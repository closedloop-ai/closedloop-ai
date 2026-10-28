/**
 * @description ISS-7769 (codex P2 review): observe the JSON envelopes the
 * desktop ACTUALLY serializes onto the wire, rather than reading the members
 * their types declare.
 *
 * WHY A TYPE-LEVEL READ IS NOT ENOUGH. TypeScript checks ASSIGNABILITY, not the
 * absence of extra properties. Its excess-property check fires only on a fresh
 * object literal assigned straight to an annotated target, so an envelope built
 * by a spread or handed back by a helper can carry keys its declared type never
 * mentions and still compile — `desktop-components-client.ts` builds every
 * component chunk as `{ ...payload, componentCount, components }`, which is
 * exactly that shape. A ledger read off the AST is blind to those keys by
 * construction, and egress honesty is a claim about bytes that leave the
 * process, not about declarations.
 *
 * So each helper here drives the REAL production client with an injected
 * `fetch`, captures the request body handed to the network, and reports its
 * top-level keys. The envelope itself is built by production code in every
 * case: `resolvePendingChunkTransition` for the session batch, the invocations
 * client's own `syncPart` for the invocation batch, and `AgentComponentSyncLane`
 * for the component payload (whose result is then re-enveloped and serialized by
 * the real components client).
 *
 * Everything reachable from here is send-path only — no database, no Electron,
 * no real network. The injected `fetch` answers every request locally.
 */
import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  type AgentComponentInvocationSyncPart,
} from "@repo/api/src/types/agent-component-invocation";
import {
  AgentSessionSyncMode,
  type SyncedComponent,
} from "@repo/api/src/types/agent-session";
import { ComponentSyncSendOutcome } from "../../../../main/agent-sync/agent-component-sync-dead-letter";
import { AgentComponentSyncLane } from "../../../../main/agent-sync/agent-session-sync-component-lane";
import type { SyncedAgentSession } from "../../../../main/agent-sync/agent-session-sync-contract";
import { resolvePendingChunkTransition } from "../../../../main/agent-sync/agent-session-sync-pending-chunks";
import type { DesktopAgentComponentsPayload } from "../../../../main/agent-sync/agent-session-sync-source";
import { createDesktopAgentSessionsClient } from "../../../../main/agent-sync/desktop-agent-sessions-client";
import { createDesktopAgentComponentInvocationsClient } from "../../../../main/dashboard/desktop-agent-component-invocations-client";
import { createDesktopComponentsClient } from "../../../../main/dashboard/desktop-components-client";

const PROBE_ORIGIN = "https://probe.invalid";
const PROBE_TOKEN = "probe-token";
const PROBE_COMPUTE_TARGET = "probe-compute-target";
const PROBE_AT = "2026-01-01T00:00:00.000Z";

/**
 * Top-level keys of the single JSON body a driver serialized.
 *
 * Throws rather than returning `[]` when nothing was captured or the body is
 * not a JSON object: an empty key list is indistinguishable from "this envelope
 * declares nothing", which would let the whole observed half of the audit pass
 * vacuously if a client ever short-circuited before its POST.
 */
function soleSerializedEnvelopeKeys(bodies: string[], label: string): string[] {
  if (bodies.length === 0) {
    throw new Error(
      `${label}: the production client serialized no request body — it short-circuited before its POST, so nothing was observed`
    );
  }
  const parsed: unknown = JSON.parse(bodies[0]);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `${label}: serialized body is not a JSON object, so it has no envelope fields to enumerate`
    );
  }
  return Object.keys(parsed);
}

/** A `fetch` that answers locally and records every string body sent through it. */
function captureFetch(): { fetchImpl: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  const fetchImpl = ((_input: unknown, init?: RequestInit) => {
    const body = init?.body;
    if (typeof body === "string") {
      bodies.push(body);
    }
    return Promise.resolve(
      new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

/**
 * Lane 1 — `AgentSessionSyncBatch`. The batch is built by the production
 * `resolvePendingChunkTransition` (the same builder the drain path uses) and
 * serialized by the production sessions client. `compress: false` keeps the body
 * a JSON string rather than gzip bytes.
 */
export async function observeAgentSessionSyncBatchKeys(
  session: SyncedAgentSession
): Promise<string[]> {
  const transition = resolvePendingChunkTransition(
    {
      sessionId: session.externalSessionId,
      syncMode: AgentSessionSyncMode.Incremental,
      chunks: [session],
      compress: false,
      activityChunked: false,
    },
    true
  );
  if (transition.kind !== "send") {
    throw new Error(
      `AgentSessionSyncBatch: expected a sendable chunk transition, got "${transition.kind}"`
    );
  }
  const { fetchImpl, bodies } = captureFetch();
  await createDesktopAgentSessionsClient({
    fetch: fetchImpl,
    getAccessToken: () => Promise.resolve(PROBE_TOKEN),
    getApiOrigin: () => PROBE_ORIGIN,
  }).sendBatch(transition.batch, PROBE_COMPUTE_TARGET);
  return soleSerializedEnvelopeKeys(bodies, "AgentSessionSyncBatch");
}

/**
 * Lane 2 — `AgentComponentInvocationSyncBatch`. The client builds this envelope
 * itself inside `syncPart`, so what lands in the captured body is entirely
 * producer-owned.
 */
export async function observeAgentComponentInvocationSyncBatchKeys(): Promise<
  string[]
> {
  const { fetchImpl, bodies } = captureFetch();
  await createDesktopAgentComponentInvocationsClient({
    fetch: fetchImpl,
    getAccessToken: () => Promise.resolve(PROBE_TOKEN),
    getApiOrigin: () => PROBE_ORIGIN,
    getComputeTargetId: () => PROBE_COMPUTE_TARGET,
  }).syncPart(buildProbeInvocationPart(), PROBE_COMPUTE_TARGET);
  return soleSerializedEnvelopeKeys(
    bodies,
    "AgentComponentInvocationSyncBatch"
  );
}

/**
 * Lane 3 — `DesktopAgentComponentsPayload`. Two production stages, because
 * neither alone is the wire: `AgentComponentSyncLane` builds the payload, then
 * the components client re-envelopes it as `{ ...payload, componentCount,
 * components }` and serializes THAT. The spread in the second stage is the
 * concrete reason this lane is observed rather than read off the AST.
 */
export async function observeDesktopAgentComponentsPayloadKeys(): Promise<
  string[]
> {
  let produced: DesktopAgentComponentsPayload | null = null;
  const lane = new AgentComponentSyncLane(
    {
      // A null source is the documented transient shape (`hydrateCursorFor`
      // leaves the keyset alone and reports "not hydrated"), which leaves the
      // lane at the epoch position and reads every row — what a first sync does.
      getSource: () => null,
      getSyncComputeTargetId: () => PROBE_COMPUTE_TARGET,
      listComponentCursorRows: () =>
        Promise.resolve([{ id: "probe-component", last_seen_at: PROBE_AT }]),
      loadComponentRows: () => Promise.resolve([buildProbeComponent()]),
      onComponentSyncBatchTelemetry: () => {
        // The lane's telemetry seam is not under test here.
      },
      sendComponents: (payload) => {
        produced = payload;
        return Promise.resolve({
          outcome: ComponentSyncSendOutcome.Accepted,
          firstUnsentChunkIndex: null,
          chunkCount: 1,
        });
      },
    },
    { getSourceStateGeneration: () => 1, isStarted: () => true }
  );
  await lane.syncOnce();
  if (produced === null) {
    throw new Error(
      "DesktopAgentComponentsPayload: the component lane built no payload, so nothing was observed"
    );
  }
  const { fetchImpl, bodies } = captureFetch();
  await createDesktopComponentsClient({
    fetch: fetchImpl,
    getAccessToken: () => Promise.resolve(PROBE_TOKEN),
    getApiOrigin: () => PROBE_ORIGIN,
    getComputeTargetId: () => PROBE_COMPUTE_TARGET,
  }).sync(produced);
  return soleSerializedEnvelopeKeys(bodies, "DesktopAgentComponentsPayload");
}

/** Minimal component row the lane can pack — only two fields are required. */
function buildProbeComponent(): SyncedComponent {
  return {
    externalId: "probe-component",
    componentKind: AgentComponentInvocationKind.Skill,
    lastSeenAt: PROBE_AT,
  };
}

/** One wire part, shaped as the invocation preparer emits it. */
function buildProbeInvocationPart(): AgentComponentInvocationSyncPart {
  return {
    protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
    externalSessionId: "probe-session",
    externalGenerationId: "probe-generation",
    sourceUpdatedAt: PROBE_AT,
    dataRevision: 1,
    sourceSequence: 1,
    partIndex: 0,
    partCount: 1,
    partHash: "probe-part-hash",
    items: [
      {
        externalInvocationId: "probe-invocation",
        sourceSessionId: "probe-session",
        kind: AgentComponentInvocationKind.Skill,
        componentKey: "probe-component-key",
        relationship: AgentComponentInvocationRelationship.Direct,
        invokedAt: PROBE_AT,
        sequence: 0,
        anchor: { kind: AgentComponentInvocationAnchorKind.Session },
        status: AgentComponentInvocationAttributionStatus.Matched,
        evidenceClass: AgentComponentInvocationEvidenceClass.CollectorSnapshot,
      },
    ],
  };
}
