/**
 * ISS-8761 — THE TEST THIS TICKET EXISTS FOR.
 *
 * `runPenseroDeliveryBackfill` shipped complete and with zero production
 * callers. An organization could store a Pensero credential, watch the settings
 * card confirm it, and never receive a single delivery point. Proving the
 * backfill "works" in isolation is what the previous suite already did, and it
 * stayed green through the entire outage — the defect was the missing wiring.
 *
 * So this suite drives the PRODUCTION TRIGGER: the cron route's `GET`, through
 * the real service, the real day planner, the real ledger, the real backfill,
 * the real interaction join, the real matcher and the real store, and asserts
 * that delivery-point rows land in the database. Only the network and KMS are
 * faked. Deleting the route's `sweepPenseroDeliveryBackfill(...)` call fails
 * these tests rather than leaving them green.
 */

import fixture from "@repo/pensero/__tests__/fixtures/pensero-delivery-hazards.fixture.json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must precede all imports
// ---------------------------------------------------------------------------

const { mockFetchDeliverySegment, mockNotifySlack, mockEmitTelemetryMetric } =
  vi.hoisted(() => ({
    mockFetchDeliverySegment: vi.fn(),
    mockNotifySlack: vi.fn().mockResolvedValue(undefined),
    mockEmitTelemetryMetric: vi.fn(),
  }));

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  const mocked = Object.assign(vi.fn(), { tx: vi.fn() });
  return { ...actual, withDb: mocked };
});

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mockEmitTelemetryMetric,
}));

// Only the TRANSPORT is faked. The payload still goes through the real
// extractor below, so the stub cannot drift from what the client would produce.
vi.mock("@repo/pensero/delivery-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@repo/pensero/delivery-client")>();
  return { ...actual, fetchDeliverySegment: mockFetchDeliverySegment };
});

vi.mock("@repo/pensero/keys", () => ({
  keys: () => ({
    PENSERO_API_TOKEN: undefined,
    PENSERO_API_BASE_URL: undefined,
  }),
}));

vi.mock("@/lib/crypto/kms-secret", () => ({
  KmsSecretPurpose: { PenseroApiToken: "pensero-api-token" },
  decryptSecret: (ciphertext: string) =>
    Promise.resolve(ciphertext.replace("enc:", "")),
}));

vi.mock("@/lib/slack-notifier", () => ({
  notifySlack: mockNotifySlack,
  buildCorrelationId: () => "ts=2026-08-04T00:00:00.000Z",
}));

vi.mock("@/lib/route-utils", () => ({
  scheduleLogFlush: vi.fn(),
  scheduleLogFlushAfter: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { DeliveryMatchOutcome, withDb } from "@repo/database";
import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { extractDeliverySegment } from "@repo/pensero/delivery-extractor";
import { PenseroBackfillMode } from "@/app/cron/backfill-pensero-delivery/mode";
import { GET } from "@/app/cron/backfill-pensero-delivery/route";

const CRON_SECRET = "test-cron-secret-iss8761";

/** The fixture's own delivery day, so the "today" lane fetches real rows. */
const TODAY = new Date("2026-08-04T09:00:00.000Z");
const TODAY_DAY = "2026-08-04";

const ORG = "11111111-1111-4111-8111-111111111111";
/** A second tenant, colliding on every identity the matcher joins on. */
const FOREIGN_ORG = "22222222-2222-4222-8222-222222222222";

const ORG_TOKEN = "tk_org_one:sk_org_one";
const FOREIGN_TOKEN = "tk_org_two:sk_org_two";

const KNOWN_USERS = [
  {
    id: "user-daveth",
    email: "Daveth.Oakhurst@ClosedLoop.ai",
    organizationId: ORG,
  },
  {
    id: "user-marisol",
    email: "marisol.ashgrove@closedloop.ai",
    organizationId: ORG,
  },
  {
    id: "user-foreign-daveth",
    email: "daveth.oakhurst@closedloop.ai",
    organizationId: FOREIGN_ORG,
  },
];

const KNOWN_PULL_REQUESTS = [
  {
    id: "prd-4228",
    repositoryFullName: "closedloop-ai/closedloop-ai",
    number: 4228,
    artifactId: "art-pr-4228",
    branchArtifactId: "art-branch-4228",
    organizationId: ORG,
  },
  // The SAME repository and number in the other tenant. If the sweep leaked one
  // org's credential or dropped an org predicate, this row is what surfaces it.
  {
    id: "prd-foreign-4228",
    repositoryFullName: "closedloop-ai/closedloop-ai",
    number: 4228,
    artifactId: "art-foreign-pr-4228",
    branchArtifactId: "art-foreign-branch-4228",
    organizationId: FOREIGN_ORG,
  },
];

const KNOWN_LINKS = [
  {
    sourceId: "art-branch-4228",
    targetId: "art-iss-4881",
    organizationId: ORG,
  },
];

const KNOWN_ARTIFACTS = [
  { id: "art-iss-4884", slug: "ISS-4884", organizationId: ORG },
];

type UpsertedPoint = {
  organizationId: string;
  providerItemId: string;
  matchOutcome: DeliveryMatchOutcome;
  personEmail: string;
  userId: string | null;
  repositoryFullName: string | null;
  pullRequestNumber: number | null;
  pullRequestDetailId: string | null;
  branchArtifactId: string | null;
};

type LedgerRow = {
  organizationId: string;
  day: string;
  lastAttemptAt: Date;
  lastSuccessAt: Date | null;
  lastFailureReason: string | null;
  attemptCount: number;
  lastRowsWritten: number;
};

type CursorRow = {
  organizationId: string;
  backwardCursor: Date | null;
  recheckCursor: Date | null;
};

/** The whole fake database, so a test can read what production actually wrote. */
let deliveryPoints: UpsertedPoint[] = [];
let ledger: LedgerRow[] = [];
let cursors: CursorRow[] = [];
let integrations: {
  organizationId: string;
  apiTokenEncrypted: string;
  baseUrl: string | null;
  teamIdentifiers: string[];
}[] = [];
/** Every credential handed to the transport, so leakage is observable. */
let requestedCredentials: { token: string; day: string }[] = [];

/**
 * Model Prisma, not wishful thinking: a `where` carrying NO `organizationId`
 * returns EVERY tenant's row rather than none, so a dropped predicate fails the
 * cross-tenant assertions for the right reason.
 */
function inOrg(rowOrganizationId: string, whereOrganizationId?: string) {
  return (
    whereOrganizationId === undefined ||
    rowOrganizationId === whereOrganizationId
  );
}

function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function makeFakeDb() {
  return {
    penseroIntegration: {
      findMany: () =>
        Promise.resolve(
          integrations.map((row) => ({
            organizationId: row.organizationId,
            teamIdentifiers: row.teamIdentifiers,
          }))
        ),
      findUnique: ({ where }: { where: { organizationId: string } }) =>
        Promise.resolve(
          integrations.find(
            (row) => row.organizationId === where.organizationId
          ) ?? null
        ),
    },
    penseroBackfillDay: {
      findMany: ({ where }: { where: { organizationId?: string } }) =>
        Promise.resolve(
          ledger
            .filter((row) => inOrg(row.organizationId, where.organizationId))
            .sort((a, b) => a.day.localeCompare(b.day))
            .map((row) => ({ day: new Date(`${row.day}T00:00:00.000Z`) }))
        ),
      upsert: (args: {
        where: { organizationId_day: { organizationId: string; day: Date } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const { organizationId, day } = args.where.organizationId_day;
        const key = isoDay(day);
        const existing = ledger.find(
          (row) => row.organizationId === organizationId && row.day === key
        );
        if (existing) {
          const update = args.update as Record<string, unknown>;
          existing.lastAttemptAt = update.lastAttemptAt as Date;
          existing.attemptCount += 1;
          if ("lastSuccessAt" in update) {
            existing.lastSuccessAt = update.lastSuccessAt as Date;
            existing.lastRowsWritten = update.lastRowsWritten as number;
          }
          existing.lastFailureReason =
            (update.lastFailureReason as string | null) ?? null;
          return Promise.resolve(existing);
        }
        const create = args.create as Record<string, unknown>;
        const row: LedgerRow = {
          organizationId,
          day: key,
          lastAttemptAt: create.lastAttemptAt as Date,
          lastSuccessAt: (create.lastSuccessAt as Date | null) ?? null,
          lastFailureReason:
            (create.lastFailureReason as string | null) ?? null,
          attemptCount: create.attemptCount as number,
          lastRowsWritten: create.lastRowsWritten as number,
        };
        ledger.push(row);
        return Promise.resolve(row);
      },
    },
    penseroBackfillCursor: {
      // Feeds the least-recently-swept sweep ordering (#6492). Every fixture
      // here starts with no cursor rows, so every org is "never swept" and the
      // organizationId tiebreak keeps the order these cases already assert.
      findMany: () =>
        Promise.resolve(
          cursors.map((row) => ({
            organizationId: row.organizationId,
            updatedAt: new Date(0),
          }))
        ),
      findUnique: ({ where }: { where: { organizationId: string } }) =>
        Promise.resolve(
          cursors.find((row) => row.organizationId === where.organizationId) ??
            null
        ),
      upsert: (args: {
        where: { organizationId: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const existing = cursors.find(
          (row) => row.organizationId === args.where.organizationId
        );
        if (existing) {
          // Only the fields the UPDATE names — `backwardCursor` moves solely
          // through the guarded `updateMany`, exactly as in production.
          const next = args.update as { recheckCursor?: Date | null };
          if ("recheckCursor" in next) {
            existing.recheckCursor = next.recheckCursor ?? null;
          }
          return Promise.resolve(existing);
        }
        const created = args.create as unknown as CursorRow;
        cursors.push({ ...created });
        return Promise.resolve(created);
      },
      // Models the MONOTONIC guard and its predicate, so a cursor assertion
      // cannot pass against a fake that ignores the condition.
      updateMany: (args: {
        where: {
          organizationId: string;
          OR: [{ backwardCursor: null }, { backwardCursor: { gt: Date } }];
        };
        data: { backwardCursor: Date };
      }) => {
        const existing = cursors.find(
          (row) => row.organizationId === args.where.organizationId
        );
        const threshold = args.where.OR[1].backwardCursor.gt;
        if (
          existing &&
          (existing.backwardCursor === null ||
            existing.backwardCursor > threshold)
        ) {
          existing.backwardCursor = args.data.backwardCursor;
          return Promise.resolve({ count: 1 });
        }
        return Promise.resolve({ count: 0 });
      },
    },
    user: {
      findMany: ({
        where,
      }: {
        where: { organizationId?: string; OR: { email: { equals: string } }[] };
      }) => {
        const wanted = new Set(
          where.OR.map((clause) => clause.email.equals.toLowerCase())
        );
        return Promise.resolve(
          KNOWN_USERS.filter(
            (user) =>
              inOrg(user.organizationId, where.organizationId) &&
              wanted.has(user.email.toLowerCase())
          )
        );
      },
    },
    pullRequestDetail: {
      findMany: ({
        where,
      }: {
        where: {
          organizationId?: string;
          OR: { repositoryFullName: string; number: number }[];
        };
      }) =>
        Promise.resolve(
          KNOWN_PULL_REQUESTS.filter(
            (pr) =>
              inOrg(pr.organizationId, where.organizationId) &&
              where.OR.some(
                (clause) =>
                  clause.repositoryFullName === pr.repositoryFullName &&
                  clause.number === pr.number
              )
          )
        ),
    },
    artifactLink: {
      findMany: ({
        where,
      }: {
        where: {
          organizationId?: string;
          OR: [{ sourceId: { in: string[] } }, { targetId: { in: string[] } }];
        };
      }) => {
        const seeds = new Set([
          ...where.OR[0].sourceId.in,
          ...where.OR[1].targetId.in,
        ]);
        return Promise.resolve(
          KNOWN_LINKS.filter(
            (link) =>
              inOrg(link.organizationId, where.organizationId) &&
              (seeds.has(link.sourceId) || seeds.has(link.targetId))
          )
        );
      },
    },
    artifact: {
      findMany: ({
        where,
      }: {
        where: { organizationId?: string; slug: { in: string[] } };
      }) =>
        Promise.resolve(
          KNOWN_ARTIFACTS.filter(
            (artifact) =>
              inOrg(artifact.organizationId, where.organizationId) &&
              where.slug.in.includes(artifact.slug)
          )
        ),
    },
    deliveryPoint: {
      findMany: () => Promise.resolve([]),
      upsert: (args: {
        where: {
          organizationId_provider_providerItemId: {
            organizationId: string;
            providerItemId: string;
          };
        };
        create: Record<string, unknown>;
      }) => {
        deliveryPoints.push(args.create as unknown as UpsertedPoint);
        const { organizationId, providerItemId } =
          args.where.organizationId_provider_providerItemId;
        return Promise.resolve({
          id: `dp-${organizationId}-${providerItemId}`,
        });
      },
    },
    deliveryPointArtifact: {
      deleteMany: () => Promise.resolve({ count: 0 }),
      createMany: ({ data }: { data: unknown[] }) =>
        Promise.resolve({ count: data.length }),
    },
  };
}

/**
 * The transport stub. It records the credential it was handed — the only way a
 * cross-tenant credential leak is observable from outside the resolver — and
 * serves the fixture for the fixture's own day, an empty window otherwise.
 */
function transportStub(options: {
  startDate: string;
  endDate: string;
  credential?: { token: string };
  teamIdentifiers?: readonly string[];
}) {
  requestedCredentials.push({
    token: options.credential?.token ?? "<env>",
    day: options.endDate,
  });
  const payload =
    options.endDate === TODAY_DAY
      ? fixture
      : {
          start_date: options.startDate,
          end_date: options.endDate,
          users: [],
        };
  return Promise.resolve({
    segment: extractDeliverySegment(payload),
    completeness: "unverified" as const,
    continuationKeysSeen: [] as string[],
  });
}

/** Every message the route actually posted, so a clean call cannot hide a dirty one. */
function slackMessages(): string[] {
  return mockNotifySlack.mock.calls.map((call) => call[0].message);
}

function makeRequest(token = CRON_SECRET, query = ""): Request {
  return new Request(
    `http://localhost/api/cron/backfill-pensero-delivery${query}`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    }
  );
}

let previousCronSecret: string | undefined;

beforeEach(() => {
  previousCronSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = CRON_SECRET;

  vi.useFakeTimers();
  vi.setSystemTime(TODAY);

  deliveryPoints = [];
  ledger = [];
  cursors = [];
  requestedCredentials = [];
  integrations = [
    {
      organizationId: ORG,
      apiTokenEncrypted: `enc:${ORG_TOKEN}`,
      baseUrl: null,
      teamIdentifiers: [],
    },
  ];

  vi.clearAllMocks();
  mockNotifySlack.mockResolvedValue(undefined);
  mockFetchDeliverySegment.mockImplementation(transportStub);

  const db = makeFakeDb();
  vi.mocked(withDb).mockImplementation((callback) =>
    Promise.resolve(callback(db as never))
  );
  vi.mocked(withDb.tx).mockImplementation((callback) =>
    Promise.resolve(callback(db as never))
  );
});

afterEach(() => {
  vi.useRealTimers();
  if (previousCronSecret === undefined) {
    Reflect.deleteProperty(process.env, "CRON_SECRET");
  } else {
    process.env.CRON_SECRET = previousCronSecret;
  }
});

describe("GET /cron/backfill-pensero-delivery", () => {
  it("AC8: delivery points actually reach the database for a configured org", async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    // The whole ticket in one assertion: rows exist because a CRON RAN, not
    // because a test called the backfill directly.
    expect(deliveryPoints.length).toBeGreaterThan(0);
    expect(deliveryPoints.every((row) => row.organizationId === ORG)).toBe(
      true
    );

    // And they are MATCHED rows carrying our own pull request, so the run went
    // all the way through join → match → attach rather than storing shells.
    const matched = deliveryPoints.filter(
      (row) => row.matchOutcome === DeliveryMatchOutcome.MATCHED
    );
    expect(matched.length).toBeGreaterThan(0);
    expect(matched[0].pullRequestDetailId).toBe("prd-4228");
    expect(matched[0].branchArtifactId).toBe("art-branch-4228");
  });

  it("validates the Pensero delivery endpoint on demand without writing the ledger", async () => {
    const reason =
      "Pensero delivery request failed: 404 (endpoint=/v1/delivery basePathSegments=0)";
    mockFetchDeliverySegment.mockRejectedValue(new Error(reason));

    const response = await GET(makeRequest(CRON_SECRET, "?mode=validate"));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(mockFetchDeliverySegment).toHaveBeenCalledTimes(1);
    expect(body).toContain("validation=true");
    expect(body).toContain("orgs=1");
    expect(body).toContain("validated=0");
    expect(body).toContain("orgsFailed=1");
    expect(body).toContain("orgsDeferred=0");
    expect(body).toContain(`dominantFailure="${reason}"`);
    // Org-scoped, because this probe sampled exactly one day (whitlockk, #6747).
    expect(body).toContain("dominantFailureOrgs=1");
    expect(body).not.toContain("dominantFailureDays");
    expect(ledger).toEqual([]);
    expect(cursors).toEqual([]);
    expect(deliveryPoints).toEqual([]);
    expect(mockNotifySlack).not.toHaveBeenCalled();
  });

  it.each([
    ["?mode=validatee", "a typo in the validation word"],
    ["?mode=dry-run", "a mode this route never defined"],
    ["?mode=Validate", "the right word in the wrong case"],
    ["?mode=", "an empty mode"],
  ])(
    "rejects %s and never starts a live backfill — %s",
    async (query: string) => {
      // whitlockk (#6747). THE SAFETY CASE. Mode selection used to be a single
      // equality test against "validate", so every value that was not exactly
      // that word — including a one-character typo — fell through to
      // `sweepPenseroDeliveryBackfill` and ran a MUTATING backfill against
      // every tenant. An operator asking for a dry run got a write.
      const response = await GET(makeRequest(CRON_SECRET, query));
      const body = await response.text();

      // THE TEETH, asserted FIRST: the property is "the mutating path was never
      // entered", not "a 400 came back". A 400 returned after the sweep had
      // already written would satisfy the status assertion below and still be
      // exactly this bug, so the write assertions lead.
      expect(mockFetchDeliverySegment).not.toHaveBeenCalled();
      expect(ledger).toEqual([]);
      expect(cursors).toEqual([]);
      expect(deliveryPoints).toEqual([]);
      expect(mockNotifySlack).not.toHaveBeenCalled();

      expect(response.status).toBe(400);
      expect(body).toContain("mode must be one of:");
      expect(body).toContain(PenseroBackfillMode.Sweep);
      expect(body).toContain(PenseroBackfillMode.Validate);
    }
  );

  it("still sweeps when no mode is named, because that is what Vercel Cron sends", async () => {
    // The other half of the fail-closed change: rejecting unknown modes must
    // not reject the scheduled request, which carries no `mode` at all.
    const response = await GET(makeRequest(CRON_SECRET));

    expect(response.status).toBe(200);
    expect(mockFetchDeliverySegment).toHaveBeenCalled();
    expect(deliveryPoints.length).toBeGreaterThan(0);
  });

  it("AC7: sweeps two tenants without either seeing the other's credential or rows", async () => {
    integrations.push({
      organizationId: FOREIGN_ORG,
      apiTokenEncrypted: `enc:${FOREIGN_TOKEN}`,
      baseUrl: null,
      teamIdentifiers: ["Platform"],
    });

    await GET(makeRequest());

    const orgRows = deliveryPoints.filter((row) => row.organizationId === ORG);
    const foreignRows = deliveryPoints.filter(
      (row) => row.organizationId === FOREIGN_ORG
    );
    expect(orgRows.length).toBeGreaterThan(0);
    expect(foreignRows.length).toBeGreaterThan(0);

    // Each org's requests carried ONLY that org's token.
    expect(new Set(requestedCredentials.map((entry) => entry.token))).toEqual(
      new Set([ORG_TOKEN, FOREIGN_TOKEN])
    );

    // The two tenants have colliding pull requests; neither may borrow the
    // other's detail row.
    for (const row of orgRows) {
      expect(row.pullRequestDetailId).not.toBe("prd-foreign-4228");
      expect(row.userId).not.toBe("user-foreign-daveth");
    }
    for (const row of foreignRows) {
      expect(row.pullRequestDetailId).not.toBe("prd-4228");
    }
  });

  it("records an attempt ledger and both cursors, and claims no completeness", async () => {
    await GET(makeRequest());

    const todayEntry = ledger.find(
      (row) => row.organizationId === ORG && row.day === TODAY_DAY
    );
    expect(todayEntry).toMatchObject({
      lastSuccessAt: TODAY,
      lastFailureReason: null,
      attemptCount: 1,
    });
    // No field on the ledger asserts the day is exhausted, because the feed
    // cannot establish that. `lastRowsWritten` is a count, not a claim.
    expect(Object.keys(todayEntry ?? {})).not.toContain("complete");

    const cursor = cursors.find((row) => row.organizationId === ORG);
    // Today is 2026-08-04 and the backward lane's default budget is 7 days, so
    // it walked 08-03, 08-02, 08-01, 07-31, 07-30, 07-29, 07-28 — and the
    // cursor sits on the oldest of those, the last day this run succeeded on.
    expect(cursor?.backwardCursor).toEqual(
      new Date("2026-07-28T00:00:00.000Z")
    );
    // Nothing had been attempted before, so nothing was rechecked.
    expect(cursor?.recheckCursor).toBeNull();
  });

  it("AC3: a zero-row day is a SUCCESSFUL attempt that never claims completeness", async () => {
    await GET(makeRequest());

    // Every backward day returned an empty window from the stub.
    const quietDay = ledger.find(
      (row) => row.organizationId === ORG && row.day === "2026-08-03"
    );
    expect(quietDay?.lastSuccessAt).toEqual(TODAY);
    expect(quietDay?.lastFailureReason).toBeNull();
    expect(quietDay?.lastRowsWritten).toBe(0);
  });

  it("resumes below a stored cursor instead of restarting at today", async () => {
    cursors.push({
      organizationId: ORG,
      backwardCursor: new Date("2026-07-01T00:00:00.000Z"),
      recheckCursor: null,
    });

    await GET(makeRequest());

    const requestedDays = requestedCredentials.map((entry) => entry.day).sort();
    // Today is always refreshed; the backward lane picks up strictly below the
    // stored cursor rather than re-walking 2026-08-03 downward.
    expect(requestedDays).toContain(TODAY_DAY);
    expect(requestedDays).toContain("2026-06-30");
    expect(requestedDays).not.toContain("2026-08-03");
  });

  it("AC5: a failed day is recorded, counted to Datadog, and alerts", async () => {
    mockFetchDeliverySegment.mockImplementation(
      (options: { endDate: string }) => {
        if (options.endDate === TODAY_DAY) {
          return Promise.reject(
            new Error("Pensero delivery request failed: 502")
          );
        }
        return transportStub(options as never);
      }
    );

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    const failedDay = ledger.find(
      (row) => row.organizationId === ORG && row.day === TODAY_DAY
    );
    expect(failedDay?.lastSuccessAt).toBeNull();
    expect(failedDay?.lastFailureReason).toContain("502");

    // The MONITORED signal, asserted on the production call shape rather than
    // on "some logger was called".
    expect(mockEmitTelemetryMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: FilterToken.PenseroBackfillDayFailed,
        orgId: ORG,
        day: TODAY_DAY,
        count: 1,
      })
    );
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({ route: "backfill-pensero-delivery" })
    );
  });

  it("puts the DOMINANT day-failure reason in the degraded Slack alert", async () => {
    // The incident, reproduced: every planned day 404s because the org's stored
    // base URL lost its `/api` segment. The alert used to read
    // `days=8 daysOk=0 daysFailed=8 rows=0` and name no cause at all, while all
    // eight ledger rows already held this exact string.
    const reason =
      "Pensero delivery request failed: 404 (endpoint=/v1/delivery basePathSegments=0)";
    mockFetchDeliverySegment.mockImplementation(() =>
      Promise.reject(new Error(reason))
    );

    await GET(makeRequest());

    const messages = slackMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("daysFailed=8");
    expect(messages[0]).toContain(`dominantFailure="${reason}"`);
    expect(messages[0]).toContain("dominantFailureDays=8");
    expect(messages[0]).toContain("distinctFailureReasons=1");
  });

  /**
   * ISS-9689. The production alarm said `orgs=1 … daysFailed=11
   * dominantFailure="… 404 …"` and never named the one organization it was
   * about, so whoever was paged had to trace it by hand before anyone could go
   * and fix the value. The org id was on every per-org failure log already; it
   * simply never reached the line a human reads.
   */
  it("names the ORGANIZATION the dominant failure belongs to", async () => {
    const reason =
      "Pensero delivery request failed: 404 (endpoint=/v1/delivery basePathSegments=3)";
    mockFetchDeliverySegment.mockImplementation(() =>
      Promise.reject(new Error(reason))
    );

    await GET(makeRequest());

    const messages = slackMessages();
    // The subject, not just the symptom — the alert now says whose it is.
    expect(messages[0]).toContain(`dominantFailureOrgIds="${ORG}"`);
    // Nothing was elided, so the id list is the whole population and not a
    // truncated prefix a reader would take for one.
    expect(messages[0]).not.toContain("dominantFailureOrgIdsOmitted");
  });

  it("reports the dominant cause AND that other causes existed", async () => {
    // Two 404s and one timeout is not the same incident as three 404s, and an
    // alert that showed only the winner would flatten them together.
    const notFound =
      "Pensero delivery request failed: 404 (endpoint=/v1/delivery basePathSegments=0)";
    mockFetchDeliverySegment.mockImplementation(
      (options: { endDate: string }) =>
        Promise.reject(
          new Error(options.endDate === TODAY_DAY ? "timed out" : notFound)
        )
    );

    await GET(makeRequest());

    const messages = slackMessages();
    expect(messages[0]).toContain(`dominantFailure="${notFound}"`);
    expect(messages[0]).toContain("dominantFailureDays=7");
    expect(messages[0]).toContain("distinctFailureReasons=2");
  });

  it("says nothing about a cause when the degradation had no failed day", async () => {
    // A truncation-signalled run is degraded with `daysFailed=0`. Inventing a
    // dominant reason there would name a failure that did not happen.
    mockFetchDeliverySegment.mockImplementation((options: never) =>
      transportStub(options).then((result) => ({
        ...result,
        completeness: "truncation_signalled" as const,
        continuationKeysSeen: ["next"],
      }))
    );

    await GET(makeRequest());

    const messages = slackMessages();
    expect(messages[0]).toContain("daysFailed=0");
    expect(messages[0]).not.toContain("dominantFailure");
  });

  it("never lets the alert carry the request query or an echoed credential", async () => {
    // The Slack channel is a wider audience than a server log: the query holds
    // `team_identifiers` (org data) and the window being walked, and an upstream
    // error page can quote the credentialed request back.
    // whitlockk (#6639): a TRANSPORT error quotes the whole URL it was handed —
    // scheme, tenant host, and the org-configured base path — and that is a
    // different code path from the descriptor the delivery client builds.
    // `isSecureHttpsUrl` constrains none of those three.
    mockFetchDeliverySegment.mockImplementation(() =>
      Promise.reject(
        new Error(
          "GET https://tenant.example/private/customer-42/v1/delivery?start_date=2026-08-04&team_identifiers=Engineering rejected for ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        )
      )
    );

    await GET(makeRequest());

    const [message] = slackMessages();
    for (const forbidden of [
      "tenant.example",
      "customer-42",
      "team_identifiers",
      "start_date",
      "Engineering",
      "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]) {
      expect(message).not.toContain(forbidden);
    }
    // POSITIVE CONTROL: the alert still carries a cause and its volume, so the
    // loop above cannot be satisfied by one that dropped the reason altogether.
    expect(message).toContain("[redacted-url]");
    expect(message).toContain("dominantFailureDays=8");
  });

  it("AC4: reports every match outcome separately, never summed", async () => {
    await GET(makeRequest());

    const runMetric = mockEmitTelemetryMetric.mock.calls
      .map((call) => call[0])
      .find((payload) => payload.metric === FilterToken.PenseroBackfillRun);

    expect(runMetric).toBeDefined();
    for (const field of [
      "matched",
      "noCounterpart",
      "ambiguous",
      "unmatchable",
      "pendingReference",
    ]) {
      expect(runMetric).toHaveProperty(field);
    }
    // No field collapses them: an "unmatched" total would make three different
    // problems with three different fixes look like one.
    expect(runMetric).not.toHaveProperty("unmatched");
    expect(runMetric.matched).toBeGreaterThan(0);
  });

  it("omits team_identifiers when the org configured none, and sends it when it did", async () => {
    await GET(makeRequest());
    expect(mockFetchDeliverySegment).toHaveBeenCalledWith(
      expect.objectContaining({ teamIdentifiers: [] })
    );

    vi.clearAllMocks();
    mockFetchDeliverySegment.mockImplementation(transportStub);
    integrations[0].teamIdentifiers = ["Engineering"];

    await GET(makeRequest());
    expect(mockFetchDeliverySegment).toHaveBeenCalledWith(
      expect.objectContaining({ teamIdentifiers: ["Engineering"] })
    );
  });

  it("skips an org with no stored credential rather than using the env token", async () => {
    integrations = [];

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(mockFetchDeliverySegment).not.toHaveBeenCalled();
    expect(deliveryPoints).toEqual([]);
  });

  it("returns 401 without a valid CRON_SECRET, before touching the database", async () => {
    const response = await GET(makeRequest("wrong-secret"));

    expect(response.status).toBe(401);
    expect(mockFetchDeliverySegment).not.toHaveBeenCalled();
    expect(deliveryPoints).toEqual([]);
  });

  it("returns 500 and alerts when the sweep itself throws", async () => {
    vi.mocked(withDb).mockImplementation(() =>
      Promise.reject(new Error("database unreachable"))
    );

    const response = await GET(makeRequest());

    expect(response.status).toBe(500);
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({
        route: "backfill-pensero-delivery",
        message: expect.stringContaining("database unreachable"),
      })
    );
  });
});
