/**
 * ISS-12521 AC-004: the add-a-directory control's IPC handler.
 *
 * It also owns the PRELOAD HOP (tamsinb, PR #8917): `createDesktopApi` over
 * an `ipcRenderer` stand-in wired to the REAL registered handler, so a
 * preload method naming a channel no main handler answers on fails here
 * instead of shipping an Add button that does nothing.
 *
 * The TCC predicate is the REAL `isTccProtectedPath` against real
 * `os.homedir()`-shaped paths, not a mock: tamsinb and whitlockk's finding on
 * this PR was that the handler called the wrong predicate, and a suite that
 * mocks whichever predicate the handler happens to name cannot tell one from
 * the other. Only `checkPathReadableAsync` is doubled, so each
 * `PathReadability` verdict can be driven and the protected path can assert
 * the probe was never issued at all.
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, test, vi } from "vitest";
import { registerDirectoryScopeIpcHandlers } from "../src/main/ipc/directory-scope-ipc.js";
import { createDesktopApi } from "../src/main/preload-common.js";
import {
  DirectoryScopeIpcChannel,
  type DirectoryScopePickPayload,
} from "../src/shared/directory-scope-ipc-channel.js";

const showOpenDialog = vi.fn();

vi.mock("electron", () => ({
  dialog: { showOpenDialog: (...args: unknown[]) => showOpenDialog(...args) },
}));

const checkPathReadableAsync = vi.fn();

vi.mock(
  "../src/main/collectors/engine/file-access-probe.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../src/main/collectors/engine/file-access-probe.js")
      >();
    return {
      ...actual,
      checkPathReadableAsync: (
        ...args: Parameters<typeof actual.checkPathReadableAsync>
      ) => checkPathReadableAsync(...args),
    };
  }
);

const HOME = os.homedir();
/** Readable, outside every protected root. */
const PLAIN_DIR = path.join(HOME, "code", "orbit-api");
const PLAIN_DIR_LABEL = path.join("~", "code", "orbit-api");
/** Not protected, so a readability verdict is what decides its outcome. */
const UNREADABLE_DIR = path.join("/opt", "orbit", "ledger");
/** A TCC-protected root (`TCC_PROTECTED_HOME_SUBDIRS`). */
const PROTECTED_ROOT = path.join(HOME, "Documents");
/** The case the retired `isTccProtectedDirectory` predicate missed. */
const PROTECTED_DESCENDANT = path.join(HOME, "Documents", "acme");
/** `~/Library/CloudStorage`, protected by ISS-11914's Library list. */
const PROTECTED_CLOUD_STORAGE = path.join(
  HOME,
  "Library",
  "CloudStorage",
  "Dropbox",
  "work"
);
/** `/Volumes`, protected by ISS-11914. */
const PROTECTED_VOLUME = path.join("/Volumes", "vault", "ledger");

type IpcListener = (event: unknown) => unknown;
type PickHandler = (
  event: unknown
) => Promise<DirectoryScopePickPayload | null>;

const UNTRUSTED_SENDER_ERROR = /untrusted sender/;
const TRUSTED_SENDER = { id: "trusted-renderer" };

function captureHandler(
  isTrustedSender: (sender: unknown) => boolean
): IpcListener {
  let listener: IpcListener | undefined;
  registerDirectoryScopeIpcHandlers(
    {
      handle: (channel, l) => {
        if (channel === DirectoryScopeIpcChannel.PickDirectory) {
          listener = l;
        }
      },
    },
    { isTrustedSender }
  );
  if (listener === undefined) {
    throw new Error("PickDirectory handler was not registered");
  }
  return listener;
}

function registerWithFakeIpcMain(
  isTrustedSender: (sender: unknown) => boolean = () => true
): PickHandler {
  const registered = captureHandler(isTrustedSender);
  // The production listener's declared return type (`unknown`) matches
  // Electron's generic `ipcMain.handle` signature, not this module's actual
  // payload — this is the one place that casts it back to what
  // `directory-scope-ipc.ts` always resolves.
  return (event) =>
    registered(event) as Promise<DirectoryScopePickPayload | null>;
}

describe("registerDirectoryScopeIpcHandlers", () => {
  beforeEach(() => {
    showOpenDialog.mockReset();
    checkPathReadableAsync.mockReset();
  });

  test("rejects an untrusted sender before opening the native dialog", async () => {
    const handler = registerWithFakeIpcMain(() => false);
    await assert.rejects(() => handler({ sender: {} }), UNTRUSTED_SENDER_ERROR);
    assert.equal(showOpenDialog.mock.calls.length, 0);
  });

  test("returns null when the picker is cancelled", async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const handler = registerWithFakeIpcMain();
    const result = await handler({ sender: {} });
    assert.equal(result, null);
  });

  test("returns null when the picker resolves with no path", async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] });
    const handler = registerWithFakeIpcMain();
    const result = await handler({ sender: {} });
    assert.equal(result, null);
  });

  test("maps a readable, unprotected pick to a fully-open scope entry", async () => {
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [PLAIN_DIR],
    });
    checkPathReadableAsync.mockResolvedValue("readable");
    const handler = registerWithFakeIpcMain();
    const result = await handler({ sender: {} });
    assert.deepEqual(result, {
      label: PLAIN_DIR_LABEL,
      path: PLAIN_DIR,
      tccProtected: false,
      unreadable: false,
    });
  });

  test("maps a blocked readability verdict to unreadable: true", async () => {
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [UNREADABLE_DIR],
    });
    checkPathReadableAsync.mockResolvedValue("blocked");
    const handler = registerWithFakeIpcMain();
    const result = await handler({ sender: {} });
    assert.deepEqual(result, {
      label: UNREADABLE_DIR,
      path: UNREADABLE_DIR,
      tccProtected: false,
      unreadable: true,
    });
  });

  test("maps an absent readability verdict to unreadable: false, not a false denial", async () => {
    // A directory picked via the native dialog always exists; "absent" here
    // would be a probe oddity, not a real denial, so it must not read as one.
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [PLAIN_DIR],
    });
    checkPathReadableAsync.mockResolvedValue("absent");
    const handler = registerWithFakeIpcMain();
    const result = await handler({ sender: {} });
    assert.ok(result);
    assert.equal(result.unreadable, false);
  });

  // marisolashgrove, PR #8917: `unknown` is whatever `classifyAccessError` could
  // not name — EIO on a flaky SMB mount, ELOOP, ENOTDIR on a bundle. Folding
  // it to readable resolves `Added` and lands the path in `includedIds`,
  // where `collectJsonlFiles` swallows the readdir error and the import
  // silently under-populates.
  test("maps an unknown readability verdict to unreadable: true, never a confident add", async () => {
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [UNREADABLE_DIR],
    });
    checkPathReadableAsync.mockResolvedValue("unknown");
    const handler = registerWithFakeIpcMain();
    const result = await handler({ sender: {} });
    assert.ok(result);
    assert.equal(result.unreadable, true);
  });

  // tamsinb, PR #8917: opening a TCC folder raises the real macOS permission
  // prompt `isTccProtectedPath` exists to avoid, and
  // `resolveAddDirectoryOutcome` returns `Protected` without ever reading
  // `unreadable`. So the probe must not be issued at all.
  test("never probes readability on a TCC-protected pick", async () => {
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [PROTECTED_ROOT],
    });
    const handler = registerWithFakeIpcMain();
    const result = await handler({ sender: {} });
    assert.equal(checkPathReadableAsync.mock.calls.length, 0);
    assert.deepEqual(result, {
      label: path.join("~", "Documents"),
      path: PROTECTED_ROOT,
      tccProtected: true,
      unreadable: false,
    });
  });

  // tamsinb and whitlockk, PR #8917: the retired `isTccProtectedDirectory`
  // matched only a direct child of home or a `.photoslibrary` bundle, so each
  // of these read as unprotected and, if readable, reached `includedIds` —
  // which `PickedDirectory` forbids for a protected folder.
  const protectedBeyondTheRoot = [
    ["a descendant of a protected home folder", PROTECTED_DESCENDANT],
    ["a folder under ~/Library/CloudStorage", PROTECTED_CLOUD_STORAGE],
    ["a folder on a mounted volume", PROTECTED_VOLUME],
  ] as const;

  for (const [description, picked] of protectedBeyondTheRoot) {
    test(`reports ${description} as TCC-protected`, async () => {
      showOpenDialog.mockResolvedValue({
        canceled: false,
        filePaths: [picked],
      });
      const handler = registerWithFakeIpcMain();
      const result = await handler({ sender: {} });
      assert.ok(result);
      assert.equal(result.tccProtected, true);
      assert.equal(checkPathReadableAsync.mock.calls.length, 0);
    });
  }
});

/**
 * The preload hop, after the pattern of
 * `desktop-feature-flags-preload-hop.test.ts`.
 *
 * tamsinb, PR #8917: the adapter suite installs a hand-written
 * `window.desktopApi` and the cases above call the registered listener
 * directly, so neither could catch `preload-common.ts` invoking a channel no
 * main handler answers on — the Add button would do nothing while both stayed
 * green. Here `createDesktopApi` drives the REAL registered handler through
 * an `ipcRenderer` stand-in that REJECTS an unknown channel.
 *
 * ACCEPTED BOUNDARY, stated rather than implied — the same one the exemplar
 * carries: this stops at the preload method. It does not run
 * `createDesktopPickDirectory`, because that module type-imports
 * `@repo/app`'s `.tsx` and `tsconfig.tests.json` sets no `--jsx` (its
 * deferred-suite list is shrink-only, ISS-5142). The adapter's own half runs
 * the production `createDesktopPickDirectory` in
 * `src/renderer/components/data-controls/__tests__/directory-scope-desktop-adapter.test.tsx`.
 * The two meet on the method name `pickDirectoryScopeEntry`, which `DesktopApi`
 * types for both.
 */
function createPickDirectoryHop() {
  const handlers = new Map<string, IpcListener>();
  const invokedChannels: string[] = [];

  registerDirectoryScopeIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    { isTrustedSender: (sender) => sender === TRUSTED_SENDER }
  );

  const desktopApi = createDesktopApi({
    // The transport edge: carry the channel to the registered main handler
    // exactly as Electron's `ipcRenderer.invoke` would.
    invoke: (channel: string) => {
      invokedChannels.push(channel);
      const handler = handlers.get(channel);
      if (!handler) {
        return Promise.reject(
          new Error(`no main handler registered for ${channel}`)
        );
      }
      return Promise.resolve(handler({ sender: TRUSTED_SENDER }));
    },
    on: () => undefined,
    removeListener: () => undefined,
    send: () => undefined,
  });

  return { invokedChannels, desktopApi };
}

describe("the pick-directory preload hop", () => {
  beforeEach(() => {
    showOpenDialog.mockReset();
    checkPathReadableAsync.mockReset();
  });

  test("the preload method reaches the real main handler on its own channel", async () => {
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [PLAIN_DIR],
    });
    checkPathReadableAsync.mockResolvedValue("readable");
    const { invokedChannels, desktopApi } = createPickDirectoryHop();

    const payload = await desktopApi.pickDirectoryScopeEntry();

    // The preload method must name THIS channel: aiming it at another one, or
    // deleting it, is exactly what a stubbed `window.desktopApi` cannot catch.
    assert.deepEqual(invokedChannels, [DirectoryScopeIpcChannel.PickDirectory]);
    assert.deepEqual(payload, {
      label: PLAIN_DIR_LABEL,
      path: PLAIN_DIR,
      tccProtected: false,
      unreadable: false,
    });
  });

  test("a cancelled pick crosses the hop as null, not as a rejection", async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const { invokedChannels, desktopApi } = createPickDirectoryHop();

    assert.equal(await desktopApi.pickDirectoryScopeEntry(), null);
    assert.deepEqual(invokedChannels, [DirectoryScopeIpcChannel.PickDirectory]);
  });

  test("a protected pick crosses the hop protected, through the real predicate", async () => {
    showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [PROTECTED_DESCENDANT],
    });
    const { desktopApi } = createPickDirectoryHop();

    const payload = await desktopApi.pickDirectoryScopeEntry();

    assert.equal(payload?.tccProtected, true);
    assert.equal(checkPathReadableAsync.mock.calls.length, 0);
  });
});
