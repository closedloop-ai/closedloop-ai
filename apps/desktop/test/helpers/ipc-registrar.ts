/**
 * @file ipc-registrar.ts
 * @description The fake `ipcMain` registrar shared by the main-process IPC
 * handler suites (ISS-5300).
 *
 * WHY THIS EXISTS. Every `src/main/ipc/*-ipc.ts` module exports a
 * `register*IpcHandlers(ipcMainLike, deps)` that takes only the `handle` slice
 * of Electron's `ipcMain`, so a suite can register the real production handlers
 * against a double and invoke them directly — the same round trip a renderer's
 * `ipcRenderer.invoke` performs. That double had been re-declared inline in 21
 * test files, and `UNTRUSTED_SENDER_ERROR` in 14 more; AGENTS.md requires a
 * nontrivial fixture repeated across files to move to a shared module.
 *
 * It is deliberately NOT `electron-module-stub.ts`'s recording `ipcMain`. That
 * one is a module-level singleton (state bleeds between tests in a file unless
 * reset) and it overwrites on duplicate registration. This one is per-test and
 * mirrors Electron's real behaviour instead: `ipcMain.handle` THROWS on a second
 * handler for the same channel, so a module that registers a channel twice fails
 * here rather than silently collapsing while a channel-set assertion still
 * passes — the app itself would crash at boot. Same contract as the fake in
 * `agent-dashboard-disabled-ipc.test.ts`.
 */

/** The shape Electron passes an `ipcMain.handle` callback. */
export type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

/** The `ipcMain` slice every `register*IpcHandlers` accepts. */
export type IpcRegistrar = {
  handle: (channel: string, listener: IpcHandler) => void;
};

export type IpcRegistrarHarness = {
  /** Pass this as the `ipcMainLike` argument. */
  registrar: IpcRegistrar;
  /** Channels registered so far, in registration order. */
  channels: () => string[];
  /** The handler for `channel`; throws when nothing registered it. */
  handler: (channel: string) => IpcHandler;
  /** Invoke `channel`'s handler. Returns whatever it returns (may be a promise). */
  invoke: (channel: string, event?: unknown, ...args: unknown[]) => unknown;
};

/**
 * A sender the production `isTrustedSender` predicates in these suites reject.
 * Distinct object identity is what makes `(sender) => sender === TRUSTED_SENDER`
 * a real discriminator rather than a constant.
 */
export const UNTRUSTED_SENDER: object = { id: "untrusted" };
export const TRUSTED_SENDER: object = { id: "trusted" };

export const UNTRUSTED_EVENT: { sender: unknown } = {
  sender: UNTRUSTED_SENDER,
};
export const TRUSTED_EVENT: { sender: unknown } = { sender: TRUSTED_SENDER };

/**
 * The message `assertTrustedIpcSender` throws (`src/main/ipc/ipc-trusted-sender.ts`).
 * Module-level so Ultracite's `useTopLevelRegex` stays satisfied.
 */
export const UNTRUSTED_SENDER_ERROR = /untrusted sender/;

/** `isTrustedSender` that accepts only {@link TRUSTED_SENDER}. */
export function isTrustedSenderDouble(sender: unknown): boolean {
  return sender === TRUSTED_SENDER;
}

export function createIpcRegistrar(): IpcRegistrarHarness {
  const handlers = new Map<string, IpcHandler>();
  const order: string[] = [];
  return {
    registrar: {
      handle: (channel, listener) => {
        if (handlers.has(channel)) {
          throw new Error(
            `Attempted to register a second handler for '${channel}'`
          );
        }
        handlers.set(channel, listener);
        order.push(channel);
      },
    },
    channels: () => [...order],
    handler: (channel) => {
      const listener = handlers.get(channel);
      if (!listener) {
        throw new Error(`No handler registered for '${channel}'`);
      }
      return listener;
    },
    invoke: (channel, event = TRUSTED_EVENT, ...args) => {
      const listener = handlers.get(channel);
      if (!listener) {
        throw new Error(`No handler registered for '${channel}'`);
      }
      return listener(event, ...args);
    },
  };
}
