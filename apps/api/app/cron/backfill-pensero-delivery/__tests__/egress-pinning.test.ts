/**
 * ISS-9690: the DAILY CRON is where the credential actually flows, so that is
 * where the egress pin has to hold.
 *
 * ISS-8761's sweep resolves every organization's stored `baseUrl` and fetches
 * it on the `7 6 * * *` schedule with that organization's decrypted Pensero
 * token attached. `isSecureHttpsUrl` cleared that base at write time by reading
 * the literal host string — it never resolves DNS — so a public hostname
 * pointing at `127.0.0.1` or `169.254.169.254` reached this path looking
 * exactly like a legitimate provider. Hardening that covered only an on-demand
 * settings probe would have left this untouched.
 *
 * Everything on the path is production code except the database, the KMS
 * decrypt, and the RESOLVER. `@repo/pensero/delivery-client` is deliberately
 * NOT mocked here — the sibling `service.test.ts` fakes the transport to reach
 * the degraded branches, and a test that did the same could not observe which
 * transport the credential left on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockDnsLookup } = vi.hoisted(() => ({ mockDnsLookup: vi.fn() }));

vi.mock("node:dns", () => ({ lookup: mockDnsLookup }));

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  const mocked = Object.assign(vi.fn(), { tx: vi.fn() });
  return { ...actual, withDb: mocked };
});

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: vi.fn(),
}));

vi.mock("@repo/pensero/keys", () => ({
  keys: () => ({
    PENSERO_API_TOKEN: undefined,
    PENSERO_API_BASE_URL: "https://pensero.operator-configured.example/api",
  }),
}));

vi.mock("@/lib/crypto/kms-secret", () => ({
  KmsSecretPurpose: { PenseroApiToken: "pensero-api-token" },
  decryptSecret: (ciphertext: string) =>
    Promise.resolve(ciphertext.replace("enc:", "")),
}));

import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { EgressBlockReason } from "@repo/pensero/pinned-egress";
import {
  sweepPenseroDeliveryBackfill,
  validatePenseroDeliveryBackfill,
} from "../service";

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-04T09:00:00.000Z");
const ORG_TOKEN = "tk_org:sk_orgsecret";

/** A public host an org admin could store and have accepted at write time. */
const TENANT_HOST = "pensero.tenant-supplied.example";
const TENANT_BASE = `https://${TENANT_HOST}/api`;

const IPV4 = 4;
const INTERNAL_ANSWER = "127.0.0.1";

/** The stored row `resolveOrgPenseroCredential` reads for this organization. */
let storedBaseUrl: string | null = TENANT_BASE;

function makeFakeDb() {
  return {
    penseroIntegration: {
      findMany: () =>
        Promise.resolve([{ organizationId: ORG, teamIdentifiers: [] }]),
      findUnique: () =>
        Promise.resolve({
          apiTokenEncrypted: `enc:${ORG_TOKEN}`,
          baseUrl: storedBaseUrl,
        }),
    },
    // The ledger the SWEEP writes. Empty reads: this organization has never
    // been swept, which is the state a first scheduled run actually sees.
    penseroBackfillDay: {
      findMany: () => Promise.resolve([]),
      upsert: () => Promise.resolve({}),
    },
    penseroBackfillCursor: {
      findMany: () => Promise.resolve([]),
      findUnique: () => Promise.resolve(null),
      upsert: () => Promise.resolve({}),
      updateMany: () => Promise.resolve({ count: 1 }),
    },
    deliveryPoint: {
      findMany: () => Promise.resolve([]),
    },
  };
}

/** Make the mocked resolver answer every name with `address`. */
function answerWith(address: string): void {
  mockDnsLookup.mockImplementation(
    (
      _hostname: string,
      _options: unknown,
      callback: (
        error: Error | null,
        addresses: { address: string; family: number }[]
      ) => void
    ) => {
      callback(null, [{ address, family: IPV4 }]);
    }
  );
}

describe("Pensero backfill cron egress pinning", () => {
  let globalFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    storedBaseUrl = TENANT_BASE;
    const db = makeFakeDb();
    vi.mocked(withDb).mockImplementation((callback) =>
      // The fake models only the two delegates this path reads, not the whole
      // Prisma client — the same shape the sibling `service.test.ts` uses.
      Promise.resolve(callback(db as never))
    );
    // Echoes the window it was asked for, so a quiet day is a quiet day rather
    // than a window mismatch the extractor would reject.
    globalFetch = vi.fn().mockImplementation((url: string | URL) => {
      const query = new URL(String(url)).searchParams;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            start_date: query.get("start_date"),
            end_date: query.get("end_date"),
            users: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    });
    vi.stubGlobal("fetch", globalFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockDnsLookup.mockReset();
  });

  it("refuses the org's stored base when its DNS answer is internal", async () => {
    answerWith(INTERNAL_ANSWER);

    const summary = await validatePenseroDeliveryBackfill({ now: NOW });

    expect(summary.organizationsConsidered).toBe(1);
    expect(summary.organizationsValidated).toBe(0);
    expect(summary.organizationsFailed).toBe(1);
    // The pinned lookup, not the platform's own resolver, is what the cron's
    // socket consulted — a plain `fetch` would never reach this mock.
    expect(mockDnsLookup).toHaveBeenCalledWith(
      TENANT_HOST,
      expect.objectContaining({ all: true }),
      expect.any(Function)
    );
    // The credential never reached a request.
    expect(globalFetch).not.toHaveBeenCalled();
  });

  /**
   * The reason travels: `summarizeFailureReasons` feeds the route's Slack
   * alert. It must name the cause and neither the org's host, the address its
   * DNS answered with, nor any part of the credential.
   */
  it("reports the refusal as the dominant cause without naming the host, the address or the token", async () => {
    answerWith(INTERNAL_ANSWER);

    const summary = await validatePenseroDeliveryBackfill({ now: NOW });
    const reason = summary.organizationFailureSummary?.reason ?? "";

    expect(reason).toContain(EgressBlockReason.InternalAddress);
    for (const forbidden of [
      TENANT_HOST,
      INTERNAL_ANSWER,
      "sk_orgsecret",
      ORG_TOKEN,
    ]) {
      expect(reason).not.toContain(forbidden);
    }
    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain(
      "sk_orgsecret"
    );
  });

  /**
   * THE POSITIVE SIBLING, and the reason `baseUrlSource` is carried across the
   * resolver at all. This organization stores a token but no base URL, so the
   * base falls back to the OPERATOR's `PENSERO_API_BASE_URL` — not tenant
   * input — and must not be pinned, or every self-hosted deployment whose
   * Pensero sits on a private address loses its nightly backfill.
   *
   * If `withOrgPenseroCredential` dropped the source label, this credential
   * would be treated as tenant-supplied, pinned, and refused; the assertion
   * below would fail.
   */
  it("does not pin a base that fell back to the operator's env var", async () => {
    storedBaseUrl = null;
    answerWith(INTERNAL_ANSWER);

    const summary = await validatePenseroDeliveryBackfill({ now: NOW });

    expect(summary.organizationsValidated).toBe(1);
    expect(summary.organizationsFailed).toBe(0);
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(mockDnsLookup).not.toHaveBeenCalled();
  });

  /**
   * THE SCHEDULED RUN, which is a DIFFERENT credential chain from the probe
   * above (review-soul, ISS-9690). `parsePenseroBackfillMode(null)` returns
   * `Sweep`, and Vercel's cron sends no `mode`, so this — not `validate` — is
   * what fires at `7 6 * * *`. The probe calls `fetchDeliverySegment` directly;
   * the sweep threads the credential through `sweepOrganization` → `attemptDay`
   * → `runPenseroDeliveryBackfill` → `fetchDeliverySegment`, and every case in
   * the sibling `service.test.ts` injects `runBackfill` and replaces that whole
   * chain. Nothing else in the suite executes it, so a `baseUrlSource` dropped
   * or hardcoded anywhere along it would be invisible.
   */
  describe("the scheduled sweep, un-injected", () => {
    it("refuses the org's stored base when its DNS answer is internal", async () => {
      answerWith(INTERNAL_ANSWER);

      const summary = await sweepPenseroDeliveryBackfill({ now: NOW });

      expect(summary.daysAttempted).toBeGreaterThan(0);
      expect(summary.daysSucceeded).toBe(0);
      expect(summary.daysFailed).toBe(summary.daysAttempted);
      expect(summary.dayFailureSummary?.reason).toContain(
        EgressBlockReason.InternalAddress
      );
      expect(mockDnsLookup).toHaveBeenCalledWith(
        TENANT_HOST,
        expect.objectContaining({ all: true }),
        expect.any(Function)
      );
      expect(globalFetch).not.toHaveBeenCalled();
    });

    it("does not pin a base that fell back to the operator's env var", async () => {
      storedBaseUrl = null;
      answerWith(INTERNAL_ANSWER);

      const summary = await sweepPenseroDeliveryBackfill({ now: NOW });

      expect(summary.daysSucceeded).toBeGreaterThan(0);
      expect(summary.daysFailed).toBe(0);
      expect(globalFetch).toHaveBeenCalled();
      expect(mockDnsLookup).not.toHaveBeenCalled();
    });
  });
});
