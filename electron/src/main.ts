import { app, BrowserWindow, shell } from "electron";
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import net from "node:net";

const BACKEND_PORT = 9090;
const VITE_PORT = 9091;
const VITE_URL = `http://localhost:${VITE_PORT}`;
const rootDir = path.resolve(__dirname, "..", "..");

let backend: ChildProcess | null = null;
let frontend: ChildProcess | null = null;

function spawnChild(name: string, cwd: string): ChildProcess {
  console.log(`[electron] spawning ${name} in ${cwd}`);
  const child = spawn("npm", ["run", "dev"], {
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env },
  });
  child.on("exit", (code, signal) => {
    console.log(`[${name}] exited code=${code} sig=${signal}`);
  });
  child.on("error", (err) => console.error(`[${name}] spawn error:`, err));
  return child;
}

function probeHost(port: number, host: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host });
    const done = (ok: boolean) => { s.removeAllListeners(); s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs);
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.once("timeout", () => done(false));
  });
}

async function isPortOpen(port: number): Promise<boolean> {
  // Vite may bind only to the IPv6 loopback (::1). Checking both families
  // avoids false negatives that cause us to spawn a second Vite, hit
  // strictPort, and crash-loop.
  const [v4, v6] = await Promise.all([
    probeHost(port, "127.0.0.1"),
    probeHost(port, "::1"),
  ]);
  return v4 || v6;
}

function waitForPort(port: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryConnect = async () => {
      if (await isPortOpen(port)) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timeout waiting for :${port}`));
      setTimeout(tryConnect, 300);
    };
    tryConnect();
  });
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    title: "Shipyard",
    backgroundColor: "#0a0c10",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  await win.loadURL(VITE_URL);
}

function killChildren(): void {
  if (backend) {
    try { backend.kill("SIGTERM"); } catch {}
    backend = null;
  }
  if (frontend) {
    try { frontend.kill("SIGTERM"); } catch {}
    frontend = null;
  }
}

app.whenReady().then(async () => {
  const backendAlready = await isPortOpen(BACKEND_PORT);
  const frontendAlready = await isPortOpen(VITE_PORT);

  if (backendAlready && frontendAlready) {
    console.log("[electron] attaching to existing dev servers on :9090/:9091");
  } else {
    if (!backendAlready) {
      backend = spawnChild("backend", path.join(rootDir, "backend"));
    }
    if (!frontendAlready) {
      frontend = spawnChild("frontend", path.join(rootDir, "frontend"));
    }
    try {
      await Promise.all([waitForPort(BACKEND_PORT), waitForPort(VITE_PORT)]);
    } catch (err) {
      console.error("[electron] services did not come up:", err);
    }
  }

  // Final guard: if something else is squatting on the vite port and our
  // child crashed instead of binding, surface the problem in-window rather
  // than showing a blank page.
  if (!(await isPortOpen(VITE_PORT))) {
    console.error(`[electron] nothing is serving :${VITE_PORT}; check your yarn dev / free the port`);
  }

  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch((err) => console.error(err));
    }
  });
});

app.on("window-all-closed", () => {
  killChildren();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  killChildren();
});
