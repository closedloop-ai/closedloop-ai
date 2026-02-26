import { type Prisma, PromptType } from "@repo/database";
import { vi } from "vitest";
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
      create: vi.fn(),
    };
    const mockTx = { prompt: mockPrompt };
    mockWithDbTx(mockTx);

    await upsertFromSnapshot(ORG_ID, null);

    expect(mockPrompt.findFirst).not.toHaveBeenCalled();
    expect(mockPrompt.create).not.toHaveBeenCalled();
  });

  it("returns without calling db when snapshot has empty prompts array", async () => {
    const mockPrompt = {
      findFirst: vi.fn(),
      create: vi.fn(),
    };
    const mockTx = { prompt: mockPrompt };
    mockWithDbTx(mockTx);

    await upsertFromSnapshot(ORG_ID, { prompts: [] });

    expect(mockPrompt.findFirst).not.toHaveBeenCalled();
    expect(mockPrompt.create).not.toHaveBeenCalled();
  });

  it("inserts initial version when no prompt history exists", async () => {
    const mockPrompt = {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "new-id" }),
    };
    const mockTx = { prompt: mockPrompt };
    mockWithDbTx(mockTx);

    await upsertFromSnapshot(ORG_ID, {
      prompts: [
        {
          promptType: PromptType.AGENT,
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
      select: { version: true, content: true, model: true, tools: true },
    });
    expect(mockPrompt.create).toHaveBeenCalledTimes(1);
    const createArg = mockPrompt.create.mock.calls[0][0];
    expect(createArg.data.organizationId).toBe(ORG_ID);
    expect(createArg.data.promptType).toBe(PromptType.AGENT);
    expect(createArg.data.name).toBe("my-agent");
    expect(createArg.data.content).toBe("You are a helpful agent.");
    expect(createArg.data.version).toBe(1);
  });

  it("skips insert when latest content is unchanged", async () => {
    const mockPrompt = {
      findFirst: vi.fn().mockResolvedValue({
        version: 4,
        content: "Evaluate the output.",
        model: "claude-3",
        tools: [],
      }),
      create: vi.fn(),
    };
    const mockTx = { prompt: mockPrompt };
    mockWithDbTx(mockTx);

    await upsertFromSnapshot(ORG_ID, {
      prompts: [
        {
          promptType: PromptType.JUDGE,
          name: "my-judge",
          description: "A judge prompt",
          model: "claude-3",
          tools: [],
          filePath: "prompts/judge.md",
          content: "Evaluate the output.",
        },
      ],
    });

    expect(mockPrompt.findFirst).toHaveBeenCalledTimes(1);
    expect(mockPrompt.create).not.toHaveBeenCalled();
  });

  it("creates a new version when content changed from latest", async () => {
    const mockPrompt = {
      findFirst: vi.fn().mockResolvedValue({
        version: 2,
        content: "Previous judge text.",
        model: "claude-3",
        tools: [],
      }),
      create: vi.fn().mockResolvedValue({ id: "new-id" }),
    };
    const mockTx = { prompt: mockPrompt };
    mockWithDbTx(mockTx);

    await upsertFromSnapshot(ORG_ID, {
      prompts: [
        {
          promptType: PromptType.JUDGE,
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
    expect(createArg.data.promptType).toBe(PromptType.JUDGE);
    expect(createArg.data.version).toBe(3);
  });

  it("retries on P2002 and exits when retry sees matching latest content", async () => {
    const mockPrompt = {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce({
          version: 1,
          content: "Old content.",
          model: "claude-3",
          tools: [],
        })
        .mockResolvedValueOnce({
          version: 2,
          content: "New content.",
          model: "claude-3",
          tools: [],
        }),
      create: vi.fn().mockRejectedValueOnce(createP2002Error()),
    };
    const mockTx = { prompt: mockPrompt };
    mockWithDbTx(mockTx);

    await upsertFromSnapshot(ORG_ID, {
      prompts: [
        {
          promptType: PromptType.AGENT,
          name: "my-agent",
          description: "An agent prompt",
          model: "claude-3",
          tools: [],
          filePath: "prompts/agent.md",
          content: "New content.",
        },
      ],
    });

    expect(mockPrompt.findFirst).toHaveBeenCalledTimes(2);
    expect(mockPrompt.create).toHaveBeenCalledTimes(1);
  });

  it("retries on P2002 and inserts next available version", async () => {
    const mockPrompt = {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce({
          version: 1,
          content: "Old content.",
          model: "claude-3",
          tools: [],
        })
        .mockResolvedValueOnce({
          version: 2,
          content: "Still old content.",
          model: "claude-3",
          tools: [],
        }),
      create: vi
        .fn()
        .mockRejectedValueOnce(createP2002Error())
        .mockResolvedValueOnce({ id: "new-id" }),
    };
    const mockTx = { prompt: mockPrompt };
    mockWithDbTx(mockTx);

    await upsertFromSnapshot(ORG_ID, {
      prompts: [
        {
          promptType: PromptType.AGENT,
          name: "my-agent",
          description: "An agent prompt",
          model: "claude-3",
          tools: [],
          filePath: "prompts/agent.md",
          content: "New content.",
        },
      ],
    });

    expect(mockPrompt.create).toHaveBeenCalledTimes(2);
    expect(mockPrompt.create.mock.calls[0][0].data.version).toBe(2);
    expect(mockPrompt.create.mock.calls[1][0].data.version).toBe(3);
  });

  it("uses a single transaction callback for multiple prompts in one snapshot", async () => {
    const mockPrompt = {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "new-id" }),
    };
    const mockTx = { prompt: mockPrompt };
    mockWithDbTx(mockTx);

    await upsertFromSnapshot(ORG_ID, {
      prompts: [
        {
          promptType: PromptType.AGENT,
          name: "my-agent",
          description: "An agent prompt",
          model: "claude-3",
          tools: [],
          filePath: "prompts/agent.md",
          content: "Version 1 content.",
        },
        {
          promptType: PromptType.JUDGE,
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
    expect(mockPrompt.findFirst).toHaveBeenCalledTimes(2);
    expect(mockPrompt.create).toHaveBeenCalledTimes(2);
  });
});

function createP2002Error(): Prisma.PrismaClientKnownRequestError {
  return Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
  }) as Prisma.PrismaClientKnownRequestError;
}
