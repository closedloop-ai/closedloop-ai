"use strict";

/**
 * Test-only shared gateway policy. Match the production candidate before
 * rewriting it, so unrelated port-zero listeners never enter the updater gate.
 * The real server still binds and reports its assigned port; only its profile
 * discovery write and optional ISS-10291 bind timing are isolated here.
 */
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { z } = require("zod");

const GATE_KEY = "__clE2eGatewayListenGate";
const portSchema = z.number().int().min(1).max(65_535);
const configurationSchema = z.union([
  z
    .array(portSchema)
    .min(1)
    .transform((ports) => ({ ports, held: true })),
  z
    .object({
      ports: z.array(portSchema).min(1),
      held: z.boolean(),
      ephemeralLoopbackPortsArg: z.string().min(1),
      userDataDir: z.string().min(1).refine(path.isAbsolute),
    })
    .strict(),
]);

const portsJson = process.env.CL_E2E_GATEWAY_LISTEN_GATE_PORTS;
if (portsJson) {
  installGatewayPolicy(configurationSchema.parse(JSON.parse(portsJson)));
}

/** Prior array metadata retains its original held-bind behavior. */
function installGatewayPolicy(configuration) {
  const ports = new Set(configuration.ports);
  const parked = [];
  const isolate = Boolean(
    configuration.ephemeralLoopbackPortsArg &&
      process.argv.includes(configuration.ephemeralLoopbackPortsArg) &&
      !require("electron").app.isPackaged
  );
  const gate = {
    held: configuration.held,
    discoveryFilePath: isolate
      ? isolateDiscoveryWrites(configuration.userDataDir)
      : undefined,
    parkedCount() {
      return parked.length;
    },
    release() {
      gate.held = false;
      const pending = parked.splice(0);
      for (const replay of pending) {
        replay();
      }
      return pending.length;
    },
  };
  globalThis[GATE_KEY] = gate;

  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    if (!ports.has(args[0])) {
      return listen.apply(this, args);
    }
    const bindingArgs = isolate ? [0, ...args.slice(1)] : args;
    if (gate.held) {
      parked.push(() => listen.apply(this, bindingArgs));
      return this;
    }
    return listen.apply(this, bindingArgs);
  };
}

/** Redirect the default file write; the original directory mkdir stays intact. */
function isolateDiscoveryWrites(userDataDir) {
  const originalDirectory = path.join(os.homedir(), ".closedloop-ai");
  const originalFile = path.join(originalDirectory, "electron-port");
  const profileDirectory = path.join(userDataDir, ".closedloop-ai");
  const profileFile = path.join(profileDirectory, "electron-port");
  const mkdir = fs.mkdir;
  const writeFile = fs.writeFile;
  fs.writeFile = function (file, ...args) {
    if (file === originalFile) {
      return mkdir
        .call(fs, profileDirectory, { recursive: true })
        .then(() => writeFile.call(this, profileFile, ...args));
    }
    return writeFile.call(this, file, ...args);
  };
  return profileFile;
}
