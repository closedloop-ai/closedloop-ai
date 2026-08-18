/**
 * ISS-5302 — behavioral coverage for the binary-paths IPC registrar
 * (`src/main/ipc/binary-paths-ipc.ts`), which is the main-process consumer of
 * the shared canonical CLI tool list (`src/shared/cli-binary-tools.ts`).
 *
 * Follows the established desktop IPC-handler pattern (see
 * `test/ipc-profile-channels.test.ts`): build a fake `handle` registrar, drive
 * the registered listeners directly, and assert the trusted/untrusted sender
 * split by its side effect rather than by inspecting the source.
 *
 * Why every tool carries an override in the detection tests: with no override,
 * `resolveBinaryFromLoginShell` calls `getShellPath()`, which spawns the user's
 * real login shell (`$SHELL -ilc`) and then probes the host's real install
 * locations, so the result would depend on what happens to be installed on the
 * machine running the suite. Supplying an override for every tool takes the
 * resolver's override branch — a pure `access(X_OK)` check against paths this
 * test owns — which is deterministic and spawns no child process.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import {
  type BinaryPathPatch,
  BinaryPathsIpcChannel,
  registerBinaryPathsIpcHandlers,
} from "../src/main/ipc/binary-paths-ipc.js";
import {
  type BinaryResolveSource,
  CLI_BINARY_TOOLS,
} from "../src/shared/cli-binary-tools.js";

type IpcHandler = (event: unknown, payload?: unknown) => unknown;

type DetectedTool = {
  name: string;
  override: string | null;
  resolvedPath: string | null;
  source: BinaryResolveSource;
};

type RegistrarResult = {
  applied: BinaryPathPatch[];
  handlers: Map<string, IpcHandler>;
};

const UNTRUSTED_SENDER_ERROR = /untrusted sender/;

// `BinaryResolveSource` is a bare string union with no runtime const to import,
// so these annotated constants are the closest available contract binding: a
// renamed union member fails typecheck here instead of silently living on as a
// stale literal inside an assertion.
const OVERRIDE_SOURCE: BinaryResolveSource = "override";
const OVERRIDE_INVALID_SOURCE: BinaryResolveSource = "override_invalid";

/**
 * The one tool these tests point at a real executable. Read off the canonical
 * list rather than written as a literal, so the test cannot name a tool the
 * shared list no longer ships.
 */
const EXECUTABLE_TOOL = CLI_BINARY_TOOLS[0];

/**
 * A second canonical tool, used only to keep a stored override map from being
 * deep-equal to the patch applied over it — see the PatchBinaryPaths test.
 */
const UNPATCHED_TOOL = CLI_BINARY_TOOLS[1];

const STORED_OVERRIDE_PATH = "/opt/symphony-test/bin/tool";
const UNPATCHED_OVERRIDE_PATH = "/opt/symphony-test/bin/other-tool";

const tempDirs: string[] = [];

after(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function makeBinDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5302-binary-paths-"));
  tempDirs.push(dir);
  return dir;
}

function registerHandlers(options: {
  binaryPaths?: Record<string, string>;
  isTrustedSender?: (sender: unknown) => boolean;
}): RegistrarResult {
  const handlers = new Map<string, IpcHandler>();
  const applied: BinaryPathPatch[] = [];
  const binaryPaths = options.binaryPaths ?? {};
  registerBinaryPathsIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    {
      isTrustedSender: options.isTrustedSender ?? (() => true),
      getBinaryPaths: () => binaryPaths,
      applyBinaryPathPatch: (patch) => {
        applied.push(patch);
        return binaryPaths;
      },
    }
  );
  return { applied, handlers };
}

async function makeExecutable(dir: string, name: string): Promise<string> {
  const target = path.join(dir, name);
  await writeFile(target, "#!/bin/sh\nexit 0\n");
  await chmod(target, 0o755);
  return target;
}

describe("binary paths IPC registrar", () => {
  test("registers exactly the binary-paths channels", () => {
    const { handlers } = registerHandlers({});

    assert.deepEqual(
      [...handlers.keys()].sort(),
      [...Object.values(BinaryPathsIpcChannel)].sort()
    );
  });

  test("GetBinaryPaths serves the stored override map", () => {
    const stored = { [EXECUTABLE_TOOL]: STORED_OVERRIDE_PATH };
    const { handlers } = registerHandlers({ binaryPaths: stored });

    assert.deepEqual(
      handlers.get(BinaryPathsIpcChannel.GetBinaryPaths)?.(null),
      stored
    );
  });

  test("PatchBinaryPaths forwards a trusted patch and returns the new map", () => {
    // The store deliberately holds a SECOND tool the patch does not mention, so
    // the store's map and the patch are not deep-equal. Without that asymmetry
    // a handler that echoed the patch straight back would satisfy the assertion
    // below and the test would prove nothing — the real defect that shape hides
    // is a clearing patch (`{ tool: null }`) rendering in Settings as a null
    // override instead of the store's resolved map.
    const stored = {
      [EXECUTABLE_TOOL]: STORED_OVERRIDE_PATH,
      [UNPATCHED_TOOL]: UNPATCHED_OVERRIDE_PATH,
    };
    const patch = { [EXECUTABLE_TOOL]: STORED_OVERRIDE_PATH };
    const { applied, handlers } = registerHandlers({ binaryPaths: stored });

    const result = handlers.get(BinaryPathsIpcChannel.PatchBinaryPaths)?.(
      { sender: {} },
      patch
    );

    // The patch must reach the store unreshaped, and the handler must answer
    // with the store's post-write map rather than echoing the patch back.
    assert.deepEqual(applied, [patch]);
    assert.deepEqual(result, stored);
    assert.notDeepEqual(result, patch);
  });

  test("PatchBinaryPaths rejects an untrusted sender before persisting", () => {
    const { applied, handlers } = registerHandlers({
      isTrustedSender: () => false,
    });
    const patchHandler = handlers.get(BinaryPathsIpcChannel.PatchBinaryPaths);

    assert.throws(
      () => patchHandler?.({ sender: {} }, { [EXECUTABLE_TOOL]: "/tmp/evil" }),
      UNTRUSTED_SENDER_ERROR
    );
    // The gate is only meaningful if the write never happened.
    assert.deepEqual(applied, []);
  });

  test("DetectCliTools serves exactly the canonical CLI tool list", {
    timeout: 10_000,
  }, async () => {
    const binDir = await makeBinDir();
    const realBinary = await makeExecutable(binDir, EXECUTABLE_TOOL);
    const missingBinary = path.join(binDir, "not-installed-here");
    const binaryPaths = Object.fromEntries(
      CLI_BINARY_TOOLS.map((name) => [
        name,
        name === EXECUTABLE_TOOL ? realBinary : missingBinary,
      ])
    );
    const { handlers } = registerHandlers({ binaryPaths });

    const detected = (await handlers.get(
      BinaryPathsIpcChannel.DetectCliTools
    )?.(null)) as Record<string, DetectedTool>;

    // The keys ARE the contract: the handler must serve the shared canonical
    // list, in its order, with nothing added and nothing dropped.
    assert.deepEqual(Object.keys(detected), [...CLI_BINARY_TOOLS]);
    assert.deepEqual(detected[EXECUTABLE_TOOL], {
      name: EXECUTABLE_TOOL,
      override: realBinary,
      resolvedPath: realBinary,
      source: OVERRIDE_SOURCE,
    });
    for (const name of CLI_BINARY_TOOLS) {
      if (name === EXECUTABLE_TOOL) {
        continue;
      }
      assert.deepEqual(detected[name], {
        name,
        override: missingBinary,
        // A non-executable override is reported back verbatim under
        // `override_invalid` rather than silently dropped, so Settings can
        // tell the user which path it could not use.
        resolvedPath: missingBinary,
        source: OVERRIDE_INVALID_SOURCE,
      });
    }
  });

  test("DetectCliTools is not gated on sender trust", {
    timeout: 10_000,
  }, async () => {
    const binDir = await makeBinDir();
    const realBinary = await makeExecutable(binDir, EXECUTABLE_TOOL);
    const binaryPaths = Object.fromEntries(
      CLI_BINARY_TOOLS.map((name) => [name, realBinary])
    );
    const { handlers } = registerHandlers({
      binaryPaths,
      isTrustedSender: () => false,
    });

    const detected = (await handlers.get(
      BinaryPathsIpcChannel.DetectCliTools
    )?.({ sender: {} })) as Record<string, DetectedTool>;

    // Current, deliberate split: only the mutating channel carries the
    // trusted-sender assertion. Detection and GetBinaryPaths are read-only
    // and answer any sender. Pinned so widening or narrowing that split has
    // to be a deliberate edit to this assertion.
    assert.deepEqual(Object.keys(detected), [...CLI_BINARY_TOOLS]);
    assert.equal(detected[EXECUTABLE_TOOL].source, OVERRIDE_SOURCE);
  });
});
