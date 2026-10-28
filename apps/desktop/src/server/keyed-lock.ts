/**
 * Per-key FIFO serialization for async work (ISS-6132, ISS-11414).
 *
 * A synchronous child process on the Electron main thread made every sequence
 * of git or shell steps mutually exclusive by accident: no second gateway
 * request could run until the child exited. Moving those steps to async child
 * processes removes that accidental lock, so a sequence that must not
 * interleave with another one on the same resource (a worktree directory, a
 * repository's refs, a deploy install) takes an explicit lock here instead.
 *
 * Operations on one key run one at a time in arrival order; a failed operation
 * releases the key for the next one. The map entry is removed once the last
 * queued operation settles, so the map never grows past the keys in use.
 *
 * Reentrant within one holder: code running inside `operation` (and awaited by
 * it) that asks for the same key again runs at once instead of queueing behind
 * itself, so a sequence can hold a key across a helper that also locks it.
 * Work the holder leaves running after it returns is not the holder any more
 * and queues like everyone else.
 */
import { AsyncLocalStorage } from "node:async_hooks";

type HeldKey = {
  locks: Map<string, Promise<void>>;
  key: string;
  released: boolean;
};

const heldKeys = new AsyncLocalStorage<readonly HeldKey[]>();

export async function withKeyedLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const held = heldKeys.getStore() ?? [];
  if (held.some((h) => h.locks === locks && h.key === key && !h.released)) {
    return await operation();
  }
  const hold: HeldKey = { locks, key, released: false };
  const run = (): Promise<T> =>
    heldKeys.run([...held, hold], async () => {
      try {
        return await operation();
      } finally {
        hold.released = true;
      }
    });
  const predecessor = locks.get(key) ?? Promise.resolve();
  const result = predecessor.then(run, run);
  const settled = result.then(
    () => undefined,
    () => undefined
  );
  locks.set(key, settled);
  try {
    return await result;
  } finally {
    if (locks.get(key) === settled) {
      locks.delete(key);
    }
  }
}
