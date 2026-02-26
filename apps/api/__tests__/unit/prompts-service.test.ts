import { vi } from "vitest";
import { computePromptSha256 } from "@/lib/prompt-snapshot-ingestion";
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
      findUnique: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
    };
    const mockTx = { prompt: mockPrompt };
    mockWithDbTx(mockTx);

    await upsertFromSnapshot(ORG_ID, null);

    expect(mockPrompt.findUnique).not.toHaveBeenCalled();
    expect(mockPrompt.create).not.toHaveBeenCalled();
  });

  it("returns without calling db when snapshot has empty prompts array", async () => {
    const mockPrompt = {
      findUnique: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
    };
    const mockTx = { prompt: mockPrompt };
    mockWithDbTx(mockTx);

    await upsertFromSnapshot(ORG_ID, { prompts: [] });

    expect(mockPrompt.findUnique).not.toHaveBeenCalled();
    expect(mockPrompt.create).not.toHaveBeenCalled();
  });

  it("inserts a new prompt with explicit sha and initial version", async () => {
    const mockPrompt = {
      findUnique: vi.fn().mockResolvedValue(null),
      aggregate: vi.fn().mockResolvedValue({ _max: { version: null } }),
      create: vi.fn().mockResolvedValue({ id: "new-id" }),
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

    expect(mockPrompt.findUnique).toHaveBeenCalledTimes(1);
    expect(mockPrompt.findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_name_sha: {
          organizationId: ORG_ID,
          name: "my-agent",
          sha: computePromptSha256("You are a helpful agent."),
        },
      },
      select: { id: true },
    });
    expect(mockPrompt.aggregate).toHaveBeenCalledTimes(1);
    expect(mockPrompt.create).toHaveBeenCalledTimes(1);
    const createArg = mockPrompt.create.mock.calls[0][0];
    expect(createArg.data.organizationId).toBe(ORG_ID);
    expect(createArg.data.promptType).toBe("AGENT");
    expect(createArg.data.name).toBe("my-agent");
    expect(createArg.data.content).toBe("You are a helpful agent.");
    expect(createArg.data.sha).toBe(
      computePromptSha256("You are a helpful agent.")
    );
    expect(createArg.data.version).toBe(1);
  });

  it("skips insert when organization, name, and sha already exist", async () => {
    const mockPrompt = {
      findUnique: vi.fn().mockResolvedValue({ id: "existing-id" }),
      aggregate: vi.fn(),
      create: vi.fn(),
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
          tools: [],
          filePath: "prompts/judge.md",
          content: "Evaluate the output.",
        },
      ],
    });

    expect(mockPrompt.findUnique).toHaveBeenCalledTimes(1);
    expect(mockPrompt.create).not.toHaveBeenCalled();
  });

  it("includes prompt type and content sha in create data", async () => {
    const mockPrompt = {
      findUnique: vi.fn().mockResolvedValue(null),
      aggregate: vi.fn().mockResolvedValue({ _max: { version: null } }),
      create: vi.fn().mockResolvedValue({ id: "new-id" }),
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

    expect(mockPrompt.create).toHaveBeenCalledTimes(1);
    const createArg = mockPrompt.create.mock.calls[0][0];
    expect(createArg.data.promptType).toBe("JUDGE");
    expect(createArg.data.sha).toBe(
      computePromptSha256("Evaluate this output.")
    );
  });

  it("uses a single transaction callback for multiple prompts in one snapshot", async () => {
    const mockPrompt = {
      findUnique: vi.fn().mockResolvedValue(null),
      aggregate: vi.fn().mockResolvedValue({ _max: { version: null } }),
      create: vi.fn().mockResolvedValue({ id: "new-id" }),
    };
    const mockTx = { prompt: mockPrompt };
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
    expect(mockPrompt.findUnique).toHaveBeenCalledTimes(2);
    expect(mockPrompt.create).toHaveBeenCalledTimes(2);
  });
});
