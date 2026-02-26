import { vi } from "vitest";
import { computePromptSha256 } from "@/lib/prompt-snapshot-ingestion";
import { getMockWithDb, mockWithDbTx } from "../utils/db-helpers";

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

  it("inserts a new prompt with explicit sha and initial version", async () => {
    const mockTx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
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

    const [insertSqlArg] = mockTx.$queryRaw.mock.calls[0];
    expect(insertSqlArg.values).toContain(ORG_ID);
    expect(insertSqlArg.values).toContain("AGENT");
    expect(insertSqlArg.values).toContain("my-agent");
    expect(insertSqlArg.values).toContain("You are a helpful agent.");
    expect(insertSqlArg.values).toContain(
      computePromptSha256("You are a helpful agent.")
    );
  });

  it("attempts a single atomic insert when organization, name, and sha already exist", async () => {
    const mockTx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
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
  });

  it("includes prompt type and content sha in atomic insert values", async () => {
    const mockTx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    mockWithDbTx(mockTx);

    await upsertFromSnapshot(ORG_ID, {
      prompts: [
        {
          promptType: "JUDGE",
          name: "my-agent",
          description: "A judge prompt",
          model: "claude-3",
          tools: [],
          filePath: "prompts/judge.md",
          content: "Evaluate this output.",
        },
      ],
    });

    expect(mockTx.$queryRaw).toHaveBeenCalledTimes(1);
    const [insertSqlArg] = mockTx.$queryRaw.mock.calls[0];
    expect(insertSqlArg.values).toContain("JUDGE");
    expect(insertSqlArg.values).toContain(
      computePromptSha256("Evaluate this output.")
    );
  });

  it("uses a single transaction callback for multiple prompts in one snapshot", async () => {
    const mockTx = {
      $queryRaw: vi.fn().mockResolvedValue([]),
    };
    mockWithDbTx(mockTx);

    await upsertFromSnapshot(ORG_ID, {
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
        {
          promptType: "JUDGE",
          name: "my-judge",
          description: "A judge prompt",
          model: "claude-3",
          tools: [],
          filePath: "prompts/judge.md",
          content: "Version 2 content.",
        },
      ],
    });

    expect(getMockWithDb().tx).toHaveBeenCalledTimes(1);
    expect(mockTx.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
