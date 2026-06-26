import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, Menu, nativeImage, Tray } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type TrayState = "starting" | "ready" | "degraded" | "error";

export type DesktopTrayHandlers = {
  onOpen?: () => void;
  onManageCommandKeys?: () => void;
  onOpenClaudeDashboard?: () => void;
  onTogglePaused?: (paused: boolean) => void;
};

const TRAY_STATE_TOOLTIP: Record<TrayState, string> = {
  starting: "Starting Symphony Desktop Client",
  ready: "Symphony Desktop Client is ready",
  degraded: "Symphony Desktop Client is running with degraded cloud status",
  error: "Symphony Desktop Client encountered a startup error",
};

export class DesktopTray {
  private tray: Tray | null = null;
  private state: TrayState = "starting";
  private paused = false;
  private pendingApprovals = 0;
  private agentMonitorEnabled = false;
  private handlers: DesktopTrayHandlers = {};

  init(handlers?: DesktopTrayHandlers): void {
    if (this.tray) {
      return;
    }
    this.handlers = handlers ?? {};

    const icon = createTrayIcon(this.pendingApprovals);
    this.tray = new Tray(icon);
    this.setState("starting");
    this.refreshContextMenu();
    this.tray.on("click", () => {
      this.handlers.onOpen?.();
    });
  }

  setState(state: TrayState, details?: string): void {
    this.state = state;
    if (!this.tray) {
      return;
    }

    const message = this.buildTooltip(
      details ?? TRAY_STATE_TOOLTIP[this.state]
    );
    this.tray.setToolTip(message);
    this.refreshContextMenu();
  }

  setPendingApprovals(count: number): void {
    this.pendingApprovals = Math.max(0, count);
    if (!this.tray) {
      return;
    }

    this.tray.setImage(createTrayIcon(this.pendingApprovals));
    if (process.platform === "darwin") {
      this.tray.setTitle(
        this.pendingApprovals > 0
          ? ` ${Math.min(this.pendingApprovals, 99)}`
          : ""
      );
    }
    this.setState(this.state);
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.refreshContextMenu();
  }

  setAgentMonitorEnabled(enabled: boolean): void {
    this.agentMonitorEnabled = enabled;
    this.refreshContextMenu();
  }

  dispose(): void {
    if (!this.tray) {
      return;
    }

    this.tray.destroy();
    this.tray = null;
  }

  private refreshContextMenu(): void {
    if (!this.tray) {
      return;
    }

    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label:
            this.pendingApprovals > 0
              ? `Open Symphony (${this.pendingApprovals} pending)`
              : "Open Symphony",
          click: () => {
            this.handlers.onOpen?.();
          },
        },
        {
          label: "Manage Browser Command Keys",
          click: () => {
            this.handlers.onManageCommandKeys?.();
          },
        },
        ...(this.agentMonitorEnabled
          ? [
              {
                label: "Open Agent Dashboard",
                click: () => {
                  this.handlers.onOpenClaudeDashboard?.();
                },
              },
            ]
          : []),
        {
          label: this.paused ? "Resume" : "Pause",
          click: () => {
            this.setPaused(!this.paused);
            this.handlers.onTogglePaused?.(this.paused);
          },
        },
        { type: "separator" },
        { label: "Quit", role: "quit" },
      ])
    );
  }

  private buildTooltip(base: string): string {
    if (this.pendingApprovals === 0) {
      return base;
    }
    return `${base} | pending approvals: ${this.pendingApprovals}`;
  }
}

function createTrayIcon(_pendingApprovals: number) {
  // On macOS, Electron automatically picks trayIconTemplate.png and trayIconTemplate@2x.png
  // when the filename contains "Template" and setTemplateImage is true.
  const resourcesDir = app.isPackaged
    ? process.resourcesPath
    : path.join(__dirname, "..", "..", "resources");
  const icon = nativeImage.createFromPath(
    path.join(resourcesDir, "trayIconTemplate.png")
  );
  if (process.platform === "darwin") {
    icon.setTemplateImage(true);
  }
  return icon;
}
