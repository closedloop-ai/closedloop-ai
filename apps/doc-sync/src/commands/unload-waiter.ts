export function unloadWaiter(
  waiters: Map<string, Set<() => void>>,
  documentName: string
): { promise: Promise<void>; cancel: () => void } {
  let resolveWaiter: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolveWaiter = resolve;
  });
  const forName = waiters.get(documentName) ?? new Set<() => void>();
  forName.add(resolveWaiter);
  waiters.set(documentName, forName);
  return {
    promise,
    cancel: () => {
      forName.delete(resolveWaiter);
      if (forName.size === 0 && waiters.get(documentName) === forName) {
        waiters.delete(documentName);
      }
    },
  };
}

/** True when `unloaded` settles first; on the deadline, cancels the waiter and is false. */
export function raceDeadline(
  unloaded: Promise<void>,
  deadlineMs: number,
  cancel: () => void
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      cancel();
      resolve(false);
    }, deadlineMs);
  });
  return Promise.race([unloaded.then(() => true), deadline]).finally(() =>
    clearTimeout(timer)
  );
}
