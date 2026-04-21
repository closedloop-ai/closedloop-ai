import { vi } from "vitest";

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/loops/compute-target-resolver", () => ({
  fetchUserComputePreferences: vi.fn(),
  resolveComputeTarget: vi.fn(),
}));

vi.mock("@/app/documents/[id]/run-loop/run-loop-helpers", () => ({
  COMMAND_MAP: { plan: "PLAN" },
  resolveLoopContext: vi.fn(),
}));

vi.mock("@/lib/loops/prompts", () => ({
  getDefaultPrompt: vi.fn(() => "default-plan-prompt"),
}));

vi.mock("@/app/loops/service", () => ({
  loopsService: {
    create: vi.fn(),
  },
}));

vi.mock("@/lib/loops/loop-orchestrator", () => ({
  launchLoop: vi.fn(),
}));

import { beforeEach, describe, expect, it } from "vitest";
import { resolveLoopContext } from "@/app/documents/[id]/run-loop/run-loop-helpers";
import { loopsService } from "@/app/loops/service";
import {
  fetchUserComputePreferences,
  resolveComputeTarget,
} from "@/lib/loops/compute-target-resolver";
import { launchPlanLoop } from "@/lib/loops/launch-plan-loop";
import { DispatchError } from "@/lib/loops/loop-desktop";
import { launchLoop } from "@/lib/loops/loop-orchestrator";

const baseOptions = {
  artifact: {
    id: "doc-1",
    slug: "plan-doc",
    title: "Plan doc",
  } as any,
  organizationId: "org-1",
  userId: "user-1",
  documentId: "doc-1",
  computeTargetId: "target-1",
  metadata: { launchSource: "test" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchUserComputePreferences).mockResolvedValue({
    preferredComputeMode: "LOCAL",
    preferredComputeTargetId: undefined,
  });
  vi.mocked(resolveComputeTarget).mockResolvedValue({
    reason: "resolved",
    target: { id: "target-1" } as any,
  });
  vi.mocked(resolveLoopContext).mockResolvedValue({
    workstream: null,
    targetRepo: "acme/repo",
    targetBranch: "main",
    contextRefs: [],
  } as any);
  vi.mocked(loopsService.create).mockResolvedValue({
    loopId: "loop-1",
  } as any);
  vi.mocked(launchLoop).mockResolvedValue("cmd-1");
});

describe("launchPlanLoop", () => {
  it("maps callback-unavailable dispatch failures to callback_unavailable", async () => {
    vi.mocked(launchLoop).mockRejectedValue(
      new DispatchError(
        "Relay dispatch not delivered: callback_unavailable",
        "cmd-1",
        "callback_unavailable"
      )
    );

    const result = await launchPlanLoop(baseOptions);

    expect(result).toEqual({ ok: false, error: "callback_unavailable" });
  });

  it("keeps generic launch failures mapped as launch_failed", async () => {
    vi.mocked(launchLoop).mockRejectedValue(
      new DispatchError(
        "Relay dispatch not delivered: target_offline",
        "cmd-1",
        "target_offline"
      )
    );

    const result = await launchPlanLoop(baseOptions);

    expect(result).toEqual({ ok: false, error: "launch_failed" });
  });

  it("keeps dispatch failures without a reason mapped as launch_failed", async () => {
    vi.mocked(launchLoop).mockRejectedValue(
      new DispatchError("Relay dispatch not delivered", "cmd-1")
    );

    const result = await launchPlanLoop(baseOptions);

    expect(result).toEqual({ ok: false, error: "launch_failed" });
  });

  it("keeps unknown non-dispatch errors mapped as launch_failed", async () => {
    vi.mocked(launchLoop).mockRejectedValue(new Error("unexpected failure"));

    const result = await launchPlanLoop(baseOptions);

    expect(result).toEqual({ ok: false, error: "launch_failed" });
  });
});
