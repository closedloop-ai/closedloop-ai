import { describe, expect, it } from "vitest";
import { extractUploadedPlanRaw } from "@/lib/loops/uploaded-plan-artifacts";

describe("extractUploadedPlanRaw", () => {
  it("reads raw plan state from the upload-artifacts DB row shape", () => {
    const raw = {
      content: "Plan markdown",
      pendingTasks: ["task-1"],
    };

    expect(
      extractUploadedPlanRaw({
        plan: {
          content: "Plan markdown",
          raw,
        },
      })
    ).toEqual(raw);
  });

  it("does not read the obsolete nested artifacts envelope", () => {
    expect(
      extractUploadedPlanRaw({
        artifacts: {
          plan: {
            raw: {
              content: "Plan markdown",
            },
          },
        },
      })
    ).toBeUndefined();
  });
});
