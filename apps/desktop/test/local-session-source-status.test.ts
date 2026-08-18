/**
 * ISS-5302 — node-lane parity for `src/shared/local-session-source-status.ts`.
 *
 * The module sits on a version-skew boundary: the main process produces the
 * `desktop:get-agent-monitor-url` payload, the renderer normalizes it. The
 * renderer lane already asserts this contract
 * (`src/renderer/__tests__/desktop-sessions-live-update.test.tsx` — legacy
 * `ready` boolean maps to reads, an unknown additive status fails closed), but
 * the node lane never loaded the module: the only main-process importers of it
 * are `app.ts` (which imports the status const, not the normalizer) and
 * `agent-monitor-ipc.ts` / `desktop-ipc-registration.ts`, whose imports are
 * type-only and therefore erased at runtime.
 *
 * Home: a new flat `test/` file rather than an extension of an existing suite.
 * The only node-lane suite that touches this surface at all is
 * `test/ipc-sender-gates.test.ts`, which is a single-purpose 120-line suite
 * about untrusted-sender rejection on two channels; the readiness contract is a
 * different concern and would not belong there. `test/local-session-store.test.ts`
 * and `test/local-session-pull-requests.test.ts` own the local session DB, not
 * the source-readiness handshake.
 *
 * The first suite drives the REAL producer (`registerAgentMonitorIpcHandlers`)
 * and feeds its emitted payload to the REAL normalizer, so a producer that
 * stopped emitting the field — or emitted it under a different name — fails
 * here. The second suite covers the skew shapes an older or newer main process
 * can put on the wire, which the types do not constrain at an IPC boundary.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AgentMonitorIpcChannel,
  type AgentMonitorIpcDeps,
  registerAgentMonitorIpcHandlers,
} from "../src/main/ipc/agent-monitor-ipc.js";
import {
  type AgentMonitorLocalSessionSourcePayload,
  LOCAL_SESSION_SOURCE_STATUSES,
  type LocalSessionSourceStatus,
  normalizeAgentMonitorLocalSessionSourceStatus,
} from "../src/shared/local-session-source-status.js";

type IpcHandler = (event: unknown, payload?: unknown) => unknown;

/**
 * A status value no version of the contract has ever defined — the shape an
 * older renderer sees when a newer main process adds a status it does not know.
 * Mirrors the renderer lane's `"unexpected-ready"` skew fixture.
 */
const UNKNOWN_STATUS = "unexpected-ready";

/**
 * Drive the real `desktop:get-agent-monitor-url` handler and return the payload
 * it puts on the wire. Only the readiness deps matter here; the rest of
 * `AgentMonitorIpcDeps` is filled by a partial cast, following the existing
 * precedent in `test/ipc-sender-gates.test.ts`, which spreads a
 * `Partial<AgentMonitorIpcDeps>` the same way.
 */
function readAgentMonitorUrlPayload(
  status: LocalSessionSourceStatus
): AgentMonitorLocalSessionSourcePayload {
  const handlers = new Map<string, IpcHandler>();
  const deps: Partial<AgentMonitorIpcDeps> = {
    isTrustedSender: () => true,
    getAgentMonitorUrl: () => null,
    isAgentMonitorReady: () => false,
    isPlanExtractionEnabled: () => false,
    getLocalSessionSourceStatus: () => status,
  };
  registerAgentMonitorIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    deps as AgentMonitorIpcDeps
  );
  return handlers.get(AgentMonitorIpcChannel.GetAgentMonitorUrl)?.(
    null
  ) as AgentMonitorLocalSessionSourcePayload;
}

describe("agent-monitor readiness payload round trip", () => {
  test("every produced status survives normalization unchanged", () => {
    for (const status of Object.values(LOCAL_SESSION_SOURCE_STATUSES)) {
      const payload = readAgentMonitorUrlPayload(status);

      assert.equal(
        payload.localSessionSourceStatus,
        status,
        `producer dropped or renamed the status for ${status}`
      );
      assert.equal(
        normalizeAgentMonitorLocalSessionSourceStatus(payload),
        status
      );
    }
  });

  test("the additive status wins over the legacy ready boolean", () => {
    // `isAgentMonitorReady()` is false in this fixture, so the payload carries
    // `ready: false` alongside `localSessionSourceStatus: "ready"`. The two
    // fields describe different things (capture-endpoint readiness vs. local
    // source readiness) and the additive field must be the one that decides.
    const payload = readAgentMonitorUrlPayload(
      LOCAL_SESSION_SOURCE_STATUSES.ready
    );

    assert.equal(payload.ready, false);
    assert.equal(
      normalizeAgentMonitorLocalSessionSourceStatus(payload),
      LOCAL_SESSION_SOURCE_STATUSES.ready
    );
  });
});

describe("normalizeAgentMonitorLocalSessionSourceStatus version skew", () => {
  test("a legacy payload with only ready:true maps to ready", () => {
    assert.equal(
      normalizeAgentMonitorLocalSessionSourceStatus({ ready: true }),
      LOCAL_SESSION_SOURCE_STATUSES.ready
    );
  });

  test("a legacy payload with ready:false maps to starting, not unavailable", () => {
    // A pre-additive main process cannot distinguish "still coming up" from
    // "gave up", so the safe read is the non-terminal one.
    assert.equal(
      normalizeAgentMonitorLocalSessionSourceStatus({ ready: false }),
      LOCAL_SESSION_SOURCE_STATUSES.starting
    );
    assert.equal(
      normalizeAgentMonitorLocalSessionSourceStatus({}),
      LOCAL_SESSION_SOURCE_STATUSES.starting
    );
  });

  test("an unknown additive status fails closed to starting", () => {
    // Present-but-unrecognized must NOT fall back to the legacy boolean, or a
    // newer main process reporting an unknown terminal state would be read as
    // ready and the renderer would issue session reads against a dead source.
    assert.equal(
      normalizeAgentMonitorLocalSessionSourceStatus({
        localSessionSourceStatus: UNKNOWN_STATUS,
        ready: true,
      }),
      LOCAL_SESSION_SOURCE_STATUSES.starting
    );
  });

  test("an explicit undefined status still fails closed, ignoring ready:true", () => {
    // `localSessionSourceStatus: undefined` is the key being present with no
    // value, which is distinct from the key being absent: `"key" in payload`
    // is true, so this takes the fail-closed path rather than the legacy one.
    assert.equal(
      normalizeAgentMonitorLocalSessionSourceStatus({
        localSessionSourceStatus: undefined,
        ready: true,
      }),
      LOCAL_SESSION_SOURCE_STATUSES.starting
    );
  });

  test("a missing payload maps to starting", () => {
    assert.equal(
      normalizeAgentMonitorLocalSessionSourceStatus(null),
      LOCAL_SESSION_SOURCE_STATUSES.starting
    );
    assert.equal(
      normalizeAgentMonitorLocalSessionSourceStatus(undefined),
      LOCAL_SESSION_SOURCE_STATUSES.starting
    );
  });
});
