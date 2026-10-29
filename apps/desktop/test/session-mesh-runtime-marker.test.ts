import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { makeSessionMeshHookCommand } from "../src/main/session-mesh/session-mesh-hook-installer-core.js";
import {
  SESSION_MESH_RUNTIME_MARKER,
  SessionMeshRuntimeMarker,
} from "../src/main/session-mesh/session-mesh-runtime-marker.js";

it("skips Electron when inactive and only invokes a live account-bound runtime", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mesh-marker-"));
  const handler = path.join(directory, "session-mesh-hook-handler.js");
  writeFileSync(handler, "process.stdout.write('invoked');");
  const command = makeSessionMeshHookCommand(
    process.execPath,
    handler,
    "SessionStart",
    "codex"
  );
  const invoke = () =>
    spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
  expect(invoke()).toMatchObject({ status: 0, stdout: "" });
  const inactiveStop = makeSessionMeshHookCommand(
    process.execPath,
    handler,
    "Stop",
    "codex"
  );
  expect(
    spawnSync("/bin/sh", ["-c", inactiveStop], { encoding: "utf8" })
  ).toMatchObject({ status: 0, stdout: "{}" });
  const file = path.join(directory, SESSION_MESH_RUNTIME_MARKER);
  writeFileSync(file, "2147483647\nold-source\n");
  expect(invoke()).toMatchObject({ status: 0, stdout: "" });
  writeFileSync(file, "0\ncorrupt\n");
  expect(invoke()).toMatchObject({ status: 0, stdout: "" });
  const marker = new SessionMeshRuntimeMarker(directory, () => undefined);
  marker.refresh("org-a:user-a:device-a");
  const first = readFileSync(file, "utf8");
  expect(first.startsWith(`${process.pid}\n`)).toBe(true);
  expect(first).not.toContain("user-a");
  expect(invoke()).toMatchObject({ status: 0, stdout: "invoked" });
  marker.refresh("org-b:user-b:device-b");
  expect(readFileSync(file, "utf8")).not.toBe(first);
  marker.refresh(null);
  expect(existsSync(file)).toBe(false);
  expect(invoke()).toMatchObject({ status: 0, stdout: "" });
});

it("cannot remove a replacement process marker during old-process cleanup", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mesh-marker-owner-"));
  const file = path.join(directory, SESSION_MESH_RUNTIME_MARKER);
  const marker = new SessionMeshRuntimeMarker(directory, () => undefined);
  marker.refresh("owner-a");
  writeFileSync(file, "2147483647\nreplacement\n");
  marker.refresh(null);
  expect(readFileSync(file, "utf8")).toBe("2147483647\nreplacement\n");
});
