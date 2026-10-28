/**
 * @file e2e-feature-flag-assignment.test.ts
 * @description ISS-8753 — the Electron E2E flag-assignment seam, from the main
 * process's side.
 *
 * TWO THINGS ARE UNDER TEST HERE, and they fail for different reasons.
 *
 * The GATING is the security half. Desktop flag resolution is moving to the
 * signed-in user's server-side PostHog assignment precisely so that a file on a
 * user's own machine can no longer decide a gate, and a seam that reintroduced
 * that would give back exactly what the cutover took away. So the packaged-build
 * refusal and the launch-argument requirement are asserted as behavior — with a
 * seed file present and readable in both cases, because a refusal that only
 * holds when there is nothing to read proves nothing.
 *
 * The ROUND TRIP is the harness half: the Playwright writer and the main-process
 * reader are driven against each other over a real temp profile, so a disagreement
 * about the file name or the payload shape fails here rather than as
 * silently-closed gates across `desktop-e2e`.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import { registerE2eFeatureFlagSeedIpcHandler } from "../src/main/ipc/e2e-feature-flag-seed-ipc.js";
import { readE2eFeatureFlagAssignment } from "../src/main/lifecycle/e2e-feature-flag-assignment.js";
import { DesktopFeatureFlagsIpcChannel } from "../src/shared/desktop-feature-flags-channel.js";
import {
  E2E_FEATURE_FLAG_ASSIGNMENT_ARG,
  E2E_FEATURE_FLAG_ASSIGNMENT_FILE,
} from "../src/shared/e2e-feature-flag-assignment-contract.js";
import { E2E_DESKTOP_FEATURE_FLAG_SEED } from "./e2e/helpers/e2e-desktop-settings-seed.js";
import {
  clearE2eFeatureFlagAssignment,
  mergeE2eFeatureFlagAssignment,
} from "./e2e/helpers/e2e-feature-flag-assignment-seed.js";

const HARNESS_ARGV = ["electron", ".", E2E_FEATURE_FLAG_ASSIGNMENT_ARG];
const SHIPPED_ARGV = ["electron", "."];
const SEEDED_KEY = "harnessSeededGate";
const TRUSTED_SENDER = { id: "trusted-renderer" };

const profiles: string[] = [];

afterEach(() => {
  for (const dir of profiles.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

/** A real temp profile with the harness seed already written into it. */
function seededProfile(flags: Record<string, boolean>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-flag-assignment-"));
  profiles.push(dir);
  mergeE2eFeatureFlagAssignment(dir, flags);
  return dir;
}

test("the harness writer and the main-process reader agree end to end", () => {
  const userDataPath = seededProfile({ [SEEDED_KEY]: true });

  const assignment = readE2eFeatureFlagAssignment(HARNESS_ARGV, {
    isPackaged: false,
    userDataPath,
  });

  // Served in the real wire shape, resolved, so the renderer's boundary read
  // classifies it ASSIGNED rather than as an evaluation that produced nothing.
  assert.equal(assignment?.resolved, true);
  assert.deepEqual(assignment?.flags, { [SEEDED_KEY]: true });
});

test("a per-spec seed layers onto the standard profile seed instead of replacing it", () => {
  // The real call order: `seedE2eDesktopSettings` first, then a spec's
  // `beforeLaunch`. A writer that overwrote would silently take `labsNav` away
  // from every spec that seeds one flag of its own.
  const userDataPath = seededProfile(E2E_DESKTOP_FEATURE_FLAG_SEED);
  mergeE2eFeatureFlagAssignment(userDataPath, { [SEEDED_KEY]: true });

  const assignment = readE2eFeatureFlagAssignment(HARNESS_ARGV, {
    isPackaged: false,
    userDataPath,
  });

  assert.deepEqual(assignment?.flags, {
    ...E2E_DESKTOP_FEATURE_FLAG_SEED,
    [SEEDED_KEY]: true,
  });
});

test("a packaged build serves nothing, even with the argument and a valid seed", () => {
  const userDataPath = seededProfile({ [SEEDED_KEY]: true });

  // The enforced half of "not a product back door": the refusal is checked
  // BEFORE argv and before the filesystem, so a shipped app cannot be argued
  // into reading a seed at all.
  assert.equal(
    readE2eFeatureFlagAssignment(HARNESS_ARGV, {
      isPackaged: true,
      userDataPath,
    }),
    null
  );
});

test("an unpackaged build without the launch argument serves nothing", () => {
  const userDataPath = seededProfile({ [SEEDED_KEY]: true });

  // The case that matters on a developer's machine: the file is right there and
  // readable, and a dev build still opens no gate from it. No shipped launcher
  // passes the argument.
  assert.equal(
    readE2eFeatureFlagAssignment(SHIPPED_ARGV, {
      isPackaged: false,
      userDataPath,
    }),
    null
  );
});

test("an ordinary launch profile with no seed file serves nothing", () => {
  const userDataPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "e2e-flag-assignment-empty-")
  );
  profiles.push(userDataPath);

  assert.equal(
    readE2eFeatureFlagAssignment(HARNESS_ARGV, {
      isPackaged: false,
      userDataPath,
    }),
    null
  );
});

test("clearing the standard seed serves nothing, so the renderer falls through to the real path", () => {
  // ISS-9728: `Unavailable` — the delivery a launch with NO identity produces,
  // and the one the guest tour turns on — is unreachable from a seed. The seam
  // answers BEFORE the auth path, so any seed at all reports an assignment that
  // ARRIVED, and `launchDesktopApp` writes one on every launch. A spec whose
  // subject is the unauthenticated reader has to take it away, which is the
  // real launch order driven here: the standard seed first, a spec's
  // `beforeLaunch` second.
  const userDataPath = seededProfile(E2E_DESKTOP_FEATURE_FLAG_SEED);

  clearE2eFeatureFlagAssignment(userDataPath);

  assert.equal(
    readE2eFeatureFlagAssignment(HARNESS_ARGV, {
      isPackaged: false,
      userDataPath,
    }),
    null
  );
});

test("a malformed or non-boolean seed serves nothing rather than a partial assignment", () => {
  const userDataPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "e2e-flag-assignment-bad-")
  );
  profiles.push(userDataPath);
  const seedPath = path.join(userDataPath, E2E_FEATURE_FLAG_ASSIGNMENT_FILE);

  fs.writeFileSync(seedPath, "{not json", "utf8");
  assert.equal(
    readE2eFeatureFlagAssignment(HARNESS_ARGV, {
      isPackaged: false,
      userDataPath,
    }),
    null
  );

  // A string verdict is REJECTED, not coerced: an unparseable assignment is
  // unknown, and unknown is closed.
  fs.writeFileSync(
    seedPath,
    JSON.stringify({ flags: { [SEEDED_KEY]: "yes" } }),
    "utf8"
  );
  assert.equal(
    readE2eFeatureFlagAssignment(HARNESS_ARGV, {
      isPackaged: false,
      userDataPath,
    }),
    null
  );
});

test("the registered IPC handler serves the seed to the trusted renderer and refuses anyone else", () => {
  const userDataPath = seededProfile({ [SEEDED_KEY]: true });
  const handlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >();
  let isPackaged = false;

  registerE2eFeatureFlagSeedIpcHandler(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    {
      isTrustedSender: (sender) => sender === TRUSTED_SENDER,
      isPackaged: () => isPackaged,
      getArgv: () => HARNESS_ARGV,
      getUserDataPath: () => userDataPath,
    }
  );

  // The channel the preload actually invokes. A handler registered on any other
  // name is a seam the renderer can never reach.
  const handler = handlers.get(DesktopFeatureFlagsIpcChannel.GetE2eSeed);
  assert.ok(handler);

  const served = handler({ sender: TRUSTED_SENDER }) as {
    flags: Record<string, boolean>;
  } | null;
  assert.deepEqual(served?.flags, { [SEEDED_KEY]: true });

  assert.equal(handler({ sender: { id: "other-window" } }), null);

  // Read lazily rather than captured at registration, so the packaged refusal
  // still applies to a handler that was registered before it was known.
  isPackaged = true;
  assert.equal(handler({ sender: TRUSTED_SENDER }), null);
});

test("a packaged build is refused by the handler before it inspects launch or profile state", () => {
  const userDataPath = seededProfile({ [SEEDED_KEY]: true });
  const handlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >();
  let argvReads = 0;
  let userDataPathReads = 0;

  registerE2eFeatureFlagSeedIpcHandler(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    {
      isTrustedSender: (sender) => sender === TRUSTED_SENDER,
      isPackaged: () => true,
      getArgv: () => {
        argvReads += 1;
        return HARNESS_ARGV;
      },
      getUserDataPath: () => {
        userDataPathReads += 1;
        return userDataPath;
      },
    }
  );
  const handler = handlers.get(DesktopFeatureFlagsIpcChannel.GetE2eSeed);
  assert.ok(handler);

  assert.equal(handler({ sender: TRUSTED_SENDER }), null);

  // An argument list evaluates before its callee, so a handler that only
  // forwarded these into the helper's own refusal would have run both by now —
  // with the argument present and a valid readable seed on disk, the case where
  // a late refusal is indistinguishable from an early one.
  assert.equal(argvReads, 0);
  assert.equal(userDataPathReads, 0);
});

test("the writer merges over a malformed prior seed instead of throwing in beforeLaunch", () => {
  const userDataPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "e2e-flag-assignment-writer-bad-")
  );
  profiles.push(userDataPath);
  const seedPath = path.join(userDataPath, E2E_FEATURE_FLAG_ASSIGNMENT_FILE);
  // What an interrupted prior write leaves behind. The writer runs inside a
  // spec's `beforeLaunch`, so a throw here fails that spec with a filesystem
  // error rather than the assertion it came for — and it would do so on every
  // subsequent run, because nothing else ever rewrites the file.
  fs.writeFileSync(seedPath, '{"flags": {"agents": tr', "utf8");

  mergeE2eFeatureFlagAssignment(userDataPath, { [SEEDED_KEY]: true });

  // Started from nothing and left a seed the READER accepts, so the launch that
  // follows is served the gate it seeded rather than falling through to the
  // real assignment path with every gate closed.
  assert.deepEqual(
    readE2eFeatureFlagAssignment(HARNESS_ARGV, {
      isPackaged: false,
      userDataPath,
    })?.flags,
    { [SEEDED_KEY]: true }
  );
});

test("the writer drops a non-boolean prior verdict rather than layering it forward", () => {
  const userDataPath = fs.mkdtempSync(
    path.join(os.tmpdir(), "e2e-flag-assignment-writer-nonbool-")
  );
  profiles.push(userDataPath);
  fs.writeFileSync(
    path.join(userDataPath, E2E_FEATURE_FLAG_ASSIGNMENT_FILE),
    JSON.stringify({ flags: { staleGate: "yes" } }),
    "utf8"
  );

  mergeE2eFeatureFlagAssignment(userDataPath, { [SEEDED_KEY]: true });

  // The writer validates with the reader's own schema, so it cannot carry
  // forward a verdict the reader rejects WHOLE — which would close the seeded
  // gate too, not just the bad key.
  assert.deepEqual(
    readE2eFeatureFlagAssignment(HARNESS_ARGV, {
      isPackaged: false,
      userDataPath,
    })?.flags,
    { [SEEDED_KEY]: true }
  );
});
