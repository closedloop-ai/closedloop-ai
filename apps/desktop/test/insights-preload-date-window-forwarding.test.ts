import assert from "node:assert/strict";
import { beforeAll, test, vi } from "vitest";

vi.mock("electron", async () => {
  const stub = await import("./helpers/electron-module-stub.js");
  return { ...stub, default: stub.default };
});

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  const stub = await import("./helpers/electron-module-stub.js");
  return {
    ...actual,
    createRequire: (from: string | URL) => {
      const required = actual.createRequire(from);
      return new Proxy(required, {
        apply: (_target, _thisArg, args: unknown[]) =>
          args[0] === "electron"
            ? stub
            : Reflect.apply(required, undefined, args as [string]),
      });
    },
  };
});

/**
 * ISS-10604 (#7549 review, davetho), narrowed by ISS-10541 — the PRELOAD hop
 * of the local insights read: renderer → `window.desktopApi.db.getInsights` →
 * `ipcRenderer.invoke`.
 *
 * Written for a FOURTH positional argument, the resolved session date basis.
 * ISS-10541 retired that cohort and removed the argument end to end, so the
 * cases pinning it are gone. What survives is the reason the file exists: this
 * bridge otherwise has only channel-NAME coverage
 * (`desktop-db-ipc-channel-parity.test.ts`), and the channel is POSITIONAL with
 * an optional `scope`, so a bridge that shifted an argument sends a
 * valid-looking call the handler misreads.
 *
 * The old version asserted against a locally hand-written 4-parameter type,
 * which is why deleting the argument from the real bridge did not fail to
 * compile. The shape below is deliberately minimal and the arity is asserted at
 * RUNTIME instead, because a cast cannot police what it declares.
 */
const CHANNEL = "desktop:db:get-insights";

type ExposedDesktopApi = {
  db: {
    getInsights: (
      section: string,
      period: string,
      scope?: string
    ) => Promise<unknown>;
  };
};

let invokeArgs: unknown[][];

beforeAll(async () => {
  const stub = await import("./helpers/electron-module-stub.js");
  stub.resetElectronModuleStub();
  await import("../src/main/preload-design-system.js");
  const api = stub.exposedMainWorldApi("desktopApi") as ExposedDesktopApi;
  await api.db.getInsights("utilization", "7", "me");
  invokeArgs = stub.rendererInvokeArgsFor(CHANNEL);
}, 300_000);

test("ISS-10541: the bridge under test was actually reached", () => {
  // The floor: a renamed channel leaves an empty list, which every `deepEqual`
  // below reads as agreement.
  assert.equal(invokeArgs.length, 1);
});

test("ISS-10541: the preload forwards section, period and scope in their own slots", () => {
  // SLOT, not presence. A bridge that dropped `scope` or shifted `period` into
  // it would still invoke the right channel with three plausible strings.
  assert.deepEqual(invokeArgs[0], ["utilization", "7", "me"]);
});

test("ISS-10541: no fourth argument is sent, so no handler can read one", () => {
  // The retirement, asserted rather than assumed. While the basis rode in the
  // fourth slot a renderer could ask the main process for the pre-alignment
  // column; the point of removing it is that it can no longer ask. A bridge
  // that reintroduced a trailing argument — even `undefined` — would give a
  // future handler something to coerce, which is how the cohort comes back.
  assert.equal(invokeArgs[0]?.length, 3);
});

test("ISS-10541: an omitted scope stays omitted rather than shifting", async () => {
  // `scope` is optional and positional, so an omitted one must arrive as
  // `undefined` in its own slot and not pull a later argument forward. Nothing
  // follows it today, which is exactly why a shift would be silent.
  const stub = await import("./helpers/electron-module-stub.js");
  const api = stub.exposedMainWorldApi("desktopApi") as ExposedDesktopApi;
  await api.db.getInsights("agents", "30");
  const calls = stub.rendererInvokeArgsFor(CHANNEL);
  assert.deepEqual(calls.at(-1), ["agents", "30", undefined]);
});
