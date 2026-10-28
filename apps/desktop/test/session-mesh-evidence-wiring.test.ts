import { SessionMeshEvidenceArm } from "@repo/api/src/types/session-mesh-evidence";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMeshEvidenceObserver } from "../src/main/session-mesh/session-mesh-evidence-observer.js";
import {
  createMeshHarness,
  disposeMeshHarnesses,
  identityA,
  meshCwd,
  meshDelivery,
  meshEvent,
  sessionEvent,
  sourceKeyOf,
} from "./session-mesh-runtime-cov-iss11283-harness.js";

/**
 * The evidence observer's PRODUCTION WIRING (ISS-11755, #8289 warning decision
 * 2; operator ruling 2026-10-01: "yes wire it into the hook pipeline; we need
 * it for the round trip").
 *
 * Every assertion here drives the real `SessionMeshRuntime` and spies on the
 * observer's own prototype, so deleting either runtime call site turns this file
 * red. A test that constructed the observer itself would prove nothing about
 * whether anything calls it — `session-mesh-evidence-observer.test.ts` owns the
 * observer's behavior, and this file owns only that the pipeline reaches it.
 */
const MESSAGE = "0b9f5a52-7a4c-4b3e-9d61-1f7c2d0c9a01";
const SUBJECT = "src/shared.ts";
const OTHER = "src/recipient-only.ts";
const CLAIM_EXPIRES_AT = "2026-09-01T01:00:00.000Z";
const AGENT_KEY = `${sourceKeyOf(identityA)}:claude:session-1`;

afterEach(() => {
  vi.restoreAllMocks();
  disposeMeshHarnesses();
});

function overlappingInbox(relevance: Record<string, unknown>) {
  return () => [
    meshDelivery({
      id: MESSAGE,
      recipientAgentId: "claude:session-1",
      summary: `Working ${SUBJECT}`,
      relevance,
      paths: [SUBJECT],
      expiresAt: CLAIM_EXPIRES_AT,
    }),
  ];
}

describe("the hook pipeline feeds the evidence observer's tool stream", () => {
  it("observes an edit event, scoped to the account and the agent", async () => {
    const observeTool = vi.spyOn(
      SessionMeshEvidenceObserver.prototype,
      "observeTool"
    );
    const harness = createMeshHarness();
    const runtime = harness.runtime();

    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_name: "Edit",
        tool_input: { file_path: SUBJECT },
      })
    );
    await runtime.whenIdle();

    expect(observeTool).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKey: AGENT_KEY,
        toolName: "Edit",
        files: [SUBJECT],
        workspaceRoot: meshCwd,
      })
    );
  });

  it("reports completion as unobserved, because only PreToolUse is installed", async () => {
    const observeTool = vi.spyOn(
      SessionMeshEvidenceObserver.prototype,
      "observeTool"
    );
    const harness = createMeshHarness();
    const runtime = harness.runtime();

    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_name: "Write",
        tool_input: { file_path: SUBJECT },
      })
    );
    await runtime.whenIdle();

    // Asserted through the call itself, not through an optional chain: with no
    // call at all, `calls.at(-1)?.[0].completed` is also `undefined`, so the
    // weaker form stayed green with the runtime's call site deleted.
    expect(observeTool).toHaveBeenCalledTimes(1);
    const [observed] = observeTool.mock.calls[0];
    // `SESSION_MESH_CLAUDE_HOOK_TYPES` has no `PostToolUse` and
    // `removeObsoleteToolHooks` deletes any that is there, so the stream
    // announces an edit and never reports its outcome. A `true` or `false` here
    // would be a boolean nobody measured.
    expect("completed" in observed).toBe(false);
  });

  it("does not forward the SendMessage mirror's own text as observed subjects", async () => {
    const observeTool = vi.spyOn(
      SessionMeshEvidenceObserver.prototype,
      "observeTool"
    );
    const harness = createMeshHarness();
    const runtime = harness.runtime();

    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_name: "SendMessage",
        tool_input: { to: "sibling", summary: `relaying ${SUBJECT}` },
      })
    );
    await runtime.whenIdle();

    // A session quoting a delivered summary back to a sibling would otherwise
    // match its own delivery and vote for that delivery's usefulness.
    expect(observeTool).toHaveBeenCalledTimes(1);
    expect(observeTool.mock.calls[0][0].text).toBe("");
  });
});

describe("a confirmed receipt records the delivery against the server's verdict", () => {
  it("records the overlapping subject, the claim window and a placebo", async () => {
    const recordDelivery = vi.spyOn(
      SessionMeshEvidenceObserver.prototype,
      "recordDelivery"
    );
    const harness = createMeshHarness();
    harness.state.inboxFor = overlappingInbox({ pathOverlap: [SUBJECT] });
    const runtime = harness.runtime();

    await runtime.handle(
      sessionEvent("PreToolUse", "session-1", {
        tool_name: "Edit",
        tool_input: { file_path: OTHER },
      })
    );
    await runtime.whenIdle();
    const context = await runtime.handle(sessionEvent("AwaitContext"));
    await runtime.handle(
      meshEvent("ContextDelivered", { receipt: context.receipt })
    );
    await runtime.whenIdle();

    expect(recordDelivery).toHaveBeenCalledWith({
      agentKey: AGENT_KEY,
      messageId: MESSAGE,
      subject: SUBJECT,
      // Drawn from the recipient's own declared paths, and never a path the
      // message named.
      placebo: OTHER,
      arm: SessionMeshEvidenceArm.Delivered,
      claimExpiresAt: Date.parse(CLAIM_EXPIRES_AT),
      intentBeforeDelivery: true,
    });
  });

  it("carries the server's empty overlap through as no demonstrated intent", async () => {
    const recordDelivery = vi.spyOn(
      SessionMeshEvidenceObserver.prototype,
      "recordDelivery"
    );
    const harness = createMeshHarness();
    harness.state.inboxFor = overlappingInbox({ pathOverlap: [] });
    const runtime = harness.runtime();

    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    const context = await runtime.handle(sessionEvent("AwaitContext"));
    await runtime.handle(
      meshEvent("ContextDelivered", { receipt: context.receipt })
    );
    await runtime.whenIdle();

    // An overlap the server did not find is `unknown`, never avoidance.
    expect(recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ subject: SUBJECT, intentBeforeDelivery: false })
    );
  });

  it("records nothing for a message that named no repository path", async () => {
    const recordDelivery = vi.spyOn(
      SessionMeshEvidenceObserver.prototype,
      "recordDelivery"
    );
    const harness = createMeshHarness();
    harness.state.inboxFor = () => [
      meshDelivery({
        id: MESSAGE,
        recipientAgentId: "claude:session-1",
        summary: "no subject anywhere",
      }),
    ];
    const runtime = harness.runtime();

    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    const context = await runtime.handle(sessionEvent("AwaitContext"));
    await runtime.handle(
      meshEvent("ContextDelivered", { receipt: context.receipt })
    );
    await runtime.whenIdle();

    // There is no subject for the proxies to be about, and a fabricated one
    // would attribute the session's next edit to a delivery that never named it.
    expect(recordDelivery).not.toHaveBeenCalled();
  });

  it("persists the seeds on the receipt, so a restart still has the verdict", async () => {
    const harness = createMeshHarness();
    harness.state.inboxFor = overlappingInbox({ pathOverlap: [SUBJECT] });
    const runtime = harness.runtime();

    await runtime.handle(sessionEvent("SessionStart"));
    await runtime.whenIdle();
    await runtime.handle(sessionEvent("AwaitContext"));

    // The inbox rows, and the server's relevance verdict on them, are gone by
    // the time the hook confirms the receipt.
    expect(Object.values(harness.ledger().receipts)[0]?.evidence).toEqual({
      [MESSAGE]: {
        subject: SUBJECT,
        placebo: null,
        intentBeforeDelivery: true,
        claimExpiresAt: Date.parse(CLAIM_EXPIRES_AT),
      },
    });
  });
});
