/**
 * @file iss-10591-capabilities-tools-retired.test.ts
 * @description ISS-10591 — `capabilities.tools` is gone from the wire.
 *
 * It was hardcoded all-false at both publishers and read by nobody, so a fresh
 * install's `/health` reported `claude: false, git: false, python3: false` on a
 * machine where all three resolve. Tool availability is the System Check's
 * answer (`HealthCheckResponse` -> `deriveAvailableHarnesses`), which probes the
 * binaries for real; this object advertises protocol support only.
 *
 * Every expectation below is an independent literal. Deriving the expected
 * shape from `EMPTY_CAPABILITIES` would make these assertions agree with the
 * constant no matter what it contains, which is exactly the regression they
 * exist to catch.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { DesktopGatewayServer } from "../src/server/server.js";
import { EMPTY_CAPABILITIES } from "../src/shared/contracts.js";

const serversToClose: DesktopGatewayServer[] = [];
const tempPathsToClean: string[] = [];

afterEach(async () => {
  for (const srv of serversToClose) {
    try {
      await srv.stop();
    } catch {
      /* already stopped */
    }
  }
  serversToClose.length = 0;
  for (const p of tempPathsToClean) {
    try {
      await fs.rm(p, { recursive: true });
    } catch {
      /* best effort */
    }
  }
  tempPathsToClean.length = 0;
});

function createTestServer(): DesktopGatewayServer {
  const tmpDir = path.join(
    os.tmpdir(),
    `iss-10591-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  tempPathsToClean.push(tmpDir);
  const srv = new DesktopGatewayServer({
    host: "127.0.0.1",
    preferredPort: 0,
    fallbackPorts: [0],
    webAppOrigin: "http://localhost:3000",
    machineName: "test",
    version: "0.0.1",
    capabilities: EMPTY_CAPABILITIES,
    getAllowedDirectories: () => ["/tmp"],
    discoveryFilePath: path.join(tmpDir, "electron-port"),
  });
  serversToClose.push(srv);
  return srv;
}

/**
 * Through the real server and the real route, not the constant: the constant
 * losing the key proves nothing if the handler still synthesizes one.
 */
test("GET /health omits tools entirely and keeps the protocol keys", async () => {
  const srv = createTestServer();
  await srv.start();

  const res = await fetch(`http://127.0.0.1:${srv.getActivePort()}/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    status: string;
    capabilities: Record<string, unknown>;
  };

  assert.equal(body.status, "ok");
  assert.equal(
    Object.hasOwn(body.capabilities, "tools"),
    false,
    `tools must be absent from the health payload, got ${JSON.stringify(body.capabilities)}`
  );
  // The named keys the cloud actually reads must survive the removal.
  assert.deepEqual(body.capabilities.versions, {});
});

/**
 * Cross-repo: an absent optional field is OMITTED, never serialized as `null`.
 * A skewed reader doing `capabilities.tools.claude` throws on a null and falls
 * to a safe `undefined` on an absent key, so the difference is not cosmetic.
 */
test("the serialized health payload contains no tools key at all, not a null one", async () => {
  const srv = createTestServer();
  await srv.start();

  const res = await fetch(`http://127.0.0.1:${srv.getActivePort()}/health`);
  const raw = await res.text();

  assert.equal(raw.includes('"tools"'), false, `tools leaked into: ${raw}`);
  assert.equal(raw.includes('"tools":null'), false);
  // The body is otherwise intact, so the assertion above is not passing merely
  // because the response was empty or an error page.
  assert.ok(raw.includes('"versions"'));
});

/**
 * ISS-12784 (R3): browser command signing is gone, so `/health` reports
 * `commandSigning: false` and never `commandSigningRequired`. `false` rather
 * than absent, because the server merges capabilities over the stored ones and
 * would otherwise keep the `true` every earlier build sent.
 */
test("the health payload reports command signing as unsupported", async () => {
  const srv = createTestServer();
  await srv.start();

  const res = await fetch(`http://127.0.0.1:${srv.getActivePort()}/health`);
  const body = (await res.json()) as { capabilities: Record<string, unknown> };

  assert.deepEqual(body.capabilities, { versions: {}, commandSigning: false });
});

/**
 * An older peer may still SEND `tools`. Nothing in this repo reads it, so it
 * must ride along as an unknown key rather than being rejected or re-emitted.
 */
test("a skewed peer's capabilities carrying tools are accepted and not re-emitted", () => {
  const fromOldPeer = {
    ...EMPTY_CAPABILITIES,
    tools: { claude: true, codex: false, git: true, gh: false, python3: true },
  };

  // Reading the current contract off the old-shaped object still works.
  assert.deepEqual(fromOldPeer.versions, {});

  // What WE publish carries nothing from it.
  assert.equal(Object.hasOwn(EMPTY_CAPABILITIES, "tools"), false);
});
