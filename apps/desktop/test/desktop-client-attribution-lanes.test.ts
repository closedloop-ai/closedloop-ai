/**
 * ISS-8749 (PR #6497 review, chatgpt-codex-connector): the lanes that build
 * their own request must each stamp the client attribution, because a lane that
 * forgets is not visibly different from a Desktop build that predates the
 * header — the attribution is simply absent, and any install/build analysis
 * silently reattributes that traffic to an old build.
 *
 * Two of those lanes compose a `Headers` rather than an object literal, so they
 * cannot use the spread the rest use. This suite covers that helper and the
 * highest-volume of the two — the renderer's cloud-api fetch bridge, which
 * proxies every renderer-originated cl-api request.
 *
 * It also covers the transcript control POST, an object-literal lane whose
 * stamp shares a source line with ISS-8689's `Retry-After` read. That line is a
 * standing merge seam: two changes have already met on it, and resolving it
 * either way reverts one side textually cleanly. `Retry-After` is asserted
 * against production wiring by `desktop-transcripts-client-retry-after.test.ts`;
 * until the case below, the attribution half was not, so deleting the stamp left
 * the whole suite green.
 *
 * A focused sibling suite rather than more cases in an existing one: the lanes
 * here share nothing with any single existing suite's subject.
 */
import assert from "node:assert/strict";
import { DesktopClientAttributionHeader } from "@repo/api/src/types/desktop-client-attribution";
import { afterEach, describe, test } from "vitest";
import { createDesktopTranscriptsClient } from "../src/main/transcript/desktop-transcripts-client.js";
import {
  applyDesktopClientAttribution,
  desktopInstallationId,
  resetDesktopClientAttribution,
  setDesktopClientAttributionResolver,
} from "../src/main/util/desktop-client-attribution-provider.js";
import {
  API_ORIGIN,
  createHarness,
} from "./cloud-api-fetch-ipc-test-harness.js";

const INSTALLATION_ID = "019c26aa-3c11-7bb2-8f04-1d7e5a9c3311";
const CLIENT_VERSION = "1.24.3";

afterEach(() => {
  resetDesktopClientAttribution();
});

describe("applyDesktopClientAttribution", () => {
  test("sets the published attribution on a Headers the caller built", () => {
    setDesktopClientAttributionResolver(() => ({
      installationId: INSTALLATION_ID,
      clientVersion: CLIENT_VERSION,
    }));
    const headers = applyDesktopClientAttribution(
      new Headers({ accept: "application/json" })
    );

    assert.equal(
      headers.get(DesktopClientAttributionHeader.InstallationId),
      INSTALLATION_ID
    );
    assert.equal(
      headers.get(DesktopClientAttributionHeader.ClientVersion),
      CLIENT_VERSION
    );
    assert.equal(headers.get("accept"), "application/json");
  });

  /**
   * Negative control: without it, the assertion above would still pass against
   * a helper that stamped a hardcoded placeholder on every request. An
   * unpublished value is OMITTED, which is the same shape an older Desktop
   * build produces, so the server's absent-value handling is the single path
   * both take.
   */
  test("sets nothing before the composition root publishes", () => {
    const headers = applyDesktopClientAttribution(new Headers());

    assert.equal(
      headers.has(DesktopClientAttributionHeader.InstallationId),
      false
    );
    assert.equal(
      headers.has(DesktopClientAttributionHeader.ClientVersion),
      false
    );
  });

  test("leaves a header the caller already set", () => {
    setDesktopClientAttributionResolver(() => ({
      clientVersion: CLIENT_VERSION,
    }));
    const headers = applyDesktopClientAttribution(
      new Headers({
        [DesktopClientAttributionHeader.ClientVersion]: "9.9.9",
      })
    );

    assert.equal(
      headers.get(DesktopClientAttributionHeader.ClientVersion),
      "9.9.9"
    );
  });
});

describe("cloud-api fetch bridge attribution", () => {
  test("stamps the published attribution on the upstream request", async () => {
    setDesktopClientAttributionResolver(() => ({
      installationId: INSTALLATION_ID,
      clientVersion: CLIENT_VERSION,
    }));
    const { invoke, fetchCalls } = createHarness();

    await invoke({ method: "GET", path: "/agent-sessions" });

    assert.equal(fetchCalls.length, 1);
    const headers = new Headers(fetchCalls[0]?.init.headers);
    assert.equal(
      headers.get(DesktopClientAttributionHeader.InstallationId),
      INSTALLATION_ID
    );
    assert.equal(
      headers.get(DesktopClientAttributionHeader.ClientVersion),
      CLIENT_VERSION
    );
    // The bridge's own credential and origin invariants must survive the merge.
    assert.equal(headers.get("Authorization"), "Bearer real-access-token");
    assert.equal(fetchCalls[0]?.url.origin, API_ORIGIN);
  });

  test("sends no attribution before the composition root publishes", async () => {
    const { invoke, fetchCalls } = createHarness();

    await invoke({ method: "GET", path: "/agent-sessions" });

    const headers = new Headers(fetchCalls[0]?.init.headers);
    assert.equal(
      headers.has(DesktopClientAttributionHeader.InstallationId),
      false
    );
    assert.equal(
      headers.has(DesktopClientAttributionHeader.ClientVersion),
      false
    );
  });
});

/** The smallest `syncPlan` body the client will send; never parsed by the stub. */
const TRANSCRIPT_SYNC_PLAN_REQUEST = {
  computeTargetId: "ct-1",
  externalSessionId: "sess-1",
  fileKey: "main",
  sourceHarness: "claude",
  sourcePathHash: "hash-1",
  sourceMtime: 1000,
  planEndOffset: 100,
} as const;

/**
 * Drive the real transcript client over a stubbed `fetch` and read what came
 * off the wire. The stub answers 503 so the call rejects before any response
 * parsing — the request headers are the whole subject, and `syncPlan`'s
 * response schema is not.
 */
async function syncPlanRequestHeaders(): Promise<Headers> {
  let captured: HeadersInit | undefined;
  const client = createDesktopTranscriptsClient({
    fetch: (_url, init) => {
      captured = init?.headers;
      return Promise.resolve(
        new Response("unavailable", { status: 503 })
      ) as ReturnType<typeof fetch>;
    },
    getAccessToken: () => Promise.resolve("token"),
    getApiOrigin: () => "https://api.test",
  });
  await client
    .syncPlan(
      TRANSCRIPT_SYNC_PLAN_REQUEST as unknown as Parameters<
        ReturnType<typeof createDesktopTranscriptsClient>["syncPlan"]
      >[0]
    )
    .catch(() => undefined);
  return new Headers(captured);
}

describe("transcript control POST attribution", () => {
  test("stamps the published attribution on the control POST", async () => {
    setDesktopClientAttributionResolver(() => ({
      installationId: INSTALLATION_ID,
      clientVersion: CLIENT_VERSION,
    }));

    const headers = await syncPlanRequestHeaders();

    assert.equal(
      headers.get(DesktopClientAttributionHeader.InstallationId),
      INSTALLATION_ID
    );
    assert.equal(
      headers.get(DesktopClientAttributionHeader.ClientVersion),
      CLIENT_VERSION
    );
    // The lane's own credential invariant must survive any future merge here.
    assert.equal(headers.get("Authorization"), "Bearer token");
  });

  test("sends no attribution before the composition root publishes", async () => {
    const headers = await syncPlanRequestHeaders();

    assert.equal(
      headers.has(DesktopClientAttributionHeader.InstallationId),
      false
    );
    assert.equal(
      headers.has(DesktopClientAttributionHeader.ClientVersion),
      false
    );
  });
});

describe("desktopInstallationId (ISS-11838)", () => {
  test("reads the published installation id", () => {
    setDesktopClientAttributionResolver(() => ({
      installationId: INSTALLATION_ID,
      clientVersion: CLIENT_VERSION,
    }));

    assert.equal(desktopInstallationId(), INSTALLATION_ID);
  });

  test("is undefined before publication and when the resolver throws", () => {
    assert.equal(desktopInstallationId(), undefined);

    setDesktopClientAttributionResolver(() => {
      throw new Error("store not ready");
    });
    assert.equal(desktopInstallationId(), undefined);
  });
});
