/**
 * ISS-12017: the vibe seed's Desktop component and invocation lanes, driven
 * against a real SQLite store with the API services mocked at their module
 * boundaries, so each case asserts what the service is actually handed.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  AgentComponentInvocationSyncAckState,
  type AgentComponentInvocationSyncItem,
  type AgentComponentInvocationSyncPart,
  agentComponentInvocationGenerationHashPreimage,
} from "@repo/api/src/types/agent-component-invocation";
import { Result } from "@repo/api/src/types/result";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  componentsSync: vi.fn(),
  invocationsSync: vi.fn(),
  ensureTarget: vi.fn(),
  findTargets: vi.fn(),
}));

vi.mock("@/app/desktop/components/sync/service", () => ({
  desktopComponentsSyncService: { sync: mocks.componentsSync },
}));
vi.mock("@/app/desktop/agent-sessions/invocations/sync/service", () => ({
  desktopAgentComponentInvocationsSyncService: { sync: mocks.invocationsSync },
}));
vi.mock("../perf-import-desktop-snapshot", () => ({
  ensurePerfComputeTarget: mocks.ensureTarget,
}));
vi.mock("@repo/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/database")>()),
  withDb: (fn: (db: unknown) => unknown) =>
    fn({ computeTarget: { findMany: mocks.findTargets } }),
}));

import type { PrismaClient } from "@repo/database";
import {
  hasValidPartHash,
  sha256Hex,
} from "@/app/agent-sessions/service/component-invocation-helpers";
import { syncGoldenComponents } from "../vibe-seed/desktop-sync/components";
import { syncGoldenInvocations } from "../vibe-seed/desktop-sync/invocations";
import type { VibeSeedContext } from "../vibe-seed/stage";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const SHIFT_MS = 10 * 24 * 60 * 60 * 1000;
const BUILDER_CLOCK_ISO = "2027-01-01T00:00:00.000Z";
const COMPUTE_TARGET_ID = "0192f0a0-0000-7000-8000-0000000000c1";
const SESSION_ID = "c8a3eb17-b0f5-484e-b007-a45a230dbad7";
const USER_ID = "0192f0a0-0000-7000-8000-0000000000b1";
const TEAMMATE_TARGET_ID = "0192f0a0-0000-7000-8000-0000000000c2";
const TEAMMATE_USER_ID = "0192f0a0-0000-7000-8000-0000000000b2";
const TEAMMATE_SESSION_ID = "8a61a0c9-4cfe-716d-bed1-fb1153589bb8";
const PRIMARY_HASH = "a".repeat(64);
const VARIANT_HASH = "b".repeat(64);

let storeDir: string;
let storePath: string;

beforeEach(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "vibe-desktop-sync-"));
  storePath = join(storeDir, "agent-dashboard.sqlite");
  mocks.ensureTarget.mockResolvedValue(COMPUTE_TARGET_ID);
  mocks.findTargets.mockResolvedValue([
    {
      id: COMPUTE_TARGET_ID,
      userId: USER_ID,
      sessionDetails: [{ externalSessionId: SESSION_ID }],
    },
  ]);
});

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

describe("syncGoldenComponents", () => {
  it("sends each component with its family's other revisions as variants, clamped to now", async () => {
    writeComponentStore(storePath);
    mocks.componentsSync.mockResolvedValue(Result.ok({ synced: true }));

    await syncGoldenComponents(context(storePath));

    expect(mocks.componentsSync).toHaveBeenCalledTimes(1);
    const [input] = mocks.componentsSync.mock.calls[0] ?? [];
    expect(input.computeTargetId).toBe(COMPUTE_TARGET_ID);
    const byKey = new Map(
      input.payload.components.map((component: { externalId: string }) => [
        component.externalId,
        component,
      ])
    );
    expect(byKey.get("/build")).toMatchObject({
      componentKind: AgentComponentKind.Command,
      contentHash: PRIMARY_HASH,
      lastSeenAt: NOW.toISOString(),
      variants: [{ contentHash: VARIANT_HASH, content: "# build v1" }],
      variantsTruncated: false,
    });
    expect(byKey.get("dataviz")).toMatchObject({ variants: [] });
  });

  it("fails loudly when the service refuses the batch", async () => {
    writeComponentStore(storePath);
    mocks.componentsSync.mockResolvedValue(Result.err("forbidden"));

    await expect(syncGoldenComponents(context(storePath))).rejects.toThrow(
      "component sync refused batch 0"
    );
  });
});

describe("syncGoldenInvocations", () => {
  it("shifts every item and re-signs the generation and each part as the server verifies them", async () => {
    const items = [
      item(0, "2026-08-20T13:43:43.834Z"),
      item(1, "2026-08-20T13:44:00.000Z"),
    ];
    writeOutboxStore(storePath, [[items[0]], [items[1]]]);
    mocks.invocationsSync.mockResolvedValue(
      Result.ok({
        accepted: true,
        state: AgentComponentInvocationSyncAckState.Activated,
      })
    );

    await syncGoldenInvocations(context(storePath));

    const parts: AgentComponentInvocationSyncPart[] =
      mocks.invocationsSync.mock.calls.map(([input]) => input.part);
    expect(parts.map((part) => part.partIndex)).toStrictEqual([0, 1]);
    expect(parts.every((part) => hasValidPartHash(part))).toBe(true);
    const shiftedItems = parts.flatMap((part) => part.items);
    expect(shiftedItems.map((shifted) => shifted.invokedAt)).toStrictEqual([
      "2026-08-30T13:43:43.834Z",
      "2026-08-30T13:44:00.000Z",
    ]);
    const generationId = sha256Hex(
      agentComponentInvocationGenerationHashPreimage({
        externalSessionId: SESSION_ID,
        items: shiftedItems,
      })
    );
    expect(parts.map((part) => part.externalGenerationId)).toStrictEqual([
      generationId,
      generationId,
    ]);
    expect(parts[0]?.sourceUpdatedAt).toBe(NOW.toISOString());
  });

  it("syncs each part from the machine its session ran on (ISS-12135)", async () => {
    mocks.findTargets.mockResolvedValue([
      {
        id: COMPUTE_TARGET_ID,
        userId: USER_ID,
        sessionDetails: [{ externalSessionId: SESSION_ID }],
      },
      {
        id: TEAMMATE_TARGET_ID,
        userId: TEAMMATE_USER_ID,
        sessionDetails: [{ externalSessionId: TEAMMATE_SESSION_ID }],
      },
    ]);
    writeOutboxStore(
      storePath,
      [[item(0, "2026-08-20T13:43:43.834Z")]],
      [SESSION_ID, TEAMMATE_SESSION_ID]
    );
    mocks.invocationsSync.mockResolvedValue(
      Result.ok({
        accepted: true,
        state: AgentComponentInvocationSyncAckState.Activated,
      })
    );

    await syncGoldenInvocations(context(storePath));

    const routed = mocks.invocationsSync.mock.calls.map(([input]) => ({
      computeTargetId: input.computeTargetId,
      userId: input.userId,
      session: input.part.externalSessionId,
    }));
    expect(routed).toHaveLength(2);
    expect(routed).toEqual(
      expect.arrayContaining([
        {
          computeTargetId: COMPUTE_TARGET_ID,
          userId: USER_ID,
          session: SESSION_ID,
        },
        {
          computeTargetId: TEAMMATE_TARGET_ID,
          userId: TEAMMATE_USER_ID,
          session: TEAMMATE_SESSION_ID,
        },
      ])
    );
  });

  it("fails loudly on a rejected part instead of skipping it", async () => {
    writeOutboxStore(storePath, [[item(0, "2026-08-20T13:43:43.834Z")]]);
    mocks.invocationsSync.mockResolvedValue(
      Result.ok({ accepted: false, reason: "generation_conflict" })
    );

    await expect(syncGoldenInvocations(context(storePath))).rejects.toThrow(
      "generation_conflict"
    );
  });
});

function context(desktopStorePath: string): VibeSeedContext {
  return {
    prisma: {} as PrismaClient,
    organizationId: "0192f0a0-0000-7000-8000-0000000000a1",
    userId: USER_ID,
    desktopStorePath,
    corpusShiftMs: SHIFT_MS,
    desktopAuth: null,
    now: NOW,
    log: () => undefined,
  };
}

function writeComponentStore(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE agent_components (
      id TEXT PRIMARY KEY, component_kind TEXT, external_id TEXT,
      component_key TEXT, name TEXT, version TEXT, harness TEXT,
      description TEXT, source_url TEXT, install_path TEXT, pack_id TEXT,
      scope TEXT, project_path TEXT, metadata TEXT, content TEXT,
      content_hash TEXT, resolved_state TEXT, first_seen_at TEXT,
      last_seen_at TEXT, uninstalled_at TEXT
    );
    CREATE TABLE agent_component_versions (
      component_kind TEXT, component_key TEXT, content_hash TEXT,
      content TEXT, format TEXT, first_seen_at TEXT, last_seen_at TEXT
    );
  `);
  const insertComponent = db.prepare(
    `INSERT INTO agent_components (id, component_kind, external_id, component_key,
       content_hash, resolved_state, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, 'unresolved', ?, ?)`
  );
  insertComponent.run(
    "c1",
    AgentComponentKind.Command,
    "/build",
    "/build",
    PRIMARY_HASH,
    "2026-08-01T00:00:00.000Z",
    BUILDER_CLOCK_ISO
  );
  insertComponent.run(
    "c2",
    AgentComponentKind.Skill,
    "dataviz",
    "dataviz",
    null,
    "2026-08-01T00:00:00.000Z",
    "2026-08-02T00:00:00.000Z"
  );
  const insertVersion = db.prepare(
    `INSERT INTO agent_component_versions VALUES (?, ?, ?, ?, 'markdown', ?, ?)`
  );
  insertVersion.run(
    AgentComponentKind.Command,
    "/build",
    PRIMARY_HASH,
    "# build v2",
    BUILDER_CLOCK_ISO,
    BUILDER_CLOCK_ISO
  );
  insertVersion.run(
    AgentComponentKind.Command,
    "/build",
    VARIANT_HASH,
    "# build v1",
    "2026-07-01T00:00:00.000Z",
    "2026-07-02T00:00:00.000Z"
  );
  db.close();
}

function item(
  sequence: number,
  invokedAt: string
): AgentComponentInvocationSyncItem {
  return {
    externalInvocationId: `tool:${sequence}:${invokedAt}:Read`,
    sourceSessionId: SESSION_ID,
    kind: AgentComponentInvocationKind.Tool,
    componentKey: "Read",
    rawName: "Read",
    normalizedName: "Read",
    relationship: AgentComponentInvocationRelationship.Direct,
    invokedAt,
    sequence,
    anchor: {
      kind: AgentComponentInvocationAnchorKind.Timestamp,
      timestamp: invokedAt,
      ordinal: 0,
    },
    status: AgentComponentInvocationAttributionStatus.Unresolved,
    evidenceClass: AgentComponentInvocationEvidenceClass.None,
  };
}

/** One outbox generation whose parts carry `partItems`, in part order. */
function writeOutboxStore(
  path: string,
  partItems: readonly (readonly (
    | AgentComponentInvocationSyncItem
    | undefined
  )[])[],
  sessionIds: readonly string[] = [SESSION_ID]
): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE agent_component_invocation_sync_outbox (
      external_session_id TEXT, external_generation_id TEXT,
      part_index INTEGER, payload TEXT
    );
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
  `);
  const insertSession = db.prepare("INSERT INTO sessions VALUES (?)");
  for (const sessionId of sessionIds) {
    insertSession.run(sessionId);
  }
  const insert = db.prepare(
    "INSERT INTO agent_component_invocation_sync_outbox VALUES (?, ?, ?, ?)"
  );
  for (const sessionId of sessionIds) {
    for (const [partIndex, items] of partItems.entries()) {
      insert.run(
        sessionId,
        "stale-generation",
        partIndex,
        JSON.stringify({
          protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
          externalSessionId: sessionId,
          externalGenerationId: "c".repeat(64),
          sourceUpdatedAt: BUILDER_CLOCK_ISO,
          dataRevision: 105,
          sourceSequence: 0,
          partIndex,
          partCount: partItems.length,
          items: items.map((entry) =>
            entry === undefined
              ? entry
              : { ...entry, sourceSessionId: sessionId }
          ),
          partHash: "d".repeat(64),
        })
      );
    }
  }
  db.close();
}
