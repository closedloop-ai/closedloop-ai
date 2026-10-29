"use strict";

/**
 * E2E-only gate for the Branches combined page-data IPC response.
 *
 * Loaded with Electron's `-r` switch only for the requesting spec. The real
 * handler and SQLite reads run first; the gate controls only when each response
 * crosses back to the renderer, matching the timing boundary the UI consumes.
 */

const { ipcMain } = require("electron");

/** `SHARED_BRANCHES_IPC_CHANNELS.pageData`. */
const CHANNEL = "desktop:shared-branches:page-data";
const GATE_KEY = "__clE2eBranchesPageDataGate";

const gate = {
  armed: false,
  skewed: false,
  dispatched: 0,
  settled: 0,
  nextId: 1,
  pending: [],
  requests: [],
  arm() {
    gate.armed = true;
    return gate.dispatched;
  },
  // ISS-8884: stage a newer producer on this same build. Every later response
  // crosses to the renderer with one additive key inside each object the
  // renderer's boundary schema used to reject outright.
  skew() {
    gate.skewed = true;
    return gate.dispatched;
  },
  snapshot() {
    return gate.pending.map(({ id, request }) => ({ id, request }));
  },
  stats() {
    return {
      dispatched: gate.dispatched,
      pending: gate.pending.length,
      requests: gate.requests.map(({ id, request }) => ({ id, request })),
      settled: gate.settled,
    };
  },
  release(id) {
    const entry = takePending(id);
    gate.settled += 1;
    entry.resolve(entry.response);
    return entry.id;
  },
  reject(id) {
    const entry = takePending(id);
    gate.settled += 1;
    entry.reject(new Error("E2E held Branches page-data rejection"));
    return entry.id;
  },
};

globalThis[GATE_KEY] = gate;

const registerHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  if (channel !== CHANNEL) {
    return registerHandler(channel, listener);
  }
  return registerHandler(channel, async (event, ...args) => {
    gate.dispatched += 1;
    const id = gate.nextId;
    gate.nextId += 1;
    gate.requests.push({ id, request: args[0] });
    // Holding is a dispatch-time decision: pre-arm reads may settle later.
    const shouldHold = gate.armed;
    const real = await listener(event, ...args);
    const response = gate.skewed ? withAdditiveServerFields(real) : real;
    if (!shouldHold) {
      gate.settled += 1;
      return response;
    }
    return new Promise((resolve, reject) => {
      gate.pending.push({ id, request: args[0], response, resolve, reject });
    });
  });
};

function takePending(id) {
  const index = gate.pending.findIndex((entry) => entry.id === id);
  if (index < 0) {
    throw new Error(`No held Branches page-data response #${id}`);
  }
  return gate.pending.splice(index, 1)[0];
}

function withAdditiveServerFields(response) {
  const list = response?.list;
  if (!(list?.pageInfo && list.facets?.names)) {
    return response;
  }
  const names = list.facets.names;
  return {
    ...response,
    list: {
      ...list,
      pageInfo: { ...list.pageInfo, generatedBy: "e2e-newer-producer" },
      facets: {
        ...list.facets,
        phases: { availability: names.availability, options: [] },
        names: {
          ...names,
          note: "additive",
          options: names.options.map((option) => ({
            ...option,
            description: "additive",
          })),
        },
      },
    },
  };
}
