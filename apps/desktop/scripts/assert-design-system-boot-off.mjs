#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import Module, { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_JAVASCRIPT_PREFIX = "data:text/javascript,";
const BootProbeTarget = {
  Source: "source",
  Dist: "dist",
};
const ENTRYPOINT_BY_TARGET = {
  [BootProbeTarget.Source]: "src/main/index.ts",
  [BootProbeTarget.Dist]: "dist/main/index.js",
};
const SERVER_MODULE_BY_TARGET = {
  [BootProbeTarget.Source]: "src/server/server.ts",
  [BootProbeTarget.Dist]: "dist/server/server.js",
};
const DIST_ENTRYPOINT = "apps/desktop/dist/main/index.js";
const realRequire = createRequire(import.meta.url);

const target = parseTarget(process.argv);

if (process.argv.includes("--self-test-containment-assertions")) {
  runContainmentAssertionSelfTest();
} else if (process.argv.includes("--probe-child")) {
  await runProbeChild(target);
} else {
  runParent(target);
}

function runParent(target) {
  const childArgs =
    target === BootProbeTarget.Source
      ? [
          "--import",
          "tsx",
          fileURLToPath(import.meta.url),
          "--probe-child",
          "--target",
          BootProbeTarget.Source,
        ]
      : [
          fileURLToPath(import.meta.url),
          "--probe-child",
          "--target",
          BootProbeTarget.Dist,
        ];
  const output = execFileSync(process.execPath, childArgs, {
    cwd: appDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 15_000,
  }).trim();

  console.log(
    JSON.stringify(
      { ok: true, summary: JSON.parse(lastJsonLine(output)) },
      null,
      2
    )
  );
}

function parseTarget(argv) {
  const targetFlagIndex = argv.indexOf("--target");
  const targetEquals = argv.find((arg) => arg.startsWith("--target="));
  const rawTarget =
    targetEquals?.slice("--target=".length) ??
    (targetFlagIndex >= 0 ? argv[targetFlagIndex + 1] : BootProbeTarget.Source);

  if (rawTarget === undefined) {
    throw new Error(
      `Usage: assert-design-system-boot-off.mjs [--target ${BootProbeTarget.Source}|${BootProbeTarget.Dist}]`
    );
  }

  const normalizedTarget =
    rawTarget === "--probe-child" ? BootProbeTarget.Source : rawTarget;

  if (
    normalizedTarget === BootProbeTarget.Source ||
    normalizedTarget === BootProbeTarget.Dist
  ) {
    return normalizedTarget;
  }

  throw new Error(
    `Usage: assert-design-system-boot-off.mjs [--target ${BootProbeTarget.Source}|${BootProbeTarget.Dist}]`
  );
}

function lastJsonLine(output) {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const line = [...lines]
    .reverse()
    .find((candidate) => candidate.startsWith("{"));
  if (!line) {
    throw new Error(`Boot probe did not emit JSON output:\n${output}`);
  }
  return line;
}

async function runProbeChild(target) {
  const userDataPath = mkdtempSync(
    path.join(tmpdir(), "agent-dashboard-disabled-boot-")
  );
  const state = createProbeState(userDataPath);
  globalThis.__agentDashboardBootProbeState = state;
  installRealHostEffectSentinels(state);
  if (typeof process.resourcesPath !== "string") {
    process.resourcesPath = path.join(appDir, "resources");
  }
  globalThis.__agentDashboardBootProbeFsPromises = await import(
    "node:fs/promises"
  );
  globalThis.__agentDashboardBootProbeOs = await import("node:os");

  const electronCjsStub = createElectronCjsStub(state);
  globalThis.__agentDashboardBootProbeElectronCjs = electronCjsStub;
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "electron") {
      return electronCjsStub;
    }
    if (request === "node:http" || request === "http") {
      return createHttpCjsStub(state);
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "electron") {
        return stub("electron");
      }
      if (specifier === "electron-log/main.js") {
        return stub("electron-log-main");
      }
      if (specifier === "electron-updater") {
        return stub("electron-updater");
      }
      if (specifier === "electron-store") {
        return stub("electron-store");
      }
      if (specifier === "node:child_process") {
        return stub("node-child-process");
      }
      if (specifier === "node:os") {
        return stub("node-os");
      }
      if (specifier === "node:http" || specifier === "http") {
        return stub("node-http");
      }
      if (specifier === "node:fs/promises") {
        return stub("node-fs-promises");
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith(DATA_JAVASCRIPT_PREFIX)) {
        return {
          format: "module",
          shortCircuit: true,
          source: decodeURIComponent(url.slice(DATA_JAVASCRIPT_PREFIX.length)),
        };
      }
      let filePath = null;
      if (url.startsWith("file:")) {
        filePath = fileURLToPath(url);
        if (isAgentDashboardRuntimeModule(filePath)) {
          state.loadedRuntimeModules.push(toAppRelative(filePath));
        }
        if (isCommonJsDependency(filePath)) {
          return {
            format: "commonjs",
            shortCircuit: true,
            source: readFileSync(filePath),
          };
        }
      }
      const result = nextLoad(url, context);
      if (filePath && result.source === undefined) {
        const sanitizedResult = { ...result };
        Reflect.deleteProperty(sanitizedResult, "source");
        return { ...sanitizedResult, source: readFileSync(filePath) };
      }
      if (result.source === undefined) {
        const sanitizedResult = { ...result };
        Reflect.deleteProperty(sanitizedResult, "source");
        return sanitizedResult;
      }
      return result;
    },
  });

  let exitCode = 1;
  try {
    const entrypoint = path.join(appDir, ENTRYPOINT_BY_TARGET[target]);
    if (!existsSync(entrypoint)) {
      if (target === BootProbeTarget.Dist) {
        throw new Error(
          `Missing ${DIST_ENTRYPOINT}; run pnpm -C apps/desktop build first.`
        );
      }
      throw new Error(`Missing ${toAppRelative(entrypoint)}`);
    }

    await import(pathToFileURL(entrypoint).href);
    await installGatewayContainment(target, state);
    state.app.emit("ready");
    await waitFor(() => state.browserWindows.length > 0, 4000);
    await settle();

    const summary = summarizeState(state);
    assertDisabledAgentDashboardBootEffects(summary);
    process.stdout.write(JSON.stringify(summary));
    exitCode = 0;
  } catch (error) {
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
  } finally {
    rmSync(userDataPath, { recursive: true, force: true });
    process.exit(exitCode);
  }
}

function createProbeState(userDataPath) {
  return {
    userDataPath,
    probeTempRoot: userDataPath,
    realHomePath: process.env.HOME ?? "",
    target: null,
    app: null,
    settingsSeed: {
      agentMonitorEnabled: false,
      cloudConnectionEnabled: false,
      onboardingCompleted: false,
    },
    loadedRuntimeModules: [],
    ipcHandlers: new Set(),
    ipcRemovedHandlers: [],
    protocolHandles: [],
    browserWindows: [],
    loadUrls: [],
    exits: [],
    childProcesses: [],
    realChildProcesses: [],
    httpCreateServerAttempts: [],
    httpListenAttempts: [],
    realListenerBinds: [],
    discoveryFileWrites: [],
    gatewayContainmentMode: null,
  };
}

function createHttpCjsStub(state) {
  // Keep ProbeServer behavior aligned with the node-http ESM stub source below.
  class ProbeServer extends EventEmitter {
    listen(...args) {
      const callback = args.find((arg) => typeof arg === "function");
      const port = args.find((arg) => typeof arg === "number") ?? null;
      const host = args.find((arg) => typeof arg === "string") ?? null;
      state.httpListenAttempts.push({ port, host });
      queueMicrotask(() => callback?.());
      return this;
    }

    address() {
      const latest = state.httpListenAttempts.at(-1);
      return { address: latest?.host ?? "127.0.0.1", port: latest?.port ?? 0 };
    }

    close(callback) {
      queueMicrotask(() => callback?.());
      this.emit("close");
      return this;
    }

    removeAllListeners(eventName) {
      return super.removeAllListeners(eventName);
    }
  }

  return {
    createServer: () => {
      state.httpCreateServerAttempts.push({ blocked: true });
      return new ProbeServer();
    },
    Server: ProbeServer,
  };
}

function createElectronCjsStub(state) {
  class ProbeApp extends EventEmitter {
    isPackaged = true;
    dock = {
      setIcon: () => undefined,
    };

    getVersion() {
      return "0.0.0-boot-probe";
    }

    setName() {}

    setAboutPanelOptions() {}

    requestSingleInstanceLock() {
      // The boot probe runs as the sole instance under a fresh temp userData,
      // so it always owns the FEA-3132 single-instance lock. Returning true
      // lets startup.ts proceed past the guard instead of quitting the launch.
      return true;
    }

    getPath(name) {
      if (name === "userData") {
        return state.userDataPath;
      }
      if (name === "logs") {
        return path.join(state.userDataPath, "logs");
      }
      return state.userDataPath;
    }

    exit(code = 0) {
      state.exits.push(code);
    }

    quit() {
      state.exits.push(0);
    }
  }

  class ProbeBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = false;
      this.webContents = new EventEmitter();
      this.webContents.send = (channel, payload) => {
        state.sentMessages ??= [];
        state.sentMessages.push({ channel, payload });
      };
      this.webContents.setWindowOpenHandler = (handler) => {
        this.windowOpenHandler = handler;
      };
      state.browserWindows.push({
        preload: options?.webPreferences?.preload ?? null,
        additionalArguments: options?.webPreferences?.additionalArguments ?? [],
      });
    }

    loadURL(url) {
      state.loadUrls.push(url);
      return Promise.resolve();
    }

    once(eventName, listener) {
      if (eventName === "ready-to-show") {
        queueMicrotask(listener);
        return this;
      }
      return super.once(eventName, listener);
    }

    show() {
      this.visible = true;
    }

    hide() {
      this.visible = false;
    }

    focus() {}

    isVisible() {
      return this.visible;
    }

    close() {
      this.emit("close", { preventDefault: () => undefined });
    }
  }

  class ProbeNotification extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
    }

    show() {}
  }

  class ProbeTray extends EventEmitter {
    setToolTip() {}
    setContextMenu() {}
    setImage() {}
    setTitle() {}
    destroy() {}
  }

  const app = new ProbeApp();
  state.app = app;
  return {
    app,
    BrowserWindow: ProbeBrowserWindow,
    Notification: ProbeNotification,
    Tray: ProbeTray,
    Menu: { buildFromTemplate: (template) => template },
    nativeTheme: { themeSource: "system" },
    nativeImage: {
      createFromPath: () => ({ setTemplateImage: () => undefined }),
    },
    protocol: {
      registerSchemesAsPrivileged: () => undefined,
      handle: (scheme) => {
        state.protocolHandles.push(scheme);
      },
      unhandle: () => undefined,
    },
    ipcMain: {
      handle: (channel) => {
        state.ipcHandlers.add(channel);
      },
      on: () => undefined,
      removeHandler: (channel) => {
        state.ipcRemovedHandlers.push(channel);
        state.ipcHandlers.delete(channel);
      },
    },
    dialog: {
      showMessageBox: async () => ({ response: 0 }),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    shell: {
      openExternal: async () => undefined,
      openPath: async () => "",
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(text, "utf8"),
      decryptString: (buffer) => Buffer.from(buffer).toString("utf8"),
    },
    session: {
      defaultSession: {
        webRequest: {
          onHeadersReceived: () => undefined,
        },
      },
    },
    powerMonitor: new EventEmitter(),
  };
}

function stub(kind) {
  return {
    shortCircuit: true,
    url: `data:text/javascript,${encodeURIComponent(stubSource(kind))}`,
  };
}

function stubSource(kind) {
  if (kind === "electron") {
    return `
      const cjs = globalThis.__agentDashboardBootProbeElectronCjs;
      export const app = cjs.app;
      export const BrowserWindow = cjs.BrowserWindow;
      export const Notification = cjs.Notification;
      export const Tray = cjs.Tray;
      export const Menu = cjs.Menu;
      export const nativeTheme = cjs.nativeTheme;
      export const nativeImage = cjs.nativeImage;
      export const protocol = cjs.protocol;
      export const ipcMain = cjs.ipcMain;
      export const dialog = cjs.dialog;
      export const shell = cjs.shell;
      export const safeStorage = cjs.safeStorage;
      export const session = cjs.session;
      export const powerMonitor = cjs.powerMonitor;
      export default cjs;
    `;
  }
  if (kind === "electron-log-main") {
    return `
      const fileTransport = {
        level: false,
        fileName: "main.log",
        maxSize: 0,
        archiveLogFn: undefined,
        getFile: () => ({ path: globalThis.__agentDashboardBootProbeState.userDataPath + "/logs/main.log" }),
      };
      const electronLog = {
        initialize: () => undefined,
        transports: {
          console: { level: false, writeFn: () => undefined },
          file: fileTransport,
        },
        error: () => undefined,
        warn: () => undefined,
        debug: () => undefined,
        info: () => undefined,
      };
      export default electronLog;
    `;
  }
  if (kind === "electron-updater") {
    return `
      export const autoUpdater = {
        logger: null,
        autoDownload: false,
        autoInstallOnAppQuit: false,
        on: () => undefined,
        checkForUpdates: async () => null,
        quitAndInstall: () => undefined,
      };
      export default { autoUpdater };
    `;
  }
  if (kind === "electron-store") {
    return `
      export default class Store {
        constructor() {
          this.store = { ...globalThis.__agentDashboardBootProbeState.settingsSeed };
        }
        get(key, defaultValue) {
          return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : defaultValue;
        }
        set(key, value) {
          this.store[key] = value;
        }
        delete(key) {
          delete this.store[key];
        }
      }
    `;
  }
  if (kind === "node-child-process") {
    return `
      import { EventEmitter } from "node:events";
      function child(method, command = null) {
        const instance = new EventEmitter();
        instance.pid = Math.floor(Math.random() * 100000) + 1000;
        instance.stdout = new EventEmitter();
        instance.stderr = new EventEmitter();
        instance.kill = () => true;
        globalThis.__agentDashboardBootProbeState.childProcesses.push({ method, command, pid: instance.pid });
        return instance;
      }
      export function spawn(command) { return child("spawn", command); }
      export function spawnSync(command) {
        globalThis.__agentDashboardBootProbeState.childProcesses.push({ method: "spawnSync", command, pid: null });
        return { status: 0, stdout: "", stderr: "" };
      }
      export function execSync(command) {
        globalThis.__agentDashboardBootProbeState.childProcesses.push({ method: "execSync", command, pid: null });
        return "";
      }
      export function execFileSync(command) {
        globalThis.__agentDashboardBootProbeState.childProcesses.push({ method: "execFileSync", command, pid: null });
        return "";
      }
      export function execFile(file, _args, options, callback) {
        const cb = typeof options === "function" ? options : callback;
        queueMicrotask(() => cb?.(null, "", ""));
        return child("execFile", file);
      }
    `;
  }
  if (kind === "node-os") {
    return `
      const realOs = globalThis.__agentDashboardBootProbeOs;
      const state = globalThis.__agentDashboardBootProbeState;
      export function homedir() { return state.probeTempRoot; }
      export function tmpdir() { return realOs.tmpdir(); }
      export function hostname() { return realOs.hostname(); }
      export const platform = realOs.platform;
      export const arch = realOs.arch;
      export const release = realOs.release;
      export default new Proxy(realOs, {
        get(target, property) {
          if (property === "homedir") {
            return homedir;
          }
          if (property === "tmpdir") {
            return tmpdir;
          }
          if (property === "hostname") {
            return hostname;
          }
          return target[property];
        },
      });
    `;
  }
  if (kind === "node-http") {
    return `
      import { EventEmitter } from "node:events";
      class ProbeServer extends EventEmitter {
        listen(...args) {
          const callback = args.find((arg) => typeof arg === "function");
          const port = args.find((arg) => typeof arg === "number") ?? null;
          const host = args.find((arg) => typeof arg === "string") ?? null;
          globalThis.__agentDashboardBootProbeState.httpListenAttempts.push({ port, host });
          queueMicrotask(() => callback?.());
          return this;
        }
        address() {
          const attempts = globalThis.__agentDashboardBootProbeState.httpListenAttempts;
          const latest = attempts.at(-1);
          return { address: latest?.host ?? "127.0.0.1", port: latest?.port ?? 0 };
        }
        close(callback) {
          queueMicrotask(() => callback?.());
          this.emit("close");
          return this;
        }
        removeAllListeners(eventName) {
          return super.removeAllListeners(eventName);
        }
      }
      export function createServer() {
        globalThis.__agentDashboardBootProbeState.httpCreateServerAttempts.push({ blocked: true });
        return new ProbeServer();
      }
      export const Server = ProbeServer;
      export default { createServer, Server };
    `;
  }
  if (kind === "node-fs-promises") {
    return `
      import pathModule from "node:path";
      const realFs = globalThis.__agentDashboardBootProbeFsPromises;
      const state = globalThis.__agentDashboardBootProbeState;
      function isDiscoveryPath(candidate) {
        if (typeof candidate !== "string") {
          return false;
        }
        return candidate.endsWith("/.closedloop-ai") || candidate.endsWith("/.closedloop-ai/electron-port");
      }
      function isUnderRealHome(candidate) {
        if (typeof candidate !== "string" || !state.realHomePath) {
          return false;
        }
        const relative = pathModule.relative(state.realHomePath, candidate);
        return Boolean(relative) && !relative.startsWith("..") && !pathModule.isAbsolute(relative);
      }
      export async function mkdir(path, options) {
        if (isDiscoveryPath(path)) {
          state.discoveryFileWrites.push({ path, underRealHome: isUnderRealHome(path), blocked: true, operation: "mkdir" });
          return undefined;
        }
        return realFs.mkdir(path, options);
      }
      export async function writeFile(path, data, options) {
        if (isDiscoveryPath(path)) {
          state.discoveryFileWrites.push({ path, underRealHome: isUnderRealHome(path), blocked: true, operation: "writeFile" });
          return undefined;
        }
        return realFs.writeFile(path, data, options);
      }
      export const constants = realFs.constants;
      export const access = (...args) => realFs.access(...args);
      export const appendFile = (...args) => realFs.appendFile(...args);
      export const chmod = (...args) => realFs.chmod(...args);
      export const chown = (...args) => realFs.chown(...args);
      export const copyFile = (...args) => realFs.copyFile(...args);
      export const cp = (...args) => realFs.cp(...args);
      export const lchmod = (...args) => realFs.lchmod?.(...args);
      export const lchown = (...args) => realFs.lchown(...args);
      export const link = (...args) => realFs.link(...args);
      export const lstat = (...args) => realFs.lstat(...args);
      export const lutimes = (...args) => realFs.lutimes(...args);
      export const mkdtemp = (...args) => realFs.mkdtemp(...args);
      export const open = (...args) => realFs.open(...args);
      export const opendir = (...args) => realFs.opendir(...args);
      export const readFile = (...args) => realFs.readFile(...args);
      export const readdir = (...args) => realFs.readdir(...args);
      export const readlink = (...args) => realFs.readlink(...args);
      export const realpath = (...args) => realFs.realpath(...args);
      export const rename = (...args) => realFs.rename(...args);
      export const rm = (...args) => realFs.rm(...args);
      export const rmdir = (...args) => realFs.rmdir(...args);
      export const stat = (...args) => realFs.stat(...args);
      export const statfs = (...args) => realFs.statfs(...args);
      export const symlink = (...args) => realFs.symlink(...args);
      export const truncate = (...args) => realFs.truncate(...args);
      export const unlink = (...args) => realFs.unlink(...args);
      export const utimes = (...args) => realFs.utimes(...args);
      const fsPromises = new Proxy(realFs, {
        get(target, property) {
          if (property === "mkdir") {
            return mkdir;
          }
          if (property === "writeFile") {
            return writeFile;
          }
          return target[property];
        },
      });
      export default fsPromises;
    `;
  }
  throw new Error(`Unknown stub kind: ${kind}`);
}

function summarizeState(state) {
  const dbHandlers = [...state.ipcHandlers].filter((channel) =>
    channel.startsWith("desktop:db:")
  );
  const sqliteDataFile = path.join(
    state.userDataPath,
    "agent-dashboard.sqlite"
  );
  const legacyPgDataDir = path.join(
    state.userDataPath,
    "agent-dashboard.pgdata"
  );
  return {
    target: state.target,
    userDataPath: state.userDataPath,
    loadedRuntimeModules: state.loadedRuntimeModules,
    dbHandlers,
    sqliteDataFileExists: existsSync(sqliteDataFile),
    legacyPgDataDirExists: existsSync(legacyPgDataDir),
    browserWindows: state.browserWindows,
    loadUrls: state.loadUrls,
    exits: state.exits,
    childProcesses: state.childProcesses,
    realChildProcesses: state.realChildProcesses,
    httpCreateServerAttempts: state.httpCreateServerAttempts,
    httpListenAttempts: state.httpListenAttempts,
    realListenerBinds: state.realListenerBinds,
    discoveryFileWrites: state.discoveryFileWrites,
    gatewayContainmentMode: state.gatewayContainmentMode,
  };
}

function assertDisabledAgentDashboardBootEffects(summary) {
  const failures = [];
  if (summary.loadedRuntimeModules.length > 0) {
    failures.push(
      `loaded Agent Dashboard runtime modules: ${summary.loadedRuntimeModules.join(", ")}`
    );
  }
  if (!summary.dbHandlers.includes("desktop:db:get-dashboard-summary")) {
    failures.push("missing disabled-mode DB IPC handler for dashboard summary");
  }
  if (summary.sqliteDataFileExists) {
    failures.push("created agent-dashboard.sqlite under temp userData");
  }
  if (summary.legacyPgDataDirExists) {
    failures.push("created agent-dashboard.pgdata under temp userData");
  }
  if (summary.childProcesses.length > 0) {
    failures.push(
      `called child process methods: ${summary.childProcesses
        .map((entry) => [entry.method, entry.command].filter(Boolean).join(":"))
        .join(", ")}`
    );
  }
  if (summary.realChildProcesses.length > 0) {
    failures.push(
      `launched real child process methods: ${summary.realChildProcesses
        .map((entry) => [entry.method, entry.command].filter(Boolean).join(":"))
        .join(", ")}`
    );
  }
  if (summary.realListenerBinds.length > 0) {
    failures.push(
      `opened real gateway listener binds: ${summary.realListenerBinds.length}`
    );
  }
  if (
    summary.target === BootProbeTarget.Dist &&
    summary.httpCreateServerAttempts.length === 0
  ) {
    failures.push("dist boot did not exercise gateway HTTP containment");
  }
  const realHomeDiscoveryWrites = summary.discoveryFileWrites.filter(
    (entry) => entry.underRealHome
  );
  if (realHomeDiscoveryWrites.length > 0) {
    failures.push("attempted discovery-file write under real home directory");
  }
  if (summary.exits.some((code) => code !== 0)) {
    failures.push(
      `boot called app.exit with non-zero code: ${summary.exits.join(", ")}`
    );
  }
  if (failures.length > 0) {
    throw new Error(
      `disabled Agent Dashboard boot assertion failed: ${failures.join("; ")}`
    );
  }
}

function runContainmentAssertionSelfTest() {
  expectContainmentFailure(
    {
      ...createPassingContainmentSummary(),
      childProcesses: [{ method: "execFile", command: "git", pid: 1 }],
    },
    "called child process methods: execFile:git"
  );
  expectContainmentFailure(
    {
      ...createPassingContainmentSummary(),
      realChildProcesses: [{ method: "spawn", command: "git", blocked: true }],
    },
    "launched real child process methods: spawn:git"
  );
  expectContainmentFailure(
    {
      ...createPassingContainmentSummary(),
      realListenerBinds: [{ port: 46_321, host: "127.0.0.1", blocked: true }],
    },
    "opened real gateway listener binds: 1"
  );
  expectContainmentFailure(
    {
      ...createPassingContainmentSummary(),
      discoveryFileWrites: [
        {
          path: "/home/.closedloop-ai",
          underRealHome: true,
          blocked: true,
          operation: "mkdir",
        },
      ],
    },
    "attempted discovery-file write under real home directory"
  );
  expectContainmentFailure(
    {
      ...createPassingContainmentSummary(),
      target: BootProbeTarget.Dist,
      httpCreateServerAttempts: [],
    },
    "dist boot did not exercise gateway HTTP containment"
  );
  expectContainmentFailure(
    {
      ...createPassingContainmentSummary(),
      loadedRuntimeModules: [
        "dist/main/agent-dashboard-design-system-runtime-abc123.js",
      ],
    },
    "loaded Agent Dashboard runtime modules"
  );
}

function createPassingContainmentSummary() {
  return {
    target: BootProbeTarget.Source,
    loadedRuntimeModules: [],
    dbHandlers: ["desktop:db:get-dashboard-summary"],
    sqliteDataFileExists: false,
    legacyPgDataDirExists: false,
    childProcesses: [],
    realChildProcesses: [],
    httpCreateServerAttempts: [{ blocked: true }],
    realListenerBinds: [],
    discoveryFileWrites: [],
    exits: [],
  };
}

function expectContainmentFailure(summary, expectedMessage) {
  try {
    assertDisabledAgentDashboardBootEffects(summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(expectedMessage)) {
      return;
    }
    throw error;
  }
  throw new Error(
    `containment assertion did not fail with message: ${expectedMessage}`
  );
}

function isAgentDashboardRuntimeModule(filePath) {
  const relative = toAppRelative(filePath);
  const basename = path.basename(relative);
  return (
    relative === "src/main/agent-dashboard-design-system-runtime.ts" ||
    relative === "dist/main/agent-dashboard-design-system-runtime.js" ||
    basename.startsWith("agent-dashboard-design-system-runtime-") ||
    relative === "src/main/agent-monitor-listener.ts" ||
    relative === "dist/main/agent-monitor-listener.js" ||
    relative.startsWith("src/main/collectors/") ||
    relative.startsWith("dist/main/collectors/") ||
    relative.startsWith("src/main/database/") ||
    relative.startsWith("dist/main/database/") ||
    basename.startsWith("db-host-protocol-")
  );
}

async function installGatewayContainment(target, state) {
  state.target = target;
  const serverModulePath = path.join(appDir, SERVER_MODULE_BY_TARGET[target]);
  if (!existsSync(serverModulePath)) {
    if (target === BootProbeTarget.Dist) {
      state.gatewayContainmentMode = "dist-http-stub";
      return;
    }
    throw new Error(`Missing ${toAppRelative(serverModulePath)}`);
  }
  const { DesktopGatewayServer } = await import(
    pathToFileURL(serverModulePath).href
  );
  state.gatewayContainmentMode = "server-module";
  const prototype = DesktopGatewayServer.prototype;
  prototype.listen = function probeListen(_server, port) {
    state.httpListenAttempts.push({ port, host: "stubbed-gateway-listen" });
  };
  prototype.writeDiscoveryFile = function probeWriteDiscoveryFile() {
    const configuredPath = this.options?.discoveryFilePath ?? null;
    state.discoveryFileWrites.push({
      path: configuredPath,
      underRealHome:
        typeof configuredPath === "string" &&
        isPathInside(configuredPath, process.env.HOME ?? ""),
      blocked: true,
    });
  };
}

function installRealHostEffectSentinels(state) {
  const childProcess = realRequire("node:child_process");
  for (const method of [
    "exec",
    "execFile",
    "fork",
    "spawn",
    "execSync",
    "execFileSync",
    "spawnSync",
  ]) {
    childProcess[method] = function blockedRealChildProcess(command) {
      state.realChildProcesses.push({
        method,
        command: normalizeHostEffectCommand(command),
        blocked: true,
      });
      throw new Error(
        `Blocked real child_process.${method} during disabled Agent Dashboard boot probe`
      );
    };
  }

  const net = realRequire("node:net");
  net.Server.prototype.listen = function blockedRealListenerBind(...args) {
    state.realListenerBinds.push({
      port: args.find((arg) => typeof arg === "number") ?? null,
      host: args.find((arg) => typeof arg === "string") ?? null,
      blocked: true,
    });
    throw new Error(
      "Blocked real server listener bind during disabled Agent Dashboard boot probe"
    );
  };
}

function normalizeHostEffectCommand(command) {
  if (typeof command === "string") {
    return command;
  }
  if (command instanceof URL) {
    return command.href;
  }
  return null;
}

function isPathInside(candidatePath, parentPath) {
  if (!parentPath) {
    return false;
  }
  const relative = path.relative(parentPath, candidatePath);
  return (
    Boolean(relative) &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

function toAppRelative(filePath) {
  return path.relative(appDir, filePath).split(path.sep).join("/");
}

function isCommonJsDependency(filePath) {
  if (!filePath.includes(`${path.sep}node_modules${path.sep}`)) {
    return false;
  }
  if (filePath.endsWith(".cjs")) {
    return true;
  }
  if (!filePath.endsWith(".js")) {
    return false;
  }
  return nearestPackageType(filePath) !== "module";
}

function nearestPackageType(filePath) {
  let directory = path.dirname(filePath);
  const root = path.parse(directory).root;
  while (directory !== root) {
    const packageJsonPath = path.join(directory, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
        return typeof packageJson.type === "string"
          ? packageJson.type
          : undefined;
      } catch {
        return undefined;
      }
    }
    directory = path.dirname(directory);
  }
  return undefined;
}

async function waitFor(predicate, timeoutMs) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for Desktop boot probe side effects");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}
