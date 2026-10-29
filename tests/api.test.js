import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { openDB } from "../server/db.js";
import { createApp } from "../server/app.js";
const origin = "http://localhost:3000";
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "pulse-"));
  const config = {
    url: process.env.TEST_DATABASE_URL || "",
    file: join(dir, "test.db"),
  };
  let service = await createApp({
    db: await openDB(config),
    origin,
    messageLimit: 1000,
  });
  await new Promise((r) => service.http.listen(0, "127.0.0.1", r));
  let base = "http://127.0.0.1:" + service.http.address().port;
  const call = async (
    path,
    { method = "GET", body, cookie, headers = {} } = {},
  ) => {
    const r = await fetch(base + "/api" + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: r.status,
      data: await r.json(),
      cookie: r.headers.get("set-cookie")?.split(";")[0],
    };
  };
  return {
    call,
    get base() {
      return base;
    },
    get service() {
      return service;
    },
    async restart() {
      await service.close();
      service = await createApp({ db: await openDB(config), origin });
      await new Promise((r) => service.http.listen(0, "127.0.0.1", r));
      base = "http://127.0.0.1:" + service.http.address().port;
    },
    async close() {
      await service.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const suffix = Math.random().toString(36).slice(2, 9);
async function register(f, name = "alice") {
  const r = await f.call("/auth/register", {
    method: "POST",
    body: {
      username: name + "_" + suffix,
      display_name: name,
      password: "correct-horse-42",
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r;
}
test("authentication, validation, CSRF, profile, logout and session invalidation", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call("/channels")).status, 401);
    assert.equal(
      (await f.call("/auth/register", { method: "POST" })).status,
      400,
    );
    const a = await register(f);
    assert.ok(a.cookie);
    const cookie = a.cookie;
    assert.equal(
      (
        await f.call("/auth/register", {
          method: "POST",
          body: { username: "alice_" + suffix, password: "correct-horse-42" },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call("/auth/login", {
          method: "POST",
          body: { username: "alice_" + suffix, password: "bad" },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await f.call("/channels", {
          method: "POST",
          cookie,
          headers: { origin: "https://evil.test" },
          body: { name: "X" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call("/channels/general/messages", {
          method: "POST",
          cookie,
          body: { text: "   " },
        })
      ).status,
      400,
    );
    assert.equal(
      (await f.call("/channels/general/messages?before=nope", { cookie }))
        .status,
      400,
    );
    const profile = await f.call("/me", {
      method: "PATCH",
      cookie,
      body: { display_name: "Алиса", bio: "Разработка" },
    });
    assert.equal(profile.data.user.bio, "Разработка");
    const ws = new WebSocket(f.base.replace("http", "ws") + "/ws", {
      headers: { cookie, origin },
    });
    await once(ws, "open");
    const closed = once(ws, "close");
    assert.equal(
      (await f.call("/auth/logout", { method: "POST", cookie })).status,
      200,
    );
    await closed;
    assert.equal((await f.call("/me", { cookie })).status, 401);
    const login = await f.call("/auth/login", {
      method: "POST",
      body: { username: "alice_" + suffix, password: "correct-horse-42" },
    });
    assert.equal(login.status, 200);
  } finally {
    await f.close();
  }
});
test("two clients, idempotency, cursor history, channel isolation, search and durable restart", async () => {
  const f = await fixture();
  try {
    const a = await register(f, "bob"),
      b = await register(f, "carol");
    const cookie = a.cookie;
    const channel = (
      await f.call("/channels", {
        method: "POST",
        cookie,
        body: { name: "Тест", description: "Проверка" },
      })
    ).data.channel;
    const ws = new WebSocket(f.base.replace("http", "ws") + "/ws", {
      headers: { cookie: b.cookie, origin },
    });
    await once(ws, "open");
    const received = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("No realtime delivery")),
        3000,
      );
      ws.on("message", (raw) => {
        const e = JSON.parse(raw);
        if (e.type === "message") {
          clearTimeout(timer);
          resolve(e.message);
        }
      });
    });
    const payload = {
      text: "Привет, WebSocket! <script>alert(1)</script> 100%_test",
      client_id: "first-" + suffix,
    };
    const first = await f.call("/channels/" + channel.id + "/messages", {
      method: "POST",
      cookie,
      body: payload,
    });
    assert.equal(first.status, 201);
    assert.equal((await received).id, first.data.message.id);
    const duplicate = await f.call("/channels/" + channel.id + "/messages", {
      method: "POST",
      cookie,
      body: payload,
    });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.data.message.id, first.data.message.id);
    assert.equal(
      (
        await f.call("/channels/general/messages", {
          method: "POST",
          cookie,
          body: payload,
        })
      ).status,
      409,
    );
    for (let i = 0; i < 7; i++)
      assert.equal(
        (
          await f.call("/channels/" + channel.id + "/messages", {
            method: "POST",
            cookie,
            body: {
              text: "Сообщение " + i,
              client_id: "cursor-" + suffix + "-" + i,
            },
          })
        ).status,
        201,
      );
    const latest = (
      await f.call("/channels/" + channel.id + "/messages?limit=3", { cookie })
    ).data;
    assert.equal(latest.messages.length, 3);
    assert.equal(latest.has_more, true);
    const older = (
      await f.call(
        "/channels/" +
          channel.id +
          "/messages?limit=3&before=" +
          latest.messages[0].id,
        { cookie },
      )
    ).data;
    assert.ok(older.messages.at(-1).id < latest.messages[0].id);
    const after = (
      await f.call(
        "/channels/" + channel.id + "/messages?after=" + first.data.message.id,
        { cookie },
      )
    ).data;
    assert.equal(after.messages.length, 7);
    const result = (
      await f.call(
        "/channels/" +
          channel.id +
          "/search?q=" +
          encodeURIComponent("100%_test"),
        { cookie },
      )
    ).data;
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].text, payload.text);
    const isolated = (
      await f.call("/channels/development/search?q=100", { cookie })
    ).data;
    assert.equal(isolated.messages.length, 0);
    assert.equal(
      (
        await f.service.db.query(
          "SELECT message_id FROM search_outbox WHERE message_id=$1",
          [first.data.message.id],
        )
      ).length,
      1,
    );
    ws.terminate();
    await f.restart();
    const history = await f.call("/channels/" + channel.id + "/messages", {
      cookie,
    });
    assert.equal(history.status, 200);
    assert.equal(history.data.messages.length, 8);
  } finally {
    await f.close();
  }
});
test("message quota returns 429 without saving rejected messages", async () => {
  const db = await openDB({ url: "", file: ":memory:" });
  const s = await createApp({ db, messageLimit: 2 });
  await new Promise((r) => s.http.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + s.http.address().port;
  try {
    const a = await fetch(base + "/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "quota", password: "correct-horse-42" }),
    });
    const cookie = a.headers.get("set-cookie").split(";")[0];
    for (let i = 0; i < 3; i++) {
      const r = await fetch(base + "/api/channels/general/messages", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ text: "Test " + i }),
      });
      assert.equal(r.status, i < 2 ? 201 : 429);
    }
    assert.equal((await db.query("SELECT * FROM messages")).length, 2);
  } finally {
    await s.close();
  }
});
test("WebSocket rejects unauthenticated and foreign-origin upgrades", async () => {
  const f = await fixture();
  try {
    const rejected = async (headers) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(f.base.replace("http", "ws") + "/ws", {
          headers,
        });
        ws.on("error", () => {});
        ws.on("open", () => {
          ws.terminate();
          reject(Error("Unexpected accepted upgrade"));
        });
        ws.on("unexpected-response", (_req, res) => {
          resolve(res.statusCode);
          res.resume();
          ws.terminate();
        });
      });
    assert.equal(await rejected({ origin }), 401);
    assert.equal(await rejected({ origin: "https://foreign.test" }), 403);
  } finally {
    await f.close();
  }
});

test("HTTP LAN deployments keep assets on HTTP; HTTPS deployments retain upgrades", async () => {
  for (const publicOrigin of ["http://192.168.1.210:3000", "https://chat.example.com"]) {
    const service = await createApp({
      db: await openDB({ url: "", file: ":memory:" }),
      origin: publicOrigin,
    });
    await new Promise((resolve) => service.http.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${service.http.address().port}/api/health`);
      assert.equal(response.status, 200);
      const policy = response.headers.get("content-security-policy");
      assert.ok(policy?.includes("script-src 'self'"), "Keep the script policy enabled");
      assert.equal(
        policy.split(";").some((directive) => directive.trim() === "upgrade-insecure-requests"),
        publicOrigin.startsWith("https://"),
        `Unexpected HTTPS asset upgrade policy for ${publicOrigin}`,
      );
      await response.arrayBuffer();
    } finally {
      await service.close();
    }
  }
});
