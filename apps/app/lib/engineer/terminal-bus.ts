/**
 * Terminal status EventBus — send status messages to the terminal window
 * from anywhere in the app.
 *
 * Usage:
 *   import { terminalBus } from "@/lib/engineer/terminal-bus";
 *   terminalBus.send("Deploying to staging...");
 *   terminalBus.send("3 files changed", { prefix: "git" });
 *   terminalBus.send("@daniel connected", { typewriter: true });
 */

export type TerminalMessage = {
  text: string;
  prefix?: string;
  typewriter?: boolean;
  /** If set, message stays visible until cleared via `terminalBus.clear(id)`. */
  persistId?: string;
};

type Listener = (message: TerminalMessage) => void;

const listeners = new Set<Listener>();

type ClearListener = (persistId: string) => void;
const clearListeners = new Set<ClearListener>();

/** Send a status message to the terminal window. */
function send(
  text: string,
  options?: { prefix?: string; typewriter?: boolean; persistId?: string }
) {
  const message: TerminalMessage = {
    text,
    prefix: options?.prefix,
    typewriter: options?.typewriter,
    persistId: options?.persistId,
  };
  for (const listener of listeners) {
    listener(message);
  }
}

/** Clear a persistent message by its ID. */
function clear(persistId: string) {
  for (const listener of clearListeners) {
    listener(persistId);
  }
}

/** Subscribe to new messages. Returns an unsubscribe function. */
function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe to clear events. Returns an unsubscribe function. */
function onClear(listener: ClearListener): () => void {
  clearListeners.add(listener);
  return () => {
    clearListeners.delete(listener);
  };
}

export const terminalBus = { send, clear, subscribe, onClear };
