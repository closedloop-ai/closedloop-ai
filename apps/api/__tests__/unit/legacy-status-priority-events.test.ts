/**
 * PRD-722 AC6: #8967 removed the shipped `artifact_status_changed` (ISS-9436)
 * and `artifact_priority_changed` (ISS-9443) PostHog events with no ruling.
 * These cases drive every production emitter that sent them before #8967 and
 * pin the event name and property set each one hands to PostHog. The names are
 * spelled literally: they are wire values dashboards read, and a fixture built
 * from our own constant would agree with a renamed constant.
 */
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { Priority } from "@repo/api/src/types/common";
import { IssueStatus } from "@repo/api/src/types/document";
import { ArtifactType } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDocument } from "../support/documents/document.test-fixtures";

const mocks = vi.hoisted(() => ({
  captureImmediate: vi.fn(),
  scheduled: [] as Promise<unknown>[],
}));

vi.mock("@repo/analytics/server", () => ({
  analytics: {
    captureImmediate: mocks.captureImmediate,
  },
}));
vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn((promise: Promise<unknown>) => {
    mocks.scheduled.push(Promise.resolve(promise).catch(() => undefined));
  }),
}));
vi.mock("@/lib/artifact-field-edit-analytics", () => ({
  captureArtifactFieldEditAnalytics: vi.fn(),
}));
vi.mock("@/app/audit/audit-emit-service", () => ({
  dispatchAuditEvents: vi.fn(),
  userAuditActor: vi.fn((id: string) => ({ type: "user", id })),
}));
vi.mock("@/app/audit/single-artifact-mutation-audit", () => ({
  dispatchSingleArtifactMutationAudits: vi.fn(),
}));
vi.mock("@/app/search/search-index-service", () => ({
  searchIndexService: { updatePriorityAfterCommit: vi.fn() },
}));
vi.mock("@/app/documents/blocked-dependent-unblock-service", () => ({
  blockedDependentUnblockService: {
    resolveBlocksForChangedArtifacts: vi.fn(),
  },
}));

import { emitBatchPrioritySideEffects } from "@/app/documents/batch-priority-side-effects";
import { emitBatchStatusSideEffects } from "@/app/documents/batch-status-side-effects";
import { emitDocumentLegacyChangeAnalytics } from "@/app/documents/document-field-edit-analytics";
import { emitSinglePrioritySideEffects } from "@/app/documents/single-priority-side-effects";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const DOC_A = "33333333-3333-4333-8333-333333333331";
const DOC_B = "33333333-3333-4333-8333-333333333332";
const TRANSACTION_ID = "44444444-4444-4444-8444-444444444444";
const user = { id: USER_ID, organizationId: ORG_ID };

const PRIORITY_EVENT = "artifact_priority_changed";
const STATUS_EVENT = "artifact_status_changed";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scheduled.length = 0;
  mocks.captureImmediate.mockResolvedValue(undefined);
});

async function settle(): Promise<void> {
  await Promise.all(mocks.scheduled);
}

function sentEvents() {
  return mocks.captureImmediate.mock.calls
    .map(([message]) => message)
    .filter(
      (message) =>
        message.event === PRIORITY_EVENT || message.event === STATUS_EVENT
    );
}

describe("bulk priority commit", () => {
  it("sends one artifact_priority_changed with no single origin", async () => {
    emitBatchPrioritySideEffects({
      user,
      authMethod: "session",
      priority: Priority.High,
      surface: ArtifactStatusEditSurface.Bulk,
      changedIds: [DOC_A, DOC_B],
      beforePriorities: new Map([
        [DOC_A, Priority.Low],
        [DOC_B, null],
      ]),
      transactionId: TRANSACTION_ID,
    });
    await settle();

    expect(sentEvents()).toEqual([
      {
        distinctId: USER_ID,
        event: PRIORITY_EVENT,
        properties: {
          organizationId: ORG_ID,
          surface: ArtifactStatusEditSurface.Bulk,
          result: "committed",
          to: Priority.High,
          artifactCount: 2,
        },
      },
    ]);
  });

  it("sends nothing for an API-key caller or when nothing moved", async () => {
    const base = {
      user,
      priority: Priority.High,
      surface: ArtifactStatusEditSurface.Bulk,
      beforePriorities: new Map([[DOC_A, Priority.Low]]),
      transactionId: TRANSACTION_ID,
    };
    emitBatchPrioritySideEffects({
      ...base,
      authMethod: "api_key",
      changedIds: [DOC_A],
    });
    emitBatchPrioritySideEffects({
      ...base,
      authMethod: "session",
      changedIds: [],
    });
    await settle();

    expect(sentEvents()).toEqual([]);
  });
});

describe("bulk status commit", () => {
  it("sends one artifact_status_changed naming the shared origin", async () => {
    await emitBatchStatusSideEffects({
      user,
      authMethod: "session",
      status: IssueStatus.Done,
      surface: ArtifactStatusEditSurface.Bulk,
      transitions: [
        {
          documentId: DOC_A,
          before: IssueStatus.Todo,
          after: IssueStatus.Done,
        },
        {
          documentId: DOC_B,
          before: IssueStatus.Todo,
          after: IssueStatus.Done,
        },
      ],
      changedIds: [DOC_A, DOC_B],
      transactionId: TRANSACTION_ID,
    });
    await settle();

    expect(sentEvents()).toEqual([
      {
        distinctId: USER_ID,
        event: STATUS_EVENT,
        properties: {
          organizationId: ORG_ID,
          surface: ArtifactStatusEditSurface.Bulk,
          result: "committed",
          from: IssueStatus.Todo,
          to: IssueStatus.Done,
          artifactCount: 2,
        },
      },
    ]);
  });

  it("omits from when the rows left different statuses", async () => {
    await emitBatchStatusSideEffects({
      user,
      authMethod: "session",
      status: IssueStatus.Done,
      surface: ArtifactStatusEditSurface.Board,
      transitions: [
        {
          documentId: DOC_A,
          before: IssueStatus.Todo,
          after: IssueStatus.Done,
        },
        {
          documentId: DOC_B,
          before: IssueStatus.InProgress,
          after: IssueStatus.Done,
        },
      ],
      changedIds: [DOC_A, DOC_B],
      transactionId: TRANSACTION_ID,
    });
    await settle();

    expect(sentEvents()).toEqual([
      {
        distinctId: USER_ID,
        event: STATUS_EVENT,
        properties: {
          organizationId: ORG_ID,
          surface: ArtifactStatusEditSurface.Board,
          result: "committed",
          to: IssueStatus.Done,
          artifactCount: 2,
        },
      },
    ]);
  });

  it("sends nothing without a trusted surface", async () => {
    await emitBatchStatusSideEffects({
      user,
      authMethod: "api_key",
      status: IssueStatus.Done,
      surface: ArtifactStatusEditSurface.Bulk,
      transitions: [
        {
          documentId: DOC_A,
          before: IssueStatus.Todo,
          after: IssueStatus.Done,
        },
      ],
      changedIds: [DOC_A],
      transactionId: TRANSACTION_ID,
    });
    await settle();

    expect(sentEvents()).toEqual([]);
  });
});

describe("single Session or Branch priority commit", () => {
  it("sends artifact_priority_changed with the prior value", async () => {
    emitSinglePrioritySideEffects({
      user,
      authMethod: "session",
      artifactId: DOC_A,
      artifactType: ArtifactType.SESSION,
      priority: null,
      surface: ArtifactStatusEditSurface.InlineCell,
      written: { changed: true, beforePriority: Priority.Urgent },
    });
    await settle();

    expect(sentEvents()).toEqual([
      {
        distinctId: USER_ID,
        event: PRIORITY_EVENT,
        properties: {
          organizationId: ORG_ID,
          surface: ArtifactStatusEditSurface.InlineCell,
          result: "committed",
          from: Priority.Urgent,
          to: null,
          artifactCount: 1,
        },
      },
    ]);
  });

  it("sends nothing for a no-op, an API key, or an unnamed surface", async () => {
    const base = {
      user,
      artifactId: DOC_A,
      artifactType: ArtifactType.BRANCH,
      priority: Priority.Low,
    } as const;
    emitSinglePrioritySideEffects({
      ...base,
      authMethod: "session",
      surface: ArtifactStatusEditSurface.Detail,
      written: { changed: false, beforePriority: Priority.Low },
    });
    emitSinglePrioritySideEffects({
      ...base,
      authMethod: "api_key",
      surface: ArtifactStatusEditSurface.Detail,
      written: { changed: true, beforePriority: Priority.High },
    });
    emitSinglePrioritySideEffects({
      ...base,
      authMethod: "session",
      written: { changed: true, beforePriority: Priority.High },
    });
    await settle();

    expect(sentEvents()).toEqual([]);
  });
});

describe("single document PUT", () => {
  const previous = makeDocument({
    id: DOC_A,
    status: IssueStatus.Todo,
    priority: Priority.Low,
  });

  it("sends both events when status and priority both moved", async () => {
    emitDocumentLegacyChangeAnalytics({
      organizationId: ORG_ID,
      userId: USER_ID,
      provenance: { surface: ArtifactStatusEditSurface.Detail },
      surface: ArtifactStatusEditSurface.Detail,
      authMethod: "session",
      requested: { status: IssueStatus.Done, priority: Priority.High },
      previous,
      artifact: {
        ...previous,
        status: IssueStatus.Done,
        priority: Priority.High,
      },
    });
    await settle();

    const events = sentEvents();
    expect(events).toHaveLength(2);
    expect(events).toEqual([
      {
        distinctId: USER_ID,
        event: STATUS_EVENT,
        properties: {
          organizationId: ORG_ID,
          surface: ArtifactStatusEditSurface.Detail,
          result: "committed",
          from: IssueStatus.Todo,
          to: IssueStatus.Done,
          artifactCount: 1,
        },
      },
      {
        distinctId: USER_ID,
        event: PRIORITY_EVENT,
        properties: {
          organizationId: ORG_ID,
          surface: ArtifactStatusEditSurface.Detail,
          result: "committed",
          from: Priority.Low,
          to: Priority.High,
          artifactCount: 1,
        },
      },
    ]);
  });

  it("never attributes a priority change the request did not ask for", async () => {
    emitDocumentLegacyChangeAnalytics({
      organizationId: ORG_ID,
      userId: USER_ID,
      provenance: { surface: ArtifactStatusEditSurface.Detail },
      surface: ArtifactStatusEditSurface.Detail,
      authMethod: "session",
      requested: { title: "Renamed" },
      previous,
      artifact: { ...previous, priority: Priority.High },
    });
    await settle();

    expect(sentEvents()).toEqual([]);
  });

  it("never attributes a status change the request did not ask for", async () => {
    emitDocumentLegacyChangeAnalytics({
      organizationId: ORG_ID,
      userId: USER_ID,
      provenance: { surface: ArtifactStatusEditSurface.Detail },
      surface: ArtifactStatusEditSurface.Detail,
      authMethod: "session",
      requested: { approverId: USER_ID },
      previous,
      artifact: { ...previous, status: IssueStatus.Done },
    });
    await settle();

    expect(sentEvents()).toEqual([]);
  });

  it("sends no priority event from a surface that cannot write one", async () => {
    emitDocumentLegacyChangeAnalytics({
      organizationId: ORG_ID,
      userId: USER_ID,
      provenance: undefined,
      surface: ArtifactStatusEditSurface.Board,
      authMethod: "session",
      requested: { priority: Priority.High },
      previous,
      artifact: { ...previous, priority: Priority.High },
    });
    await settle();

    expect(sentEvents()).toEqual([]);
  });
});
