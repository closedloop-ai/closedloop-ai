/**
 * @file iss9846-desktop-contract-replay.integration.test.ts
 * @description ISS-9846 (PRD-707 R1) — replay the RECORDED desktop sync
 * payloads through the real routes, against real Postgres, under real
 * `sk_live_` API-key auth.
 *
 * WHY. Five of the eight desktop-affecting incidents in the ten days to
 * 2026-09-03 were CLOUD changes that broke the desktop↔cloud contract
 * (ISS-8780/#6576, ISS-8271, ISS-8267, ISS-8049, ISS-8051). None of them was a
 * desktop bug and none was caught by a desktop test. This layer replays one
 * adversarial payload per incident and covers four of the five; ISS-8049 is a
 * relay-transport failure that never reaches a route and is out of reach here —
 * see the note at the bottom of this file.
 *
 * WHAT MAKES IT DIFFERENT FROM THE NEIGHBOURING SUITES. Two things, both
 * deliberate:
 *
 *  1. The payloads are the DESKTOP BUILDER'S OWN OUTPUT, recorded by
 *     `apps/desktop/test/contract-replay/fixtures-build.ts`, not hand-written
 *     here. A hand-written payload asserts what this file's author believed the
 *     desktop sends; every one of these incidents was a disagreement about
 *     exactly that. `apps/api` cannot import `apps/desktop` (private, no
 *     exports, not a declared dependency), so the fixtures are committed and the
 *     DESKTOP lane holds them current — `apps/desktop/test/contract-replay-
 *     fixtures.test.ts` rebuilds them through the production builders and reds
 *     on any drift. This side re-checks each fixture's digest against the
 *     manifest, which catches a hand-edited fixture but cannot see builder
 *     drift; that is the desktop gate's job and it is stated here so nobody
 *     reads this digest check as covering it.
 *
 *  2. Auth is REAL. `route.integration.test.ts` next door mocks
 *     `withAnyAuth` away, so it proves nothing about the channel the desktop
 *     actually uses. Here a real `ApiKey` row is minted through
 *     `apiKeysService.generate` and the request carries
 *     `Authorization: Bearer sk_live_…`, so the whole wrapper — key hash
 *     lookup, user/org resolution, write-scope check — is on the path. One case
 *     mints through `seedApiKeys` instead, so the credential the containerized
 *     E2E lane depends on is itself on a replayed path rather than assumed.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type DesktopAgentSessionsPayload,
  DesktopAgentSessionsSyncErrorCode,
  SYNC_CONTENT_ENCODING_HEADER,
  type SyncedAgentSession,
  SyncPayloadEncoding,
} from "@repo/api/src/types/agent-session";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import {
  resolveSeedApiKeyDecision,
  seedApiKeys,
} from "@repo/database/scripts/seed/api-keys";
import {
  E2E_SEED_API_KEY_ENV,
  resolveSeedRunPlan,
  SeedProfileName,
} from "@repo/database/scripts/seed/profiles";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { BranchMaterializationRetryState } from "@/app/agent-sessions/service/artifact-links/branch-materialization-retry";
import { apiKeysService } from "@/app/api-keys/service";
import { POST as invocationsSyncPost } from "@/app/desktop/agent-sessions/invocations/sync/route";
import { POST as sessionsSyncPost } from "@/app/desktop/agent-sessions/sync/route";

const FIXTURES_DIR = resolve(
  import.meta.dirname,
  "../fixtures/desktop-contract-replay"
);
const REGEN_COMMAND =
  "CONTRACT_REPLAY_WRITE_FIXTURES=1 pnpm --filter desktop exec vitest run --config vitest.node.config.ts test/contract-replay-fixtures.test.ts";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

/**
 * The fixtures are files on disk, so reading them is a PARSE BOUNDARY and the
 * repo's rule applies: validate an unknown object shape with Zod, never a bare
 * cast. The digest check further down proves the bytes were not hand-edited; it
 * says nothing about whether a REGENERATED fixture still has the shape this
 * suite indexes into, and a bare `as` would turn that drift into an
 * `undefined`-shaped failure inside an assertion instead of at the read.
 *
 * The ENVELOPE is validated here; the payloads inside it deliberately are not.
 * Re-stating the session and invocation wire schemas would duplicate the very
 * contract under test — the routes' own Zod parse is what must judge those, and
 * a copy here could disagree with it and hide the disagreement.
 */
const expectedCountsSchema = z
  .object({
    sessions: z.number().int().nonnegative(),
    tokenEvents: z.number().int().nonnegative(),
    componentUsage: z.number().int().nonnegative(),
    invocations: z.number().int().nonnegative(),
    branchActivityAtoms: z.number().int().nonnegative(),
  })
  .strict();

const manifestEntrySchema = z
  .object({
    slug: z.string().min(1),
    incident: z.string().min(1),
    file: z.string().min(1),
    kind: z.enum(["session", "chunked", "invocation-parts"]),
    parts: z.number().int().positive(),
    sizer: z.enum(["identity", "gzip"]),
    requiresRepositoryAuthority: z.boolean(),
    repositoryFullName: z.string().min(1).nullable(),
    expectedAcceptedSessionIds: z.array(z.string()),
    expected: expectedCountsSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

type ManifestEntry = z.infer<typeof manifestEntrySchema>;

const manifestSchema = z
  .object({
    manifestVersion: z.number().int(),
    provenance: z.record(z.string(), z.unknown()),
    entries: z.array(manifestEntrySchema).nonempty(),
  })
  .strict();

const wireSessionsSchema = z.array(z.unknown()).nonempty();

const sessionFixtureSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("session"),
    sessions: wireSessionsSchema,
  }),
  z.object({
    kind: z.literal("chunked"),
    chunks: wireSessionsSchema,
  }),
]);

const invocationFixtureSchema = z.object({
  kind: z.literal("invocation-parts"),
  parts: z.array(z.unknown()).nonempty(),
});

function readFixtureText(file: string): string {
  return readFileSync(join(FIXTURES_DIR, file), "utf8");
}

function readFixtureJson(file: string): unknown {
  return JSON.parse(readFixtureText(file));
}

const manifest = manifestSchema.parse(readFixtureJson("manifest.json"));

/**
 * The sessions a session fixture asks the cloud to ingest, in wire order.
 *
 * The cast is the one place a wire payload is taken on trust, and it is
 * deliberate: the route's own Zod schema is the judge of these objects, and that
 * judgement is what the whole suite exists to exercise.
 */
function sessionsOf(file: string): SyncedAgentSession[] {
  const fixture = sessionFixtureSchema.parse(readFixtureJson(file));
  const sessions =
    fixture.kind === "chunked" ? fixture.chunks : fixture.sessions;
  return sessions as SyncedAgentSession[];
}

type Lane = {
  organizationId: string;
  userId: string;
  computeTargetId: string;
  apiKey: string;
};

/**
 * A fresh organisation, user, `sk_live_` key and compute target.
 *
 * Committed rather than rolled back: `ensureInternalBranchActivityTargets`
 * takes `pg_advisory_xact_lock()` inside the ingest transaction, and the token
 * event write chunks across statements, so the replays run on their own
 * connections rather than nested inside one test-owned transaction. Everything
 * is namespaced under a per-case organisation, which the counts below are all
 * scoped to.
 */
const organizations = createCommittedTestOrganizationTracker();

/**
 * Every organisation a lane was opened for, so the `afterEach` can take its API
 * keys with it.
 *
 * Recorded the instant the organisation exists and BEFORE anything else that can
 * throw: the per-case `try/finally` this replaces never ran when `createLane`
 * itself threw — the key was already minted by then, and a live full-access row
 * outlived the case that made it.
 */
const laneOrganizationIds: string[] = [];

async function createLane(): Promise<Lane> {
  const organizationId = await organizations.create();
  laneOrganizationIds.push(organizationId);
  const user = await createTestUser(organizationId);
  const created = await apiKeysService.generate(organizationId, user.id, {
    name: "iss9846 contract replay",
  });
  const computeTarget = await withDb((db) =>
    db.computeTarget.create({
      data: {
        organizationId,
        userId: user.id,
        machineName: "contract-replay-machine",
        platform: "darwin",
      },
      select: { id: true },
    })
  );
  return {
    organizationId,
    userId: user.id,
    computeTargetId: computeTarget.id,
    apiKey: created.plaintext,
  };
}

/** Every API key this suite minted, so cleanup takes them with the org. */
async function dropLaneApiKeys(): Promise<void> {
  // `ApiKey.organizationId` is a bare uuid column with no `@relation`, so
  // deleting the organization cascades nothing here and a live full-access key
  // would outlive every suite that mints one.
  const organizationIds = laneOrganizationIds.splice(0);
  if (organizationIds.length === 0) {
    return;
  }
  await withDb((db) =>
    db.apiKey.deleteMany({ where: { organizationId: { in: organizationIds } } })
  );
}

/**
 * Register the repository with a canonical authority for this organisation.
 *
 * Load-bearing for the ISS-8780 replay and nothing else:
 * `ensureInternalBranchActivityTargets` drops every target whose
 * `repositoryAuthority` is undefined, so a branch ref into an unregistered repo
 * never reaches the advisory lock at all — the request still answers 200 and the
 * fixture looks like coverage while exercising nothing.
 */
function registerRepositoryAuthority(
  organizationId: string,
  fullName: string
): Promise<unknown> {
  return withDb((db) =>
    db.publicRepository.create({
      data: {
        organizationId,
        owner: fullName.split("/")[0] ?? "org",
        name: fullName.split("/")[1] ?? "repo",
        htmlUrl: `https://github.com/${fullName}`,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: `iss9846-${organizationId}`,
          fullName,
        }),
      },
    })
  );
}

function syncRequest(
  lane: Lane,
  path: string,
  body: unknown,
  compress: boolean
): NextRequest {
  const json = JSON.stringify(body);
  const headers: Record<string, string> = {
    authorization: `Bearer ${lane.apiKey}`,
    "content-type": "application/json",
  };
  if (!compress) {
    return new NextRequest(
      `https://api.example.test${path}?computeTargetId=${lane.computeTargetId}`,
      { body: json, headers, method: "POST" }
    );
  }
  headers[SYNC_CONTENT_ENCODING_HEADER] = SyncPayloadEncoding.Gzip;
  return new NextRequest(
    `https://api.example.test${path}?computeTargetId=${lane.computeTargetId}`,
    { body: gzipSync(Buffer.from(json)), headers, method: "POST" }
  );
}

function routeContext(): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve({}) };
}

/**
 * `compress` is REQUIRED, and must be the same value handed to `syncRequest` for
 * this batch: the desktop stamps `encoding` on the envelope whenever it
 * gzips (`agent-session-sync-contract.ts` builds it from the same flag that
 * sets `Content-Encoding`), so a replay that compressed the body but left the
 * field off would be measuring a payload no installed desktop sends — and a
 * regression in that field would stay green here forever.
 */
function batchFor(
  sessions: SyncedAgentSession[],
  compress: boolean
): DesktopAgentSessionsPayload {
  return {
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: randomUUID(),
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
    // OMITTED, never `null`, when the body is not compressed: the field is
    // optional and additive, and every pre-FEA-4138 desktop leaves it off.
    ...(compress ? { encoding: SyncPayloadEncoding.Gzip } : {}),
    // The envelope the desktop actually sends (`agent-session-sync-contract.ts`
    // sets this unconditionally). It is not cosmetic: a batch carrying a HELD
    // sentinel revision is rejected outright as
    // `held_revision_requires_row_level_ack` without it, because whole-batch
    // ack semantics cannot express "accepted, and this row deliberately not
    // written". Replaying without it would have measured a payload no installed
    // desktop sends.
    wantsAcceptedSessionIds: true,
  };
}

type StoredCounts = z.infer<typeof expectedCountsSchema> & {
  branchDetails: number;
  branchActivityAtoms: number;
};

/**
 * What the organisation actually holds after the replay. Every count is
 * org-scoped, so a row another case wrote cannot be counted here.
 *
 * WHICH counts a case asserts is the case's own business, and they differ: the
 * three-fixture case below pins the whole `expected` block including its zeroes,
 * while the token-event and branch cases pin only the fields their incident is
 * about. Do not read this docstring as a promise that every field is checked
 * everywhere — that promise would be false, and a reader who believed it would
 * skip adding the assertion their new case actually needs.
 */
function storedCounts(organizationId: string): Promise<StoredCounts> {
  return withDb(async (db) => {
    const [
      sessions,
      tokenEvents,
      componentUsage,
      invocations,
      branchDetails,
      branchActivityAtoms,
    ] = await Promise.all([
      db.sessionDetail.count({
        where: { artifact: { is: { organizationId } } },
      }),
      db.agentSessionTokenEvent.count({
        where: { session: { is: { artifact: { is: { organizationId } } } } },
      }),
      db.agentComponentSessionUsage.count({
        where: { session: { is: { artifact: { is: { organizationId } } } } },
      }),
      db.agentComponentInvocation.count({
        where: {
          generation: {
            is: { session: { is: { artifact: { is: { organizationId } } } } },
          },
        },
      }),
      db.branchDetail.count({ where: { organizationId } }),
      // Canonical atoms only. A writer claims the legacy v1 identity BESIDE the
      // target-qualified v2 row, so an unfiltered count is 2 per event and would
      // read as a duplicate.
      db.branchActivityAtom.count({
        where: { organizationId, compatibilityAliasForSourceEventId: null },
      }),
    ]);
    return {
      sessions,
      tokenEvents,
      componentUsage,
      invocations,
      branchDetails,
      branchActivityAtoms,
    };
  });
}

/** Canonical atoms the ingest stamped `Partial`; a count-driven re-stamp shows here. */
function partialAtomCount(organizationId: string): Promise<number> {
  return withDb((db) =>
    db.branchActivityAtom.count({
      where: {
        organizationId,
        compatibilityAliasForSourceEventId: null,
        completeness: BranchActivityEvidenceCompleteness.Partial,
      },
    })
  );
}

/**
 * Every channel the ingest can park work in, counted together.
 *
 * "Zero dead letters" is only meaningful beside a positive control — an
 * unauthenticated request writes nothing either, so a bare zero here is
 * satisfied by a 401 exactly as well as by a successful ingest. Each case
 * therefore asserts these zeroes AND the stored counts above.
 *
 * `deadLetters` is reported separately from everything else because they are
 * different facts. A DEAD-LETTERED branch-materialization retry is work the
 * ingest gave up on; one fixture legitimately leaves a row that is NOT that (see
 * its case). Folding them into one number would either force that fixture to
 * tolerate a real dead letter or force this suite to assert a zero the healthy
 * path does not produce.
 *
 * `pendingRetries` is therefore "every retry row that is not dead-lettered" —
 * `Pending`, `Claimed` AND `Terminal`, which is three of the four members of
 * `BranchMaterializationRetryState`, not just the scheduled one its name
 * suggests. Named for the row that actually occurs on this suite's fixtures and
 * defined by exclusion so a fifth state joins it automatically; what the
 * assertions are really pinning is that nothing was dead-lettered and that the
 * non-dead-letter row count is exactly the expected one.
 */
function deadLetterCounts(organizationId: string): Promise<{
  deadLetters: number;
  pendingRetries: number;
  quarantines: number;
}> {
  return withDb(async (db) => {
    const [deadLetters, pendingRetries, quarantines] = await Promise.all([
      db.branchMaterializationRetry.count({
        where: {
          organizationId,
          state: BranchMaterializationRetryState.DeadLetter,
        },
      }),
      db.branchMaterializationRetry.count({
        where: {
          organizationId,
          state: { not: BranchMaterializationRetryState.DeadLetter },
        },
      }),
      db.monitoredSessionActivityQuarantine.count({
        where: { organizationId },
      }),
    ]);
    return { deadLetters, pendingRetries, quarantines };
  });
}

/** The one accepted-ack envelope shape, so the two replay cases cannot drift. */
function acceptedBody(entry: ManifestEntry) {
  return {
    success: true,
    data: {
      synced: true,
      acceptedSessionIds: entry.expectedAcceptedSessionIds,
    },
  };
}

/** The branch row `ensureInternalBranchActivityTargets` would have created. */
function branchFor(organizationId: string, repositoryFullName: string | null) {
  return withDb((db) =>
    db.branchDetail.findFirst({
      where: { organizationId, repositoryFullName: repositoryFullName ?? "" },
      select: { artifactId: true, branchName: true, repositoryId: true },
    })
  );
}

function entryFor(slug: string): ManifestEntry {
  const entry = manifest.entries.find((candidate) => candidate.slug === slug);
  if (!entry) {
    throw new Error(
      `no manifest entry named ${slug}; the fixture set changed without this suite. Regenerate: ${REGEN_COMMAND}`
    );
  }
  return entry;
}

/** Drive one recorded session fixture end to end and return the outcome. */
async function replaySessionFixture(
  lane: Lane,
  entry: ManifestEntry
): Promise<{ statuses: number[]; bodies: unknown[] }> {
  const statuses: number[] = [];
  const bodies: unknown[] = [];
  // Chunks are separate requests in production; a chunked fixture is replayed
  // as the SEQUENCE the cloud actually receives, never reassembled here.
  const compress = entry.sizer === "gzip";
  for (const session of sessionsOf(entry.file)) {
    const response = await sessionsSyncPost(
      syncRequest(
        lane,
        "/desktop/agent-sessions/sync",
        batchFor([session], compress),
        compress
      ),
      routeContext()
    );
    statuses.push(response.status);
    bodies.push(await response.json());
  }
  return { statuses, bodies };
}

describeIfDb(
  "ISS-9846 desktop→cloud contract replay (recorded payloads)",
  () => {
    // Per CASE, not per file: each replay counts rows for its own organisation, so
    // a lane left standing would be counted by the next one.
    afterEach(async () => {
      await dropLaneApiKeys();
      await organizations.cleanup();
    });

    it("lists exactly the seven recorded incident fixtures in its manifest", () => {
      // Replays nothing — it pins the INVENTORY. The manifest is what every case
      // below indexes into, so a suite that silently stopped covering an incident
      // would otherwise just run fewer cases and stay green.
      expect(manifest.manifestVersion).toBe(1);
      expect(manifest.entries.map((entry) => entry.slug).sort()).toEqual([
        "iss-8051-token-events-over-historical-cap",
        "iss-8069-oversized-index-key",
        "iss-8267-partial-unique-arbiter",
        "iss-8271-sentinel-data-revision",
        "iss-8271-sentinel-maintenance-stale",
        "iss-8780-internal-branch-target",
        "iss-9860-monitored-activity-pages",
      ]);
    });

    it("holds every fixture to the digest the desktop builder recorded", () => {
      // Integrity of the RECORDING, not currency of the builder: this catches a
      // hand-edited fixture. Builder drift is caught on the desktop side, by
      // `apps/desktop/test/contract-replay-fixtures.test.ts`, which is the only
      // side that can run the builder at all.
      for (const entry of manifest.entries) {
        const digest = createHash("sha256")
          .update(readFixtureText(entry.file))
          .digest("hex");
        expect(`${entry.file}:${digest}`).toBe(`${entry.file}:${entry.sha256}`);
      }
    });

    it("authenticates the replay with a real sk_live_ key, not a mock", async () => {
      const lane = await createLane();
      // The key is a real row reached through the real wrapper: its plaintext
      // hashes to the stored `keyHash`, and the SAME request with the last
      // character flipped must be refused. Without that second half, a wrapper
      // that accepted any bearer token would satisfy the first.
      expect(lane.apiKey.startsWith("sk_live_")).toBe(true);
      const stored = await withDb((db) =>
        db.apiKey.findFirst({
          where: { organizationId: lane.organizationId },
          select: { keyHash: true, keyPrefix: true },
        })
      );
      expect(stored?.keyPrefix).toBe("sk_live_");
      expect(stored?.keyHash).toBe(
        createHash("sha256").update(lane.apiKey, "utf8").digest("hex")
      );

      const entry = entryFor("iss-8271-sentinel-maintenance-stale");
      const accepted = await replaySessionFixture(lane, entry);
      expect(accepted.statuses).toEqual([200]);

      const tampered: Lane = { ...lane, apiKey: `${lane.apiKey}x` };
      const refused = await replaySessionFixture(tampered, entry);
      expect(refused.statuses).toEqual([401]);
    });

    it("authenticates both routes with a key minted by the E2E seed itself", async () => {
      // Every other lane here calls `apiKeysService.generate` directly, which
      // exercises the ROUTE's auth but never runs `seedApiKeys` — the thing the
      // containerized E2E lane actually depends on for its credential. It could
      // break in every way that matters and all the replays above would stay
      // green. This drives the real seed function and then replays with what it
      // wrote.
      const lane = await createLane();

      // The REAL generator's output, not a hand-written literal: it is what pins
      // the seed's restated key format (`isApiKeyPlaintext`) against the shape
      // apps/api actually emits, so a change to one reds here rather than
      // silently drifting from the other.
      const generated = await apiKeysService.generate(
        lane.organizationId,
        lane.userId,
        { name: "iss9846 seed key shape" }
      );
      const seedEnv: NodeJS.ProcessEnv = {
        ...process.env,
        [E2E_SEED_API_KEY_ENV]: generated.plaintext,
        // Only READ, to decide whether minting is permitted; the client passed to
        // `seedApiKeys` below is what actually connects. Pinned to a literal so
        // the decision does not depend on how the ambient test database is
        // spelled.
        DATABASE_URL: "postgresql://postgres@localhost:5432/app",
      };
      expect(resolveSeedApiKeyDecision(seedEnv)).toEqual({
        mint: true,
        plaintext: generated.plaintext,
      });

      await withDb((db) =>
        seedApiKeys(
          db,
          { organizationId: lane.organizationId, userId: lane.userId },
          { ...resolveSeedRunPlan(), profile: SeedProfileName.E2e },
          seedEnv
        )
      );

      // The row now answering for this plaintext is the SEED's, not the
      // generator's: `seedApiKeys` clears the prior holder of the hash and
      // re-mints under its own name. Without this the replays below would pass
      // on the generator's row and prove nothing about the seed.
      const seeded = await withDb((db) =>
        db.apiKey.findUnique({
          where: {
            keyHash: createHash("sha256")
              .update(generated.plaintext, "utf8")
              .digest("hex"),
          },
          select: { name: true, organizationId: true, expiresAt: true },
        })
      );
      expect(seeded).toEqual({
        name: "E2E seed key",
        organizationId: lane.organizationId,
        expiresAt: null,
      });

      const seededLane: Lane = { ...lane, apiKey: generated.plaintext };
      const sessionEntry = entryFor("iss-8271-sentinel-maintenance-stale");
      const [seedSession] = sessionsOf(sessionEntry.file);
      if (!seedSession) {
        throw new Error("session fixture carried no session to anchor against");
      }
      const anchored: SyncedAgentSession = {
        ...seedSession,
        // The invocation part below names this session by id, so the anchor must
        // carry the fixture's own `externalSessionId` or the part attaches to
        // nothing and the 200 means only "the route parsed it".
        externalSessionId: "contract-replay-iss8267",
      };
      const sessionResponse = await sessionsSyncPost(
        syncRequest(
          seededLane,
          "/desktop/agent-sessions/sync",
          batchFor([anchored], false),
          false
        ),
        routeContext()
      );
      expect(sessionResponse.status).toBe(200);

      // The SECOND route, on the same seeded key — one route answering 200 says
      // nothing about the other's wrapper.
      const invocationEntry = entryFor("iss-8267-partial-unique-arbiter");
      const invocationFixture = invocationFixtureSchema.parse(
        readFixtureJson(invocationEntry.file)
      );
      const [firstPart] = invocationFixture.parts;
      if (!firstPart) {
        throw new Error("invocation fixture carried no part");
      }
      const invocationResponse = await invocationsSyncPost(
        syncRequest(
          seededLane,
          "/desktop/agent-sessions/invocations/sync",
          {
            protocolVersion: (firstPart as { protocolVersion: number })
              .protocolVersion,
            parts: [firstPart],
          },
          false
        ),
        routeContext()
      );
      expect(invocationResponse.status).toBe(200);

      // And the seed's own refusals are on this path too: the same run with no
      // secret writes nothing, so a future edit that made minting unconditional
      // cannot pass this case.
      const withoutSecret: NodeJS.ProcessEnv = { ...seedEnv };
      Reflect.deleteProperty(withoutSecret, E2E_SEED_API_KEY_ENV);
      expect(resolveSeedApiKeyDecision(withoutSecret)).toEqual({
        mint: false,
        reason: "no-secret",
      });
    });

    it.each([
      "iss-8271-sentinel-data-revision",
      "iss-8271-sentinel-maintenance-stale",
      "iss-8069-oversized-index-key",
    ])(
      "accepts the %s payload and stores exactly what it carries",
      async (slug) => {
        const entry = entryFor(slug);
        const lane = await createLane();
        const { statuses, bodies } = await replaySessionFixture(lane, entry);

        expect(statuses).toEqual(
          Array.from({ length: entry.parts }, () => 200)
        );
        // The POSITIVE form of "the batch was accepted": the row-level ack names
        // the sessions the server persisted. A `synced: true` alone is satisfied
        // by an ingest that silently wrote nothing.
        //
        // Scaled by `entry.parts` like the status assertion above. Every
        // fixture is single-part today, so a hardcoded one-element array would
        // pass now and fail confusingly the first time a seed grows past the
        // chunk cap — on the shape of the assertion rather than the contract.
        expect(bodies).toEqual(
          Array.from({ length: entry.parts }, () => acceptedBody(entry))
        );
        const counts = await storedCounts(lane.organizationId);
        expect(counts).toMatchObject(entry.expected);
        expect(await deadLetterCounts(lane.organizationId)).toEqual({
          deadLetters: 0,
          pendingRetries: 0,
          quarantines: 0,
        });
      }
    );

    it("accepts a session carrying more token events than the removed cap allowed", async () => {
      const entry = entryFor("iss-8051-token-events-over-historical-cap");
      // The recording must actually be over the historical bound, or the replay
      // is a no-op against a reintroduced cap.
      expect(entry.expected.tokenEvents).toBeGreaterThan(10_000);
      const lane = await createLane();
      const { statuses, bodies } = await replaySessionFixture(lane, entry);
      expect(statuses).toEqual([200]);
      expect(bodies).toEqual([acceptedBody(entry)]);

      const counts = await storedCounts(lane.organizationId);
      // Every event, not merely "some": a truncating cap and a rejecting one
      // are different defects and only the count tells them apart.
      expect(counts.tokenEvents).toBe(entry.expected.tokenEvents);
      expect(counts.sessions).toBe(entry.expected.sessions);
      expect(await deadLetterCounts(lane.organizationId)).toEqual({
        deadLetters: 0,
        pendingRetries: 0,
        quarantines: 0,
      });
    });

    it("materializes the internal branch target for a registered repository", async () => {
      const entry = entryFor("iss-8780-internal-branch-target");
      expect(entry.requiresRepositoryAuthority).toBe(true);
      const repositoryFullName = entry.repositoryFullName;
      expect(repositoryFullName).not.toBeNull();

      const lane = await createLane();
      await registerRepositoryAuthority(
        lane.organizationId,
        repositoryFullName as string
      );

      const { statuses } = await replaySessionFixture(lane, entry);
      expect(statuses).toEqual([200]);

      const branch = await branchFor(lane.organizationId, repositoryFullName);
      expect(branch?.branchName).toBe("feat/contract-replay-iss8780");

      const counts = await storedCounts(lane.organizationId);
      expect(counts.sessions).toBe(entry.expected.sessions);
      expect(counts.branchDetails).toBe(1);
      // THE POSITIVE PROOF, and it is the ATOM rather than the branch row.
      // Measured while building this: with `ensureInternalBranchActivityTargets`
      // broken, the branch row is still created by the branch-REF path and a
      // `branchDetails === 1` assertion stays green. The monitored-activity atom
      // is what only this path produces — it exists only for a target this
      // helper resolved — so it is what distinguishes "the internal-branch-target
      // path ran" from "some other writer happened to make the same row".
      expect(counts.branchActivityAtoms).toBe(1);
      // One PENDING retry is the healthy outcome here, not a defect: the ref
      // carries a non-push method, so the branch lane schedules a re-check for
      // push evidence it has not seen. Nothing is dead-lettered and nothing is
      // quarantined, which is what "the batch was fully accepted" means.
      expect(await deadLetterCounts(lane.organizationId)).toEqual({
        deadLetters: 0,
        pendingRetries: 1,
        quarantines: 0,
      });
    });

    it("does not reach that path at all without a registered repository", async () => {
      // THE NEGATIVE CONTROL, and the reason the case above is evidence rather
      // than decoration. `ensureInternalBranchActivityTargets` drops every target
      // whose repository authority is undefined, so the identical fixture into an
      // UNREGISTERED repository still answers 200 and still stores its session —
      // and materializes nothing. Without this pair, forgetting the registration
      // would leave the case above green while exercising none of the code the
      // #6576 mutation lives in.
      const entry = entryFor("iss-8780-internal-branch-target");
      const lane = await createLane();
      const { statuses } = await replaySessionFixture(lane, entry);
      expect(statuses).toEqual([200]);

      const counts = await storedCounts(lane.organizationId);
      expect(counts.sessions).toBe(entry.expected.sessions);
      expect(counts.branchDetails).toBe(0);
      expect(counts.branchActivityAtoms).toBe(0);
      expect(
        await branchFor(lane.organizationId, entry.repositoryFullName)
      ).toBeNull();
    });

    it("persists every monitored event of a paged carrier as a canonical atom, none re-stamped Partial", async () => {
      // ISS-9860. The recorded payload is TWO parts: the desktop chunker pages
      // the 1,260 distinct events at 1,000 per request, and each part carries
      // the full ref set with one page of carriers. The removed caps would
      // have kept 50 per target / 100 per session on the desktop and truncated
      // to 100 again at `collectCandidates`; a `.max()` returning to either
      // carrier schema would 400 the part; a re-cap of the quarantine or of
      // `persistBranchActivityAtomsInTransaction` would throw inside the slice.
      // The manifest declares the atom total from the seed, so this asserts a
      // positive count rather than the absence of an error.
      const entry = entryFor("iss-9860-monitored-activity-pages");
      expect(entry.kind).toBe("chunked");
      expect(entry.parts).toBe(2);
      expect(entry.requiresRepositoryAuthority).toBe(true);
      expect(entry.expected.branchActivityAtoms).toBeGreaterThan(1000);
      const repositoryFullName = entry.repositoryFullName;
      expect(repositoryFullName).not.toBeNull();

      const lane = await createLane();
      await registerRepositoryAuthority(
        lane.organizationId,
        repositoryFullName as string
      );

      const { statuses } = await replaySessionFixture(lane, entry);
      expect(statuses).toEqual([200, 200]);

      const counts = await storedCounts(lane.organizationId);
      expect(counts.sessions).toBe(entry.expected.sessions);
      expect(counts.branchDetails).toBe(2);
      expect(counts.branchActivityAtoms).toBe(
        entry.expected.branchActivityAtoms
      );
      expect(await partialAtomCount(lane.organizationId)).toBe(0);
      // One non-dead-letter retry row is the healthy outcome, as in the
      // ISS-8780 case above: the refs carry a non-push method, so the branch
      // lane schedules a push-evidence re-check. Measured at one row for this
      // two-branch session. Nothing is dead-lettered and nothing is quarantined.
      expect(await deadLetterCounts(lane.organizationId)).toEqual({
        deadLetters: 0,
        pendingRetries: 1,
        quarantines: 0,
      });
    });

    it("ingests the recorded invocation generation through its own route", async () => {
      const entry = entryFor("iss-8267-partial-unique-arbiter");
      const fixture = invocationFixtureSchema.parse(
        readFixtureJson(entry.file)
      );
      const lane = await createLane();
      // The invocation ingest attaches to an existing session, so establish it
      // through the session route first — the same order the desktop uses.
      const sessionEntry = entryFor("iss-8271-sentinel-maintenance-stale");
      const [seedSession] = sessionsOf(sessionEntry.file);
      if (!seedSession) {
        throw new Error("session fixture carried no session to anchor against");
      }
      const anchored: SyncedAgentSession = {
        ...seedSession,
        externalSessionId: "contract-replay-iss8267",
      };
      const seeded = await sessionsSyncPost(
        syncRequest(
          lane,
          "/desktop/agent-sessions/sync",
          batchFor([anchored], false),
          false
        ),
        routeContext()
      );
      expect(seeded.status).toBe(200);

      for (const part of fixture.parts) {
        const response = await invocationsSyncPost(
          syncRequest(
            lane,
            "/desktop/agent-sessions/invocations/sync",
            // The route takes a single-part BATCH envelope, and the envelope's
            // version must not understate the part it carries — an older API's
            // pre-parse gate reads the envelope, not the part.
            {
              protocolVersion: (part as { protocolVersion: number })
                .protocolVersion,
              parts: [part],
            },
            false
          ),
          routeContext()
        );
        // A 42P10 from the partial-unique arbiter surfaces here as a 500, and a
        // schema disagreement as a 400; both are the defect this stands for.
        expect(response.status).toBe(200);
      }

      const counts = await storedCounts(lane.organizationId);
      expect(counts.invocations).toBe(entry.expected.invocations);
      expect(await deadLetterCounts(lane.organizationId)).toEqual({
        deadLetters: 0,
        pendingRetries: 0,
        quarantines: 0,
      });
    });

    it("names the failing field path when it does reject a payload", async () => {
      const lane = await createLane();
      const entry = entryFor("iss-8271-sentinel-maintenance-stale");
      const [session] = sessionsOf(entry.file);
      if (!session) {
        throw new Error("session fixture carried no session");
      }
      // `startedAt` is a required storable timestamp, so an unparseable one is a
      // genuine rejection rather than a forward-compatible unknown field. ISS-8005
      // requires the 400 to say WHICH field, so the desktop can log a cause
      // instead of an opaque `validation_failed`.
      const response = await sessionsSyncPost(
        syncRequest(
          lane,
          "/desktop/agent-sessions/sync",
          batchFor([{ ...session, startedAt: "not-a-timestamp" }], false),
          false
        ),
        routeContext()
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        code?: string;
        details?: { reason?: string };
      };
      expect(body.code).toBe(
        DesktopAgentSessionsSyncErrorCode.ValidationFailed
      );
      // The PATH, not just a rejection. `validation_failed` with no field is the
      // opaque 400 ISS-8005 exists to remove, and it is what an assertion on the
      // status alone would accept.
      expect(body.details?.reason ?? "").toContain("sessions[0].startedAt");
      // And nothing was written on the way to that verdict.
      const counts = await storedCounts(lane.organizationId);
      expect(counts.sessions).toBe(0);
    });

    it("keeps the gzip replay path honest about what it sent", () => {
      // The over-cap fixture is ~2.9 MB of JSON against a 256 KiB request cap, so
      // it only reaches the route compressed. If `syncRequest` ever stopped
      // compressing, that replay would fail as a 413 and read as a contract
      // regression; pin the transform instead of trusting it.
      const entry = entryFor("iss-8051-token-events-over-historical-cap");
      expect(entry.sizer).toBe("gzip");

      // The envelope must SAY it was compressed, and must stay silent when it
      // was not: the desktop sets `encoding` from the same flag that stamps
      // `Content-Encoding`, and omits the field entirely on an identity body.
      // Without this pair, a replay could compress the transport and ship an
      // envelope no installed desktop sends, and nothing here would notice.
      const [gzipSession] = sessionsOf(
        entryFor("iss-8271-sentinel-maintenance-stale").file
      );
      if (!gzipSession) {
        throw new Error("session fixture carried no session");
      }
      expect(batchFor([gzipSession], true).encoding).toBe(
        SyncPayloadEncoding.Gzip
      );
      expect(batchFor([gzipSession], false)).not.toHaveProperty("encoding");

      const payload = { hello: "contract replay" };
      const request = syncRequest(
        {
          organizationId: "org",
          userId: "user",
          computeTargetId: "target",
          apiKey: "sk_live_probe",
        },
        "/desktop/agent-sessions/sync",
        payload,
        true
      );
      expect(request.headers.get(SYNC_CONTENT_ENCODING_HEADER)).toBe(
        SyncPayloadEncoding.Gzip
      );
      return request.arrayBuffer().then((body) => {
        expect(
          JSON.parse(gunzipSync(Buffer.from(body)).toString("utf8"))
        ).toEqual(payload);
      });
    });
  }
);

/**
 * ISS-8049 — THE DOCUMENTED GAP, recorded rather than forced.
 *
 * That incident is a CloudRelay transport failure: the payload never reaches a
 * Next.js route handler, so no fixture replayed through `POST` can reproduce it.
 * Covering it needs a relay in the loop, which is PRD-707 D2's live harness
 * (ISS-9166) and its relay stretch item, not this layer. Adding a fifth fixture
 * here that merely exercised the route would be coverage theatre: it would go
 * green whether or not the relay defect existed.
 */
