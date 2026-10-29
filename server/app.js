import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { createClient } from "redis";
import { openDB } from "./db.js";
import {
  hashPassword,
  verifyPassword,
  getSession,
  issueSession,
  cookieToken,
  digest,
} from "./auth.js";
import { startIndexer, searchMessages } from "./search.js";
const userFields = "id,username,display_name,bio";
const projection =
  "SELECT m.id,m.channel_id,m.user_id,m.text,m.client_id,m.created_at,u.username,u.display_name FROM messages m JOIN users u ON u.id=m.user_id";
const clean = (m) => ({ ...m, id: Number(m.id) });
const fail = (status, message) => Object.assign(new Error(message), { status });
function string(value, min, max, label) {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.trim().length > max
  )
    throw fail(400, `${label}: от ${min} до ${max} символов`);
  return value.trim();
}
export async function createApp(options = {}) {
  const db = options.db || (await openDB());
  const origin =
    options.origin || process.env.PUBLIC_ORIGIN || "http://localhost:3000";
  const secure = options.secure ?? process.env.COOKIE_SECURE === "true";
  const es = options.elasticsearch ?? process.env.ELASTICSEARCH_URL;
  const app = express(),
    http = createServer(app),
    wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  if (process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { "connect-src": ["'self'", "ws:", "wss:"] },
      },
    }),
  );
  app.use(express.json({ limit: "20kb" }));
  app.use((req, res, next) => {
    req.body ??= {};
    next();
  });
  // Same-origin cookies, CSRF protection for every mutation and the WS upgrade.
  app.use("/api", (req, res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin &&
      req.headers.origin !== origin
    )
      return res.status(403).json({ error: "Недопустимый источник запроса" });
    next();
  });
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: 3000,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  const authLimit = rateLimit({
    windowMs: 60000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Слишком много попыток. Подождите минуту." },
  });
  const writeLimit = rateLimit({
    windowMs: 60000,
    limit: Number(
      options.messageLimit || process.env.MESSAGE_RATE_LIMIT || 120,
    ),
    keyGenerator: (req) => req.user.id,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Слишком много сообщений. Подождите минуту." },
  });
  const connections = new Map();
  let publisher, subscriber;
  const deliver = (event) => {
    for (const ws of wss.clients)
      if (ws.readyState === WebSocket.OPEN) {
        if (ws.bufferedAmount > 1024 * 1024) {
          ws.close(1013, "Slow consumer");
          continue;
        }
        ws.send(JSON.stringify(event));
      }
  };
  if (process.env.REDIS_URL) {
    publisher = createClient({ url: process.env.REDIS_URL });
    subscriber = publisher.duplicate();
    publisher.on("error", (e) => console.error("Redis:", e.message));
    subscriber.on("error", (e) => console.error("Redis:", e.message));
    await publisher.connect();
    await subscriber.connect();
    await subscriber.subscribe("pulse:events", (value) => {
      try {
        deliver(JSON.parse(value));
      } catch {}
    });
  }
  const broadcast = async (event) => {
    if (publisher) {
      try {
        await publisher.publish("pulse:events", JSON.stringify(event));
      } catch (e) {
        console.error("Publish failed:", e.message);
        deliver(event);
      }
    } else deliver(event);
  };
  app.get("/api/health", async (req, res) => {
    await db.query("SELECT 1");
    res.json({
      status: "ok",
      database: db.postgres ? "postgresql" : "sqlite",
      realtime: publisher ? "redis" : "single-process",
    });
  });
  app.post("/api/auth/register", authLimit, async (req, res) => {
    const username = string(req.body.username, 3, 32, "Логин").toLowerCase();
    if (!/^[a-z0-9_]+$/.test(username))
      throw fail(400, "Логин: латинские буквы, цифры и _");
    const password = string(req.body.password, 8, 128, "Пароль");
    const name = string(req.body.display_name || username, 1, 60, "Имя");
    const id = randomUUID();
    const hash = await hashPassword(password);
    try {
      await db.exec(
        "INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES($1,$2,$3,$4,$5)",
        [id, username, name, hash, new Date().toISOString()],
      );
    } catch (e) {
      if (
        e.code === "23505" ||
        (e.code?.startsWith("ERR_SQLITE") && e.message.includes("UNIQUE"))
      )
        throw fail(409, "Этот логин уже занят");
      throw e;
    }
    await issueSession(db, res, id, secure);
    res
      .status(201)
      .json({
        user: (
          await db.query(`SELECT ${userFields} FROM users WHERE id=$1`, [id])
        )[0],
      });
  });
  // Equal-cost verification for unknown users reduces username enumeration by timing.
  const dummy = await hashPassword(randomUUID());
  app.post("/api/auth/login", authLimit, async (req, res) => {
    const username = string(req.body.username, 1, 32, "Логин").toLowerCase();
    const password = string(req.body.password, 1, 128, "Пароль");
    const user = (
      await db.query("SELECT * FROM users WHERE username=$1", [username])
    )[0];
    const valid = await verifyPassword(password, user?.password_hash || dummy);
    if (!user || !valid) throw fail(401, "Неверный логин или пароль");
    await issueSession(db, res, user.id, secure);
    res.json({
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        bio: user.bio,
      },
    });
  });
  app.use("/api", async (req, res, next) => {
    req.user = await getSession(db, req);
    if (!req.user) return res.status(401).json({ error: "Войдите в аккаунт" });
    next();
  });
  app.get("/api/me", (req, res) => {
    const { expires_at, ...user } = req.user;
    res.json({ user });
  });
  app.patch("/api/me", async (req, res) => {
    const name = string(req.body.display_name, 1, 60, "Имя");
    const bio = string(req.body.bio || "", 0, 300, "О себе");
    await db.exec("UPDATE users SET display_name=$1,bio=$2 WHERE id=$3", [
      name,
      bio,
      req.user.id,
    ]);
    res.json({
      user: (
        await db.query(`SELECT ${userFields} FROM users WHERE id=$1`, [
          req.user.id,
        ])
      )[0],
    });
  });
  app.post("/api/auth/logout", async (req, res) => {
    await db.exec("DELETE FROM sessions WHERE token_hash=$1", [
      digest(cookieToken(req)),
    ]);
    for (const ws of wss.clients)
      if (ws.tokenHash === digest(cookieToken(req)))
        ws.close(4001, "Session ended");
    res.clearCookie("pulse_session", {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure,
    });
    res.json({ ok: true });
  });
  app.get("/api/channels", async (req, res) => {
    const rows = await db.query(
      `SELECT c.*,(SELECT text FROM messages WHERE channel_id=c.id ORDER BY id DESC LIMIT 1) AS last_text,(SELECT MAX(id) FROM messages WHERE channel_id=c.id) AS last_id,(SELECT created_at FROM messages WHERE channel_id=c.id ORDER BY id DESC LIMIT 1) AS last_at FROM channels c ORDER BY c.created_at,c.id`,
    );
    res.json({
      channels: rows.map((c) => ({ ...c, last_id: Number(c.last_id || 0) })),
    });
  });
  app.post("/api/channels", writeLimit, async (req, res) => {
    const name = string(req.body.name, 1, 60, "Название");
    const description = string(req.body.description || "", 0, 300, "Описание");
    const channel = {
      id: randomUUID(),
      name,
      description,
      owner_id: req.user.id,
      created_at: new Date().toISOString(),
    };
    await db.exec(
      "INSERT INTO channels(id,name,description,owner_id,created_at) VALUES($1,$2,$3,$4,$5)",
      Object.values(channel),
    );
    await broadcast({ type: "channel", channel });
    res.status(201).json({ channel });
  });
  async function channelExists(req, res, next) {
    if (
      !(
        await db.query("SELECT id FROM channels WHERE id=$1", [req.params.id])
      )[0]
    )
      throw fail(404, "Канал не найден");
    next();
  }
  app.get("/api/channels/:id/messages", channelExists, async (req, res) => {
    const before = Number(req.query.before || Number.MAX_SAFE_INTEGER),
      after = Number(req.query.after || 0),
      limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
    if (
      ![before, after, limit].every(Number.isSafeInteger) ||
      before < 1 ||
      after < 0
    )
      throw fail(400, "Неверный курсор");
    const rows = await db.query(
      projection +
        ` WHERE m.channel_id=$1 AND m.id<$2 AND m.id>$3 ORDER BY m.id ${after ? "ASC" : "DESC"} LIMIT $4`,
      [req.params.id, before, after, limit],
    );
    res.json({
      messages: (after ? rows : rows.reverse()).map(clean),
      has_more: rows.length === limit,
    });
  });
  app.post(
    "/api/channels/:id/messages",
    channelExists,
    writeLimit,
    async (req, res) => {
      const text = string(req.body.text, 1, 4000, "Сообщение");
      const clientId = string(
        req.body.client_id || randomUUID(),
        1,
        80,
        "ID сообщения",
      );
      const rows = await db.query(
        "INSERT INTO messages(channel_id,user_id,text,client_id,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,client_id) DO NOTHING RETURNING id",
        [req.params.id, req.user.id, text, clientId, new Date().toISOString()],
      );
      const message = clean(
        (
          await db.query(
            projection + " WHERE m.user_id=$1 AND m.client_id=$2",
            [req.user.id, clientId],
          )
        )[0],
      );
      if (message.channel_id !== req.params.id || message.text !== text)
        throw fail(409, "ID сообщения уже использован");
      if (rows.length) await broadcast({ type: "message", message });
      res.status(rows.length ? 201 : 200).json({ message });
    },
  );
  app.get("/api/channels/:id/search", channelExists, async (req, res) => {
    const q = string(req.query.q, 1, 100, "Поиск");
    const { ids, engine } = await searchMessages(db, es, req.params.id, q);
    const messages = ids.length
      ? await db.query(
          projection +
            ` WHERE m.channel_id=$1 AND m.id IN (${ids.map((_, i) => "$" + (i + 2)).join(",")}) ORDER BY m.id DESC`,
          [req.params.id, ...ids],
        )
      : [];
    res.json({ messages: messages.map(clean), engine });
  });
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "Метод API не найден" }),
  );
  const dist = resolve("dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get("/{*path}", (req, res) =>
      res.sendFile(resolve(dist, "index.html")),
    );
  }
  app.use((err, req, res, next) => {
    if (!err.status) console.error(err);
    res
      .status(err.status || 500)
      .json({ error: err.status ? err.message : "Ошибка сервера" });
  });
  http.on("upgrade", async (req, socket, head) => {
    try {
      if (
        new URL(req.url, "http://local").pathname !== "/ws" ||
        (req.headers.origin && req.headers.origin !== origin)
      ) {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const user = await getSession(db, req);
      if (!user) {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      const count = connections.get(user.id) || 0;
      if (count >= 10) {
        socket.end("HTTP/1.1 429 Too Many Requests\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        connections.set(user.id, count + 1);
        ws.user = user;
        ws.tokenHash = digest(cookieToken(req));
        ws.alive = true;
        ws.on("pong", () => (ws.alive = true));
        ws.on("error", () => {});
        ws.on("message", () => {});
        ws.on("close", () => {
          const n = (connections.get(user.id) || 1) - 1;
          if (n > 0) connections.set(user.id, n);
          else connections.delete(user.id);
        });
        ws.send(JSON.stringify({ type: "ready", user_id: user.id }));
      });
    } catch {
      socket.destroy();
    }
  });
  const heartbeat = setInterval(async () => {
    for (const ws of wss.clients) {
      if (
        !ws.alive ||
        !(
          await db.query(
            "SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>$2",
            [ws.tokenHash, new Date().toISOString()],
          )
        )[0]
      ) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, 30000);
  heartbeat.unref();
  const stopIndexer = startIndexer(db, es);
  const cleanup = setInterval(
    () =>
      db
        .exec("DELETE FROM sessions WHERE expires_at<$1", [
          new Date().toISOString(),
        ])
        .catch(console.error),
    3600000,
  );
  cleanup.unref();
  return {
    app,
    http,
    db,
    async close() {
      clearInterval(heartbeat);
      clearInterval(cleanup);
      stopIndexer();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((r) => wss.close(r));
      if (http.listening) await new Promise((r) => http.close(r));
      if (subscriber) await subscriber.quit();
      if (publisher) await publisher.quit();
      await db.close();
    },
  };
}
