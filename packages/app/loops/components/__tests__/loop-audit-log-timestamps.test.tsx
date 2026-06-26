import type {
  LoopEvent,
  LoopEventsPaginatedResponse,
} from "@repo/api/src/types/loop";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/app/loops/hooks/use-loops", () => ({
  useLoopEventsPaginated: vi.fn(),
}));

import { useLoopEventsPaginated } from "@repo/app/loops/hooks/use-loops";
import { LoopAuditLog } from "../loop-audit-log";

function makeResponse(events: LoopEvent[]): {
  data: LoopEventsPaginatedResponse;
  isLoading: false;
  error: null;
} {
  return {
    data: { data: events, total: events.length },
    isLoading: false,
    error: null,
  };
}

describe("LoopAuditLog timestamps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders malformed persisted event timestamps as fallback text without throwing", () => {
    vi.mocked(useLoopEventsPaginated).mockReturnValue(
      makeResponse([
        {
          type: "started",
          loopId: "loop-1",
          timestamp: "not-a-date",
        },
      ]) as any
    );

    expect(() => render(<LoopAuditLog loopId="loop-1" />)).not.toThrow();
    expect(screen.getByText("not-a-date")).toBeInTheDocument();
  });
});
