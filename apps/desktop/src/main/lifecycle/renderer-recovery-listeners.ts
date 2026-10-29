import { app, powerMonitor } from "electron";

/** Own the process-wide recovery listeners for exactly one renderer generation. */
export class RendererRecoveryListeners {
  private resumeHandler: (() => void) | null = null;
  private childProcessGoneHandler:
    | ((event: Electron.Event, details: Electron.Details) => void)
    | null = null;

  install(checkFrame: () => void): void {
    this.dispose();
    this.resumeHandler = checkFrame;
    powerMonitor?.on("resume", checkFrame);
    this.childProcessGoneHandler = (_event, details) => {
      if (details.type === "GPU") {
        checkFrame();
      }
    };
    app.on("child-process-gone", this.childProcessGoneHandler);
  }

  dispose(): void {
    if (this.resumeHandler) {
      powerMonitor?.off("resume", this.resumeHandler);
      this.resumeHandler = null;
    }
    if (this.childProcessGoneHandler) {
      app.off("child-process-gone", this.childProcessGoneHandler);
      this.childProcessGoneHandler = null;
    }
  }
}
