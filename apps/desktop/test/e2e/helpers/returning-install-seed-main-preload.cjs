"use strict";

const path = require("node:path");
const { app, ipcMain } = require("electron");

// Test-only IPC reuses the existing seed-contract name; no production handler changes.
const seedChannel = "CLOSEDLOOP_BRIDGE_TAB_LOCAL_STORAGE_SEED";

app.once("browser-window-created", (_event, window) => {
  const contents = window.webContents;
  const session = contents.session;
  const ownership = { targetWebContentsId: contents.id, events: [] };
  globalThis.__returningInstallSeedOwnership = ownership;
  const record = (entry) => {
    if (ownership.events.length < 32) {
      ownership.events.push(entry);
    }
  };
  let active = true;
  let claimed = false;
  let id;
  const unregisterSeed = () => {
    if (id !== undefined) {
      const registeredId = id;
      id = undefined;
      session.unregisterPreloadScript(registeredId);
    }
  };
  const authorizeSeed = (event, readback) => {
    record({
      kind: "request",
      active,
      claimed,
      senderWebContentsId: event.sender.id,
      targetFrame: event.senderFrame === contents.mainFrame,
      frameUrl: event.senderFrame?.url,
      readback: readback !== undefined,
    });
    if (
      active &&
      claimed &&
      readback !== undefined &&
      event.sender === contents &&
      event.senderFrame === contents.mainFrame &&
      globalThis.__returningInstallSeedReceipt === undefined
    ) {
      globalThis.__returningInstallSeedReceipt = readback;
      event.returnValue = true;
      return;
    }
    if (
      active &&
      !claimed &&
      event.sender === contents &&
      event.senderFrame === contents.mainFrame &&
      event.senderFrame.url.startsWith("app://")
    ) {
      claimed = true;
      unregisterSeed();
      event.returnValue = true;
      return;
    }
    event.returnValue = false;
  };
  ipcMain.on(seedChannel, authorizeSeed);
  id = session.registerPreloadScript({
    type: "frame",
    filePath: path.join(__dirname, "returning-install-seed-frame-preload.cjs"),
  });
  record({ kind: "registered", id });
  contents.on("preload-error", (_event, preloadPath, error) => {
    record({ kind: "preload-error", preloadPath, error: String(error) });
  });
  const dispose = () => {
    record({
      kind: "dispose",
      url: contents.isDestroyed() ? null : contents.getURL(),
      claimed,
    });
    active = false;
    contents.removeListener("dom-ready", onDomReady);
    contents.removeListener("destroyed", dispose);
    unregisterSeed();
  };
  // The initial blank document can settle while protocol registration is pending.
  const onDomReady = () => {
    if (contents.getURL().startsWith("app://")) {
      dispose();
    }
  };
  contents.on("dom-ready", onDomReady);
  contents.once("destroyed", dispose);
  // A sibling may have snapshotted the preload before unregister. Keep answering
  // false until exit rather than leave its synchronous request without a receiver.
  app.once("will-quit", () => {
    dispose();
    ipcMain.removeListener(seedChannel, authorizeSeed);
  });
});
