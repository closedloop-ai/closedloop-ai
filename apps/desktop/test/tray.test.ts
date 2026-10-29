import type { MenuItemConstructorOptions } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => {
  const buildFromTemplate = vi.fn(
    (template: readonly MenuItemConstructorOptions[]) => template
  );
  const createFromPath = vi.fn(() => ({ setTemplateImage: vi.fn() }));
  const trayInstances: Array<{
    destroy: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    setContextMenu: ReturnType<typeof vi.fn>;
    setImage: ReturnType<typeof vi.fn>;
    setTitle: ReturnType<typeof vi.fn>;
    setToolTip: ReturnType<typeof vi.fn>;
  }> = [];

  class Tray {
    readonly destroy = vi.fn();
    readonly on = vi.fn();
    readonly setContextMenu = vi.fn();
    readonly setImage = vi.fn();
    readonly setTitle = vi.fn();
    readonly setToolTip = vi.fn();

    constructor() {
      trayInstances.push(this);
    }
  }

  return { buildFromTemplate, createFromPath, Tray, trayInstances };
});

vi.mock("electron", () => ({
  app: { isPackaged: false },
  Menu: { buildFromTemplate: electronMocks.buildFromTemplate },
  nativeImage: { createFromPath: electronMocks.createFromPath },
  Tray: electronMocks.Tray,
}));

import { DesktopTray } from "../src/main/tray.js";

describe("DesktopTray open action", () => {
  beforeEach(() => {
    electronMocks.buildFromTemplate.mockClear();
    electronMocks.createFromPath.mockClear();
    electronMocks.trayInstances.length = 0;
  });

  it("opens only from the Open ClosedLoop menu action", () => {
    const onOpen = vi.fn();
    const tray = new DesktopTray();

    tray.init({ onOpen });

    const nativeTray = electronMocks.trayInstances[0];
    expect(nativeTray).toBeDefined();
    expect(nativeTray?.on).not.toHaveBeenCalled();

    const template = latestMenuTemplate();
    expect(template[0]?.label).toBe("Open ClosedLoop");
    expect(onOpen).not.toHaveBeenCalled();

    template[0]?.click?.({} as never, {} as never, {} as never);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("keeps the ClosedLoop label when pending approvals are shown", () => {
    const tray = new DesktopTray();
    tray.init();

    tray.setPendingApprovals(3);

    expect(latestMenuTemplate()[0]?.label).toBe("Open ClosedLoop (3 pending)");
  });
});

function latestMenuTemplate(): readonly MenuItemConstructorOptions[] {
  const call = electronMocks.buildFromTemplate.mock.calls.at(-1);
  if (!call) {
    throw new Error("Tray menu was not built");
  }
  return call[0];
}
