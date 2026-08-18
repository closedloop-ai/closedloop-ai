/**
 * @file desktop-components-client.ts
 * @description Typed client for the component-inventory control-plane route
 * (`POST /desktop/components/sync`), consumed by the component sync lane in
 * {@link AgentSessionSyncService} (Gap B / #2570 follow-up).
 *
 * Mirrors the {@link createDesktopTranscriptsClient} transport: a Bearer token
 * from `DesktopSessionManager` + the configured API origin — the same
 * first-party authenticated HTTP transport the session sync lane and the
 * transcript control plane use.
 *
 * ISS-4542: the `sync` method resolves a classified {@link ComponentSyncSendResult}
 * (never throws): `Accepted` only when the whole batch reached the cloud;
 * `LaneFailure` (not signed in / no compute target / no origin / transport /
 * timeout / a bare HTTP 400 version-skew / 401/403/408/429 / any 5xx) which the
 * sync lane treats as "pause without advancing the cursor or charging the
 * poison-row budget"; and
 * `BatchRejected` (a permanent per-batch 4xx, or a locally-oversized component)
 * which charges the lane's bounded dead-letter budget so a genuine poison batch is
 * eventually dead-lettered to the back of the line instead of head-of-line-blocking
 * the whole lane. Swallowing every failure keeps the component lane from crashing
 * the shared 5s sync tick.
 *
 * FEA-3621: the server enforces a 256 KiB request body cap and 413s a larger
 * body. A large org's component batch exceeds that in a single POST, so `sync`
 * splits the components array into sub-cap chunks (by serialized byte size, not
 * element count) and POSTs each sequentially. Because the server upserts each
 * component idempotently by its `(computeTargetId, componentKind,
 * externalComponentId)` key, chunking and retries never drop or double-count a
 * component. `sync` reports `Accepted` only when EVERY chunk is acked, so the
 * caller advances its cursor atomically for the whole batch (a partial failure
 * re-sends the same rows next tick).
 *
 * FEA-3692 (safety net): a single component that STILL exceeds the per-request
 * budget on its own is NOT silently dropped. The desktop already clamps `content`
 * by its serialized byte size (`clampSyncedComponentContent`) so this branch is
 * unreachable for real bodies, but were it ever hit — a future field bloating the
 * envelope, a schema drift — `sync` reports `BatchRejected` (ISS-4542) INSTEAD of
 * `Accepted`. Reporting success while an oversized definition is dropped would
 * advance the durable cursor past a component that never reached the cloud (silent
 * data loss); classifying it `BatchRejected` instead lets the lane's bounded
 * dead-letter budget advance PAST the poison row rather than block the lane
 * forever (the pre-ISS-4542 `false`/retry-in-place behavior). The sendable sub-cap
 * chunks are still POSTed best-effort first (they upsert idempotently), so the only
 * rows held back are the genuinely-oversized ones.
 */
import {
  ComponentSyncSendOutcome,
  type ComponentSyncSendResult,
  classifyComponentSyncHttpStatus,
} from "../agent-sync/agent-component-sync-dead-letter.js";
import type { DesktopAgentComponentsPayload } from "../agent-sync/agent-session-sync-source.js";
import { resolveDesktopCloudCredential } from "../auth/desktop-cloud-credential.js";
import {
  createTransitionLogger,
  errorMessage,
} from "../diagnostics/component-sync-diagnostics.js";

const COMPONENTS_SYNC_REQUEST_TIMEOUT_MS = 30_000;

/**
 * FEA-3621: server-side body cap for `POST /desktop/components/sync`
 * (`DESKTOP_COMPONENTS_SYNC_REQUEST_MAX_BYTES` = 262_144). Mirrors the
 * agent-session lane's `SESSION_PAYLOAD_BYTE_CAP`. A serialized body larger
 * than this is rejected with HTTP 413, so we split the components array into
 * sub-cap chunks and POST each separately.
 */
export const COMPONENTS_SYNC_REQUEST_MAX_BYTES = 262_144; // 256 KiB

/**
 * Headroom reserved below the hard cap for the JSON envelope that wraps the
 * components array (`schemaVersion`, `batchId`, `syncMode`, `componentCount`,
 * plus the array brackets/commas). The envelope is only a few dozen bytes, but
 * we keep a comfortable margin so a chunk packed right up to the budget still
 * serializes under the server cap.
 */
const COMPONENTS_CHUNK_ENVELOPE_HEADROOM_BYTES = 8192; // 8 KiB

/** Serialized-byte budget the components of a single chunk may occupy. */
export const COMPONENTS_CHUNK_BYTE_BUDGET =
  COMPONENTS_SYNC_REQUEST_MAX_BYTES - COMPONENTS_CHUNK_ENVELOPE_HEADROOM_BYTES;

const TAG = "components-sync-client";

const textEncoder = new TextEncoder();

type SyncedComponent = DesktopAgentComponentsPayload["components"][number];

/** UTF-8 byte length of a string (matches the server's `TextEncoder` check). */
function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

/**
 * FEA-3621: split a components array into chunks whose serialized JSON stays
 * under {@link COMPONENTS_CHUNK_BYTE_BUDGET}. Boundaries are computed from the
 * actual UTF-8 byte size of each element (`,`-joined) — NOT element count — so
 * a handful of large components still packs into sub-cap requests.
 *
 * Each element is measured once. A component whose own serialized size already
 * exceeds the budget is returned as a singleton "oversized" chunk: the caller
 * logs + skips it (it can never fit the cap, exactly like the agent-session
 * lane's dead-letter of a locally-oversized session) rather than emitting a
 * body that is guaranteed to 413. The relative order of components is preserved
 * across chunks so the caller's cursor semantics are unaffected.
 */
export function chunkComponentsByByteSize(
  components: SyncedComponent[],
  byteBudget: number = COMPONENTS_CHUNK_BYTE_BUDGET
): { chunks: SyncedComponent[][]; oversized: SyncedComponent[] } {
  const chunks: SyncedComponent[][] = [];
  const oversized: SyncedComponent[] = [];
  let current: SyncedComponent[] = [];
  let currentBytes = 0;

  for (const component of components) {
    // Serialized size of this element on its own. Adding it to a chunk costs
    // its own bytes plus one separator comma when the chunk is non-empty.
    const componentBytes = byteLength(JSON.stringify(component));

    if (componentBytes > byteBudget) {
      // A single component that alone blows the budget can never fit a sub-cap
      // request. Flush the in-progress chunk, then set it aside for the caller
      // to log + skip (no request is emitted for it).
      if (current.length > 0) {
        chunks.push(current);
        current = [];
        currentBytes = 0;
      }
      oversized.push(component);
      continue;
    }

    const separatorBytes = current.length > 0 ? 1 : 0;
    if (
      current.length > 0 &&
      currentBytes + separatorBytes + componentBytes > byteBudget
    ) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(component);
    currentBytes += (current.length > 1 ? 1 : 0) + componentBytes;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return { chunks, oversized };
}

export type DesktopComponentsClientOptions = {
  fetch?: typeof fetch;
  getAccessToken: () => Promise<string | null>;
  getApiOrigin: () => string | undefined;
  /**
   * The relay-scoped compute target the inventory rows belong to. Returns `null`
   * when none is known yet (offline / pre-auth) → the POST is skipped and `sync`
   * resolves to `false`, matching the sync service's "not-connected → no-op".
   */
  getComputeTargetId: () => string | null;
};

type ResolvedRequest = {
  url: URL;
  token: string;
};

export type DesktopComponentsClient = {
  /**
   * POST a component inventory batch to `/desktop/components/sync`. Resolves a
   * {@link ComponentSyncSendResult} (ISS-4542): `Accepted` on a full 2xx,
   * `BatchRejected` on a permanent per-batch 4xx (or a locally-oversized
   * component) that should burn the poison-row budget toward dead-lettering, and
   * `LaneFailure` on a lane-wide condition (not signed in, no compute target, no
   * origin, transport/timeout error, HTTP 401/403/408/429, or any 5xx) that must
   * pause the lane WITHOUT advancing the cursor or charging the poison budget.
   */
  sync(
    payload: DesktopAgentComponentsPayload
  ): Promise<ComponentSyncSendResult>;
};

export function createDesktopComponentsClient(
  options: DesktopComponentsClientOptions
): DesktopComponentsClient {
  const fetchImpl = options.fetch ?? fetch;

  // Transition-based diagnostics: the component lane's skip branches used to be
  // silent (or DEBUG-only), so a first-party auth/transport failure looked
  // identical to "no components collected". We log a branch reason only when the
  // outcome changes, so a stuck failure names itself exactly once (no per-tick
  // spam) and a later success logs a one-line recovery. Grep `components-sync-client`.
  // Shared with the sync-service lane via `createTransitionLogger` (same behavior).
  const { note } = createTransitionLogger(TAG);

  // Resolve the first-party Desktop session token via the shared desktop-wide
  // policy, or null (with a named skip) when it is unavailable.
  const resolveCredential = async (): Promise<string | null> => {
    const credential = await resolveDesktopCloudCredential(options, (error) =>
      note(
        "warn",
        "access-token-error",
        `component sync: access token fetch threw: ${errorMessage(error)}`
      )
    );
    if (!credential) {
      note(
        "warn",
        "no-credential",
        "component sync skipped: no first-party session token available (sign in to sync components)"
      );
      return null;
    }
    return credential.token;
  };

  const buildRequest = async (): Promise<ResolvedRequest | null> => {
    const computeTargetId = options.getComputeTargetId();
    if (!computeTargetId) {
      note(
        "warn",
        "no-compute-target",
        "component sync skipped: no compute target yet (offline / pre-auth)"
      );
      return null;
    }

    const token = await resolveCredential();
    if (!token) {
      return null;
    }

    const origin = options.getApiOrigin();
    if (!origin) {
      note(
        "warn",
        "no-api-origin",
        "component sync skipped: no API origin configured"
      );
      return null;
    }

    let url: URL;
    try {
      url = new URL("/desktop/components/sync", origin);
    } catch {
      note(
        "warn",
        "invalid-origin",
        `component sync skipped: invalid API origin: ${origin}`
      );
      return null;
    }
    url.searchParams.set("computeTargetId", computeTargetId);
    return { url, token };
  };

  // POST one sub-cap chunk of components. Resolves a per-chunk
  // {@link ComponentSyncSendOutcome} (ISS-4542): `Accepted` on 2xx,
  // `BatchRejected` on a permanent per-batch 4xx, `LaneFailure` on a transport/
  // timeout error or a lane-wide status (401/403/408/429/5xx). Each chunk carries
  // the full envelope (schemaVersion/batchId/syncMode) with its own subset of
  // components; the server upserts each component idempotently by its
  // `(computeTargetId, componentKind, externalComponentId)` key, so which chunk
  // carries a given component — and re-sending it — is immaterial to the result.
  const postChunk = async (
    request: ResolvedRequest,
    chunkPayload: DesktopAgentComponentsPayload
  ): Promise<ComponentSyncSendOutcome> => {
    let response: Response;
    try {
      response = await fetchImpl(request.url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${request.token}`,
        },
        body: JSON.stringify(chunkPayload),
        signal: AbortSignal.timeout(COMPONENTS_SYNC_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Transport/timeout/abort is lane-wide (network down, host unreachable),
      // NOT a per-batch rejection — never charge the poison budget for it.
      note(
        "warn",
        "request-failed",
        `component sync request failed: ${errorMessage(error)}`
      );
      return ComponentSyncSendOutcome.LaneFailure;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const outcome = classifyComponentSyncHttpStatus(response.status);
      note(
        "warn",
        `http-${response.status}`,
        `component sync returned HTTP ${response.status} (${outcome})${
          body ? `: ${body.slice(0, 200)}` : ""
        }`
      );
      return outcome;
    }
    return ComponentSyncSendOutcome.Accepted;
  };

  return {
    async sync(
      payload: DesktopAgentComponentsPayload
    ): Promise<ComponentSyncSendResult> {
      const request = await buildRequest();
      if (!request) {
        // Missing credential / compute target / origin is lane-wide (offline /
        // pre-auth), not a per-batch rejection — pause without charging the budget.
        return {
          outcome: ComponentSyncSendOutcome.LaneFailure,
          firstUnsentChunkIndex: null,
          chunkCount: 0,
        };
      }

      // FEA-3621: chunk the components below the server body cap. A large org's
      // batch serializes to > 256 KiB and 413s in one POST; split it into
      // sub-cap requests sent sequentially. `sync` reports `Accepted` only when
      // EVERY chunk is acked, so the caller advances its cursor atomically for
      // the whole batch: a partial failure leaves the cursor unmoved and the
      // next tick re-sends the same rows, which the server upserts idempotently
      // (no dropped or double-counted components).
      const { chunks, oversized } = chunkComponentsByByteSize(
        payload.components
      );

      // Send the sub-cap chunks sequentially (best effort). Bail on the first
      // non-Accepted chunk so a mid-batch error does not partially advance intent.
      // A `LaneFailure` (transport/timeout/401/403/408/429/5xx) leaves the cursor
      // unmoved AND does not charge the poison budget; a `BatchRejected` (permanent
      // per-batch 4xx) surfaces so the caller's bounded dead-letter budget advances.
      // Already-acked earlier chunks upsert idempotently on the retry.
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index];
        const chunkPayload: DesktopAgentComponentsPayload = {
          ...payload,
          componentCount: chunk.length,
          components: chunk,
        };
        const chunkOutcome = await postChunk(request, chunkPayload);
        if (chunkOutcome !== ComponentSyncSendOutcome.Accepted) {
          note(
            "warn",
            "chunk-failed",
            `component sync ${chunkOutcome} on chunk ${index + 1}/${chunks.length} (${chunk.length} component(s)); ${
              chunkOutcome === ComponentSyncSendOutcome.LaneFailure
                ? "lane-wide — pausing without advancing"
                : "permanent per-batch rejection — charging the dead-letter budget"
            }`
          );
          return {
            outcome: chunkOutcome,
            firstUnsentChunkIndex: index,
            chunkCount: chunks.length,
          };
        }
      }

      // FEA-3692 safety net: a component that STILL exceeds the per-request budget
      // on its own can never fit a sub-cap request. Before ISS-4542 this returned
      // `false` (retry-in-place) forever, HEAD-OF-LINE-BLOCKING the lane. It is a
      // PERMANENT per-batch problem (like a 413 on its own), so classify it
      // `BatchRejected`: the sendable chunks already upserted best-effort above,
      // and the caller's bounded dead-letter budget advances past the poison row
      // instead of blocking the whole lane. Never report success (silent data loss).
      if (oversized.length > 0) {
        note(
          "warn",
          "oversized-component-retained",
          `component sync found ${oversized.length} oversized component(s) exceeding the ${COMPONENTS_CHUNK_BYTE_BUDGET}-byte per-request budget on their own; treating as a permanent per-batch rejection so the dead-letter budget advances past them — this should not happen now that content is clamped by serialized byte size`
        );
        return {
          outcome: ComponentSyncSendOutcome.BatchRejected,
          firstUnsentChunkIndex: chunks.length,
          chunkCount: chunks.length,
        };
      }

      if (chunks.length === 0) {
        // Empty batch with nothing oversized (an all-empty `components` array):
        // there is genuinely nothing to send and nothing dropped, so treat it as
        // accepted. An oversized-only batch never reaches here — it returned
        // `BatchRejected` above.
        note("info", "ok", "component sync had no components to send");
        return {
          outcome: ComponentSyncSendOutcome.Accepted,
          firstUnsentChunkIndex: null,
          chunkCount: 0,
        };
      }

      note(
        "info",
        "ok",
        `component sync accepted ${payload.componentCount} component(s) via session auth in ${chunks.length} chunk(s)`
      );
      return {
        outcome: ComponentSyncSendOutcome.Accepted,
        firstUnsentChunkIndex: null,
        chunkCount: chunks.length,
      };
    },
  };
}
