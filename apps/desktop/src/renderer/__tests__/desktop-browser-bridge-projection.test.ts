import { describe, expect, it, vi } from "vitest";
import {
  resolveApiValue,
  selectReadOnlyDesktopApi,
} from "../desktop-browser-bridge-projection";
import {
  cloudRelayFor,
  createHostApiStub,
} from "./desktop-browser-bridge-harness";

// ISS-10696: the projection's refusals and its narrowing of malformed records.
// `desktop-browser-bridge.test.ts` pins the allowlists themselves; this file
// pins what happens to a host that does not satisfy them.

describe("selectReadOnlyDesktopApi refusals", () => {
  it("refuses a host whose cloud read relay is not callable", () => {
    expect(() =>
      selectReadOnlyDesktopApi(createHostApiStub({ cloudApiFetch: "nope" }))
    ).toThrow("Desktop browser bridge cloud read API is missing");
  });

  it("refuses a host with no cloud read relay key at all as an unavailable path", () => {
    const { cloudApiFetch: _cloudApiFetch, ...withoutCloud } =
      createHostApiStub();

    expect(() => selectReadOnlyDesktopApi(withoutCloud)).toThrow(
      "Desktop browser bridge API path is unavailable"
    );
  });

  it("refuses a host whose required read is present but not callable", () => {
    expect(() =>
      selectReadOnlyDesktopApi(createHostApiStub({ getAllFlags: "flags" }))
    ).toThrow("Desktop browser bridge read API is missing: getAllFlags");
  });

  it("refuses a nested required read that is not callable, naming the path", () => {
    const branchesApi = {
      ...(createHostApiStub().branchesApi as Record<string, unknown>),
      pageData: 5,
    };

    expect(() =>
      selectReadOnlyDesktopApi(createHostApiStub({ branchesApi }))
    ).toThrow(
      "Desktop browser bridge read API is missing: branchesApi.pageData"
    );
  });

  it("leaves an optional read absent when the host carries a non-function under its name", () => {
    const agentSessionsApi = {
      ...(createHostApiStub().agentSessionsApi as Record<string, unknown>),
      eventsPage: { stub: true },
    };
    const selected = selectReadOnlyDesktopApi(
      createHostApiStub({ agentSessionsApi })
    ) as { agentSessionsApi: Record<string, unknown> };

    expect(Object.hasOwn(selected.agentSessionsApi, "eventsPage")).toBe(false);
  });
});

describe("cloud read relay", () => {
  it("refuses a request that is not a record with a string path", () => {
    const cloudApiFetch = vi.fn();
    const relay = cloudRelayFor(cloudApiFetch);

    expect(() => relay("/agent-sessions")).toThrow(
      "Desktop browser bridge cloud read is invalid"
    );
    expect(() => relay({ path: 7 })).toThrow(
      "Desktop browser bridge cloud read is invalid"
    );
    expect(cloudApiFetch).not.toHaveBeenCalled();
  });

  it("uppercases an explicit method and relays only a bodiless GET", async () => {
    const cloudApiFetch = vi.fn(() => Promise.resolve({ status: 200 }));
    const relay = cloudRelayFor(cloudApiFetch);

    await expect(
      relay({ method: "get", path: "/agent-sessions" })
    ).resolves.toEqual({ status: 200 });
    expect(cloudApiFetch).toHaveBeenLastCalledWith({
      method: "GET",
      path: "/agent-sessions",
    });

    expect(() => relay({ method: "post", path: "/agent-sessions" })).toThrow(
      "Desktop browser bridge permits cloud reads only"
    );
    expect(() =>
      relay({ body: "{}", method: "GET", path: "/agent-sessions" })
    ).toThrow("Desktop browser bridge permits cloud reads only");
    expect(cloudApiFetch).toHaveBeenCalledTimes(1);
  });
});

describe("settings record projection", () => {
  it("answers null for a settings read that returns no record", async () => {
    await expect(projectedSettings("not-a-record")).resolves.toBeNull();
  });

  it("passes settings through untouched-in-shape when savedConfigs is not an array", async () => {
    await expect(
      projectedSettings({
        activeConfigId: "config-1",
        binaryPaths: { claude: "/usr/local/bin/claude" },
        savedConfigs: "corrupt",
      })
    ).resolves.toEqual({ activeConfigId: "config-1", savedConfigs: "corrupt" });
  });

  it("carries the invite spotlight's seeded answers, which the mirrored renderer reads", async () => {
    // ISS-12135 bug 50: without this key the browser-bridge renderer never sees
    // a vibe profile's answer and re-nudges on every launch.
    await expect(
      projectedSettings({
        binaryPaths: { claude: "/usr/local/bin/claude" },
        inviteSpotlightAnsweredOrganizationIds: ["org_acme"],
      })
    ).resolves.toEqual({
      inviteSpotlightAnsweredOrganizationIds: ["org_acme"],
    });
  });

  it("replaces a saved profile that is not a record with an empty one", async () => {
    await expect(
      projectedSettings({
        savedConfigs: [
          "corrupt",
          { apiKeySource: "keychain", id: "config-2", name: "Second" },
        ],
      })
    ).resolves.toEqual({
      savedConfigs: [{}, { id: "config-2", name: "Second" }],
    });
  });
});

describe("resolveApiValue", () => {
  it("walks own keys only and names the parent of the leaf", () => {
    const leaf = () => undefined;
    const api = { db: { getSessions: leaf } };

    expect(resolveApiValue(api, ["db", "getSessions"])).toEqual({
      parent: api.db,
      value: leaf,
    });
    expect(() => resolveApiValue(api, ["db", "toString"])).toThrow(
      "Desktop browser bridge API path is unavailable"
    );
    expect(() => resolveApiValue(api, ["db", "getSessions", "name"])).toThrow(
      "Desktop browser bridge API path is unavailable"
    );
  });
});

/** What the projection's settings read answers for a host that returns this. */
function projectedSettings(hostSettings: unknown): Promise<unknown> {
  const selected = selectReadOnlyDesktopApi(
    createHostApiStub({ getSettings: () => Promise.resolve(hostSettings) })
  );
  return (selected.getSettings as () => Promise<unknown>)();
}
