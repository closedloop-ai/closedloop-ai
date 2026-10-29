import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { E2E_EPHEMERAL_LOOPBACK_PORTS_ARG } from "../src/main/lifecycle/loopback-port-isolation.js";
import { PORT_PROBE_ORDER } from "../src/shared/contracts.js";
import { launchAuthenticatedDesktopApp } from "./e2e/helpers/authenticated-desktop-app.js";
import {
  type ElectronLauncher,
  launchDesktopApp,
  USER_DATA_DIR_ARG,
} from "./e2e/helpers/desktop-app.js";
import { gatewayListenGateEnv } from "./e2e/helpers/gateway-listen-gate.js";

const preloadUrl = new URL(
  "./e2e/helpers/gateway-listen-gate-preload.cjs",
  import.meta.url
);
const actualRequire = createRequire(preloadUrl);
const syntheticHome = path.resolve("synthetic-home");
const profile = path.resolve("synthetic-profile");
const discoveryDirectory = path.join(syntheticHome, ".closedloop-ai");
const discoveryFile = path.join(discoveryDirectory, "electron-port");
const profileDirectory = path.join(profile, ".closedloop-ai");
const profileFile = path.join(profileDirectory, "electron-port");
const gateSchema = z.object({
  held: z.boolean(),
  discoveryFilePath: z.string().optional(),
  parkedCount: z.custom<() => number>((value) => typeof value === "function"),
  release: z.custom<() => number>((value) => typeof value === "function"),
});
const metadataSchema = z.object({
  ports: z.array(z.number()),
  held: z.boolean(),
  ephemeralLoopbackPortsArg: z.string(),
  userDataDir: z.string(),
});
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("actual CommonJS gateway isolation preload", () => {
  it.each(PORT_PROBE_ORDER)(
    "rewrites recognized port %s and preserves listen arguments and receiver",
    (port) => {
      const fixture = createFixture();
      fixture.execute();
      const callback = vi.fn();
      expect(fixture.server.listen(port, "127.0.0.1", callback)).toBe(
        fixture.server
      );
      expect(fixture.listen).toHaveBeenCalledExactlyOnceWith(
        0,
        "127.0.0.1",
        callback
      );
      expect(fixture.listen.mock.contexts).toEqual([fixture.server]);
    }
  );

  it("matches before rewriting, parks only recognized listeners and replays once", () => {
    const fixture = createFixture({ held: true });
    fixture.execute();
    const gate = fixture.gate();
    for (const port of PORT_PROBE_ORDER) {
      expect(fixture.server.listen(port, "127.0.0.1")).toBe(fixture.server);
    }
    expect(fixture.listen).not.toHaveBeenCalled();
    for (const argument of [0, 4318, { port: PORT_PROBE_ORDER[0] }]) {
      fixture.server.listen(argument);
    }
    expect(fixture.listen.mock.calls).toEqual([
      [0],
      [4318],
      [{ port: PORT_PROBE_ORDER[0] }],
    ]);
    expect(gate.parkedCount()).toBe(PORT_PROBE_ORDER.length);
    expect(gate.release()).toBe(PORT_PROBE_ORDER.length);
    expect(fixture.listen.mock.calls.slice(3)).toEqual(
      PORT_PROBE_ORDER.map(() => [0, "127.0.0.1"])
    );
    expect(gate.release()).toBe(0);
    expect(fixture.gate().held).toBe(false);
    fixture.server.listen(PORT_PROBE_ORDER[0]);
    expect(fixture.listen).toHaveBeenLastCalledWith(0);
  });

  it.each(["unflagged", "packaged", "legacy", "absent"] as const)(
    "preserves fixed binds and default discovery for %s launches",
    async (mode) => {
      const fixture = createFixture({ mode });
      fixture.execute();
      fixture.server.listen(PORT_PROBE_ORDER[0]);
      if (mode === "legacy") {
        expect(fixture.listen).not.toHaveBeenCalled();
        expect(fixture.gate().release()).toBe(1);
      }
      expect(fixture.listen).toHaveBeenCalledExactlyOnceWith(
        PORT_PROBE_ORDER[0]
      );
      expect(fixture.files.writeFile).toBe(fixture.writeFile);
      await fixture.files.writeFile(discoveryFile, "19432", "utf8");
      expect(fixture.writeFile).toHaveBeenCalledExactlyOnceWith(
        discoveryFile,
        "19432",
        "utf8"
      );
      expect(fixture.mkdir).not.toHaveBeenCalled();
    }
  );

  it("redirects only the exact discovery write while retaining original parent mkdir semantics", async () => {
    const fixture = createFixture();
    fixture.execute();
    expect(fixture.files.mkdir).toBe(fixture.mkdir);
    await fixture.files.mkdir(discoveryDirectory, { recursive: true });
    expect(fixture.mkdir).toHaveBeenCalledExactlyOnceWith(discoveryDirectory, {
      recursive: true,
    });
    expect(
      await fixture.files.writeFile(discoveryFile, "assigned-port", "utf8")
    ).toBe("write-result");
    expect(fixture.mkdir).toHaveBeenLastCalledWith(profileDirectory, {
      recursive: true,
    });
    expect(fixture.writeFile).toHaveBeenCalledExactlyOnceWith(
      profileFile,
      "assigned-port",
      "utf8"
    );
    expect(fixture.writeFile.mock.contexts).toEqual([fixture.files]);
    expect(fixture.gate().discoveryFilePath).toBe(profileFile);
  });

  it("delegates custom paths, other filenames and URL inputs without creating a profile parent", async () => {
    const fixture = createFixture();
    fixture.execute();
    const inputs = [
      path.join(discoveryDirectory, "other-file"),
      path.join(profile, "custom-port"),
      pathToFileURL(discoveryFile),
    ];
    for (const file of inputs) {
      await fixture.files.writeFile(file, "payload", { flag: "wx" });
    }
    expect(fixture.mkdir).not.toHaveBeenCalled();
    expect(fixture.writeFile.mock.calls).toEqual(
      inputs.map((file) => [file, "payload", { flag: "wx" }])
    );
  });

  it("propagates mkdir and write failures without writing after a failed parent creation", async () => {
    const fixture = createFixture();
    fixture.execute();
    const failure = new Error("synthetic filesystem rejection");
    fixture.mkdir.mockRejectedValueOnce(failure);
    await expect(
      fixture.files.writeFile(discoveryFile, "payload")
    ).rejects.toBe(failure);
    expect(fixture.writeFile).not.toHaveBeenCalled();
    fixture.writeFile.mockRejectedValueOnce(failure);
    await expect(
      fixture.files.writeFile(discoveryFile, "payload")
    ).rejects.toBe(failure);
    expect(fixture.writeFile).toHaveBeenCalledExactlyOnceWith(
      profileFile,
      "payload"
    );
  });

  it.each([
    "{",
    "[]",
    '{"ports":[0]}',
    JSON.stringify({ ...metadata(false), userDataDir: "relative-profile" }),
    JSON.stringify({ ...metadata(false), unexpected: true }),
  ])("rejects malformed metadata %s before installing wrappers", (raw) => {
    const fixture = createFixture({ raw });
    expect(fixture.execute).toThrow();
    expect(fixture.Server.prototype.listen).toBe(fixture.listen);
    expect(fixture.files.writeFile).toBe(fixture.writeFile);
  });
});

describe("production test launcher gateway policy wiring", () => {
  it.each(["default", "authenticated", "held-default"] as const)(
    "passes shared preload and profile metadata through the %s launcher",
    async (surface) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-wiring-"));
      roots.push(root);
      const userDataDir = path.join(root, "profile");
      const homes = path.join(root, "homes");
      const failure = new Error("synthetic launch boundary stop");
      const observations: Parameters<ElectronLauncher>[0][] = [];
      const launchElectron: ElectronLauncher = (options) => {
        observations.push(options);
        return Promise.reject(failure);
      };
      const options = { userDataDir, harnessHomesRoot: homes, launchElectron };
      const pending =
        surface === "authenticated"
          ? launchAuthenticatedDesktopApp(options)
          : launchDesktopApp({
              ...options,
              gatewayListenGate: surface === "held-default",
            });
      await expect(pending).rejects.toBe(failure);
      expect(observations).toHaveLength(1);
      const launch = observations[0];
      expect(launch?.args).toContain(fileURLToPath(preloadUrl));
      expect(launch?.args).toContain(E2E_EPHEMERAL_LOOPBACK_PORTS_ARG);
      expect(launch?.args).toContain(`${USER_DATA_DIR_ARG}${userDataDir}`);
      const raw = launch?.env?.CL_E2E_GATEWAY_LISTEN_GATE_PORTS;
      expect(raw).toBeDefined();
      expect(metadataSchema.parse(JSON.parse(raw ?? "null"))).toEqual(
        metadata(surface === "held-default", userDataDir)
      );
      expect(fs.existsSync(homes)).toBe(false);
    }
  );
});

function metadata(held: boolean, userDataDir = profile) {
  return metadataSchema.parse(
    JSON.parse(
      gatewayListenGateEnv(held, userDataDir).CL_E2E_GATEWAY_LISTEN_GATE_PORTS
    )
  );
}

/** Execute the actual CJS preload with real CJS Zod, without binding any sockets. */
function createFixture(
  options: {
    held?: boolean;
    mode?: "unflagged" | "packaged" | "legacy" | "absent";
    raw?: string;
  } = {}
) {
  const listen = vi.fn(function (this: unknown, ..._args: unknown[]) {
    return this;
  });
  class Server {
    declare listen: typeof listen;
  }
  Object.defineProperty(Server.prototype, "listen", {
    value: listen,
    writable: true,
  });
  // The instance must resolve the prototype wrapper installed by the actual CJS.
  const server = new Server();
  const mkdir = vi.fn(async (..._args: unknown[]) => "mkdir-result");
  const writeFile = vi.fn(async (..._args: unknown[]) => "write-result");
  const files = { mkdir, writeFile };
  let raw = options.raw ?? JSON.stringify(metadata(options.held ?? false));
  if (options.mode === "legacy") {
    raw = JSON.stringify(PORT_PROBE_ORDER);
  }
  const context: Record<string, unknown> = {
    require: (id: string) => {
      switch (id) {
        case "node:fs/promises":
          return files;
        case "node:net":
          return { Server };
        case "node:os":
          return { homedir: () => syntheticHome };
        case "node:path":
          return path;
        case "zod":
          return actualRequire(id);
        case "electron":
          return { app: { isPackaged: options.mode === "packaged" } };
        default:
          throw new Error(`Unexpected gateway preload dependency: ${id}`);
      }
    },
    process: {
      argv:
        options.mode === "unflagged" ? [] : [E2E_EPHEMERAL_LOOPBACK_PORTS_ARG],
      env:
        options.mode === "absent"
          ? {}
          : { CL_E2E_GATEWAY_LISTEN_GATE_PORTS: raw },
    },
  };
  return {
    Server,
    server,
    listen,
    files,
    mkdir,
    writeFile,
    gate: () => gateSchema.parse(context.__clE2eGatewayListenGate),
    execute: () =>
      new Script(fs.readFileSync(preloadUrl, "utf8"), {
        filename: preloadUrl.pathname,
      }).runInNewContext(context),
  };
}
