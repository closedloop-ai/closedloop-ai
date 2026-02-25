/**
 * Unit tests for upsertFromSnapshot() in prompts-service.
 *
 * Tests cover:
 * - null snapshot → no-op
 * - empty snapshot → no-op
 * - AGENT prompt → calls tx.$queryRaw with INSERT SQL
 * - JUDGE prompt → called with 'JUDGE' cast
 * - Duplicate call → executes without error (ON CONFLICT DO NOTHING)
 * - Two different-content snapshots with same name/type → both call tx.$queryRaw
 */
import { vi } from "vitest";
import { mockWithDbTx } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
  PromptType: {
    AGENT: "AGENT",
    JUDGE: "JUDGE",
  },
}));

import { upsertFromSnapshot } from "@/lib/prompts-service";

const ORG_ID = "org-1";

describe("upsertFromSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns without calling db when snapshot is null", async () => {
    const mockTx = { $queryRaw: vi.fn() };
    mockWithDbTx(mockTx);

    await upsertFromSnapshot(ORG_ID, null);

    expect(mockTx.$queryRaw).not.toHaveBeenCalled();
  });

  it("returns without calling db when snapshot has empty prompts array", async () => {
    const mockTx = { $queryRaw: vi.fn() };
    mockWithDbTx(mockTx);

    await upsertFromSnapshot(ORG_ID, { prompts: [] });

    expect(mockTx.$queryRaw).not.toHaveBeenCalled();
  });

  it("calls tx.$queryRaw with INSERT SQL for an AGENT prompt", async () => {
    const mockTx = { $queryRaw: vi.fn().mockResolvedValue([]) };
    mockWithDbTx(mockTx);

    await upsertFromSnapshot(ORG_ID, {
      prompts: [
        {
          promptType: "AGENT",
          name: "my-agent",
          description: "An agent prompt",
          model: "claude-3",
          tools: ["bash", "read"],
          filePath: "prompts/agent.md",
          content: "You are a helpful agent.",
        },
      ],
    });

    expect(mockTx.$queryRaw).toHaveBeenCalledTimes(1);
    const [sqlArg] = mockTx.$queryRaw.mock.calls[0];
    // Verify the SQL template values include the org ID, prompt type, and name
    expect(sqlArg.values).toContain(ORG_ID);
    expect(sqlArg.values).toContain("AGENT");
    expect(sqlArg.values).toContain("my-agent");
    expect(sqlArg.values).toContain("You are a helpful agent.");
  });

  it("calls tx.$queryRaw with JUDGE type cast for a JUDGE prompt", async () => {
    const mockTx = { $queryRaw: vi.fn().mockResolvedValue([]) };
    mockWithDbTx(mockTx);

    await upsertFromSnapshot(ORG_ID, {
      prompts: [
        {
          promptType: "JUDGE",
          name: "my-judge",
          description: "A judge prompt",
          model: "claude-3",
          tools: [],
          filePath: "prompts/judge.md",
          content: "Evaluate the output.",
        },
      ],
    });

    expect(mockTx.$queryRaw).toHaveBeenCalledTimes(1);
    const [sqlArg] = mockTx.$queryRaw.mock.calls[0];
    expect(sqlArg.values).toContain("JUDGE");
    expect(sqlArg.values).toContain("my-judge");
    expect(sqlArg.values).toContain("Evaluate the output.");
  });

  it("executes without error on duplicate call (ON CONFLICT handles idempotency)", async () => {
    const mockTx = { $queryRaw: vi.fn().mockResolvedValue([]) };
    mockWithDbTx(mockTx);

    const snapshot = {
      prompts: [
        {
          promptType: "AGENT" as const,
          name: "my-agent",
          description: "An agent prompt",
          model: "claude-3",
          tools: [],
          filePath: "prompts/agent.md",
          content: "You are a helpful agent.",
        },
      ],
    };

    // First call
    await upsertFromSnapshot(ORG_ID, snapshot);
    // Second call with same snapshot (simulates ON CONFLICT DO NOTHING)
    await upsertFromSnapshot(ORG_ID, snapshot);

    // Both calls succeed without throwing
    expect(mockTx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("calls tx.$queryRaw twice for two different-content snapshots with same name/type", async () => {
    const mockTx = { $queryRaw: vi.fn().mockResolvedValue([]) };
    mockWithDbTx(mockTx);

    const firstSnapshot = {
      prompts: [
        {
          promptType: "AGENT" as const,
          name: "my-agent",
          description: "An agent prompt",
          model: "claude-3",
          tools: [],
          filePath: "prompts/agent.md",
          content: "Version 1 content.",
        },
      ],
    };

    const secondSnapshot = {
      prompts: [
        {
          promptType: "AGENT" as const,
          name: "my-agent",
          description: "An agent prompt",
          model: "claude-3",
          tools: [],
          filePath: "prompts/agent.md",
          content: "Version 2 content — different sha triggers new row.",
        },
      ],
    };

    await upsertFromSnapshot(ORG_ID, firstSnapshot);
    await upsertFromSnapshot(ORG_ID, secondSnapshot);

    // Both snapshots have different content (different sha), so both insert attempts fire
    expect(mockTx.$queryRaw).toHaveBeenCalledTimes(2);
    const firstCallValues = mockTx.$queryRaw.mock.calls[0][0].values;
    const secondCallValues = mockTx.$queryRaw.mock.calls[1][0].values;
    expect(firstCallValues).toContain("Version 1 content.");
    expect(secondCallValues).toContain(
      "Version 2 content — different sha triggers new row."
    );
  });
});
