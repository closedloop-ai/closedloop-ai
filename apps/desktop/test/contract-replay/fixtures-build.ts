/**
 * @file fixtures-build.ts
 * @description ISS-9846 (PRD-707 R1) — the adversarial desktop→cloud contract
 * fixtures, built by the REAL production payload builders.
 *
 * WHY THE FIXTURES ARE RECORDED RATHER THAN IMPORTED. `apps/api` cannot reach
 * `apps/desktop`: the desktop app is `private: true`, declares no `exports`, is
 * named `desktop`, and is not one of `apps/api`'s 61 declared dependencies. So
 * the API-side replay suite cannot call `prepareAgentSessionPayload` — it reads
 * what this module produced, committed under
 * `apps/api/__tests__/fixtures/desktop-contract-replay/`.
 *
 * WHY THAT IS SAFE. A frozen copy of a builder's output is a test of the copy,
 * not of the builder, and it stays green forever while the builder drifts. The
 * staleness gate is `test/contract-replay-fixtures.test.ts`, which rebuilds
 * every fixture here through the same production builders and compares the
 * bytes. An edit to `src/main/agent-sync/agent-session-sync-payload.ts` (or the
 * invocation builder) that changes any emitted payload reds that suite until the
 * fixtures are regenerated. It lives in the DESKTOP lane because that is the
 * only side of the boundary that can run the builder at all; the API side
 * re-checks each fixture's digest against the manifest, which catches a
 * hand-edited fixture but cannot catch builder drift.
 *
 * The seeds below are hand-authored from the INCIDENTS, never from the builder
 * output — a fixture derived from the thing it guards cannot fail.
 */
import { createHash } from "node:crypto";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  type AgentComponentInvocationCompleteGeneration,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  type AgentComponentInvocationSyncItem,
} from "@repo/api/src/types/agent-component-invocation";
import { SYNC_DECOMPRESSED_CHUNK_TARGET_BYTES } from "@repo/api/src/types/agent-session-sync-limits";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/session-monitored-activity";
import { MetadataContentPolicy } from "@repo/lib/agent-sessions/metadata-preview";
import {
  computeAgentComponentInvocationGenerationId,
  prepareAgentComponentInvocationSyncParts,
} from "../../src/main/agent-sync/agent-component-invocation-sync-payload.js";
import { SESSION_PAYLOAD_CONTENT_BYTE_CAP } from "../../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import {
  gzipSyncPayloadSizer,
  identitySyncPayloadSizer,
  type SyncPayloadSizer,
} from "../../src/main/agent-sync/agent-session-sync-compression.js";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  type SyncedAgentSession,
} from "../../src/main/agent-sync/agent-session-sync-contract.js";
import { prepareAgentSessionPayload } from "../../src/main/agent-sync/agent-session-sync-payload.js";

/** Where the built fixtures are published, repo-root-relative. */
export const CONTRACT_REPLAY_FIXTURES_DIR =
  "apps/api/__tests__/fixtures/desktop-contract-replay";

export const CONTRACT_REPLAY_MANIFEST_FILE = "manifest.json";
export const CONTRACT_REPLAY_MANIFEST_VERSION = 1;

/** How to rebuild everything here. Quoted verbatim into every fixture. */
export const CONTRACT_REPLAY_REGEN_COMMAND =
  "CONTRACT_REPLAY_WRITE_FIXTURES=1 pnpm --filter desktop exec vitest run --config vitest.node.config.ts test/contract-replay-fixtures.test.ts";

const GENERATED_BY = "apps/desktop/test/contract-replay/fixtures-build.ts";

/**
 * The repository the internal-branch-target path (#6576 / ISS-8780) is replayed
 * against. `ensureInternalBranchActivityTargets` filters out every target whose
 * `repositoryAuthority` is undefined, so a branch ref into a repo the seeded
 * organisation has NOT registered exercises nothing at all and looks like
 * coverage. The API suite registers this name before replaying.
 */
export const CONTRACT_REPLAY_REPOSITORY_FULL_NAME =
  "closedloop-ai/closedloop-ai";

/**
 * The historical cardinality bound ISS-8051 removed from `tokenEvents`. Written
 * as a literal here on purpose: the constant is DELETED from the codebase (only
 * the schema's own comment names it), so there is nothing to import, and a
 * fixture sized from a live constant would move with a future re-cap instead of
 * catching it.
 */
export const ISS_8051_HISTORICAL_TOKEN_EVENT_CAP = 10_000;

const SESSION_STARTED_AT = "2026-09-01T10:00:00.000Z";
const SESSION_UPDATED_AT = "2026-09-01T11:00:00.000Z";

/**
 * A deterministic HIGH-ENTROPY string past the btree index-tuple maximum.
 *
 * The entropy is load-bearing and a low-entropy fixture is a false green: an
 * index tuple cannot be TOASTed out of line but it CAN be compressed inline, so
 * `"q".repeat(4096)` is folded to nothing by PGLZ and no limit is ever reached.
 * The API side states the same property in
 * `apps/api/__tests__/support/index-key-poison.test-fixtures.ts`; it is restated
 * rather than imported because `apps/desktop` cannot import `apps/api` test
 * support — that undeclared workspace edge is the whole reason these fixtures
 * are recorded instead of generated in-process.
 */
function overLimitIndexKey(seed: string): string {
  let digest = seed;
  let out = "";
  while (out.length < 4096) {
    digest = createHash("sha256").update(digest).digest("hex");
    out += digest;
  }
  return out.slice(0, 4096);
}

function baseSession(
  externalSessionId: string,
  overrides: Partial<SyncedAgentSession> = {}
): SyncedAgentSession {
  return {
    externalSessionId,
    name: "contract replay session",
    status: "active",
    harness: "claude",
    cwd: "/tmp/contract-replay",
    startedAt: SESSION_STARTED_AT,
    updatedAt: SESSION_UPDATED_AT,
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  };
}

/**
 * A branch ref that reaches `ensureInternalBranchActivityTargets`.
 *
 * The `method` is load-bearing and MEASURED, not assumed. A PUSH method
 * (`gh_pr_create`, `git_push`) makes the generic branch-ref lane materialize the
 * branch first, so `resolveTargets` finds it, `materializeInternalBranchTargets`
 * filters the candidate out as already resolved, and the helper returns before
 * it ever takes the advisory lock the #6576 defect lives in — the fixture drives
 * the route, stores a branch, and exercises none of the code it is named for.
 * `monitoredActivityOnly` is the opposite mistake: such a target is
 * `transportOnly` and is deliberately EXCLUDED from this materialization, so
 * nothing is created at all.
 */
function monitoredBranchRef(
  branchName: string,
  eventCount = 1
): SyncedArtifactRef {
  const startedAtMs = Date.parse(SESSION_STARTED_AT);
  return {
    kind: "branch",
    repositoryFullName: CONTRACT_REPLAY_REPOSITORY_FULL_NAME,
    branchName,
    method: ArtifactRefMethod.GitCommand,
    relation: ArtifactRefRelation.Referenced,
    observedAt: SESSION_UPDATED_AT,
    monitoredSessionActivity: {
      completeness: BranchActivityEvidenceCompleteness.Complete,
      events: Array.from({ length: eventCount }, (_, index) => ({
        kind: MonitoredSessionActivityEventKind.AgentAction,
        sourceEventId: `${branchName}-action-${index + 1}`,
        occurredAt:
          eventCount === 1
            ? SESSION_UPDATED_AT
            : new Date(startedAtMs + index * 1000).toISOString(),
        completeness: BranchActivityEvidenceCompleteness.Complete,
      })),
    },
  };
}

/**
 * ISS-9860: the two carrier sizes the paging seed carries. Literals on purpose,
 * like `ISS_8051_HISTORICAL_TOKEN_EVENT_CAP` above: the 50/100 caps this replays
 * past are DELETED, so a fixture sized from a live constant could not catch
 * their return. 1,200 exceeds the removed per-session cap and the 1,000-event
 * page, so the payload chunks into two monitored pages; the 60 on a second
 * target exceed the removed per-target cap on their own.
 */
export const ISS_9860_PAGED_TARGET_EVENTS = 1200;
export const ISS_9860_SECOND_TARGET_EVENTS = 60;
const ISS_9860_FIXTURE_DATA_REVISION = 101;

function tokenEventsOverHistoricalCap(): NonNullable<
  SyncedAgentSession["tokenEvents"]
> {
  const count = ISS_8051_HISTORICAL_TOKEN_EVENT_CAP + 1;
  const events: NonNullable<SyncedAgentSession["tokenEvents"]> = [];
  for (let index = 0; index < count; index += 1) {
    events.push({
      externalEventId: `te-${index}`,
      agentExternalId: null,
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      createdAt: SESSION_STARTED_AT,
    });
  }
  return events;
}

/** Row counts the CLOUD must end up storing, counted from the seed input. */
export type ContractReplayExpectedCounts = {
  sessions: number;
  tokenEvents: number;
  componentUsage: number;
  invocations: number;
  /** Canonical monitored-activity atoms (alias rows excluded). */
  branchActivityAtoms: number;
};

export type ContractReplaySessionSeed = {
  slug: string;
  incident: string;
  standsFor: string;
  session: SyncedAgentSession;
  /**
   * `gzip` when the payload only fits the wire under compression — the sizer
   * production selects from the negotiated `compress` capability. The API suite
   * reads this to decide whether to send `content-encoding: gzip`.
   */
  sizer: "identity" | "gzip";
  /** True when the replay needs a registered repository authority to fire. */
  requiresRepositoryAuthority: boolean;
  /**
   * The `externalSessionId`s the cloud must echo on the row-level ack.
   *
   * Declared from the SEED, never read back from the response: it is what makes
   * "the batch was accepted" a positive statement about which sessions landed
   * rather than the absence of an error. An empty list is a real expectation —
   * a held sentinel revision is accepted AND deliberately unpersisted.
   */
  expectedAcceptedSessionIds: string[];
  expected: ContractReplayExpectedCounts;
};

export type ContractReplayInvocationSeed = {
  slug: string;
  incident: string;
  standsFor: string;
  generation: AgentComponentInvocationCompleteGeneration;
  expected: ContractReplayExpectedCounts;
};

function invocationItem(
  sequence: number,
  externalSessionId: string
): AgentComponentInvocationSyncItem {
  return {
    externalInvocationId: `inv-${sequence}`,
    sourceSessionId: externalSessionId,
    kind: AgentComponentInvocationKind.Tool,
    componentKey: "Read",
    relationship: AgentComponentInvocationRelationship.Direct,
    invokedAt: SESSION_UPDATED_AT,
    sequence,
    anchor: {
      kind: AgentComponentInvocationAnchorKind.Event,
      eventId: `event-${sequence}`,
    },
    status: AgentComponentInvocationAttributionStatus.Unresolved,
    evidenceClass: AgentComponentInvocationEvidenceClass.None,
  };
}

const ISS_8267_EXTERNAL_SESSION_ID = "contract-replay-iss8267";
const ISS_8267_ITEMS = [
  invocationItem(0, ISS_8267_EXTERNAL_SESSION_ID),
  invocationItem(1, ISS_8267_EXTERNAL_SESSION_ID),
];

export const CONTRACT_REPLAY_SESSION_SEEDS: readonly ContractReplaySessionSeed[] =
  [
    {
      slug: "iss-8271-sentinel-data-revision",
      incident: "ISS-8271",
      standsFor:
        "Desktop parks rows at the local sentinel revisions -1 (import pending) and 0 (maintenance stale) and the sync lane has no revision filter, so both leak onto the wire. A `min(1)` at the wire schema rejected the WHOLE batch — the parse is batch-wide — and the reseal that heals the row emits no sync signal, so ~450 deliveries/day stranded. Both sentinels must be ACCEPTED and dispositioned per session.",
      session: baseSession("contract-replay-iss8271-sentinel-negative", {
        dataRevision: -1,
      }),
      sizer: "identity",
      requiresRepositoryAuthority: false,
      expectedAcceptedSessionIds: [],
      // The -1 sentinel is a HOLD, not a write: the batch is accepted and the
      // session is deliberately left unpersisted until the row heals. What is
      // asserted is the 200 plus the absence of any dead letter.
      expected: {
        sessions: 0,
        tokenEvents: 0,
        componentUsage: 0,
        invocations: 0,
        branchActivityAtoms: 0,
      },
    },
    {
      slug: "iss-8271-sentinel-maintenance-stale",
      incident: "ISS-8271",
      standsFor:
        "The sentinel 0 (maintenance stale) on an UNCHUNKED payload: content is complete and sealed, so it folds to `no revision` and the session is applied additively. Distinct outcome from the -1 hold above, and a schema `min(1)` rejects both identically.",
      session: baseSession("contract-replay-iss8271-sentinel-zero", {
        dataRevision: 0,
      }),
      sizer: "identity",
      requiresRepositoryAuthority: false,
      expectedAcceptedSessionIds: ["contract-replay-iss8271-sentinel-zero"],
      expected: {
        sessions: 1,
        tokenEvents: 0,
        componentUsage: 0,
        invocations: 0,
        branchActivityAtoms: 0,
      },
    },
    {
      slug: "iss-8051-token-events-over-historical-cap",
      incident: "ISS-8051",
      standsFor:
        "A session carrying more than the 10,000 token events `MAX_SYNCED_TOKEN_EVENTS_PER_SESSION` used to cap. A `.max()` on a Zod array REJECTS rather than truncates, and the route safeParses the whole batch, so one event too many dropped the session's events, agents, metadata and tiling — and re-dropped them on every retry. The producer never knew the ceiling existed.",
      session: baseSession("contract-replay-iss8051-over-cap", {
        tokenEvents: tokenEventsOverHistoricalCap(),
      }),
      // Uncompressed this payload is ~1.7 MB against a 256 KiB request cap, so
      // production reaches it only through the gzip sizer. Sizing it with the
      // identity sizer would CHUNK it into ~7 parts of ~1,400 events each and no
      // single part would carry more than 10,000 — the fixture would then be
      // green against the reintroduced cap for the wrong reason.
      sizer: "gzip",
      requiresRepositoryAuthority: false,
      expectedAcceptedSessionIds: ["contract-replay-iss8051-over-cap"],
      expected: {
        sessions: 1,
        tokenEvents: ISS_8051_HISTORICAL_TOKEN_EVENT_CAP + 1,
        componentUsage: 0,
        invocations: 0,
        branchActivityAtoms: 0,
      },
    },
    {
      slug: "iss-8069-oversized-index-key",
      incident: "ISS-8069 / ISS-8125",
      standsFor:
        "A component-usage row whose `componentKey` is far past the btree index-tuple maximum (2704 bytes). Unprojected it reaches the index and Postgres raises `index row size N exceeds btree version 4 maximum 2704` inside the ingest transaction, taking the session with it. The value is high-entropy on purpose: a compressible one is folded inline by PGLZ and never reaches any limit.",
      session: baseSession("contract-replay-iss8069-index-key", {
        components: [
          {
            componentKind: AgentComponentInvocationKind.Tool,
            componentKey: overLimitIndexKey("iss-8069-contract-replay"),
            invocations: 1,
            errorCount: 0,
          },
        ],
      }),
      sizer: "identity",
      requiresRepositoryAuthority: false,
      expectedAcceptedSessionIds: ["contract-replay-iss8069-index-key"],
      expected: {
        sessions: 1,
        tokenEvents: 0,
        componentUsage: 1,
        invocations: 0,
        branchActivityAtoms: 0,
      },
    },
    {
      slug: "iss-8780-internal-branch-target",
      incident: "ISS-8780 / #6576",
      standsFor:
        "A branch ref carrying monitored session activity into a repository the organisation has REGISTERED with a repository authority — the only shape that reaches `ensureInternalBranchActivityTargets`. That helper takes `pg_advisory_xact_lock()` per branch identity; the lock returns void, which Prisma cannot deserialize, so issuing it as `$queryRaw` throws on every execution and the whole ingest slice fails.",
      session: baseSession("contract-replay-iss8780-branch-target", {
        artifactRefs: [monitoredBranchRef("feat/contract-replay-iss8780")],
      }),
      sizer: "identity",
      requiresRepositoryAuthority: true,
      expectedAcceptedSessionIds: ["contract-replay-iss8780-branch-target"],
      expected: {
        sessions: 1,
        tokenEvents: 0,
        componentUsage: 0,
        invocations: 0,
        branchActivityAtoms: 1,
      },
    },
    {
      slug: "iss-9860-monitored-activity-pages",
      incident: "ISS-9860",
      standsFor:
        "A session whose monitored-session activity exceeds the caps the desktop collector and the cloud ingest used to apply — 50 events per target, 100 per session, a 200-entry raw scan — and the 1,000-distinct-event page the sync chunker now ships per request. Every event past the old bounds was never persisted anywhere and no cursor could reach it. The desktop pages the carriers across chunks; the cloud must persist every event of every page as a canonical atom, with its per-event statements chunked by bind budget, and neither side may re-stamp a count-driven Partial.",
      session: baseSession("contract-replay-iss9860-paged-activity", {
        // A REAL revision, because this is the one chunked replay: chunk 0 can
        // only open a pending sequence when it carries one, and without it the
        // cloud refuses every later page as a foreign chunk. A literal rather
        // than the live `DATA_REVISION` so a future bump does not change the
        // recorded bytes and force a regen of a fixture about something else.
        dataRevision: ISS_9860_FIXTURE_DATA_REVISION,
        artifactRefs: [
          monitoredBranchRef(
            "feat/contract-replay-iss9860",
            ISS_9860_PAGED_TARGET_EVENTS
          ),
          monitoredBranchRef(
            "feat/contract-replay-iss9860-second",
            ISS_9860_SECOND_TARGET_EVENTS
          ),
        ],
      }),
      sizer: "identity",
      requiresRepositoryAuthority: true,
      expectedAcceptedSessionIds: ["contract-replay-iss9860-paged-activity"],
      expected: {
        sessions: 1,
        tokenEvents: 0,
        componentUsage: 0,
        invocations: 0,
        branchActivityAtoms:
          ISS_9860_PAGED_TARGET_EVENTS + ISS_9860_SECOND_TARGET_EVENTS,
      },
    },
  ];

export const CONTRACT_REPLAY_INVOCATION_SEEDS: readonly ContractReplayInvocationSeed[] =
  [
    {
      slug: "iss-8267-partial-unique-arbiter",
      incident: "ISS-8267",
      standsFor:
        "A component-invocation generation whose cloud write lands on a model carrying the partial unique `idx_acig_one_active_per_session`. Prisma's native upsert arbitrates on the PARTIAL index's column instead of the identity named in `where`, and Postgres rejects a bare-column arbiter whose only unique is partial with 42P10 — at SQL generation time, on every call.",
      generation: {
        externalSessionId: ISS_8267_EXTERNAL_SESSION_ID,
        externalGenerationId: computeAgentComponentInvocationGenerationId(
          ISS_8267_EXTERNAL_SESSION_ID,
          ISS_8267_ITEMS
        ),
        items: ISS_8267_ITEMS,
        sourceUpdatedAt: SESSION_UPDATED_AT,
        dataRevision: 35,
        sourceSequence: 1,
      },
      expected: {
        sessions: 0,
        tokenEvents: 0,
        componentUsage: 0,
        invocations: ISS_8267_ITEMS.length,
        branchActivityAtoms: 0,
      },
    },
  ];

type FixtureProvenance = {
  warning: string;
  incident: string;
  standsFor: string;
  generatedBy: string;
  regenCommand: string;
  builders: string[];
};

const PROVENANCE_WARNING =
  "DERIVED fixture — produced by the real desktop payload builders and never hand-edited. Regenerate with the command in `regenCommand`; `apps/desktop/test/contract-replay-fixtures.test.ts` reds until you do.";

const SESSION_BUILDERS = [
  "apps/desktop/src/main/agent-sync/agent-session-sync-payload.ts",
];
const INVOCATION_BUILDERS = [
  "apps/desktop/src/main/agent-sync/agent-component-invocation-sync-payload.ts",
];

export type ContractReplayManifestEntry = {
  slug: string;
  incident: string;
  file: string;
  kind: "session" | "chunked" | "invocation-parts";
  parts: number;
  sizer: "identity" | "gzip";
  requiresRepositoryAuthority: boolean;
  repositoryFullName: string | null;
  expectedAcceptedSessionIds: string[];
  expected: ContractReplayExpectedCounts;
  /** SHA-256 of the fixture file's exact bytes, so a hand edit is detectable. */
  sha256: string;
};

export type ContractReplayManifest = {
  manifestVersion: number;
  provenance: {
    generatedBy: string;
    regenCommand: string;
    schemaVersion: number;
    maxBytes: number;
    maxDecompressedBytes: number;
    contentPolicy: string;
  };
  entries: ContractReplayManifestEntry[];
};

/** One built fixture: its filename and the exact bytes to write or compare. */
export type BuiltFixtureFile = { name: string; contents: string };

export type BuiltContractReplayFixtures = {
  files: BuiltFixtureFile[];
  manifest: ContractReplayManifest;
};

/** The one serialization, so the writer and the comparer cannot disagree. */
function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sizerFor(kind: "identity" | "gzip"): SyncPayloadSizer {
  return kind === "gzip" ? gzipSyncPayloadSizer : identitySyncPayloadSizer;
}

function buildSessionFixture(seed: ContractReplaySessionSeed): {
  contents: string;
  kind: "session" | "chunked";
  parts: number;
} {
  const provenance: FixtureProvenance = {
    warning: PROVENANCE_WARNING,
    incident: seed.incident,
    standsFor: seed.standsFor,
    generatedBy: GENERATED_BY,
    regenCommand: CONTRACT_REPLAY_REGEN_COMMAND,
    builders: SESSION_BUILDERS,
  };
  // The REAL production preparer, at the widest content tier so the fixture is
  // the shape every narrower level is a subset of.
  const prepared = prepareAgentSessionPayload(
    seed.session,
    SESSION_PAYLOAD_CONTENT_BYTE_CAP,
    sizerFor(seed.sizer),
    SYNC_DECOMPRESSED_CHUNK_TARGET_BYTES,
    false,
    MetadataContentPolicy.Retain
  );
  if (prepared.kind === "dead-letter") {
    throw new Error(
      `${seed.slug}: the desktop preparer dead-lettered this seed at ${prepared.payloadBytes} bytes — the cloud would never receive it, so a replay fixture for it would assert nothing.`
    );
  }
  if (prepared.unsendableComponentUnits) {
    throw new Error(
      `${seed.slug}: the preparer skipped component-usage units it could not fit (${JSON.stringify(prepared.unsendableComponentUnits)}). Fix the seed rather than freezing the loss.`
    );
  }
  if (prepared.kind === "chunked") {
    const chunks = [prepared.firstChunk, ...prepared.remainingChunks];
    return {
      contents: serialize({
        provenance,
        schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
        kind: "chunked",
        chunks,
      }),
      kind: "chunked",
      parts: chunks.length,
    };
  }
  return {
    contents: serialize({
      provenance,
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      kind: "session",
      sessions: [prepared.session],
    }),
    kind: "session",
    parts: 1,
  };
}

function buildInvocationFixture(seed: ContractReplayInvocationSeed): {
  contents: string;
  parts: number;
} {
  const provenance: FixtureProvenance = {
    warning: PROVENANCE_WARNING,
    incident: seed.incident,
    standsFor: seed.standsFor,
    generatedBy: GENERATED_BY,
    regenCommand: CONTRACT_REPLAY_REGEN_COMMAND,
    builders: INVOCATION_BUILDERS,
  };
  const parts = prepareAgentComponentInvocationSyncParts(seed.generation);
  if (parts.length === 0) {
    throw new Error(`${seed.slug}: the invocation preparer emitted no parts`);
  }
  return {
    contents: serialize({
      provenance,
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      kind: "invocation-parts",
      parts,
    }),
    parts: parts.length,
  };
}

/**
 * Build every fixture and its manifest from the seeds above, in memory.
 *
 * Callers either WRITE the result (the regen path) or COMPARE it against the
 * committed bytes (the standing staleness gate). Both go through this one
 * function, so the gate can never be checking something the regen would not
 * have produced.
 */
export function buildContractReplayFixtures(): BuiltContractReplayFixtures {
  const files: BuiltFixtureFile[] = [];
  const entries: ContractReplayManifestEntry[] = [];

  for (const seed of CONTRACT_REPLAY_SESSION_SEEDS) {
    const built = buildSessionFixture(seed);
    const name = `${seed.slug}.json`;
    files.push({ name, contents: built.contents });
    entries.push({
      slug: seed.slug,
      incident: seed.incident,
      file: name,
      kind: built.kind,
      parts: built.parts,
      sizer: seed.sizer,
      requiresRepositoryAuthority: seed.requiresRepositoryAuthority,
      repositoryFullName: seed.requiresRepositoryAuthority
        ? CONTRACT_REPLAY_REPOSITORY_FULL_NAME
        : null,
      expectedAcceptedSessionIds: seed.expectedAcceptedSessionIds,
      expected: seed.expected,
      sha256: createHash("sha256").update(built.contents).digest("hex"),
    });
  }

  for (const seed of CONTRACT_REPLAY_INVOCATION_SEEDS) {
    const built = buildInvocationFixture(seed);
    const name = `${seed.slug}.json`;
    files.push({ name, contents: built.contents });
    entries.push({
      slug: seed.slug,
      incident: seed.incident,
      file: name,
      kind: "invocation-parts",
      parts: built.parts,
      sizer: "identity",
      requiresRepositoryAuthority: false,
      repositoryFullName: null,
      expectedAcceptedSessionIds: [],
      expected: seed.expected,
      sha256: createHash("sha256").update(built.contents).digest("hex"),
    });
  }

  const manifest: ContractReplayManifest = {
    manifestVersion: CONTRACT_REPLAY_MANIFEST_VERSION,
    provenance: {
      generatedBy: GENERATED_BY,
      regenCommand: CONTRACT_REPLAY_REGEN_COMMAND,
      schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
      maxBytes: SESSION_PAYLOAD_CONTENT_BYTE_CAP,
      maxDecompressedBytes: SYNC_DECOMPRESSED_CHUNK_TARGET_BYTES,
      contentPolicy: MetadataContentPolicy.Retain,
    },
    entries: entries.sort((left, right) => left.slug.localeCompare(right.slug)),
  };

  files.push({
    name: CONTRACT_REPLAY_MANIFEST_FILE,
    contents: serialize(manifest),
  });
  return { files, manifest };
}
