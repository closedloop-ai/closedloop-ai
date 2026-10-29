import { app, dialog } from "electron";
import { createCrashDialogPresenter } from "./crash-dialog-presenter.js";

/**
 * ISS-12135: the one `dialog.showErrorBox` in the main process. Every
 * fatal-error box goes through here so an off-screen test launch writes it to
 * stderr instead of raising a native modal (see `crash-dialog-presenter.ts`);
 * `test/native-error-box-wiring.test.ts` fails a direct call elsewhere.
 */
export const showNativeErrorBox = createCrashDialogPresenter({
  argv: process.argv,
  isPackaged: app.isPackaged,
  showErrorBox: (title, body) => dialog.showErrorBox(title, body),
  writeStderr: (text) => {
    process.stderr.write(text);
  },
});
