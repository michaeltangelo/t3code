const { app, BrowserWindow, dialog, ipcMain, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const phase = process.argv.find((arg) => arg.startsWith("--test-phase="))?.split("=")[1];
const fixtureOrigin = process.env.AUTH_PROBE_FIXTURE_ORIGIN;
const selfTest =
  ["write", "read"].includes(phase) && /^http:\/\/127\.0\.0\.1:\d+$/.test(fixtureOrigin ?? "");
if (phase && !selfTest) throw new Error("Invalid self-test configuration.");
const dataRoot = selfTest ? process.env.AUTH_PROBE_TEST_DATA : path.join(__dirname, ".data");
if (!dataRoot || !path.isAbsolute(dataRoot))
  throw new Error("Probe storage must be an absolute path.");
fs.mkdirSync(dataRoot, { recursive: true });
app.setPath("userData", path.join(dataRoot, "chromium"));
app.setPath("sessionData", path.join(dataRoot, "chromium"));
app.setName("T3 Website Auth Test");
const services = {
  gemini: { url: "https://gemini.google.com/", partition: "persist:t3-auth-probe-gemini" },
  muse: { url: "https://muse.ai/", partition: "persist:t3-auth-probe-muse" },
};
const shellURL = pathToFileURL(path.join(__dirname, "index.html")).href;
const observationsFile = path.join(dataRoot, "observations.json");
const results = new Set(["signed-in", "blocked", "signed-out", "not-tested"]);
let observations = {};
let history = {};
try {
  const saved = JSON.parse(fs.readFileSync(observationsFile, "utf8"));
  for (const id of Object.keys(services)) {
    const entries = Array.isArray(saved[id]) ? saved[id] : [saved[id]];
    history[id] = entries.filter((entry) => results.has(entry?.result)).slice(-20);
    observations[id] = history[id].at(-1);
  }
} catch {}
let window;
let quitting = false;
let restart = false;
const guests = new Map();
const statuses = Object.fromEntries(
  Object.keys(services).map((id) => [
    id,
    { origin: null, loading: false, blocked: false, loadError: null, popups: 0 },
  ]),
);

function report() {
  return {
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    platform: process.platform,
    runStarted: started,
    storage: "Device-local, isolated from T3 Code and your default browser",
    services: Object.fromEntries(
      Object.keys(services).map((id) => [
        id,
        {
          ...statuses[id],
          observation: observations[id] ?? { result: "not-tested" },
          history: history[id] ?? [],
        },
      ]),
    ),
  };
}
const started = new Date().toISOString();
function notify() {
  if (window && !window.isDestroyed()) window.webContents.send("probe:update", report());
}
function trusted(event) {
  if (
    event.sender !== window?.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    event.senderFrame.url !== shellURL
  ) {
    throw new Error("Only the local probe controls can perform this action.");
  }
}
function serviceFor(id) {
  if (!Object.hasOwn(services, id)) throw new Error("Unknown service.");
  return services[id];
}
function allowed(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" ||
      (selfTest && parsed.origin === fixtureOrigin) ||
      url === "about:blank"
    );
  } catch {
    return false;
  }
}
function configureSession(ses) {
  ses.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(permission === "clipboard-sanitized-write"),
  );
  ses.setPermissionCheckHandler(
    (_contents, permission) => permission === "clipboard-sanitized-write",
  );
}
function wireGuest(contents, id) {
  const observeURL = (url) => {
    try {
      const parsed = new URL(url);
      statuses[id].origin = parsed.origin;
      statuses[id].blocked =
        /(?:deniedsigninrejected|disallowed_useragent|browsernotsupported)/i.test(parsed.href);
    } catch {}
    notify();
  };
  contents.on("will-navigate", (event, url) => {
    if (!allowed(url)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!allowed(url)) event.preventDefault();
  });
  contents.on("did-navigate", (_event, url) => observeURL(url));
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame) observeURL(url);
  });
  contents.on("did-start-loading", () => {
    statuses[id].loading = true;
    statuses[id].loadError = null;
    notify();
  });
  contents.on("did-stop-loading", () => {
    statuses[id].loading = false;
    notify();
  });
  contents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
    if (mainFrame && code !== -3) {
      statuses[id].loadError = code;
      notify();
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (!allowed(url)) return { action: "deny" };
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        width: 560,
        height: 760,
        autoHideMenuBar: true,
        webPreferences: {
          session: contents.session,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          preload: undefined,
        },
      },
    };
  });
  contents.on("did-create-window", (child) => {
    statuses[id].popups += 1;
    wireGuest(child.webContents, id);
    notify();
  });
}

async function runFixtureTest() {
  const assert = require("node:assert/strict");
  const ses = session.fromPartition(services.gemini.partition);
  const isolated = session.fromPartition(services.muse.partition);
  configureSession(ses);
  const win = new BrowserWindow({
    show: false,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await win.loadURL(`${fixtureOrigin}/${phase}`);
  const state = await win.webContents.executeJavaScript(
    '({storage:localStorage.getItem("probe"),cookies:document.cookie})',
  );
  const globals = await win.webContents.executeJavaScript(
    "({node:typeof require,bridge:typeof authProbe})",
  );
  assert.deepEqual(globals, { node: "undefined", bridge: "undefined" });
  wireGuest(win.webContents, "gemini");
  const popupReady = new Promise((resolve) => win.webContents.once("did-create-window", resolve));
  await win.webContents.executeJavaScript(
    `window.open(${JSON.stringify(fixtureOrigin + "/popup")}); void 0`,
    true,
  );
  const popup = await popupReady;
  assert.equal(popup.webContents.session, ses);
  popup.destroy();
  const cookies = await ses.cookies.get({ url: fixtureOrigin });
  const other = await isolated.cookies.get({ url: fixtureOrigin });
  assert.equal(state.storage, "synthetic-value");
  assert.equal(
    cookies.some((cookie) => cookie.name === "persistent" && cookie.httpOnly && cookie.hostOnly),
    true,
  );
  assert.equal(other.length, 0);
  assert.equal(state.cookies.includes("persistent="), false);
  if (phase === "write") {
    assert.equal(
      cookies.some((cookie) => cookie.name === "session"),
      true,
    );
    assert.equal(
      cookies.some((cookie) => cookie.name === "session" && cookie.session),
      true,
    );
  }
  const sessionCookieSurvived = cookies.some((cookie) => cookie.name === "session");
  await ses.cookies.flushStore();
  ses.flushStorageData();
  fs.writeFileSync(
    path.join(dataRoot, `${phase}.json`),
    JSON.stringify({
      phase,
      passed: true,
      persistentCookieSurvived: true,
      localStorageSurvived: true,
      profilesIsolated: true,
      httpOnlyPreserved: true,
      noNodeOrProbeBridge: true,
      popupUsesSameProfile: true,
      sessionCookieSurvived,
    }),
  );
  win.destroy();
  app.quit();
}

app
  .whenReady()
  .then(async () => {
    if (selfTest) return runFixtureTest();
    for (const service of Object.values(services))
      configureSession(session.fromPartition(service.partition));
    window = new BrowserWindow({
      title: "T3 Website Auth Test",
      width: 1320,
      height: 900,
      minWidth: 760,
      minHeight: 640,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        webviewTag: true,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-attach-webview", (event, preferences, params) => {
      const match = Object.values(services).find(
        (service) => service.partition === params.partition && service.url === params.src,
      );
      if (!match || params.preload) {
        event.preventDefault();
        return;
      }
      delete preferences.preload;
      preferences.nodeIntegration = false;
      preferences.nodeIntegrationInSubFrames = false;
      preferences.contextIsolation = false;
      preferences.sandbox = true;
    });
    window.webContents.on("did-attach-webview", (_event, contents) => {
      const id = Object.keys(services).find(
        (key) => contents.session === session.fromPartition(services[key].partition),
      );
      if (!id) {
        contents.close();
        return;
      }
      guests.set(id, contents);
      wireGuest(contents, id);
    });
    ipcMain.handle("probe:state", (event) => {
      trusted(event);
      return report();
    });
    ipcMain.handle("probe:external", async (event, id) => {
      trusted(event);
      await shell.openExternal(serviceFor(id).url);
    });
    ipcMain.handle("probe:observe", (event, id, result) => {
      trusted(event);
      serviceFor(id);
      if (!results.has(result)) throw new Error("Invalid observation.");
      observations[id] = {
        result,
        recordedAt: new Date().toISOString(),
        runStarted: started,
        source: "user-observed",
      };
      history[id] = [...(history[id] ?? []), observations[id]].slice(-20);
      fs.writeFileSync(observationsFile, JSON.stringify(history, null, 2));
      notify();
    });
    ipcMain.handle("probe:restart", (event) => {
      trusted(event);
      restart = true;
      app.quit();
    });
    ipcMain.handle("probe:export", async (event) => {
      trusted(event);
      const choice = await dialog.showSaveDialog(window, {
        defaultPath: "t3-auth-probe-results.json",
        filters: [{ name: "JSON report", extensions: ["json"] }],
      });
      if (choice.canceled || !choice.filePath) return;
      fs.writeFileSync(choice.filePath, JSON.stringify(report(), null, 2));
    });
    await window.loadURL(shellURL);
  })
  .catch(() => {
    console.error("Auth probe startup or self-test failed.");
    app.exit(1);
  });

app.on("before-quit", (event) => {
  if (selfTest || quitting) return;
  event.preventDefault();
  quitting = true;
  Promise.all(
    Object.values(services).map(async (service) => {
      const ses = session.fromPartition(service.partition);
      await ses.cookies.flushStore();
      ses.flushStorageData();
    }),
  )
    .then(() => {
      if (restart) app.relaunch();
      app.quit();
    })
    .catch(() => {
      quitting = false;
      restart = false;
      dialog.showErrorBox(
        "Could not flush browser storage",
        "The probe stayed open. Retry closing before testing restart persistence.",
      );
    });
});
app.on("window-all-closed", () => app.quit());
