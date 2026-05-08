/**
 * Tests for the LoopCell variants in DocumentRow.
 *
 * Covers:
 * - Default variant (legacy behavior, regression-protected)
 * - Team variant (active from activeLoops, completed/failed from loopSummaries)
 * - My Tasks variant (everything from loopSummaries)
 * - Priority logic (failed-newer-than-active wins on My Tasks)
 * - Terminal status labels (CANCELLED vs TIMED_OUT vs FAILED)
 * - Unknown LoopCommand fallback
 */
import { Priority } from "@repo/api/src/types/common";
import type { DocumentWithWorkstream } from "@repo/api/src/types/document";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import type {
  LoopSummariesResponse,
  LoopWithUser,
} from "@repo/api/src/types/loop";
import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn() })),
  usePathname: vi.fn(() => "/"),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  useParams: vi.fn(() => ({})),
}));

vi.mock("@/hooks/queries/use-judges", () => ({
  usePlanJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  usePrdJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
  useCodeJudgesFeedback: vi.fn(() => ({ data: null, isLoading: false })),
}));

import type {
  DocumentRowItem,
  RowEditHandlers,
} from "@/components/document-table/document-row";
import { DocumentRow } from "@/components/document-table/document-row";
import {
  DocumentColumn,
  type DocumentColumn as DocumentColumnType,
} from "@/hooks/use-column-visibility";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FEATURE_ID = "doc-feature-1";
const LOOP_ID_ACTIVE = "loop-active-1";
const LOOP_ID_COMPLETED = "loop-completed-1";
const LOOP_ID_FAILED = "loop-failed-1";

const COLS: DocumentColumnType[] = [DocumentColumn.Loop];
const ADA_NAME_REGEX = /Ada Lovelace/;

function makeFeature(
  overrides?: Partial<DocumentWithWorkstream>
): DocumentWithWorkstream {
  return {
    id: FEATURE_ID,
    organizationId: "org-1",
    workstreamId: null,
    projectId: "project-1",
    type: DocumentType.Feature,
    title: "My Feature",
    slug: "FEAT-1",
    fileName: null,
    status: DocumentStatus.Draft,
    priority: Priority.Medium,
    latestVersion: 1,
    createdById: "user-1",
    assigneeId: null,
    assignee: null,
    approverId: null,
    approver: null,
    tokenUsage: null,
    targetRepo: null,
    targetBranch: null,
    templateForType: null,
    sortOrder: null,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-02"),
    ...overrides,
  };
}

const featureItem: DocumentRowItem = {
  kind: "feature",
  data: makeFeature(),
};

function makeArtifactItem(
  overrides?: Partial<DocumentWithWorkstream>
): DocumentRowItem {
  return {
    kind: "artifact",
    data: makeFeature({
      id: FEATURE_ID,
      type: DocumentType.Prd,
      slug: "PRD-1",
      ...overrides,
    }),
  };
}

function makeActiveLoop(): LoopWithUser {
  return {
    id: LOOP_ID_ACTIVE,
    documentId: FEATURE_ID,
    user: {
      id: "user-1",
      firstName: "Ada",
      lastName: "Lovelace",
      avatarUrl: null,
      email: "ada@example.com",
    },
    computeTarget: null,
  } as LoopWithUser;
}

function summariesWith(
  overrides: Partial<LoopSummariesResponse[string]>
): LoopSummariesResponse {
  return {
    [FEATURE_ID]: {
      activeLoop: null,
      latestCompleted: null,
      latestFailed: null,
      ...overrides,
    },
  };
}

const TEST_BASIC_USER = {
  id: "user-ada",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  avatarUrl: null,
};

function activeEntry(
  overrides?: Partial<{ command: string; startedAt: Date; isLocal: boolean }>
) {
  return {
    loopId: LOOP_ID_ACTIVE,
    command: (overrides?.command ?? LoopCommand.Plan) as never,
    status: LoopStatus.Running as never,
    user: TEST_BASIC_USER,
    isLocal: overrides?.isLocal ?? false,
    childSubtype: null,
    isDirectLoop: false,
    startedAt: overrides?.startedAt ?? new Date("2026-04-28T08:00:00.000Z"),
    completedAt: null,
    failedAt: null,
    updatedAt: overrides?.startedAt ?? new Date("2026-04-28T08:00:00.000Z"),
  };
}

function completedEntry(overrides?: { command?: string; completedAt?: Date }) {
  const completedAt =
    overrides?.completedAt ?? new Date("2026-04-28T11:00:00.000Z");
  return {
    loopId: LOOP_ID_COMPLETED,
    command: (overrides?.command ?? LoopCommand.GeneratePrd) as never,
    status: LoopStatus.Completed as never,
    user: TEST_BASIC_USER,
    isLocal: false,
    childSubtype: null,
    isDirectLoop: false,
    startedAt: null,
    completedAt,
    failedAt: null,
    updatedAt: completedAt,
  };
}

function failedEntry(overrides?: {
  command?: string;
  status?: string;
  failedAt?: Date;
  completedAt?: Date | null;
}) {
  const failedAt = overrides?.failedAt ?? new Date("2026-04-28T10:00:00.000Z");
  return {
    loopId: LOOP_ID_FAILED,
    command: (overrides?.command ?? LoopCommand.Execute) as never,
    status: (overrides?.status ?? LoopStatus.Failed) as never,
    user: TEST_BASIC_USER,
    isLocal: false,
    childSubtype: null,
    isDirectLoop: false,
    startedAt: null,
    completedAt:
      overrides?.completedAt === undefined ? null : overrides.completedAt,
    failedAt,
    updatedAt: failedAt,
  };
}

function renderRow(
  editHandlers: RowEditHandlers,
  item: DocumentRowItem = featureItem
) {
  return render(
    <DocumentRow
      editHandlers={editHandlers}
      item={item}
      visibleColumns={COLS}
    />
  );
}

// ---------------------------------------------------------------------------
// Default variant — legacy behavior preserved
// ---------------------------------------------------------------------------

describe("LoopCell — default variant (no loopVariant set)", () => {
  it("renders dash when no active loop, no failed gen status, no summaries", () => {
    const { getByText } = renderRow({});
    expect(getByText("—")).toBeInTheDocument();
  });

  it("renders running spinner + user when active loop exists (regression)", () => {
    const { getByText, container } = renderRow({
      activeLoops: [makeActiveLoop()],
    });
    expect(getByText("Ada Lovelace")).toBeInTheDocument();
    const link = container.querySelector(`a[href="/loops/${LOOP_ID_ACTIVE}"]`);
    expect(link).toBeInTheDocument();
  });

  it("renders 'Loop Failed' when generationStatus is FAILURE (regression)", () => {
    const baseItem = makeArtifactItem();
    if (baseItem.kind !== "artifact") {
      throw new Error("expected artifact kind");
    }
    const item: DocumentRowItem = {
      kind: "artifact",
      data: {
        ...baseItem.data,
        generationStatus: {
          status: "FAILURE",
          loopId: LOOP_ID_FAILED,
        },
      } as DocumentWithWorkstream,
    };
    const { getByText, container } = renderRow({}, item);
    expect(getByText("Loop Failed")).toBeInTheDocument();
    const link = container.querySelector(`a[href="/loops/${LOOP_ID_FAILED}"]`);
    expect(link).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Team variant
// ---------------------------------------------------------------------------

describe("LoopCell — team variant", () => {
  it("renders running spinner + user when active loop is on the document", () => {
    const { getByText, container } = renderRow({
      loopVariant: "team",
      activeLoops: [makeActiveLoop()],
    });
    expect(getByText("Ada Lovelace")).toBeInTheDocument();
    expect(
      container.querySelector(`a[href="/loops/${LOOP_ID_ACTIVE}"]`)
    ).toBeInTheDocument();
  });

  it("renders completed badge with user + relative time when no active loop", () => {
    const { container, getByText } = renderRow({
      loopVariant: "team",
      loopSummaries: summariesWith({
        latestCompleted: completedEntry({ command: LoopCommand.Plan }),
      }),
    });
    expect(getByText(ADA_NAME_REGEX)).toBeInTheDocument();
    expect(
      container.querySelector(`a[href="/loops/${LOOP_ID_COMPLETED}"]`)
    ).toBeInTheDocument();
  });

  it("renders failed label when latestFailed is present and no active loop", () => {
    const { getByText, container } = renderRow({
      loopVariant: "team",
      loopSummaries: summariesWith({
        latestFailed: failedEntry({
          command: LoopCommand.Execute,
          status: LoopStatus.Failed,
        }),
      }),
    });
    expect(getByText("Code failed")).toBeInTheDocument();
    expect(
      container.querySelector(`a[href="/loops/${LOOP_ID_FAILED}"]`)
    ).toBeInTheDocument();
  });

  it("renders dash when no active, no completed, no failed", () => {
    const { getByText } = renderRow({
      loopVariant: "team",
      loopSummaries: summariesWith({}),
    });
    expect(getByText("—")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// My Tasks variant
// ---------------------------------------------------------------------------

describe("LoopCell — my-tasks variant", () => {
  it("renders progress label when active loop exists", () => {
    const { getByText } = renderRow({
      loopVariant: "my-tasks",
      loopSummaries: summariesWith({
        activeLoop: activeEntry({ command: LoopCommand.Plan }),
      }),
    });
    expect(getByText("Plan generating")).toBeInTheDocument();
  });

  it("renders completed label when no active and no failed", () => {
    const { getByText } = renderRow({
      loopVariant: "my-tasks",
      loopSummaries: summariesWith({
        latestCompleted: completedEntry({ command: LoopCommand.GeneratePrd }),
      }),
    });
    expect(getByText("PRD generated")).toBeInTheDocument();
  });

  it("renders failed label when no active loop and latestFailed present", () => {
    const { getByText } = renderRow({
      loopVariant: "my-tasks",
      loopSummaries: summariesWith({
        latestFailed: failedEntry({
          command: LoopCommand.Execute,
          status: LoopStatus.Failed,
        }),
      }),
    });
    expect(getByText("Code failed")).toBeInTheDocument();
  });

  it("priority: failed wins over active when failedAt > active.startedAt", () => {
    const { getByText, queryByText } = renderRow({
      loopVariant: "my-tasks",
      loopSummaries: summariesWith({
        activeLoop: activeEntry({
          command: LoopCommand.Plan,
          startedAt: new Date("2026-04-28T08:00:00.000Z"),
        }),
        latestFailed: failedEntry({
          command: LoopCommand.Execute,
          status: LoopStatus.Failed,
          failedAt: new Date("2026-04-28T09:30:00.000Z"),
        }),
      }),
    });
    expect(getByText("Code failed")).toBeInTheDocument();
    expect(queryByText("Plan generating")).not.toBeInTheDocument();
  });

  it("priority: active wins over completed-newer (asymmetry)", () => {
    const { getByText, queryByText } = renderRow({
      loopVariant: "my-tasks",
      loopSummaries: summariesWith({
        activeLoop: activeEntry({
          command: LoopCommand.Plan,
          startedAt: new Date("2026-04-28T09:00:00.000Z"),
        }),
        latestCompleted: completedEntry({
          command: LoopCommand.GeneratePrd,
          completedAt: new Date("2026-04-28T11:00:00.000Z"),
        }),
      }),
    });
    expect(getByText("Plan generating")).toBeInTheDocument();
    expect(queryByText("PRD generated")).not.toBeInTheDocument();
  });

  it("priority: active wins over failed-older-than-active", () => {
    const { getByText, queryByText } = renderRow({
      loopVariant: "my-tasks",
      loopSummaries: summariesWith({
        activeLoop: activeEntry({
          command: LoopCommand.Plan,
          startedAt: new Date("2026-04-28T10:00:00.000Z"),
        }),
        latestFailed: failedEntry({
          command: LoopCommand.Execute,
          status: LoopStatus.Failed,
          failedAt: new Date("2026-04-28T08:00:00.000Z"),
        }),
      }),
    });
    expect(getByText("Plan generating")).toBeInTheDocument();
    expect(queryByText("Code failed")).not.toBeInTheDocument();
  });

  it("distinguishes CANCELLED label from FAILED", () => {
    const { getByText } = renderRow({
      loopVariant: "my-tasks",
      loopSummaries: summariesWith({
        latestFailed: failedEntry({
          command: LoopCommand.Execute,
          status: LoopStatus.Cancelled,
        }),
      }),
    });
    expect(getByText("Code cancelled")).toBeInTheDocument();
  });

  it("distinguishes TIMED_OUT label from FAILED", () => {
    const { getByText } = renderRow({
      loopVariant: "my-tasks",
      loopSummaries: summariesWith({
        latestFailed: failedEntry({
          command: LoopCommand.Execute,
          status: LoopStatus.TimedOut,
        }),
      }),
    });
    expect(getByText("Code timed out")).toBeInTheDocument();
  });

  it("renders dash when summary entry is missing for the document", () => {
    const { getByText } = renderRow({
      loopVariant: "my-tasks",
      loopSummaries: {},
    });
    expect(getByText("—")).toBeInTheDocument();
  });

  it("renders dash when summary exists but all entries are null", () => {
    const { getByText } = renderRow({
      loopVariant: "my-tasks",
      loopSummaries: summariesWith({}),
    });
    expect(getByText("—")).toBeInTheDocument();
  });

  it("falls back to raw command string for unknown LoopCommand value", () => {
    const { getByText } = renderRow({
      loopVariant: "my-tasks",
      loopSummaries: summariesWith({
        activeLoop: activeEntry({ command: "FUTURE_COMMAND" }),
      }),
    });
    // getCommandLabels returns command itself as the progress label fallback
    expect(getByText("FUTURE_COMMAND")).toBeInTheDocument();
  });
});
