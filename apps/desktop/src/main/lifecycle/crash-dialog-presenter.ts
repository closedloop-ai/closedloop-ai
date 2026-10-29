import { isWindowRevealSuppressed } from "./window-reveal-suppression.js";

/**
 * ISS-12135: how a fatal-error box reaches the person at the machine.
 *
 * `dialog.showErrorBox` is a native modal that appears whether or not the
 * window was revealed, and it blocks the exit that follows it until someone
 * dismisses it. A launch that keeps its window off screen (an unpackaged
 * `--e2e-no-reveal` test launch) therefore writes the box to stderr instead, so
 * a test or probe that crashes fails without putting a modal on a shared
 * machine's screen. Every other launch shows the box unchanged.
 */
export type CrashDialogPresenterDeps = {
  argv: readonly string[];
  isPackaged: boolean;
  showErrorBox: (title: string, body: string) => void;
  writeStderr: (text: string) => void;
};

export type CrashDialogPresenter = (title: string, body: string) => void;

export function createCrashDialogPresenter(
  deps: CrashDialogPresenterDeps
): CrashDialogPresenter {
  if (isWindowRevealSuppressed(deps.argv, { isPackaged: deps.isPackaged })) {
    return (title, body) => deps.writeStderr(`${title}\n${body}\n`);
  }
  return deps.showErrorBox;
}
