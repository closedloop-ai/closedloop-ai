"use strict";

const { ipcRenderer } = require("electron");
const seedChannel = "CLOSEDLOOP_BRIDGE_TAB_LOCAL_STORAGE_SEED";

if (
  process.isMainFrame &&
  location.protocol === "app:" &&
  ipcRenderer.sendSync(seedChannel) === true
) {
  // The production main window is unsandboxed; require the existing writer only
  // after main authorizes this exact first frame. The sidecar keeps its own preload.
  let seed = {};
  let error;
  try {
    require("./bridge-tab-seed-preload.cjs");
    seed = Object.fromEntries(
      Object.keys(JSON.parse(process.env[seedChannel] ?? "{}")).map((key) => [
        key,
        localStorage.getItem(key),
      ])
    );
  } catch (failure) {
    error = String(failure);
  }
  // A synchronous receipt survives renderer mutations and failed-launch cleanup.
  ipcRenderer.sendSync(seedChannel, {
    url: location.href,
    readyState: document.readyState,
    bodyPresent: document.body !== null,
    seed,
    ...(error === undefined ? {} : { error }),
  });
  if (error !== undefined) {
    throw new Error(error);
  }
}
