// Self-contained reproducible test: isolated SQLite DB, ephemeral HTTP port.
import { spawn } from "node:child_process";
import { openDB } from "../server/db.js";
import { createApp } from "../server/app.js";
const service = await createApp({
  db: await openDB({ url: "", file: ":memory:" }),
  messageLimit: 10000,
});
await new Promise((r) => service.http.listen(0, "127.0.0.1", r));
try {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/load.js",
        `--url=http://127.0.0.1:${service.http.address().port}`,
        ...process.argv.slice(2),
      ],
      { stdio: "inherit" },
    );
    child.on("exit", resolve);
    child.on("error", reject);
  });
  process.exitCode = code;
} finally {
  await service.close();
}
