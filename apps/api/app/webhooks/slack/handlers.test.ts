import { Priority } from "@repo/api/src/types/common";
import { DocumentType } from "@repo/api/src/types/document";
import {
  PRIORITY_LABEL_NONE,
  PRIORITY_LABELS,
} from "@repo/design-system/lib/vocabulary/priority-order";
import { beforeEach, describe, expect, it, vi } from "vitest";

// `withDb` runs the caller's callback against the mock client rather than
// resolving a canned value, so each query's `where` predicate is executed and
// can be asserted. Stubbing `withDb` itself would leave the org-scoping in
// those predicates unpinned.
const {
  mockWithDb,
  mockSlackIntegrationFindFirst,
  mockUserFindFirst,
  mockProjectFindUnique,
  mockDocumentService,
  mockLog,
} = vi.hoisted(() => {
  const slackIntegrationFindFirst = vi.fn();
  const userFindFirst = vi.fn();
  const projectFindUnique = vi.fn();
  const db = {
    slackIntegration: { findFirst: slackIntegrationFindFirst },
    user: { findFirst: userFindFirst },
    project: { findUnique: projectFindUnique },
  };
  return {
    mockWithDb: Object.assign(
      vi.fn((fn: (client: typeof db) => unknown) => fn(db)),
      { tx: vi.fn((fn: (client: typeof db) => unknown) => fn(db)) }
    ),
    mockSlackIntegrationFindFirst: slackIntegrationFindFirst,
    mockUserFindFirst: userFindFirst,
    mockProjectFindUnique: projectFindUnique,
    mockDocumentService: {
      create: vi.fn(),
      findById: vi.fn(),
    },
    mockLog: { warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock("@repo/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("@repo/database")>();
  return { ...original, withDb: mockWithDb };
});

vi.mock("@/app/documents/document-service", () => ({
  documentService: mockDocumentService,
}));

vi.mock("@repo/observability/log", () => ({ log: mockLog }));

import type { SlackSlashCommandPayload } from "./handlers";
import { handleCreateIdea, handleGetStatus } from "./handlers";

function payload(
  overrides: Partial<SlackSlashCommandPayload> = {}
): SlackSlashCommandPayload {
  return {
    team_id: "T-TEAM",
    user_id: "U-USER",
    text: "",
    channel_id: "C-CHANNEL",
    command: "/symphony",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// resolveSlackContext — exercised indirectly through the exported handlers
// ---------------------------------------------------------------------------

describe("resolveSlackContext (via handleCreateIdea)", () => {
  it("returns ephemeral when no SlackIntegration exists", async () => {
    mockSlackIntegrationFindFirst.mockResolvedValueOnce(null);

    const res = await handleCreateIdea(
      payload({ text: "proj-id-that-is-long-enough My idea" })
    );

    expect(res.response_type).toBe("ephemeral");
    expect(res.text).toContain("not connected");
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("No SlackIntegration"),
      expect.objectContaining({ teamId: "T-TEAM" })
    );
    expect(mockSlackIntegrationFindFirst).toHaveBeenCalledWith({
      where: { teamId: "T-TEAM" },
      select: { organizationId: true },
    });
    expect(mockUserFindFirst).not.toHaveBeenCalled();
  });

  it("returns ephemeral when integration exists but user is not found", async () => {
    mockSlackIntegrationFindFirst.mockResolvedValueOnce({
      organizationId: "org-1",
    });
    mockUserFindFirst.mockResolvedValueOnce(null);

    const res = await handleCreateIdea(
      payload({ text: "proj-id-that-is-long-enough My idea" })
    );

    expect(res.response_type).toBe("ephemeral");
    expect(res.text).toContain("not linked");
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("No User found"),
      expect.objectContaining({
        slackUserId: "U-USER",
        organizationId: "org-1",
      })
    );
    // The user lookup is scoped to the org the SlackIntegration resolved to —
    // a Slack user linked in another tenant must not match.
    expect(mockUserFindFirst).toHaveBeenCalledWith({
      where: { slackId: "U-USER", organizationId: "org-1" },
      select: { id: true },
    });
  });
});

// ---------------------------------------------------------------------------
// parseCreateIdeaText — exercised indirectly through handleCreateIdea
// ---------------------------------------------------------------------------

describe("parseCreateIdeaText (via handleCreateIdea)", () => {
  function setupContext() {
    mockSlackIntegrationFindFirst.mockResolvedValueOnce({
      organizationId: "org-1",
    });
    mockUserFindFirst.mockResolvedValueOnce({ id: "user-1" });
  }

  it("empty text returns no-title ephemeral", async () => {
    setupContext();

    const res = await handleCreateIdea(payload({ text: "" }));

    expect(res.response_type).toBe("ephemeral");
    expect(res.text).toContain("provide a title");
  });

  it("whitespace-only text returns no-title ephemeral", async () => {
    setupContext();

    const res = await handleCreateIdea(payload({ text: "   " }));

    expect(res.response_type).toBe("ephemeral");
    expect(res.text).toContain("provide a title");
  });

  it("short first word (no projectId) returns project-required ephemeral", async () => {
    setupContext();

    const res = await handleCreateIdea(payload({ text: "My great idea" }));

    expect(res.response_type).toBe("ephemeral");
    expect(res.text).toContain("project ID is required");
  });

  it("long first word alone (no title after projectId) returns no-title ephemeral", async () => {
    setupContext();

    const res = await handleCreateIdea(
      payload({ text: "abcdefghijklmnopqrstuvwxyz" })
    );

    // A single >20-char token with no second part means title="" via the else branch
    // (parts.length === 1 so the heuristic falls through to title = trimmed,
    //  projectId = null, then the no-projectId guard fires)
    expect(res.response_type).toBe("ephemeral");
    expect(res.text).toContain("project ID is required");
  });

  it("long first word + remaining text parses as projectId + title", async () => {
    setupContext();
    mockProjectFindUnique.mockResolvedValueOnce({ id: "proj-abc" });
    mockDocumentService.create.mockResolvedValueOnce({
      id: "doc-1",
      title: "Build the thing",
    });

    const res = await handleCreateIdea(
      payload({ text: "cuid_abcdefghijklmnopqrst Build the thing" })
    );

    expect(res.response_type).toBe("in_channel");
    expect(mockDocumentService.create).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      expect.objectContaining({
        title: "Build the thing",
        projectId: "cuid_abcdefghijklmnopqrst",
      })
    );
  });
});

// ---------------------------------------------------------------------------
// handleCreateIdea
// ---------------------------------------------------------------------------

describe("handleCreateIdea", () => {
  function setupFullContext() {
    mockSlackIntegrationFindFirst.mockResolvedValueOnce({
      organizationId: "org-1",
    });
    mockUserFindFirst.mockResolvedValueOnce({ id: "user-1" });
  }

  const validText = "cuid_abcdefghijklmnopqrst New PRD idea";

  it("returns ephemeral when project is not found in the org", async () => {
    setupFullContext();
    mockProjectFindUnique.mockResolvedValueOnce(null);

    const res = await handleCreateIdea(payload({ text: validText }));

    expect(res.response_type).toBe("ephemeral");
    expect(res.text).toContain("was not found");
    expect(res.text).toContain("cuid_abcdefghijklmnopqrst");
    // The project is looked up by id AND org — an id belonging to another
    // tenant must miss rather than resolve.
    expect(mockProjectFindUnique).toHaveBeenCalledWith({
      where: { id: "cuid_abcdefghijklmnopqrst", organizationId: "org-1" },
      select: { id: true },
    });
  });

  it("returns ephemeral when documentService.create returns null", async () => {
    setupFullContext();
    mockProjectFindUnique.mockResolvedValueOnce({ id: "proj-1" });
    mockDocumentService.create.mockResolvedValueOnce(null);

    const res = await handleCreateIdea(payload({ text: validText }));

    expect(res.response_type).toBe("ephemeral");
    expect(res.text).toContain("Failed to create");
  });

  it("returns in_channel with artifact title and id on success", async () => {
    setupFullContext();
    mockProjectFindUnique.mockResolvedValueOnce({ id: "proj-1" });
    mockDocumentService.create.mockResolvedValueOnce({
      id: "artifact-99",
      title: "New PRD idea",
    });

    const res = await handleCreateIdea(payload({ text: validText }));

    expect(res.response_type).toBe("in_channel");
    expect(res.text).toContain("New PRD idea");
    expect(res.text).toContain("artifact-99");
    expect(mockDocumentService.create).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      expect.objectContaining({
        type: DocumentType.Prd,
        title: "New PRD idea",
        content: "",
        projectId: "cuid_abcdefghijklmnopqrst",
      })
    );
  });

  it("returns ephemeral and logs when documentService.create throws", async () => {
    setupFullContext();
    mockProjectFindUnique.mockResolvedValueOnce({ id: "proj-1" });
    mockDocumentService.create.mockRejectedValueOnce(new Error("db down"));

    const res = await handleCreateIdea(payload({ text: validText }));

    expect(res.response_type).toBe("ephemeral");
    expect(res.text).toContain("error occurred");
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to create idea"),
      expect.objectContaining({ error: "db down" })
    );
  });

  it("logs non-Error thrown values as strings", async () => {
    setupFullContext();
    mockProjectFindUnique.mockResolvedValueOnce({ id: "proj-1" });
    mockDocumentService.create.mockRejectedValueOnce("weird throw");

    await handleCreateIdea(payload({ text: validText }));

    expect(mockLog.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to create idea"),
      expect.objectContaining({ error: "weird throw" })
    );
  });
});

// ---------------------------------------------------------------------------
// handleGetStatus
// ---------------------------------------------------------------------------

describe("handleGetStatus", () => {
  function setupContext() {
    mockSlackIntegrationFindFirst.mockResolvedValueOnce({
      organizationId: "org-1",
    });
    mockUserFindFirst.mockResolvedValueOnce({ id: "user-1" });
  }

  it("returns ephemeral when context resolution fails", async () => {
    mockSlackIntegrationFindFirst.mockResolvedValueOnce(null);

    const res = await handleGetStatus(payload({ text: "some-id" }));

    expect(res.response_type).toBe("ephemeral");
    expect(res.text).toContain("not connected");
  });

  it("returns ephemeral when identifier is empty", async () => {
    setupContext();

    const res = await handleGetStatus(payload({ text: "" }));

    expect(res.response_type).toBe("ephemeral");
    expect(res.text).toContain("provide a project or artifact identifier");
  });

  it("returns artifact status", async () => {
    setupContext();
    mockDocumentService.findById.mockResolvedValueOnce({
      title: "My PRD",
      type: DocumentType.Prd,
      status: "DRAFT",
      latestVersion: 3,
    });

    const res = await handleGetStatus(payload({ text: "artifact-id" }));

    expect(res.response_type).toBe("ephemeral");
    expect(res.text).toContain("*My PRD*");
    expect(res.text).toContain(`Type: ${DocumentType.Prd}`);
    expect(res.text).toContain("Status: DRAFT");
    expect(res.text).toContain("Version: v3");
    expect(res.text).not.toContain("Generation:");
    expect(mockDocumentService.findById).toHaveBeenCalledWith(
      "artifact-id",
      "org-1"
    );
  });

  it("falls through to project lookup when artifact is not found", async () => {
    setupContext();
    mockDocumentService.findById.mockResolvedValueOnce(null);
    mockProjectFindUnique.mockResolvedValueOnce({
      id: "proj-1",
      name: "Sprint 42",
      priority: Priority.High,
      _count: { artifacts: 7 },
    });

    const res = await handleGetStatus(payload({ text: "proj-1" }));

    expect(res.response_type).toBe("ephemeral");
    expect(res.text).toContain("*Sprint 42*");
    expect(res.text).toContain(`Priority: ${PRIORITY_LABELS[Priority.High]}`);
    expect(res.text).toContain("Documents: 7");
    expect(mockProjectFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "proj-1", organizationId: "org-1" },
      })
    );
  });

  it("prints No priority for a project with an unset priority, never the raw null", async () => {
    setupContext();
    mockDocumentService.findById.mockResolvedValueOnce(null);
    mockProjectFindUnique.mockResolvedValueOnce({
      id: "proj-2",
      name: "Unranked",
      priority: null,
      _count: { artifacts: 0 },
    });

    const res = await handleGetStatus(payload({ text: "proj-2" }));

    expect(res.text).toContain(`Priority: ${PRIORITY_LABEL_NONE}`);
    expect(res.text).not.toContain("null");
  });

  it("returns not-found when neither artifact nor project matches", async () => {
    setupContext();
    mockDocumentService.findById.mockResolvedValueOnce(null);
    mockProjectFindUnique.mockResolvedValueOnce(null);

    const res = await handleGetStatus(payload({ text: "unknown-id" }));

    expect(res.response_type).toBe("ephemeral");
    expect(res.text).toContain("No artifact or project found");
    expect(res.text).toContain("unknown-id");
  });
});
