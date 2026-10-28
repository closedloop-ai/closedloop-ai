/** Signal-cancellable timeout used by the native browser-sign-in callback race. */
export function defaultDesktopSessionTimeout(
  ms: number,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
      },
      { once: true }
    );
  });
}
