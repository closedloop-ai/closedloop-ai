/**
 * ISS-9788 (PRD-666): the last uncovered cell of the end-to-end lattice — the
 * COMPONENT-INVENTORY and INVOCATION-PARTS sync lanes crossing the wire.
 *
 * ISS-9625 (#6863) mapped the lattice and closed the render cells; ISS-9624
 * (`local-cloud-session-reconciliation.integration.test.ts`) closed the
 * SESSION lane's wire crossing. This is the same arm for the two lanes that
 * carry components: what the desktop ships is put through the REAL cloud
 * ingress (the wire parser plus the route's service, never a row written to
 * the tables), and the cloud's rollup is reconciled against the desktop-side
 * fold over the SAME records — so a row dropped in sync or ingest reddens
 * here, which a cloud-vs-cloud comparison structurally cannot see.
 *
 * Two independently maintained halves are under test:
 *
 *   • the desktop's `prepareAgentComponentInvocationSyncParts` (the producer's
 *     own byte-bounded partition of one complete generation) against
 *     `agentComponentInvocationsService.ingestPart` plus the detail page's
 *     `loadAgentComponentInvocationReadPage`;
 *   • `parseDesktopAgentComponentsPayload` + `desktopComponentsSyncService.sync`
 *     against `agentComponentsService.listForOrg`, keyed by the org-level slug
 *     both surfaces build with the shared `encodeComponentSlug`.
 *
 * Populations are NON-EMPTY and UNEQUAL (an empty population reconciles with an
 * empty population trivially), every count is written from the seeded
 * constants below rather than read back off the fixture, and a second
 * organization is the org-scoping control.
 *
 * Seeds are COMMITTED and torn down by `createCommittedTestOrganizationTracker`
 * for the reason the sibling arms state: every read reaches the database
 * through `withDb`'s pooled client, so rows inside an uncommitted fixture
 * transaction would be invisible to it.
 */

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  type AgentComponentInvocationCompleteGeneration,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  AgentComponentInvocationSyncAckState,
  type AgentComponentInvocationSyncItem,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import { AGENT_COMPONENT_SYNC_SCHEMA_VERSION } from "@repo/api/src/types/agent-component-sync-schema-version";
import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
  type SyncedComponent,
} from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { normalizeCommandComponentKey } from "@repo/lib/sessions/command-user-turn-id";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createComputeTarget } from "@/__tests__/utils/chunked-sync-test-helpers";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { agentComponentsService } from "@/app/agent-components/service";
import { loadAgentComponentInvocationReadPage } from "@/app/agent-components/service/invocation-read";
import { agentComponentListQuerySchema } from "@/app/agent-components/validators";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { agentComponentInvocationsService } from "@/app/agent-sessions/service/component-invocations";
import { desktopAgentComponentInvocationsSyncService } from "@/app/desktop/agent-sessions/invocations/sync/service";
import { desktopComponentsSyncService } from "@/app/desktop/components/sync/service";
import { parseDesktopAgentComponentsPayload } from "@/lib/desktop-agent-components-parse";
import { parseDesktopAgentSessionsPayload } from "@/lib/desktop-agent-sessions-schema";
import {
  computeAgentComponentInvocationGenerationId,
  prepareAgentComponentInvocationSyncParts,
} from "../../../desktop/src/main/agent-sync/agent-component-invocation-sync-payload.js";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const committedOrganizations = createCommittedTestOrganizationTracker();

const SESSION_STARTED_AT = "2026-06-12T09:00:00.000Z";
const SESSION_UPDATED_AT = "2026-06-12T11:00:00.000Z";
const INVOKED_AT = "2026-06-12T10:15:00.000Z";
const SOURCE_UPDATED_AT = "2026-06-12T11:05:00.000Z";
const ALPHA_SESSION_ID = "iss9788-lanes-alpha";
/**
 * A command is keyed by its slash form on BOTH sides — the desktop's own
 * candidate producers run `normalizeCommandComponentKey`, and the cloud's
 * `admitSyncedCommandComponents` folds a bare name to the same shape — so the
 * fixture ships what a real desktop ships rather than asserting that fold.
 */
const DEPLOY_COMMAND_KEY = normalizeCommandComponentKey("deploy");
/** NUL: no kind or key can contain it, so joined keys cannot collide. */
const KEY_SEPARATOR = String.fromCharCode(0);
const BETA_SESSION_ID = "iss9788-lanes-beta";

/**
 * Written from {@link buildTargetComponents} / {@link buildTargetGenerations},
 * never read back off them: agreement alone cannot catch a change that moves
 * the desktop fold and the cloud fold TOGETHER. No two values coincide, so a
 * count landing in the wrong bucket cannot satisfy its neighbour.
 */
const TARGET_COMPONENT_COUNT = 3;
const TARGET_INVOCATION_COUNT = 4;
const TARGET_CODE_REVIEW_INVOCATIONS = 3;
const TARGET_DEPLOY_INVOCATIONS = 1;
const TARGET_ALPHA_INVOCATIONS = 3;
const TARGET_BETA_INVOCATIONS = 1;

/** Carried ONLY by the foreign organization; a read that lost its org scope folds it in. */
const FOREIGN_COMPONENT_KEY = "foreign-skill";
const FOREIGN_INVOCATION_COUNT = 1;

type SeededOrganization = {
  organizationId: string;
  userId: string;
  computeTargetId: string;
  components: SyncedComponent[];
  generations: AgentComponentInvocationCompleteGeneration[];
};

type SeededCorpus = {
  target: SeededOrganization;
  foreign: SeededOrganization;
};

let corpus: SeededCorpus;

beforeAll(async () => {
  if (hasDatabase) {
    corpus = await seedCorpus();
  }
});

afterAll(() => committedOrganizations.cleanup());

describeIfDb(
  "Component and invocation lanes: Local vs Cloud reconciliation (ISS-9788)",
  () => {
    it("accepts historical invocation replay from a new machine without copying parent sessions", async () => {
      const computeTargetId = await createComputeTarget(
        corpus.target.organizationId,
        corpus.target.userId,
        "invocation-replay-new-machine"
      );
      const part = prepareAgentComponentInvocationSyncParts(
        corpus.target.generations[0]
      )[0];
      const result = await agentComponentInvocationsService.ingestPart({
        organizationId: corpus.target.organizationId,
        computeTargetId,
        part,
      });
      expect(result).toEqual({
        ok: true,
        value: { state: AgentComponentInvocationSyncAckState.Activated },
      });
      const sessionsOnNewMachine = await withDb((db) =>
        db.sessionDetail.count({ where: { computeTargetId } })
      );
      expect(sessionsOnNewMachine).toBe(0);
    });

    it("does not resolve another organization's historical session", async () => {
      const part = prepareAgentComponentInvocationSyncParts(
        corpus.foreign.generations[0]
      )[0];
      const result = await agentComponentInvocationsService.ingestPart({
        organizationId: corpus.target.organizationId,
        computeTargetId: corpus.target.computeTargetId,
        part,
      });
      expect(result).toEqual({
        ok: false,
        error: AgentComponentInvocationSyncRejectReason.SessionMissing,
      });
    });

    it("does not choose between duplicate historical sessions on different machines", async () => {
      const scope = {
        organizationId: corpus.target.organizationId,
        userId: corpus.target.userId,
      };
      const sourceA = await createComputeTarget(
        scope.organizationId,
        scope.userId,
        "invocation-replay-source-a"
      );
      const sourceB = await createComputeTarget(
        scope.organizationId,
        scope.userId,
        "invocation-replay-source-b"
      );
      const externalSessionId = "invocation-replay-ambiguous";
      await ingestParentSessions(
        { ...scope, computeTargetId: sourceA },
        [externalSessionId],
        "invocation-replay-source-a"
      );
      await ingestParentSessions(
        { ...scope, computeTargetId: sourceB },
        [externalSessionId],
        "invocation-replay-source-b"
      );
      const historical = generation(externalSessionId, [
        item(
          "ambiguous-1",
          externalSessionId,
          AgentComponentInvocationKind.Skill,
          "code-review",
          0
        ),
      ]);
      const part = prepareAgentComponentInvocationSyncParts(historical)[0];
      expect(
        await agentComponentInvocationsService.ingestPart({
          organizationId: scope.organizationId,
          computeTargetId: corpus.target.computeTargetId,
          part,
        })
      ).toEqual({
        ok: false,
        error: AgentComponentInvocationSyncRejectReason.SessionMissing,
      });
    });

    it("reconciles the desktop's shipped inventory against the cloud's component list", async () => {
      // Both surfaces build the org-level identity with the SHARED slug encoder —
      // the desktop's Agents view resolves detail hrefs by it — so identity is
      // the unit of reconciliation and a dropped row is a missing slug.
      const local = corpus.target.components.map((component) =>
        encodeComponentSlug(
          component.componentKind,
          component.componentKey,
          component.name
        )
      );
      const cloud = await agentComponentsService.listForOrg(
        corpus.target.organizationId,
        agentComponentListQuerySchema.parse({})
      );

      expect(
        cloud.items.map((item) => item.slug).sort(),
        "every component the desktop shipped must be listed once, and nothing else"
      ).toEqual([...local].sort());
      expect(cloud.total).toBe(local.length);
      // Neither side alone: a fixture that shipped nothing would agree with an
      // empty list.
      expect(local).toHaveLength(TARGET_COMPONENT_COUNT);

      // ORG SCOPING. The control must EXIST before its exclusion means anything.
      const foreign = await agentComponentsService.listForOrg(
        corpus.foreign.organizationId,
        agentComponentListQuerySchema.parse({})
      );
      const foreignSlug = encodeComponentSlug(
        AgentComponentKind.Skill,
        FOREIGN_COMPONENT_KEY
      );
      expect(foreign.items.map((item) => item.slug)).toEqual([foreignSlug]);
      expect(cloud.items.map((item) => item.slug)).not.toContain(foreignSlug);
    });

    it("reconciles the desktop's prepared invocation parts against the cloud's per-component read", async () => {
      // The desktop fold: the items the producer's own partition put on the wire,
      // counted per (kind, key) and per source session. A part the cloud refused
      // or a row ingest lost shows up ONLY here — every per-part ack below was
      // `accepted`, which is exactly why the acks alone prove nothing.
      const localByComponent = new Map<string, number>();
      const localBySession = new Map<string, number>();
      for (const generation of corpus.target.generations) {
        for (const part of prepareAgentComponentInvocationSyncParts(
          generation
        )) {
          for (const item of part.items) {
            const key = `${item.kind}${KEY_SEPARATOR}${item.componentKey}`;
            localByComponent.set(key, (localByComponent.get(key) ?? 0) + 1);
            localBySession.set(
              item.sourceSessionId,
              (localBySession.get(item.sourceSessionId) ?? 0) + 1
            );
          }
        }
      }

      const inventory = await agentComponentsService.listForOrg(
        corpus.target.organizationId,
        agentComponentListQuerySchema.parse({})
      );
      const cloudBySession = new Map<string, number>();
      let cloudTotal = 0;
      for (const [key, localCount] of localByComponent) {
        const [kind, componentKey] = key.split(KEY_SEPARATOR) as [
          string,
          string,
        ];
        const page = await withDb((db) =>
          loadAgentComponentInvocationReadPage(db, {
            organizationId: corpus.target.organizationId,
            kind,
            key: componentKey,
            // Both arms of the read's `OR`: the attributed rows through the
            // inventory ids and the unattributed ones through the key fold, so
            // whether `relinkActiveForComputeTarget` has run cannot move the count.
            inventoryIds: inventory.items
              .filter(
                (item) =>
                  item.slug === encodeComponentSlug(kind, componentKey, null)
              )
              .map((item) => item.id),
          })
        );
        expect(
          page.total,
          `the cloud read and the desktop partition must count one invocation population for ${kind}:${componentKey}`
        ).toBe(localCount);
        cloudTotal += page.total;
        for (const row of page.items) {
          cloudBySession.set(
            row.externalSessionId,
            (cloudBySession.get(row.externalSessionId) ?? 0) + 1
          );
        }
      }

      // Whole-object, per session: an equal grand total can hide a row that
      // landed on the wrong session's generation.
      expect(Object.fromEntries(cloudBySession)).toEqual(
        Object.fromEntries(localBySession)
      );
      // Neither side alone, and the populations are unequal by construction.
      expect(cloudTotal).toBe(TARGET_INVOCATION_COUNT);
      expect(
        localByComponent.get(
          `${AgentComponentInvocationKind.Skill}${KEY_SEPARATOR}code-review`
        )
      ).toBe(TARGET_CODE_REVIEW_INVOCATIONS);
      expect(
        localByComponent.get(
          `${AgentComponentInvocationKind.Command}${KEY_SEPARATOR}${DEPLOY_COMMAND_KEY}`
        )
      ).toBe(TARGET_DEPLOY_INVOCATIONS);
      expect(localBySession.get(ALPHA_SESSION_ID)).toBe(
        TARGET_ALPHA_INVOCATIONS
      );
      expect(localBySession.get(BETA_SESSION_ID)).toBe(TARGET_BETA_INVOCATIONS);

      // KNOWN-LEGITIMATE DIVERGENCE, not asserted: `AgentComponent.invocations`
      // on the list row is the SESSION lane's `componentUsage` rollup, a
      // different population from the invocation-parts lane, so it is not
      // compared against this count. And the cloud folds `componentKey` through
      // `normalizeAgentComponentInvocationKey` (lower-case) before it reads, so a
      // mixed-case key would count once here and twice locally; every key seeded
      // below is already lower-case.

      // ORG SCOPING. Assert the control exists before reading anything into its
      // absence.
      const foreignInventory = await agentComponentsService.listForOrg(
        corpus.foreign.organizationId,
        agentComponentListQuerySchema.parse({})
      );
      const foreignPage = await withDb((db) =>
        loadAgentComponentInvocationReadPage(db, {
          organizationId: corpus.foreign.organizationId,
          kind: AgentComponentInvocationKind.Skill,
          key: FOREIGN_COMPONENT_KEY,
          // Attributed to its own inventory row, so the same both-arms read the
          // target uses; `[]` here would read only the unattributed arm.
          inventoryIds: foreignInventory.items.map((item) => item.id),
        })
      );
      expect(foreignPage.total).toBe(FOREIGN_INVOCATION_COUNT);
      const leaked = await withDb((db) =>
        loadAgentComponentInvocationReadPage(db, {
          organizationId: corpus.target.organizationId,
          kind: AgentComponentInvocationKind.Skill,
          key: FOREIGN_COMPONENT_KEY,
          // The FOREIGN inventory ids on purpose: a read that lost its org scope
          // would find the foreign rows through them.
          inventoryIds: foreignInventory.items.map((item) => item.id),
        })
      );
      expect(
        leaked.total,
        "a read that lost `session.artifact.organizationId` folds the foreign invocation in"
      ).toBe(0);
    });
  }
);

/**
 * The three inventory rows the target organization receives over the wire —
 * one of each kind the invocation corpus below names, plus a hook nothing
 * invokes, so the inventory population is not a restatement of the invocation
 * population.
 */
function buildTargetComponents(): SyncedComponent[] {
  return [
    component(AgentComponentKind.Skill, "code-review"),
    component(AgentComponentKind.Command, DEPLOY_COMMAND_KEY),
    component(AgentComponentKind.Hook, "pre-commit"),
  ];
}

/**
 * | session | invocations                                   |
 * |---------|-----------------------------------------------|
 * | alpha   | skill code-review ×2, command deploy ×1       |
 * | beta    | skill code-review ×1                          |
 *
 * `code-review` spans BOTH sessions so the per-session split is not a
 * restatement of the per-component one.
 */
function buildTargetGenerations(): AgentComponentInvocationCompleteGeneration[] {
  return [
    generation(ALPHA_SESSION_ID, [
      item(
        "a1",
        ALPHA_SESSION_ID,
        AgentComponentInvocationKind.Skill,
        "code-review",
        0
      ),
      item(
        "a2",
        ALPHA_SESSION_ID,
        AgentComponentInvocationKind.Command,
        DEPLOY_COMMAND_KEY,
        1
      ),
      item(
        "a3",
        ALPHA_SESSION_ID,
        AgentComponentInvocationKind.Skill,
        "code-review",
        2
      ),
    ]),
    generation(BETA_SESSION_ID, [
      item(
        "b1",
        BETA_SESSION_ID,
        AgentComponentInvocationKind.Skill,
        "code-review",
        0
      ),
    ]),
  ];
}

async function seedCorpus(): Promise<SeededCorpus> {
  const target = await seedOrganization({
    machineName: "iss9788-target",
    sessionIds: [ALPHA_SESSION_ID, BETA_SESSION_ID],
    components: buildTargetComponents(),
    generations: buildTargetGenerations(),
  });
  const foreignSessionId = "iss9788-lanes-foreign";
  const foreign = await seedOrganization({
    machineName: "iss9788-foreign",
    sessionIds: [foreignSessionId],
    components: [component(AgentComponentKind.Skill, FOREIGN_COMPONENT_KEY)],
    generations: [
      generation(foreignSessionId, [
        item(
          "f1",
          foreignSessionId,
          AgentComponentInvocationKind.Skill,
          FOREIGN_COMPONENT_KEY,
          0
        ),
      ]),
    ],
  });
  return { target, foreign };
}

/**
 * Ingest one organization's corpus through the REAL cloud ingress of each lane:
 * the session lane first (an invocation generation hangs off its parent
 * session row), then the component lane's parser + service, then the
 * invocation lane's service over the desktop's own prepared parts.
 *
 * A rejected payload is a thrown fixture-build error, never an assertion: the
 * suites own the behavioural expectations.
 */
async function seedOrganization(input: {
  machineName: string;
  sessionIds: string[];
  components: SyncedComponent[];
  generations: AgentComponentInvocationCompleteGeneration[];
}): Promise<SeededOrganization> {
  const organizationId = await committedOrganizations.create();
  const user = await createTestUser(organizationId);
  const computeTargetId = await createComputeTarget(
    organizationId,
    user.id,
    input.machineName
  );
  const scope = { organizationId, userId: user.id, computeTargetId };

  await ingestParentSessions(scope, input.sessionIds, input.machineName);
  await ingestComponents(scope, input.components, input.machineName);
  await ingestGenerations(scope, input.generations, input.machineName);

  return {
    organizationId,
    userId: user.id,
    computeTargetId,
    components: input.components,
    generations: input.generations,
  };
}

type IngestScope = {
  organizationId: string;
  userId: string;
  computeTargetId: string;
};

async function ingestParentSessions(
  scope: IngestScope,
  sessionIds: string[],
  machineName: string
): Promise<void> {
  const parsed = parseDesktopAgentSessionsPayload({
    schemaVersion: AGENT_SESSION_SYNC_SCHEMA_VERSION,
    batchId: "00000000-0000-4000-8000-000000009788",
    syncMode: AgentSessionSyncMode.Backfill,
    sessionCount: sessionIds.length,
    sessions: sessionIds.map((externalSessionId) => ({
      externalSessionId,
      name: externalSessionId,
      status: SESSION_STATUS.ACTIVE,
      harness: "claude",
      startedAt: SESSION_STARTED_AT,
      updatedAt: SESSION_UPDATED_AT,
      agents: [],
      events: [],
      tokenUsageByModel: [],
    })),
  });
  if (!parsed.ok) {
    throw new Error(
      `${machineName}: session fixture failed the cloud ingress contract: ${parsed.reason}`
    );
  }
  await agentSessionsService.upsertSessions(scope, parsed.payload);
}

async function ingestComponents(
  scope: IngestScope,
  components: SyncedComponent[],
  machineName: string
): Promise<void> {
  const parsed = parseDesktopAgentComponentsPayload({
    schemaVersion: AGENT_COMPONENT_SYNC_SCHEMA_VERSION,
    batchId: "00000000-0000-4000-8000-000000009789",
    syncMode: AgentSessionSyncMode.Backfill,
    componentCount: components.length,
    components,
  });
  if (!parsed.ok) {
    throw new Error(
      `${machineName}: component fixture failed the cloud ingress contract: ${parsed.reason}`
    );
  }
  const result = await desktopComponentsSyncService.sync({
    clerkUserId: null,
    ...scope,
    payload: parsed.payload,
  });
  if (!result.ok) {
    throw new Error(`${machineName}: component sync refused: ${result.error}`);
  }
}

async function ingestGenerations(
  scope: IngestScope,
  generations: AgentComponentInvocationCompleteGeneration[],
  machineName: string
): Promise<void> {
  for (const generation of generations) {
    for (const part of prepareAgentComponentInvocationSyncParts(generation)) {
      const result = await desktopAgentComponentInvocationsSyncService.sync({
        clerkUserId: null,
        ...scope,
        part,
        // The invocation lane keeps its server-owned org-policy gate; this
        // fixture never writes the organization settings row it reads.
      });
      if (
        !(
          result.ok &&
          result.value.accepted &&
          result.value.state === AgentComponentInvocationSyncAckState.Activated
        )
      ) {
        throw new Error(
          `${machineName}: invocation part ${part.partIndex} of ${part.externalSessionId} was not activated: ${JSON.stringify(result)}`
        );
      }
    }
  }
}

function component(
  componentKind: AgentComponentKind,
  componentKey: string
): SyncedComponent {
  return {
    externalId: `${componentKind}:${componentKey}`,
    componentKind,
    componentKey,
    name: componentKey,
    harness: "claude",
    firstSeenAt: SESSION_STARTED_AT,
    lastSeenAt: SESSION_UPDATED_AT,
  };
}

function generation(
  externalSessionId: string,
  items: AgentComponentInvocationSyncItem[]
): AgentComponentInvocationCompleteGeneration {
  return {
    externalSessionId,
    // The identity the producer stamps and the preparer re-checks — computed
    // by the desktop's own helper so the fixture cannot drift from it.
    externalGenerationId: computeAgentComponentInvocationGenerationId(
      externalSessionId,
      items
    ),
    sourceUpdatedAt: SOURCE_UPDATED_AT,
    dataRevision: 1,
    sourceSequence: 1,
    items,
  };
}

function item(
  externalInvocationId: string,
  sourceSessionId: string,
  kind: AgentComponentInvocationKind,
  componentKey: string,
  sequence: number
): AgentComponentInvocationSyncItem {
  return {
    externalInvocationId,
    sourceSessionId,
    kind,
    componentKey,
    relationship: AgentComponentInvocationRelationship.Direct,
    invokedAt: INVOKED_AT,
    sequence,
    anchor: {
      kind: AgentComponentInvocationAnchorKind.Event,
      eventId: `${externalInvocationId}-event`,
    },
    status: AgentComponentInvocationAttributionStatus.Unresolved,
    evidenceClass: AgentComponentInvocationEvidenceClass.None,
  };
}
