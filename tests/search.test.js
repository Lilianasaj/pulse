import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openDB } from "../server/db.js";
import { startIndexer } from "../server/search.js";
test("durable index outbox retains failures and removes only confirmed writes", async () => {
  const db = await openDB({ url: "", file: ":memory:" });
  let fail = true,
    received = [];
  const es = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push(body);
    res.setHeader("content-type", "application/json");
    if (fail) {
      res.statusCode = 503;
      res.end("{}");
    } else res.end(JSON.stringify({ items: [{ index: { status: 201 } }] }));
  });
  await new Promise((r) => es.listen(0, "127.0.0.1", r));
  let stop;
  try {
    await db.exec(
      "INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES($1,$2,$3,$4,$5)",
      ["u", "indexer", "Indexer", "not-used", new Date().toISOString()],
    );
    await db.exec(
      "INSERT INTO messages(channel_id,user_id,text,client_id,created_at) VALUES($1,$2,$3,$4,$5)",
      ["general", "u", "Проверка индексации", "m", new Date().toISOString()],
    );
    stop = startIndexer(db, "http://127.0.0.1:" + es.address().port);
    const until = async (predicate) => {
      const deadline = Date.now() + 5000;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw Error("Indexer timeout");
        await new Promise((r) => setTimeout(r, 30));
      }
    };
    await until(() => received.length > 0);
    assert.equal((await db.query("SELECT * FROM search_outbox")).length, 1);
    fail = false;
    await until(
      async () => (await db.query("SELECT * FROM search_outbox")).length === 0,
    );
    assert.ok(received.at(-1).includes("Проверка индексации"));
    assert.equal((await db.query("SELECT * FROM messages")).length, 1);
  } finally {
    stop?.();
    await new Promise((r) => es.close(r));
    await db.close();
  }
});
