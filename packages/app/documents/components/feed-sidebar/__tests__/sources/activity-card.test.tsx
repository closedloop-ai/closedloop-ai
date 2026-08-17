/**
 * ISS-5007. The artifact activity feed rendered internal serializations as
 * user-facing copy: the "created this artifact" row printed the whole
 * `{ status, title }` snapshot into a chip, hard-clipped mid-word, and a
 * priority change read `field: priority, value: MEDIUM`. These assert the
 * rendered output of each event type, since the defect was only ever visible
 * at the render, not in the store.
 */
import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import {
  ActivityFeedActorKind,
  ActivityFeedItemSource,
  type ArtifactActivityFeedItem,
} from "@repo/api/src/types/artifact-activity-feed";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import type { User } from "@repo/api/src/types/user";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useOrganizationUsersMock = vi.fn();
const useProjectsMock = vi.fn();

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => useOrganizationUsersMock(),
}));

vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProjects: () => useProjectsMock(),
}));

// The actor cell is NOT mocked: it resolves against the same org-user
// directory as the change chips, and the defect this file guards is the two of
// them disagreeing about that one lookup. Stubbing it out is what let the
// disagreement through.
vi.mock("@repo/app/shared/components/user-link", () => ({
  UserLink: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

/** A settled query with records: the only state in which a miss is a real absence. */
function readyQuery<T>(data: T[]) {
  return { data, isPending: false, isError: false, fetchStatus: "idle" };
}

import { FeedItemKind } from "../../feed-item";
import { ActivityCard } from "../../sources/activity-card";
import { ACTIVITY_SOURCE_ID } from "../../sources/activity-types";

const ARTIFACT_TITLE = "Enhance Session Quality Signals with GitHub PR Metrics";

const ASSIGNEE: User = {
  id: "user_b",
  firstName: "Dana",
  lastName: "Reed",
  email: "dana@example.com",
} as User;

const PROJECT = { id: "018f-b", name: "Session Quality" } as ProjectWithDetails;

function makeItem(overrides: Partial<ArtifactActivityFeedItem>) {
  const event: ArtifactActivityFeedItem = {
    id: "event:1",
    source: ActivityFeedItemSource.Event,
    action: null,
    actor: { kind: ActivityFeedActorKind.Agent, id: "agent-1" },
    before: null,
    after: null,
    payload: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
  return {
    id: event.id,
    kind: FeedItemKind.Activity,
    sourceId: ACTIVITY_SOURCE_ID,
    createdAt: event.createdAt,
    event,
  } as Parameters<typeof ActivityCard>[0]["item"];
}

function renderedText(container: HTMLElement): string {
  return container.textContent ?? "";
}

describe("ActivityCard change values (ISS-5007)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrganizationUsersMock.mockReturnValue(readyQuery([ASSIGNEE]));
    useProjectsMock.mockReturnValue(readyQuery([PROJECT]));
  });

  it("renders a creation row as its headline, with no serialized snapshot", () => {
    const { container } = render(
      <ActivityCard
        item={makeItem({
          action: ArtifactActivityAction.Creation,
          after: { status: "TODO", title: ARTIFACT_TITLE },
        })}
      />
    );

    expect(screen.getByText("created this artifact")).toBeTruthy();
    expect(renderedText(container)).not.toContain(ARTIFACT_TITLE);
    expect(renderedText(container)).not.toContain("status:");
  });

  it("renders a priority change as labels, not as field/value tokens", () => {
    const { container } = render(
      <ActivityCard
        item={makeItem({
          action: ArtifactActivityAction.FieldChange,
          before: { field: "priority", value: "MEDIUM" },
          after: { field: "priority", value: "LOW" },
        })}
      />
    );

    const text = renderedText(container);
    expect(text).toContain("updated the priority");
    expect(text).toContain("Medium");
    expect(text).toContain("Low");
    expect(text).not.toContain("field:");
    expect(text).not.toContain("value:");
  });

  it("renders no raw field-name tokens for any event type in the feed", () => {
    const cases: Partial<ArtifactActivityFeedItem>[] = [
      {
        action: ArtifactActivityAction.Creation,
        after: { status: "TODO", title: ARTIFACT_TITLE },
      },
      {
        action: ArtifactActivityAction.StatusChange,
        before: "TODO",
        after: "IN_REVIEW",
      },
      {
        action: ArtifactActivityAction.Assignment,
        before: null,
        after: "user_b",
      },
      {
        action: ArtifactActivityAction.FieldChange,
        before: { field: "projectId", value: "018f-a" },
        after: { field: "projectId", value: "018f-b" },
      },
      {
        source: ActivityFeedItemSource.VersionCreated,
        payload: { version: 4 },
      },
      {
        source: ActivityFeedItemSource.Derivation,
        payload: { direction: "produced", relatedArtifactId: "x" },
      },
      { source: ActivityFeedItemSource.Loop, payload: { status: "COMPLETED" } },
      {
        source: ActivityFeedItemSource.Evaluation,
        payload: { reportType: "code_review" },
      },
    ];

    for (const overrides of cases) {
      const { container, unmount } = render(
        <ActivityCard item={makeItem(overrides)} />
      );
      const text = renderedText(container);
      expect(text).not.toContain("field:");
      expect(text).not.toContain("value:");
      expect(text).not.toContain("status:");
      expect(text).not.toContain("018f-");
      unmount();
    }
  });

  it("names the person on an assignment row instead of showing the id", () => {
    const { container } = render(
      <ActivityCard
        item={makeItem({
          action: ArtifactActivityAction.Assignment,
          before: null,
          after: "user_b",
        })}
      />
    );

    const text = renderedText(container);
    expect(text).toContain("Dana Reed");
    expect(text).not.toContain("user_b");
  });

  it("reserves the chip's space while the org-user map is still loading", () => {
    useOrganizationUsersMock.mockReturnValue({
      data: undefined,
      isPending: true,
      isError: false,
      fetchStatus: "fetching",
    });

    const { container } = render(
      <ActivityCard
        item={makeItem({
          action: ArtifactActivityAction.Assignment,
          before: null,
          after: "user_b",
        })}
      />
    );

    // A pending lookup must not claim the person is unknown.
    expect(renderedText(container)).not.toContain("Unknown user");
    expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
  });

  it("says the person is unknown only once the map has settled without them", () => {
    useOrganizationUsersMock.mockReturnValue(readyQuery([ASSIGNEE]));

    const { container } = render(
      <ActivityCard
        item={makeItem({
          action: ArtifactActivityAction.Assignment,
          before: null,
          after: "user_gone",
        })}
      />
    );

    expect(renderedText(container)).toContain("Unknown user");
  });

  it("truncates a long value with an ellipsis rather than clipping it", () => {
    const { container } = render(
      <ActivityCard
        item={makeItem({
          action: ArtifactActivityAction.FieldChange,
          before: { field: "title", value: "Old name" },
          after: { field: "title", value: ARTIFACT_TITLE },
        })}
      />
    );

    // `truncate` is overflow-hidden + text-ellipsis + nowrap; the bug was a
    // nowrap pill with overflow-hidden and NO ellipsis, so the cut looked like
    // a rendering fault. The full string stays in the DOM either way.
    const truncated = Array.from(
      container.querySelectorAll('[data-slot="chip"] .truncate')
    ).map((node) => node.textContent);
    expect(truncated).toEqual(["Old name", ARTIFACT_TITLE]);
  });
});

describe("ActivityCard directory states (ISS-5007)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrganizationUsersMock.mockReturnValue(readyQuery([ASSIGNEE]));
    useProjectsMock.mockReturnValue(readyQuery([PROJECT]));
  });

  function assignmentRow() {
    return makeItem({
      actor: { kind: ActivityFeedActorKind.Human, id: "user_b" },
      action: ArtifactActivityAction.Assignment,
      before: { field: "assigneeId", value: null },
      after: { field: "assigneeId", value: "user_b" },
    });
  }

  // `isPending` goes false when the read ERRORS, not only when it succeeds, so
  // a directory outage used to render every assignment row as a confident
  // "Unknown user" — a fact about a person we never actually looked up.
  it("claims nothing about a person when the org-user read failed", () => {
    useOrganizationUsersMock.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      fetchStatus: "idle",
    });

    const { container } = render(<ActivityCard item={assignmentRow()} />);

    const text = renderedText(container);
    expect(text).toContain("updated the assignee");
    expect(text).not.toContain("Unknown user");
    expect(text).not.toContain("user_b");
  });

  // A restricted viewer's /users can legitimately return []. We cannot look
  // anyone up, so we must not report them as unknown either.
  it("claims nothing about a person when the directory is empty", () => {
    useOrganizationUsersMock.mockReturnValue(readyQuery<User>([]));

    const { container } = render(<ActivityCard item={assignmentRow()} />);

    expect(renderedText(container)).not.toContain("Unknown user");
  });

  // The actor cell and the chips read one directory, so they cannot disagree.
  it("holds the actor name too while the directory is pending", () => {
    useOrganizationUsersMock.mockReturnValue({
      data: undefined,
      isPending: true,
      isError: false,
      fetchStatus: "fetching",
    });

    const { container } = render(<ActivityCard item={assignmentRow()} />);

    expect(renderedText(container)).not.toContain("Unknown user");
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(3);
  });

  it("does not call the actor unknown when the directory is unavailable", () => {
    useOrganizationUsersMock.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      fetchStatus: "idle",
    });

    const { container } = render(<ActivityCard item={assignmentRow()} />);

    expect(renderedText(container)).not.toContain("Unknown user");
    expect(renderedText(container)).toContain("Member");
  });

  it("names the project on a project change instead of a dead headline", () => {
    const { container } = render(
      <ActivityCard
        item={makeItem({
          action: ArtifactActivityAction.FieldChange,
          before: { field: "projectId", value: "018f-a" },
          after: { field: "projectId", value: "018f-b" },
        })}
      />
    );

    const text = renderedText(container);
    expect(text).toContain("updated the project");
    expect(text).toContain("Session Quality");
    expect(text).not.toContain("018f-");
  });

  it("names which role moved on an approver change", () => {
    const { container } = render(
      <ActivityCard
        item={makeItem({
          action: ArtifactActivityAction.Assignment,
          before: { field: "approverId", value: null },
          after: { field: "approverId", value: "user_b" },
        })}
      />
    );

    expect(renderedText(container)).toContain("updated the approver");
  });

  // A rename produces two truncated pills that read identically at rail width;
  // the full string has to be reachable on hover, not only in the DOM.
  it("carries the full value in a title attribute on a truncated chip", () => {
    const { container } = render(
      <ActivityCard
        item={makeItem({
          action: ArtifactActivityAction.FieldChange,
          before: { field: "title", value: "Old name" },
          after: { field: "title", value: ARTIFACT_TITLE },
        })}
      />
    );

    const titles = Array.from(
      container.querySelectorAll('[data-slot="chip"] .truncate')
    ).map((node) => node.getAttribute("title"));
    expect(titles).toEqual(["Old name", ARTIFACT_TITLE]);
  });
});
