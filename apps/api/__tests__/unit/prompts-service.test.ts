import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMockWithDb, mockWithDbTx } from "../utils/db-helpers";

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  return {
    ...actual,
    withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  };
});

import { upsertFromSnapshot } from "@/lib/prompts-service";

const ORG_ID = "org-1";

describe("upsertFromSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns without calling db when snapshot is null", async () => {
    const mockPrompt = {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      createMany: vi.fn(),
    };
    const mockTx = { prompt: mockPrompt };
    mockWithDbTx(mockTx);

    await upsertFromSnapshot(ORG_ID, null);

    expect(mockPrompt.findFirst).not.toHaveBeenCalled();
    expect(mockPrompt.findMany).not.toHaveBeenCalled();
    expect(mockPrompt.createMany).not.toHaveBeenCalled();
  });

  it("returns without calling db when snapshot has empty prompts array", async () => {
    const mockPrompt = {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      createMany: vi.fn(),
    };
    const mockTx = { prompt: mockPrompt };
    mockWithDbTx(mockTx);

    await upsertFromSnapshot(ORG_ID, { prompts: [] });

    expect(mockPrompt.findFirst).not.toHaveBeenCalled();
    expect(mockPrompt.findMany).not.toHaveBeenCalled();
    expect(mockPrompt.createMany).not.toHaveBeenCalled();
  });

  it("inserts initial version when no prompt history exists", async () => {
    const mockPrompt = {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const mockTx = { prompt: mockPrompt };
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

    expect(mockPrompt.findFirst).toHaveBeenCalledTimes(1);
    expect(mockPrompt.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: ORG_ID,
        name: "my-agent",
      },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    expect(mockPrompt.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrompt.createMany).toHaveBeenCalledTimes(1);
    const createArg = mockPrompt.createMany.mock.calls[0][0];
    expect(createArg.data[0].organizationId).toBe(ORG_ID);
    expect(createArg.data[0].promptType).toBe("AGENT");
    expect(createArg.data[0].name).toBe("my-agent");
    expect(createArg.data[0].content).toBe("You are a helpful agent.");
    expect(createArg.data[0].version).toBe(1);
    expect(createArg.skipDuplicates).toBe(true);
  });

  it("skips insert when matching content/model/tools already exists", async () => {
    const mockPrompt = {
      findMany: vi.fn().mockResolvedValue([
        {
          tools: ["tool-b", "tool-a"],
        },
      ]),
      findFirst: vi.fn(),
      createMany: vi.fn(),
    };
    const mockTx = { prompt: mockPrompt };
    mockWithDbTx(mockTx);

    await upsertFromSnapshot(ORG_ID, {
      prompts: [
        {
          promptType: "JUDGE",
          name: "my-judge",
          description: "A judge prompt",
          model: "claude-3",
          tools: ["tool-a", "tool-b"],
          filePath: "prompts/judge.md",
          content: "Evaluate the output.",
        },
      ],
    });

    expect(mockPrompt.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrompt.findFirst).not.toHaveBeenCalled();
    expect(mockPrompt.createMany).not.toHaveBeenCalled();
  });

  it("creates a new version when content changed from latest", async () => {
    const mockPrompt = {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue({
        version: 4,
        content: "Old content.",
        model: "claude-3",
        tools: ["tool-a"],
      }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const mockTx = { prompt: mockPrompt };
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

    expect(mockPrompt.createMany).toHaveBeenCalledTimes(1);
    const createArg = mockPrompt.createMany.mock.calls[0][0];
    expect(createArg.data[0].promptType).toBe("JUDGE");
    expect(createArg.data[0].version).toBe(5);
  });

  it("retries on skipped insert and succeeds when a later attempt can insert", async () => {
    const mockPrompt = {
      findMany: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
      findFirst: vi
        .fn()
        .mockResolvedValueOnce({ version: 1 })
        .mockResolvedValueOnce({ version: 2 })
        .mockResolvedValueOnce({ version: 3 }),
      createMany: vi
        .fn()
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 }),
    };
    const mockTx = { prompt: mockPrompt };
    mockWithDbTx(mockTx);

    await upsertFromSnapshot(ORG_ID, {
      prompts: [
        {
          promptType: "AGENT",
          name: "my-agent",
          description: "An agent prompt",
          model: "claude-3",
          tools: [],
          filePath: "prompts/agent.md",
          content: "New content.",
        },
      ],
    });

    expect(mockPrompt.findMany).toHaveBeenCalledTimes(3);
    expect(mockPrompt.findFirst).toHaveBeenCalledTimes(3);
    expect(mockPrompt.createMany).toHaveBeenCalledTimes(3);
  });

  it("uses a single transaction callback for multiple prompts in one snapshot", async () => {
    const mockPrompt = {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const mockTx = { prompt: mockPrompt };
    mockWithDbTx(mockTx);

    await upsertFromSnapshot(ORG_ID, {
      prompts: [
        {
          promptType: "AGENT",
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
    expect(mockPrompt.findMany).toHaveBeenCalledTimes(2);
    expect(mockPrompt.findFirst).toHaveBeenCalledTimes(2);
    expect(mockPrompt.createMany).toHaveBeenCalledTimes(2);
  });
});
