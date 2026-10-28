import { describe, expect, test } from "vitest";
import {
  buildConnectSrc,
  enforcesContentSecurityPolicy,
  shouldEnableContentSecurityPolicy,
} from "../content-security-policy";

// Origins written independently of the policy under test. `52hf33zy5` /
// `gm12y2fpf` are real per-deployment Vercel alias shapes; the whole point is
// that no build-time value can contain them.
const STAGE_PREVIEW_STREAM =
  "https://api-stage-52hf33zy5.preview.stage.example/compute-targets/status-stream";
const PROD_PREVIEW_STREAM =
  "https://api-prod-gm12y2fpf.preview.stage.example/compute-targets/status-stream";
const STAGE_API_URL = "https://api.stage.example";
const PROD_API_URL = "https://api.closedloop.ai";
// The app's OWN preview alias — the host `resolveApiOrigin` rewrites away FROM,
// never the one it derives.
const APP_PREVIEW_STREAM =
  "https://app-stage-52hf33zy5.preview.stage.example/compute-targets/status-stream";
// Preview aliases that sit OUTSIDE the stage preview parent. Each is a shape a
// future "just let previews through" change would reach for.
const VERCEL_ALIAS_STREAM =
  "https://api-stage-52hf33zy5.vercel.app/compute-targets/status-stream";
const PROD_DOMAIN_PREVIEW_STREAM =
  "https://api-prod-gm12y2fpf.preview.closedloop.ai/compute-targets/status-stream";
const FOREIGN_PREVIEW_STREAM =
  "https://api-stage-52hf33zy5.preview.example.com/compute-targets/status-stream";
// Written out, not imported: a fence that reads its expectation out of the
// module it polices moves with that module and cannot fail.
const STAGE_PREVIEW_HOST_SOURCE = "https://*.preview.stage.example";
const UNRELATED_STREAM =
  "https://evil.example.com/compute-targets/status-stream";
const SUFFIX_LOOKALIKE_STREAM =
  "https://api-stage-52hf33zy5.preview.stage.example.evil.example.com/compute-targets/status-stream";
const ELECTRON_HOSTNAMES = ["http://localhost:19432"];
const REALTIME_SOCKET_ORIGIN = "wss://realtime.closedloop.ai";
const REALTIME_SOCKET_HANDSHAKE =
  "wss://realtime.closedloop.ai/realtime/?EIO=4&transport=websocket";
const DOC_SYNC_SOCKET_ORIGIN = "wss://doc-sync.closedloop.test";
const DOC_SYNC_DOCUMENT_SOCKET =
  "wss://doc-sync.closedloop.test/org-1:artifact:PRD-1";

const WILDCARD_PREFIX = "*.";

/**
 * Minimal CSP host-source matcher, written from CSP3 §6.6.2.6 rather than from
 * the directive it polices — a check that read its expectation out of
 * `buildConnectSrc` could not fail. Matches scheme, host and port; paths are
 * ignored, since admission here is decided by origin.
 */
function admitsOrigin(source: string, targetUrl: string): boolean {
  const target = new URL(targetUrl);
  const separator = source.indexOf("://");
  if (separator === -1) {
    return false;
  }
  if (`${source.slice(0, separator)}:` !== target.protocol) {
    return false;
  }

  const authority = source.slice(separator + "://".length).split("/")[0] ?? "";
  const portSeparator = authority.lastIndexOf(":");
  const host =
    portSeparator === -1 ? authority : authority.slice(0, portSeparator);
  const port = portSeparator === -1 ? "" : authority.slice(portSeparator + 1);
  if (port !== target.port) {
    return false;
  }

  if (host.startsWith(WILDCARD_PREFIX)) {
    const suffix = host.slice(WILDCARD_PREFIX.length - 1);
    return (
      target.hostname.endsWith(suffix) && target.hostname.length > suffix.length
    );
  }
  return target.hostname === host;
}

function connectSrcAdmits(sources: string[], targetUrl: string): boolean {
  return sources.some((source) => admitsOrigin(source, targetUrl));
}

const stageConnectSrc = () =>
  buildConnectSrc({
    apiUrl: STAGE_API_URL,
    environment: "stage",
    gaMeasurementId: undefined,
    electronHostnames: ELECTRON_HOSTNAMES,
  });

const prodConnectSrc = () =>
  buildConnectSrc({
    apiUrl: PROD_API_URL,
    environment: "prod",
    gaMeasurementId: undefined,
    electronHostnames: ELECTRON_HOSTNAMES,
  });

// Identical inputs, one classification away from the allowance, so the
// difference against `stageConnectSrc()` is exactly what the stage branch adds.
const stageInputsWithoutAllowance = () =>
  buildConnectSrc({
    apiUrl: STAGE_API_URL,
    environment: "prod",
    gaMeasurementId: undefined,
    electronHostnames: ELECTRON_HOSTNAMES,
  });

describe("connect-src admits the compute-target status stream (ISS-7218)", () => {
  test("stage admits the per-deployment preview API origin the client streams from", () => {
    expect(connectSrcAdmits(stageConnectSrc(), STAGE_PREVIEW_STREAM)).toBe(
      true
    );
  });

  test("stage still admits its own configured API origin", () => {
    expect(
      connectSrcAdmits(
        stageConnectSrc(),
        `${STAGE_API_URL}/compute-targets/status-stream`
      )
    ).toBe(true);
  });

  test("stage stays constrained: unrelated and suffix-lookalike origins refused", () => {
    expect(connectSrcAdmits(stageConnectSrc(), UNRELATED_STREAM)).toBe(false);
    expect(connectSrcAdmits(stageConnectSrc(), SUFFIX_LOOKALIKE_STREAM)).toBe(
      false
    );
  });

  // Refusal here depends on the `preview.` label specifically, so broadening
  // the source by even one label (`https://*.stage.example`) flips it.
  // Without these, a wildcard as wide as `https://*.ai` passes the suite.
  test("stage admits only the preview label, not the whole stage domain", () => {
    expect(
      connectSrcAdmits(
        stageConnectSrc(),
        "https://app.stage.example/compute-targets/status-stream"
      )
    ).toBe(false);
    expect(
      connectSrcAdmits(
        stageConnectSrc(),
        "https://api-stage-52hf33zy5.notpreview.stage.example/compute-targets/status-stream"
      )
    ).toBe(false);
  });

  // `getAppEnvironment` returns "stage" for an unclassifiable deployment too,
  // so a production deployment whose env vars fail to classify must still not
  // pick up the wildcard.
  test("a deployment classified stage but serving the production API gets no preview allowance", () => {
    const misclassifiedProd = buildConnectSrc({
      apiUrl: PROD_API_URL,
      environment: "stage",
      gaMeasurementId: undefined,
      electronHostnames: ELECTRON_HOSTNAMES,
    });
    expect(connectSrcAdmits(misclassifiedProd, STAGE_PREVIEW_STREAM)).toBe(
      false
    );
    expect(
      connectSrcAdmits(
        misclassifiedProd,
        `${PROD_API_URL}/compute-targets/status-stream`
      )
    ).toBe(true);
  });

  test("production admits its own API origin", () => {
    expect(
      connectSrcAdmits(
        prodConnectSrc(),
        `${PROD_API_URL}/compute-targets/status-stream`
      )
    ).toBe(true);
  });

  test("production admits no preview alias — its connect-src is not widened", () => {
    expect(connectSrcAdmits(prodConnectSrc(), STAGE_PREVIEW_STREAM)).toBe(
      false
    );
    expect(connectSrcAdmits(prodConnectSrc(), PROD_PREVIEW_STREAM)).toBe(false);
    expect(connectSrcAdmits(prodConnectSrc(), UNRELATED_STREAM)).toBe(false);
  });

  test("local and preview deployments get no preview allowance either", () => {
    for (const environment of ["local", "preview"] as const) {
      const sources = buildConnectSrc({
        apiUrl: STAGE_API_URL,
        environment,
        gaMeasurementId: undefined,
        electronHostnames: ELECTRON_HOSTNAMES,
      });
      expect(connectSrcAdmits(sources, STAGE_PREVIEW_STREAM)).toBe(false);
    }
  });

  test("Google Analytics sources appear only for an ID GA would mount under", () => {
    const withGa = buildConnectSrc({
      apiUrl: PROD_API_URL,
      environment: "prod",
      gaMeasurementId: "G-TEST123",
      electronHostnames: [],
    });
    expect(
      connectSrcAdmits(withGa, "https://www.google-analytics.com/g/collect")
    ).toBe(true);
    expect(
      connectSrcAdmits(
        prodConnectSrc(),
        "https://www.google-analytics.com/g/collect"
      )
    ).toBe(false);
  });

  test("Electron gateway hostnames stay in the allowlist", () => {
    expect(
      connectSrcAdmits(prodConnectSrc(), "http://localhost:19432/me")
    ).toBe(true);
  });

  // ISS-7475: CSP_EXTRA_CONNECT_SRC (presigned S3/R2 bucket origins) rides in
  // through extraSources; omitting it must contribute nothing.
  test("extraSources appear when provided and only then", () => {
    const withExtras = buildConnectSrc({
      apiUrl: PROD_API_URL,
      environment: "prod",
      gaMeasurementId: undefined,
      electronHostnames: [],
      extraSources: ["https://bucket.s3.us-east-1.amazonaws.com"],
    });
    expect(
      connectSrcAdmits(
        withExtras,
        "https://bucket.s3.us-east-1.amazonaws.com/object"
      )
    ).toBe(true);
    expect(
      connectSrcAdmits(
        prodConnectSrc(),
        "https://bucket.s3.us-east-1.amazonaws.com/object"
      )
    ).toBe(false);
  });

  // ISS-11210 requirement 11: the realtime socket's origin rides in through
  // realtimeUrl (REALTIME_PUBLIC_URL); omitting it must contribute nothing.
  test("the realtime socket origin appears when provided and only then", () => {
    const withRealtime = buildConnectSrc({
      apiUrl: PROD_API_URL,
      environment: "prod",
      gaMeasurementId: undefined,
      electronHostnames: [],
      realtimeUrl: `${REALTIME_SOCKET_ORIGIN}/realtime`,
    });
    // The origin exactly, not the URL it came from: a path in a CSP source
    // narrows it to that path.
    expect(
      withRealtime.filter((source) => !prodConnectSrc().includes(source))
    ).toEqual([REALTIME_SOCKET_ORIGIN]);
    expect(connectSrcAdmits(withRealtime, REALTIME_SOCKET_HANDSHAKE)).toBe(
      true
    );
    expect(connectSrcAdmits(prodConnectSrc(), REALTIME_SOCKET_HANDSHAKE)).toBe(
      false
    );
    expect(
      connectSrcAdmits(withRealtime, "https://realtime.closedloop.ai/realtime/")
    ).toBe(false);
  });

  // PLN-2189 T-4.1: the document sync socket's origin rides in through
  // docSyncUrl (DOC_SYNC_PUBLIC_URL); omitting it must contribute nothing.
  test("the doc-sync socket origin appears when provided and only then", () => {
    const withDocSync = buildConnectSrc({
      apiUrl: PROD_API_URL,
      environment: "prod",
      gaMeasurementId: undefined,
      electronHostnames: [],
      docSyncUrl: `${DOC_SYNC_SOCKET_ORIGIN}/`,
    });
    expect(
      withDocSync.filter((source) => !prodConnectSrc().includes(source))
    ).toEqual([DOC_SYNC_SOCKET_ORIGIN]);
    expect(connectSrcAdmits(withDocSync, DOC_SYNC_DOCUMENT_SOCKET)).toBe(true);
    expect(connectSrcAdmits(prodConnectSrc(), DOC_SYNC_DOCUMENT_SOCKET)).toBe(
      false
    );
  });
});

/**
 * whitlockk, PR #5556: the source admits more than the single host
 * `resolveApiOrigin` derives. It does, and CSP host-source grammar is why — a
 * wildcard stands for a WHOLE leftmost label (CSP3 §6.6.2.6 `host-part`), so
 * `https://api-stage-*.preview.stage.example` is not expressible and
 * `api-stage-…` cannot be told apart from `api-prod-…` or `app-…` inside the
 * directive. Vercel aliases the production API project's deployments under that
 * same parent (`api-prod-gm12y2fpf.preview.stage.example`, the shape
 * `scripts/deploy/resolve-db-health-url.test.ts` uses), so those hosts are
 * admitted too, on stage — where, since ISS-8437, the policy enforces, so
 * these are the sources actually permitted rather than merely un-reported.
 *
 * That breadth is accepted rather than accidental, and these tests are its
 * fence: they pin exactly what the stage branch contributes and exactly what it
 * must never reach, so a later change cannot grow it into a general
 * preview-domain allowlist while the suite stays green. Narrowing it for real
 * needs the per-request API origin rather than a build-time directive
 * (ISS-7499); a deliberate narrowing is expected to rewrite these.
 */
describe("the stage preview allowance's breadth is fenced (ISS-7218)", () => {
  test("the stage branch contributes exactly one source, the preview parent", () => {
    const baseline = stageInputsWithoutAllowance();
    const added = stageConnectSrc().filter(
      (source) => !baseline.includes(source)
    );

    expect(added).toEqual([STAGE_PREVIEW_HOST_SOURCE]);
  });

  test("accepted breadth: sibling preview hosts the app never derives are admitted", () => {
    expect(connectSrcAdmits(stageConnectSrc(), PROD_PREVIEW_STREAM)).toBe(true);
    expect(connectSrcAdmits(stageConnectSrc(), APP_PREVIEW_STREAM)).toBe(true);
  });

  test("no preview alias outside the stage preview parent is admitted", () => {
    for (const origin of [
      VERCEL_ALIAS_STREAM,
      PROD_DOMAIN_PREVIEW_STREAM,
      FOREIGN_PREVIEW_STREAM,
    ]) {
      expect(connectSrcAdmits(stageConnectSrc(), origin)).toBe(false);
    }
  });
});

describe("shouldEnableContentSecurityPolicy", () => {
  test("enabled on a production deployment (real prod or stage)", () => {
    expect(shouldEnableContentSecurityPolicy("true", "production")).toBe(true);
  });

  test("enabled when VERCEL_ENV is unset (e.g. local with CSP on)", () => {
    expect(shouldEnableContentSecurityPolicy("true", undefined)).toBe(true);
  });

  test("disabled on a preview deployment even when CSP_ENABLED=true (FEA-1466)", () => {
    expect(shouldEnableContentSecurityPolicy("true", "preview")).toBe(false);
  });

  test("disabled when CSP_ENABLED is not 'true'", () => {
    expect(shouldEnableContentSecurityPolicy("false", "production")).toBe(
      false
    );
    expect(shouldEnableContentSecurityPolicy(undefined, "production")).toBe(
      false
    );
  });
});

// The stage API origin with no subdomain. Every other fixture here is a
// subdomain, which exercises only the `endsWith` half of the host test — this
// is the bare-domain equality half.
const STAGE_API_URL_BARE_DOMAIN = "https://stage.example";
// Written out rather than derived: a host that ENDS in the stage domain's
// characters without ending in a `.`-prefixed label of it.
const STAGE_DOMAIN_LOOKALIKE_API_URL = "https://api.evilstage.example";
// The stage domain as a PREFIX of someone else's host.
const STAGE_DOMAIN_SUFFIXED_API_URL = "https://api.stage.example.evil.example";
// Request hosts, written out rather than imported from the modules under test
// for the same reason as every other fixture here. `app.closedloop.ai` is the
// canonical prod host; the second is the shape Vercel aliases each prod
// deployment under, and the one `resolveApiOrigin` rewrites into an
// `api-prod-*` origin prod's `connect-src` does not carry.
const PROD_APP_HOST = "app.closedloop.ai";
const PROD_ALIAS_APP_HOST = "app-prod-gm12y2fpf.preview.stage.example";
const STAGE_APP_HOST = "app.stage.example";
const STAGE_ALIAS_APP_HOST = "app-stage-52hf33zy5.preview.stage.example";

describe("enforcesContentSecurityPolicy (ISS-8437)", () => {
  test("stage enforces on its configured API subdomain", () => {
    expect(
      enforcesContentSecurityPolicy(STAGE_API_URL, "stage", STAGE_APP_HOST)
    ).toBe(true);
  });

  test("stage enforces on the bare stage domain too", () => {
    expect(
      enforcesContentSecurityPolicy(
        STAGE_API_URL_BARE_DOMAIN,
        "stage",
        STAGE_APP_HOST
      )
    ).toBe(true);
  });

  test("production enforces on its own label, whatever API origin it carries", () => {
    expect(
      enforcesContentSecurityPolicy(PROD_API_URL, "prod", PROD_APP_HOST)
    ).toBe(true);
    // The prod arm deliberately does not corroborate against the API origin
    // the way the stage arm does: `"prod"` is never a fallback, so the label
    // is already the positive signal.
    expect(
      enforcesContentSecurityPolicy(STAGE_API_URL, "prod", PROD_APP_HOST)
    ).toBe(true);
  });

  test("a prod API origin mislabelled stage still does not enforce", () => {
    expect(
      enforcesContentSecurityPolicy(PROD_API_URL, "stage", PROD_APP_HOST)
    ).toBe(false);
  });

  test("neither preview nor local enforces on the stage API origin", () => {
    expect(
      enforcesContentSecurityPolicy(STAGE_API_URL, "preview", STAGE_APP_HOST)
    ).toBe(false);
    expect(
      enforcesContentSecurityPolicy(STAGE_API_URL, "local", STAGE_APP_HOST)
    ).toBe(false);
  });

  test("a host that only resembles the stage domain does not enforce", () => {
    expect(
      enforcesContentSecurityPolicy(
        STAGE_DOMAIN_LOOKALIKE_API_URL,
        "stage",
        STAGE_APP_HOST
      )
    ).toBe(false);
    expect(
      enforcesContentSecurityPolicy(
        STAGE_DOMAIN_SUFFIXED_API_URL,
        "stage",
        STAGE_APP_HOST
      )
    ).toBe(false);
  });
});

/**
 * The prod arm is fenced to the canonical host because ONE prod build answers
 * on two of them, and only one has its browser-derived API origin in
 * `connect-src` (whitlockk, PR #6312). Enforcing on the Vercel deployment alias
 * would block the app-wide API client — `resolveApiOrigin` rewrites that host
 * `app-*` → `api-*`, and prod's `connect-src` carries no
 * `*.preview.stage.example` source, deliberately.
 *
 * The stage arm carries no such fence, and that asymmetry is the contract:
 * stage's `connect-src` DOES admit the preview parent, so its alias-derived
 * origin is already permitted and enforcing there breaks nothing.
 */
describe("prod enforcement is fenced to the canonical host (PR #6312)", () => {
  test("the prod deployment alias reports rather than enforces", () => {
    expect(
      enforcesContentSecurityPolicy(PROD_API_URL, "prod", PROD_ALIAS_APP_HOST)
    ).toBe(false);
  });

  test("no prod host other than the canonical one enforces", () => {
    for (const host of ["", "app.closedloop.ai.evil.example", "localhost"]) {
      expect(enforcesContentSecurityPolicy(PROD_API_URL, "prod", host)).toBe(
        false
      );
    }
  });

  test("stage is NOT fenced — its alias still enforces", () => {
    expect(
      enforcesContentSecurityPolicy(
        STAGE_API_URL,
        "stage",
        STAGE_ALIAS_APP_HOST
      )
    ).toBe(true);
  });
});
