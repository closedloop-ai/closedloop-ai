type SignInWindow = {
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  focus: () => void;
};

/** Activate the application as well as its window after browser authorization. */
export function activateAfterSignIn({
  window,
  activateApp,
}: {
  window: SignInWindow | null;
  activateApp: () => void;
}): void {
  if (!window || window.isDestroyed()) {
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  activateApp();
  window.focus();
}
