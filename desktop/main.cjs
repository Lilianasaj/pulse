const { app, BrowserWindow, session, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
let configured;
try {
  configured = JSON.parse(
    fs.readFileSync(path.join(__dirname, "config.json"), "utf8"),
  ).url;
} catch {}
const url = process.env.CHAT_URL || configured || "http://localhost:3000";
let parsed;
try {
  parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol)) throw Error();
} catch {
  throw Error("CHAT_URL must be an http(s) URL");
}
app.enableSandbox();
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) =>
    cb(false),
  );
  const create = () => {
    const win = new BrowserWindow({
      title: "Pulse Chat",
      width: 1280,
      height: 840,
      minWidth: 380,
      minHeight: 560,
      backgroundColor: "#191d2b",
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    for (const event of ["will-navigate", "will-redirect"])
      win.webContents.on(event, (e, target) => {
        if (new URL(target).origin !== parsed.origin) e.preventDefault();
      });
    win
      .loadURL(url)
      .catch(() =>
        dialog.showErrorBox(
          "Pulse Chat",
          "Сервер недоступен: " +
            url +
            "\nЗапустите сервер или задайте CHAT_URL.",
        ),
      );
  };
  create();
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) create();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
