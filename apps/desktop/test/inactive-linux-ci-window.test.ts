import { describe, expect, it, vi } from "vitest";
import {
  type InactiveLinuxCiContext,
  mapInactiveLinuxCiWindow,
  mapInactiveWindow,
  selectInactiveLinuxCiMapping,
} from "./e2e/helpers/inactive-linux-ci-window.js";

type MappingWindow = Parameters<typeof mapInactiveWindow>[0];

function createWindow() {
  let visible = false;
  let focused = false;
  let modal = false;
  let destroyed = false;
  const bounds = { x: 260, y: 140, width: 1400, height: 800 };
  const window: MappingWindow = {
    getBounds: () => ({ ...bounds }),
    isDestroyed: () => destroyed,
    isFocused: () => focused,
    isModal: () => modal,
    isVisible: () => visible,
    showInactive: vi.fn(() => {
      visible = true;
    }),
    webContents: { backgroundThrottling: false },
  };
  return {
    window,
    bounds,
    setVisible: () => {
      visible = true;
    },
    setFocused: () => {
      focused = true;
    },
    setModal: () => {
      modal = true;
    },
    setDestroyed: () => {
      destroyed = true;
    },
  };
}

describe("explicit inactive Linux CI window mapping", () => {
  it("maps the existing window without changing focus, bounds or throttling", () => {
    const fixture = createWindow();
    mapInactiveWindow(fixture.window);
    expect(fixture.window.showInactive).toHaveBeenCalledOnce();
    expect(fixture.window.isVisible()).toBe(true);
    expect(fixture.window.isFocused()).toBe(false);
    expect(fixture.window.getBounds()).toEqual(fixture.bounds);
    expect(fixture.window.webContents.backgroundThrottling).toBe(false);
  });

  it.each(["setVisible", "setFocused", "setModal", "setDestroyed"] as const)(
    "refuses an incompatible %s precondition before showing",
    (change) => {
      const fixture = createWindow();
      fixture[change]();
      expect(() => mapInactiveWindow(fixture.window)).toThrow();
      expect(fixture.window.showInactive).not.toHaveBeenCalled();
    }
  );

  it("refuses a throttled hidden renderer before showing", () => {
    const fixture = createWindow();
    fixture.window.webContents.backgroundThrottling = true;
    expect(() => mapInactiveWindow(fixture.window)).toThrow();
    expect(fixture.window.showInactive).not.toHaveBeenCalled();
  });

  it("propagates the actual showInactive failure", () => {
    const fixture = createWindow();
    const failure = new Error("native mapping failed");
    fixture.window.showInactive = () => {
      throw failure;
    };
    expect(() => mapInactiveWindow(fixture.window)).toThrow(failure);
  });

  it("rejects a mapping that activates the window", () => {
    const fixture = createWindow();
    fixture.window.showInactive = () => {
      fixture.setVisible();
      fixture.setFocused();
    };
    expect(() => mapInactiveWindow(fixture.window)).toThrow();
  });

  it("rejects a mapping that changes bounds", () => {
    const fixture = createWindow();
    fixture.window.showInactive = () => {
      fixture.setVisible();
      fixture.bounds.width += 1;
    };
    expect(() => mapInactiveWindow(fixture.window)).toThrow();
  });
});

function createContext(
  platform: NodeJS.Platform = "linux",
  env: InactiveLinuxCiContext["env"] = { CI: "true", DISPLAY: ":99" }
): InactiveLinuxCiContext {
  return { platform, env };
}

function createApplication() {
  const fixture = createWindow();
  const handle = {
    evaluate: vi.fn((callback: typeof mapInactiveWindow) =>
      Promise.resolve(callback(fixture.window))
    ),
    dispose: vi.fn(() => Promise.resolve()),
  };
  const app = { browserWindow: vi.fn(() => Promise.resolve(handle)) };
  const page = { fixtureId: "synthetic-page" };
  return { ...fixture, app, page, handle };
}

const invalidMappingContexts: {
  name: string;
  context: InactiveLinuxCiContext;
}[] = [
  { name: "macOS", context: createContext("darwin") },
  { name: "Windows", context: createContext("win32") },
  { name: "CI absent", context: createContext("linux", { DISPLAY: ":99" }) },
  {
    name: "CI false",
    context: createContext("linux", { CI: "false", DISPLAY: ":99" }),
  },
  {
    name: "CI numeric",
    context: createContext("linux", { CI: "1", DISPLAY: ":99" }),
  },
  {
    name: "CI case mismatch",
    context: createContext("linux", { CI: "TRUE", DISPLAY: ":99" }),
  },
  { name: "DISPLAY absent", context: createContext("linux", { CI: "true" }) },
  {
    name: "DISPLAY empty",
    context: createContext("linux", { CI: "true", DISPLAY: "" }),
  },
  {
    name: "Wayland present",
    context: createContext("linux", {
      CI: "true",
      DISPLAY: ":99",
      WAYLAND_DISPLAY: "wayland-0",
    }),
  },
];

describe("mapping wrapper eligibility and handle ownership", () => {
  it("defaults to no mapping without reaching Electron", async () => {
    const fixture = createApplication();
    await mapInactiveLinuxCiWindow(fixture.app, fixture.page);
    expect(fixture.app.browserWindow).not.toHaveBeenCalled();
  });

  it.each(invalidMappingContexts)(
    "explicit false skips $name without validation or mapping",
    async ({ context }) => {
      const fixture = createApplication();
      await mapInactiveLinuxCiWindow(fixture.app, fixture.page, false, context);
      expect(fixture.app.browserWindow).not.toHaveBeenCalled();
    }
  );

  it.each(invalidMappingContexts)(
    "explicit true rejects $name before reaching Electron",
    async ({ context }) => {
      const fixture = createApplication();
      await expect(
        mapInactiveLinuxCiWindow(fixture.app, fixture.page, true, context)
      ).rejects.toThrow(
        "Inactive mapping requires the owned Linux CI Xvfb path"
      );
      expect(fixture.app.browserWindow).not.toHaveBeenCalled();
    }
  );

  it.each([
    { name: "Xvfb", context: createContext() },
    {
      name: "empty Wayland",
      context: createContext("linux", {
        CI: "true",
        DISPLAY: ":99",
        WAYLAND_DISPLAY: "",
      }),
    },
    {
      name: "PWDEBUG stays caller-owned",
      context: createContext("linux", {
        CI: "true",
        DISPLAY: ":99",
        PWDEBUG: "1",
      }),
    },
  ])(
    "executes the real window decision once and disposes for $name",
    async ({ context }) => {
      const fixture = createApplication();
      await mapInactiveLinuxCiWindow(fixture.app, fixture.page, true, context);
      expect(fixture.app.browserWindow).toHaveBeenCalledExactlyOnceWith(
        fixture.page
      );
      expect(fixture.handle.evaluate).toHaveBeenCalledExactlyOnceWith(
        mapInactiveWindow
      );
      expect(fixture.window.showInactive).toHaveBeenCalledOnce();
      expect(fixture.handle.dispose).toHaveBeenCalledOnce();
    }
  );

  it("preserves mapping failure and disposes the acquired handle", async () => {
    const fixture = createApplication();
    const failure = new Error("native mapping failed");
    fixture.window.showInactive = () => {
      throw failure;
    };
    await expect(
      mapInactiveLinuxCiWindow(fixture.app, fixture.page, true, createContext())
    ).rejects.toThrow(failure);
    expect(fixture.handle.dispose).toHaveBeenCalledOnce();
  });
});

const callerSelectionContexts: {
  name: string;
  context: InactiveLinuxCiContext;
  expected: boolean;
}[] = [
  { name: "Linux CI", context: createContext(), expected: true },
  { name: "macOS", context: createContext("darwin"), expected: false },
  { name: "Windows", context: createContext("win32"), expected: false },
  { name: "CI absent", context: createContext("linux", {}), expected: false },
  {
    name: "CI false",
    context: createContext("linux", { CI: "false" }),
    expected: false,
  },
  {
    name: "CI numeric",
    context: createContext("linux", { CI: "1" }),
    expected: false,
  },
  {
    name: "debug",
    context: createContext("linux", { CI: "true", PWDEBUG: "1" }),
    expected: false,
  },
  {
    name: "debug zero is present",
    context: createContext("linux", { CI: "true", PWDEBUG: "0" }),
    expected: false,
  },
  {
    name: "debug empty",
    context: createContext("linux", { CI: "true", PWDEBUG: "" }),
    expected: true,
  },
  {
    name: "DISPLAY remains wrapper-owned",
    context: createContext("linux", { CI: "true" }),
    expected: true,
  },
  {
    name: "Wayland remains wrapper-owned",
    context: createContext("linux", {
      CI: "true",
      DISPLAY: ":99",
      WAYLAND_DISPLAY: "wayland-0",
    }),
    expected: true,
  },
];

describe("consumer opt-in selection", () => {
  it.each(callerSelectionContexts)(
    "preserves the exact existing caller selection for $name",
    ({ context, expected }) => {
      expect(selectInactiveLinuxCiMapping(context, true)).toBe(expected);
      expect(selectInactiveLinuxCiMapping(context, false)).toBe(false);
      expect(selectInactiveLinuxCiMapping(context)).toBe(false);
    }
  );
});
