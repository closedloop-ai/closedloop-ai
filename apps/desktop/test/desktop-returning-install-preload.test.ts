import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const mainPreloadUrl = new URL(
  "./e2e/helpers/returning-install-seed-main-preload.cjs",
  import.meta.url
);
const framePreloadUrl = new URL(
  "./e2e/helpers/returning-install-seed-frame-preload.cjs",
  import.meta.url
);

/** Execute the shipped CommonJS adapter, rather than scan its source shape. */
function executePreload(file: URL, context: Record<string, unknown>): void {
  new Script(fs.readFileSync(file, "utf8"), {
    filename: file.pathname,
  }).runInNewContext({
    __dirname: path.dirname(file.pathname),
    ...context,
  });
}

function createMainFixture() {
  const app = new EventEmitter();
  const ipcMain = new EventEmitter();
  const registerPreloadScript = vi.fn(() => "owned-seed-registration");
  const unregisterPreloadScript = vi.fn();
  const session = { registerPreloadScript, unregisterPreloadScript };
  const mainFrame = { url: "app://index.html" };
  const contents = Object.assign(new EventEmitter(), {
    mainFrame,
    isDestroyed: () => false,
    getURL: () => mainFrame.url,
    session,
  });
  executePreload(mainPreloadUrl, {
    require: (id: string) => {
      if (id === "node:path") {
        return path;
      }
      if (id === "electron") {
        return { app, ipcMain };
      }
      throw new Error(`Unexpected main preload dependency: ${id}`);
    },
  });
  app.emit("browser-window-created", {}, { webContents: contents });
  const [channel] = ipcMain.eventNames();
  if (channel === undefined) {
    throw new Error("Actual main IPC responder was not installed");
  }
  const replyCounts: number[] = [];
  const request = (
    sender: unknown,
    senderFrame: unknown,
    readback?: unknown
  ) => {
    const replies: unknown[] = [];
    const event = { sender, senderFrame };
    // Electron sends the first assignment immediately; it is not a mutable field.
    Object.defineProperty(event, "returnValue", {
      set: (value: unknown) => {
        replies.push(value);
      },
    });
    ipcMain.emit(channel, event, readback);
    replyCounts.push(replies.length);
    return replies[0];
  };
  return {
    app,
    ipcMain,
    contents,
    channel,
    request,
    replyCounts,
    registerPreloadScript,
    unregisterPreloadScript,
  };
}

describe("returning-install main preload frame ownership", () => {
  it("sends exactly one synchronous reply for an accepted claim and a denied replay", () => {
    const fixture = createMainFixture();
    expect(fixture.request(fixture.contents, fixture.contents.mainFrame)).toBe(
      true
    );
    expect(fixture.request(fixture.contents, fixture.contents.mainFrame)).toBe(
      false
    );
    expect(fixture.replyCounts).toEqual([1, 1]);
    fixture.app.emit("will-quit");
  });

  it("keeps the intended app claim through initial blank DOM readiness", () => {
    const fixture = createMainFixture();
    fixture.contents.mainFrame.url = "about:blank";
    fixture.contents.emit("dom-ready");
    expect(fixture.unregisterPreloadScript).not.toHaveBeenCalled();
    expect(fixture.request(fixture.contents, fixture.contents.mainFrame)).toBe(
      false
    );
    fixture.contents.mainFrame.url = "app://index.html";
    expect(fixture.request(fixture.contents, fixture.contents.mainFrame)).toBe(
      true
    );
    expect(fixture.unregisterPreloadScript).toHaveBeenCalledTimes(1);
    fixture.contents.emit("dom-ready");
    expect(fixture.request(fixture.contents, fixture.contents.mainFrame)).toBe(
      false
    );
    fixture.app.emit("will-quit");
    expect(fixture.unregisterPreloadScript).toHaveBeenCalledTimes(1);
    expect(fixture.contents.listenerCount("dom-ready")).toBe(0);
  });

  it("denies sibling, child, missing and non-app frames without consuming the intended main-frame claim", () => {
    const fixture = createMainFixture();
    const sibling = {
      mainFrame: { url: "app://index.html" },
      session: fixture.contents.session,
    };
    expect(fixture.request(sibling, sibling.mainFrame)).toBe(false);
    expect(fixture.request(fixture.contents, { url: "app://index.html" })).toBe(
      false
    );
    expect(fixture.request(fixture.contents, null)).toBe(false);
    fixture.contents.mainFrame.url = "about:blank";
    expect(fixture.request(fixture.contents, fixture.contents.mainFrame)).toBe(
      false
    );
    expect(fixture.unregisterPreloadScript).not.toHaveBeenCalled();
    fixture.contents.mainFrame.url = "app://index.html";
    expect(fixture.request(fixture.contents, fixture.contents.mainFrame)).toBe(
      true
    );
    expect(fixture.registerPreloadScript).toHaveBeenCalledExactlyOnceWith({
      type: "frame",
      filePath: path.join(
        path.dirname(mainPreloadUrl.pathname),
        "returning-install-seed-frame-preload.cjs"
      ),
    });
    expect(fixture.unregisterPreloadScript).toHaveBeenCalledExactlyOnceWith(
      "owned-seed-registration"
    );
  });

  it("denies second claims and queued sibling requests while retaining a responder until exit", () => {
    const fixture = createMainFixture();
    expect(fixture.request(fixture.contents, fixture.contents.mainFrame)).toBe(
      true
    );
    expect(fixture.request(fixture.contents, fixture.contents.mainFrame)).toBe(
      false
    );
    fixture.contents.emit("dom-ready");
    const sibling = { mainFrame: { url: "app://index.html" } };
    expect(fixture.request(sibling, sibling.mainFrame)).toBe(false);
    expect(fixture.ipcMain.listenerCount(fixture.channel)).toBe(1);
    fixture.contents.emit("destroyed");
    fixture.app.emit("will-quit");
    expect(fixture.unregisterPreloadScript).toHaveBeenCalledTimes(1);
    expect(fixture.ipcMain.listenerCount(fixture.channel)).toBe(0);
    expect(fixture.contents.listenerCount("dom-ready")).toBe(0);
    expect(fixture.contents.listenerCount("destroyed")).toBe(0);
  });

  it.each(["dom-ready", "destroyed"])(
    "disposes an unclaimed seed on %s without granting a late request",
    (event) => {
      const fixture = createMainFixture();
      fixture.contents.emit(event);
      expect(
        fixture.request(fixture.contents, fixture.contents.mainFrame)
      ).toBe(false);
      fixture.app.emit("will-quit");
      expect(fixture.unregisterPreloadScript).toHaveBeenCalledExactlyOnceWith(
        "owned-seed-registration"
      );
      expect(fixture.ipcMain.listenerCount(fixture.channel)).toBe(0);
    }
  );

  it("does not install another seed for a subsequent same-session window", () => {
    const fixture = createMainFixture();
    fixture.app.emit(
      "browser-window-created",
      {},
      { webContents: fixture.contents }
    );
    expect(fixture.registerPreloadScript).toHaveBeenCalledTimes(1);
    fixture.app.emit("will-quit");
  });
});

function executeFrame(
  isMainFrame: boolean,
  protocol: string,
  authorized: boolean
) {
  const sendSync = vi.fn(() => authorized);
  const writer = vi.fn();
  executePreload(framePreloadUrl, {
    process: { isMainFrame, env: {} },
    location: { protocol, href: "app://index.html" },
    document: { readyState: "loading", body: null },
    require: (id: string) => {
      if (id === "electron") {
        return { ipcRenderer: { sendSync } };
      }
      if (id === "./bridge-tab-seed-preload.cjs") {
        return writer();
      }
      throw new Error(`Unexpected frame preload dependency: ${id}`);
    },
  });
  return { sendSync, writer };
}

describe("returning-install frame adapter invokes the shared writer", () => {
  it.each([
    { isMainFrame: false, protocol: "app:" },
    { isMainFrame: true, protocol: "https:" },
  ])(
    "does not request or seed an ineligible frame: $isMainFrame/$protocol",
    ({ isMainFrame, protocol }) => {
      const fixture = executeFrame(isMainFrame, protocol, true);
      expect(fixture.sendSync).not.toHaveBeenCalled();
      expect(fixture.writer).not.toHaveBeenCalled();
    }
  );

  it("does not invoke the writer for a denied app main frame", () => {
    const fixture = executeFrame(true, "app:", false);
    expect(fixture.sendSync).toHaveBeenCalledTimes(1);
    expect(fixture.writer).not.toHaveBeenCalled();
  });

  it("invokes the exact existing writer only for an authorized app main frame", () => {
    const fixture = executeFrame(true, "app:", true);
    expect(fixture.sendSync).toHaveBeenCalledTimes(2);
    expect(fixture.sendSync).toHaveBeenLastCalledWith(
      "CLOSEDLOOP_BRIDGE_TAB_LOCAL_STORAGE_SEED",
      {
        url: "app://index.html",
        readyState: "loading",
        bodyPresent: false,
        seed: {},
      }
    );
    expect(fixture.writer).toHaveBeenCalledTimes(1);
  });
});
