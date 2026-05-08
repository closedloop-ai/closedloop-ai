import { LoopErrorCode, LoopStatus } from "@repo/api/src/types/loop";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoopStatusBadge } from "@/components/status-badge";

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: () => ({
    enabled: true,
    key: "ghost-loop-ux",
    payload: undefined,
    variant: undefined,
  }),
}));

describe("LoopStatusBadge", () => {
  it("uses failed styling for friendly error labels without specific colors", () => {
    render(
      <LoopStatusBadge
        errorCode={LoopErrorCode.ProcessFailed}
        status={LoopStatus.Failed}
      />
    );

    expect(screen.getByText("Command failed")).toHaveClass("bg-destructive/10");
  });
});
