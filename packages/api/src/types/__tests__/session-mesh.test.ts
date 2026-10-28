import { describe, expect, it } from "vitest";
import { InsightsScope } from "../insights.ts";
import {
  sessionMeshFeedbackValidator,
  sessionMeshInsightsQueryValidator,
  sessionMeshPresenceValidator,
  sessionMeshPublishValidator,
} from "../session-mesh";

const workspace = {
  repository: "closedloop/symphony",
  revision: "abc123",
  paths: ["apps/api/app/session-mesh/route.ts"],
  symbols: ["sessionMeshService"],
};

describe("Session Mesh contracts", () => {
  it("bounds the entire wire record, not just its context field", () => {
    const oversizedWorkspace = {
      ...workspace,
      paths: Array.from({ length: 200 }, (_, i) => `${i}/${"界".repeat(990)}`),
    };
    expect(
      sessionMeshPresenceValidator.safeParse({
        agentId: "claude:large",
        workspace: oversizedWorkspace,
      }).success
    ).toBe(false);
    expect(
      sessionMeshPublishValidator.safeParse({
        authorAgentId: "claude:large",
        idempotencyKey: "large",
        kind: "discovery",
        summary: "Large file set",
        workspace: oversizedWorkspace,
      }).success
    ).toBe(false);
  });
  it("requires a canonical runtime agent id rather than a slot alias field", () => {
    expect(sessionMeshPresenceValidator.safeParse({ workspace }).success).toBe(
      false
    );
    expect(
      sessionMeshPresenceValidator.safeParse({
        agentId: "agent-7f2",
        workspace,
      }).success
    ).toBe(true);
  });

  it("accepts context six levels deep and rejects it at seven", () => {
    expect(publishWithContextDepth(6).success).toBe(true);
    expect(publishWithContextDepth(7).success).toBe(false);
  });

  it("rejects context containing a value of an unsupported JSON type", () => {
    expect(
      sessionMeshPublishValidator.safeParse({
        authorAgentId: "claude:fn",
        idempotencyKey: "fn",
        kind: "discovery",
        summary: "Non-JSON context value",
        workspace,
        context: { handler: () => undefined },
      }).success
    ).toBe(false);
  });

  it("bounds a durable, evidence-bearing message", () => {
    expect(
      sessionMeshPublishValidator.safeParse({
        messageId: "d9c16ee1-9468-4bd2-b57e-610bd3f6ec34",
        idempotencyKey: "hook:claude:session-7:discovery:42",
        authorAgentId: "claude:session-7",
        kind: "discovery",
        workspace,
        summary: "The gateway route is the only local transport owner.",
        context: { evidence: ["apps/desktop/src/server/router.ts"] },
      }).success
    ).toBe(true);
  });
});

describe("sessionMeshFeedbackValidator", () => {
  const base = {
    idempotencyKey: "hook:claude:session-7:feedback:1",
    kind: "coordination_overhead" as const,
    rationale: "Waited on a peer claim before proceeding.",
  };

  it("requires coordinationOverheadMs when kind is coordination_overhead", () => {
    const result = sessionMeshFeedbackValidator.safeParse(base);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        "coordinationOverheadMs is required"
      );
    }
  });

  it("accepts coordination_overhead when coordinationOverheadMs is present", () => {
    expect(
      sessionMeshFeedbackValidator.safeParse({
        ...base,
        coordinationOverheadMs: 4200,
      }).success
    ).toBe(true);
  });

  it("does not require coordinationOverheadMs for other feedback kinds", () => {
    expect(
      sessionMeshFeedbackValidator.safeParse({ ...base, kind: "useful" })
        .success
    ).toBe(true);
  });
});

describe("sessionMeshInsightsQueryValidator", () => {
  it("rejects an individual userId under organization scope", () => {
    const result = sessionMeshInsightsQueryValidator.safeParse({
      scope: InsightsScope.Org,
      userId: "d9c16ee1-9468-4bd2-b57e-610bd3f6ec34",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        "Organization scope cannot select an individual user"
      );
    }
  });

  it("allows organization scope with no userId", () => {
    expect(
      sessionMeshInsightsQueryValidator.safeParse({ scope: InsightsScope.Org })
        .success
    ).toBe(true);
  });

  it("allows a userId under the default me scope", () => {
    expect(
      sessionMeshInsightsQueryValidator.safeParse({
        scope: InsightsScope.Me,
        userId: "d9c16ee1-9468-4bd2-b57e-610bd3f6ec34",
      }).success
    ).toBe(true);
  });
});

function publishWithContextDepth(leafDepth: number) {
  let nested: unknown = "leaf";
  for (let depth = 1; depth < leafDepth; depth++) {
    nested = { child: nested };
  }
  return sessionMeshPublishValidator.safeParse({
    authorAgentId: "claude:deep",
    idempotencyKey: "deep",
    kind: "discovery",
    summary: "Deeply nested context",
    workspace,
    context: { nested },
  });
}
