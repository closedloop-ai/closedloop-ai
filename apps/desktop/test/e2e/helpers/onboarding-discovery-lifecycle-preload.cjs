"use strict";

// ISS-10539: hold the zero-progress boot window at the main-process IPC boundary.
// Real handlers run first; preload, polling, dialog, and guest machine stay real.
const { ipcMain } = require("electron");
const gate = { started: false };
globalThis.__clE2eOnboardingDiscovery = gate;
const registerHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  if (
    channel !== "desktop:get-runtime-status" &&
    channel !== "desktop:get-onboarding-local-state"
  ) {
    return registerHandler(channel, listener);
  }
  return registerHandler(channel, async (event, ...args) => {
    const response = await listener(event, ...args);
    if (channel === "desktop:get-runtime-status") {
      return {
        ...response,
        ingest: {
          byHarness: gate.started
            ? [{ harness: "claude", total: 950, processed: 0 }]
            : [],
          complete: false,
          preparing: !gate.started,
          processed: 0,
          total: gate.started ? 950 : 0,
        },
      };
    }
    return {
      ...response,
      contractVersion: 2,
      inventory: {
        status: "measured",
        inventoryRevision: 1,
        parseCompleteness: "complete",
        uploadCompleteness: "complete",
        physicalBytes: 9500,
        attributableRawBytes: 9500,
        discoveredBytes: 9500,
        eligibleParseBytes: 9500,
        excludedBytes: 0,
        enumeratedHarnesses: ["claude"],
        evidence: [{ harness: "claude", outcome: "measured" }],
        sessionsByHarness: [{ harness: "claude", sessionCount: 950 }],
      },
      analysisEta: {
        contractVersion: 1,
        inventoryRevision: 1,
        kind: "calculating",
      },
    };
  });
};
