/**
 * ISS-6756 (whitlockk) — the per-session version attribution read
 * (`attachUsageSessionVersions`, service/detail-read.ts) must select from the
 * SAME identity population as the lanes that produced `usageSessions`.
 *
 * The question this file answers is "what fails if that caller slips back to
 * `componentKey: { equals: key, mode: "insensitive" }`?" — nothing did, before
 * this file. Prisma binds that key as an unescaped ILIKE PATTERN, so for a key
 * shaped like `mcp__closedloop__ping` the read also matched
 * `mcpXXclosedloopYYping` — a DIFFERENT component. Its row can win the
 * deterministic `lastInvokedAt DESC, id ASC` ordering, and the session then
 * renders that component's `versionHash` and `definitionHash`: a wrong answer,
 * not a missing one, on a page that says which revision ran.
 *
 * So the double below EVALUATES both spellings honestly — the folded equality as
 * an equality, the old one with `_`/`%` as wildcards — and the decoy row is
 * seeded to win the ordering. Asserting the emitted `where` alone would not
 * catch a caller that kept the new spelling but pointed it at the wrong value.
 */

import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  listByArtifactIds: vi.fn(),
  Prisma: { TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" } },
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: mocks.Prisma,
}));

vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: { listByArtifactIds: mocks.listByArtifactIds },
}));

import {
  buildInventoryRow,
  buildServiceDb,
} from "@/__tests__/support/agent-components/service-db-double";
import { agentComponentsService } from "../service";

const ORG = "org-1";
const KIND = "mcp_tool";
/** The identity under test — an `_`-bearing key, the shape this domain mints. */
const KEY = "mcp__closedloop__ping";
/** A DIFFERENT component, matched only by ILIKE's reading of `_`. */
const DECOY_KEY = "mcpXXclosedloopYYping";
const SESSION_ID = "sess-1";
const OWN_HASH = "a".repeat(64);
const DECOY_HASH = "d".repeat(64);

type UsageRow = {
  id: string;
  agentSessionId: string;
  componentKey: string;
  componentVersionHash: string;
  definitionVersionId: string | null;
  lastInvokedAt: Date;
};

const VERSION_ROWS: readonly UsageRow[] = [
  {
    id: "u-own",
    agentSessionId: SESSION_ID,
    componentKey: KEY,
    componentVersionHash: OWN_HASH,
    definitionVersionId: null,
    lastInvokedAt: new Date("2026-01-01T00:00:00.000Z"),
  },
  {
    // Newer, so it WINS the read's `lastInvokedAt DESC` ordering the moment the
    // predicate lets it through. That is what turns the over-match into a wrong
    // rendered hash rather than a harmless extra row.
    id: "u-decoy",
    agentSessionId: SESSION_ID,
    componentKey: DECOY_KEY,
    componentVersionHash: DECOY_HASH,
    definitionVersionId: null,
    lastInvokedAt: new Date("2026-06-01T00:00:00.000Z"),
  },
];

/** `component_key_normalized` as the table's trigger derives it. */
function fold(value: string): string {
  return value.toLowerCase().trim();
}

/**
 * ILIKE semantics for a bound, UNESCAPED pattern: `_` matches any one character,
 * `%` any run, everything else is literal, and the whole match is anchored and
 * case-insensitive. This is what Prisma emits for `mode: "insensitive"`.
 */
function ilikeMatches(pattern: string, value: string): boolean {
  const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${source.replaceAll("_", ".").replaceAll("%", ".*")}$`,
    "i"
  ).test(value);
}

/** Apply whichever identity spelling the caller emitted. */
function matchesIdentity(where: Record<string, unknown>, row: UsageRow) {
  const folded = where.componentKeyNormalized as { in?: string[] } | undefined;
  if (folded?.in) {
    return folded.in.includes(fold(row.componentKey));
  }
  const raw = where.componentKey as { equals?: string } | undefined;
  if (raw?.equals !== undefined) {
    return ilikeMatches(raw.equals, row.componentKey);
  }
  return true;
}

function installDb(usageFindMany: ReturnType<typeof vi.fn>) {
  const db = buildServiceDb({
    agentComponent: {
      findMany: vi.fn().mockResolvedValue([
        buildInventoryRow({
          id: "ac-mcp",
          componentKind: KIND,
          componentKey: KEY,
          name: KEY,
          sessionUsages: [
            {
              agentSessionId: SESSION_ID,
              invocationCount: 3,
              usageComponentKind: KIND,
              usageComponentKey: KEY,
              session: {
                artifactId: SESSION_ID,
                artifact: { organizationId: ORG },
              },
            },
          ],
        }),
      ]),
    },
    agentComponentSessionUsage: { findMany: usageFindMany },
  });
  mocks.withDb.mockImplementation((cb: (db: unknown) => unknown) => cb(db));
  mocks.withDb.tx.mockImplementation((cb: (db: unknown) => unknown) => cb(db));
  return db;
}

/**
 * Serves the version-attribution read (the only usage `findMany` bound by
 * `agentSessionId`) from `VERSION_ROWS`, filtered by whatever identity
 * predicate the caller emitted; every other usage `findMany` gets nothing.
 */
function versionAttributionFindMany() {
  return vi.fn((args: { where: Record<string, unknown> }) => {
    const where = args.where ?? {};
    if (!where.agentSessionId) {
      return Promise.resolve([]);
    }
    return Promise.resolve(
      VERSION_ROWS.filter((row) => matchesIdentity(where, row))
        .slice()
        .sort(
          (a, b) =>
            b.lastInvokedAt.getTime() - a.lastInvokedAt.getTime() ||
            a.id.localeCompare(b.id)
        )
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listByArtifactIds.mockResolvedValue([]);
});

describe("per-session version attribution identity (ISS-6756)", () => {
  it("attributes the component's OWN revision, not the ILIKE decoy's", async () => {
    const findMany = versionAttributionFindMany();
    installDb(findMany);

    const detail = await agentComponentsService.getDetailForOrg(
      ORG,
      encodeComponentSlug(KIND, KEY, null)
    );

    expect(detail?.usageSessions).toEqual([
      expect.objectContaining({
        sessionId: SESSION_ID,
        versionHash: OWN_HASH,
      }),
    ]);
  });

  it("asks for the persisted fold, so no ILIKE reaches this lane", async () => {
    const findMany = versionAttributionFindMany();
    installDb(findMany);

    await agentComponentsService.getDetailForOrg(
      ORG,
      encodeComponentSlug(KIND, KEY, null)
    );

    const call = findMany.mock.calls.find(
      ([args]) =>
        (args as { where: Record<string, unknown> }).where?.agentSessionId
    );
    if (!call) {
      throw new Error(
        "no attribution read carried an agentSessionId predicate"
      );
    }
    const where = (call[0] as { where: Record<string, unknown> }).where;
    expect(where.componentKeyNormalized).toEqual({ in: [KEY] });
    expect(where).not.toHaveProperty("componentKey");
    expect(JSON.stringify(where)).not.toContain("insensitive");
  });

  it("asks nothing at all when the route carries no name", async () => {
    // The orphan-only content-hash route resolves `key` to `""`. Emitting the
    // identity predicate anyway would ask for `component_key_normalized IN ('')`
    // — every row still on the `ADD COLUMN … DEFAULT ''` value — and attribute
    // one of THEIR revisions. `usageNameIdentityWhere`'s stated precondition,
    // honoured at this caller.
    const findMany = versionAttributionFindMany();
    installDb(findMany);

    const detail = await agentComponentsService.getDetailForOrg(
      ORG,
      encodeComponentSlug(KIND, "", null)
    );

    expect(
      detail?.usageSessions?.every((s) => s.versionHash === null) ?? true
    ).toBe(true);
    for (const [args] of findMany.mock.calls) {
      const where = (args as { where?: Record<string, unknown> }).where ?? {};
      expect(where.componentKeyNormalized).not.toEqual({ in: [""] });
    }
  });

  it("the decoy really is admitted by the predicate this replaced", () => {
    // The counterfactual, stated rather than assumed: without it the first case
    // would pass on a fixture where both spellings agree, and prove nothing.
    expect(ilikeMatches(KEY, DECOY_KEY)).toBe(true);
    expect(fold(DECOY_KEY)).not.toBe(fold(KEY));
  });
});
