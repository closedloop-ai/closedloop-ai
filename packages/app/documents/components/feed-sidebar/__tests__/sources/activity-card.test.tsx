/**
 * The activity row containers, rendered (ISS-5007, ISS-12117). One adapter,
 * two looks: the comments rail's compact card and the Activity tab's timeline
 * line must say the same thing about the same row, and neither may print an
 * id or a serialized snapshot. These assert the rendered output, since the
 * ISS-5007 defect was only ever visible at the render.
 */
import { ArtifactActivityAction } from "@repo/api/src/types/artifact-activity";
import {
  ActivityFeedActorKind,
  ActivityFeedItemSource,
  type ArtifactActivityFeedItem,
} from "@repo/api/src/types/artifact-activity-feed";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import type { User } from "@repo/api/src/types/user";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { avatarImageMockModule } from "@repo/app/test/mocks/avatar-image";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useOrganizationUsersMock = vi.fn();
const useProjectsMock = vi.fn();
const useTagsMock = vi.fn();

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => useOrganizationUsersMock(),
}));
vi.mock("@repo/app/projects/hooks/use-projects", () => ({
  useProjects: (...args: unknown[]) => useProjectsMock(...args),
}));
vi.mock("@repo/app/tags/hooks/use-tags", () => ({
  useTags: (...args: unknown[]) => useTagsMock(...args),
}));

// The actor cell is NOT mocked: it resolves against the same org-user
// directory as the names in the phrase, and the defect this file guards is
// the two of them disagreeing about that one lookup.
// Only `AvatarImage` is replaced (jsdom never loads a picture), so a photo
// asserts as an `<img>` and the fallback glyph and initials stay real.
vi.mock("@repo/design-system/components/ui/avatar", (importOriginal) =>
  avatarImageMockModule(importOriginal)
);
vi.mock("@repo/app/shared/components/user-link", () => ({
  UserLink: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@repo/navigation/link", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

/** A settled query with records: the only state in which a miss is a real absence. */
function readyQuery<T>(data: T[]) {
  return { data, isPending: false, isError: false, fetchStatus: "idle" };
}
const PENDING_QUERY = {
  data: undefined,
  isPending: true,
  isError: false,
  fetchStatus: "fetching",
};
const FAILED_QUERY = {
  data: undefined,
  isPending: false,
  isError: true,
  fetchStatus: "idle",
};

import { FeedItemKind } from "../../feed-item";
import {
  ActivityArtifactKind,
  ActivityCard,
  ActivityCardLayout,
  ActivityCommentCard,
} from "../../sources/activity-card";
import { ACTIVITY_SOURCE_ID } from "../../sources/activity-types";

/** One initial on every avatar (Nerys, 2026-10-22), and nothing else. */
const ONLY_D = /^D$/;

const ARTIFACT_TITLE = "Enhance Session Quality Signals with GitHub PR Metrics";

const DANA: User = {
  id: "user_b",
  firstName: "Dana",
  lastName: "Reed",
  email: "dana@example.com",
} as User;

const PROJECT = { id: "018f-b", name: "Session Quality" } as ProjectWithDetails;
const TAG = { id: "tag_1", name: "frontend", color: "blue" };

function makeItem(overrides: Partial<ArtifactActivityFeedItem>) {
  const event: ArtifactActivityFeedItem = {
    id: "event:1",
    source: ActivityFeedItemSource.Event,
    action: null,
    actor: { kind: ActivityFeedActorKind.Human, id: "user_b" },
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

const LAYOUTS = [ActivityCardLayout.Rail, ActivityCardLayout.Timeline];

beforeEach(() => {
  vi.clearAllMocks();
  useOrganizationUsersMock.mockReturnValue(readyQuery([DANA]));
  useProjectsMock.mockReturnValue(readyQuery([PROJECT]));
  useTagsMock.mockReturnValue(readyQuery([TAG]));
});

describe.each(LAYOUTS)("ActivityCard (%s look)", (layout) => {
  function renderRow(overrides: Partial<ArtifactActivityFeedItem>) {
    return render(<ActivityCard item={makeItem(overrides)} layout={layout} />);
  }

  it("renders a creation row as its phrase, with no serialized snapshot", () => {
    const { container } = renderRow({
      action: ArtifactActivityAction.Creation,
      after: { status: "DRAFT", title: ARTIFACT_TITLE },
    });
    // No documentType from the host: a neutral noun, never a guessed "PRD".
    expect(container).toHaveTextContent("created this document Draft");
    expect(container.textContent).not.toContain(ARTIFACT_TITLE);
    expect(container.textContent).not.toContain("status:");
  });

  it("draws a status change as two pills in the catalog wording", () => {
    const { container } = renderRow({
      action: ArtifactActivityAction.StatusChange,
      before: "DRAFT",
      after: "IN_REVIEW",
    });
    expect(container).toHaveTextContent(
      "changed status from Draft to In Review"
    );
    const pills = Array.from(
      container.querySelectorAll('[data-slot="badge"]')
    ).map((node) => node.textContent);
    expect(pills).toEqual(["Draft", "In Review"]);
  });

  it("names the person on an assignment, never the id", () => {
    const { container } = renderRow({
      action: ArtifactActivityAction.Assignment,
      before: { field: "assigneeId", value: null },
      after: { field: "assigneeId", value: "user_b" },
    });
    expect(container).toHaveTextContent("assigned Dana Reed");
    expect(container.textContent).not.toContain("user_b");
  });

  it("names the project on a project change, never the id", () => {
    const { container } = renderRow({
      action: ArtifactActivityAction.FieldChange,
      before: { field: "projectId", value: null },
      after: { field: "projectId", value: "018f-b" },
    });
    expect(container).toHaveTextContent("moved this to Session Quality");
    expect(container.textContent).not.toContain("018f-");
  });

  it("names the tag in its own colour, with the bulk suffix", () => {
    const { container } = renderRow({
      action: ArtifactActivityAction.FieldChange,
      before: null,
      after: { field: "tag", value: "tag_1" },
    });
    expect(container).toHaveTextContent("added the frontend tag · bulk update");
  });

  it("holds every name while the org-user directory is pending", () => {
    useOrganizationUsersMock.mockReturnValue(PENDING_QUERY);
    const { container } = renderRow({
      action: ArtifactActivityAction.Assignment,
      before: { field: "assigneeId", value: null },
      after: { field: "assigneeId", value: "user_b" },
    });
    expect(container.textContent).not.toContain("Unknown user");
    expect(
      container.querySelectorAll('[data-slot="skeleton"]').length
    ).toBeGreaterThan(0);
  });

  it("says the person is unknown only once the directory has settled", () => {
    const { container } = renderRow({
      action: ArtifactActivityAction.Assignment,
      before: { field: "assigneeId", value: null },
      after: { field: "assigneeId", value: "user_gone" },
    });
    expect(container).toHaveTextContent("assigned Unknown user");
  });

  // `isPending` goes false when the read ERRORS, so a directory outage used
  // to render a confident "Unknown user" — a fact we never looked up.
  it("claims nothing about a person when the org-user read failed", () => {
    useOrganizationUsersMock.mockReturnValue(FAILED_QUERY);
    const { container } = renderRow({
      action: ArtifactActivityAction.Assignment,
      before: { field: "assigneeId", value: null },
      after: { field: "assigneeId", value: "user_b" },
    });
    expect(container).toHaveTextContent("Member");
    expect(container).toHaveTextContent("updated the assignee");
    expect(container.textContent).not.toContain("Unknown user");
    expect(container.textContent).not.toContain("user_b");
  });

  it("labels a Session's stored statuses with the Session words", () => {
    const { container } = render(
      <ActivityCard
        artifactKind={ActivityArtifactKind.Session}
        item={makeItem({
          action: ArtifactActivityAction.StatusChange,
          actor: { kind: ActivityFeedActorKind.System, id: null },
          before: "active",
          after: "inactive",
        })}
        layout={layout}
      />
    );
    expect(container).toHaveTextContent(
      "changed status from Active to Inactive"
    );
    expect(container.textContent).not.toContain("from desktop sync");
  });

  it("uses the universal status words when that flag is on", () => {
    const { container } = render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY],
        })}
      >
        <ActivityCard
          artifactKind={ActivityArtifactKind.Session}
          item={makeItem({
            action: ArtifactActivityAction.StatusChange,
            before: "inactive",
            after: "active",
          })}
          layout={layout}
        />
      </FeatureFlagAdapterProvider>
    );
    expect(container.textContent).not.toContain("inactive");
  });

  it("names the API-key owner with the API badge on an agent row", () => {
    render(
      <ActivityCard
        item={makeItem({
          action: ArtifactActivityAction.StatusChange,
          actor: { kind: ActivityFeedActorKind.Agent, id: "user_b" },
          before: "DRAFT",
          after: "IN_REVIEW",
        })}
        layout={layout}
      />
    );
    expect(screen.getByText("Dana Reed")).toBeInTheDocument();
    expect(screen.getByText("API", { exact: true })).toBeInTheDocument();
  });

  it("gives a System row no badge", () => {
    const { container } = render(
      <ActivityCard
        item={makeItem({
          action: ArtifactActivityAction.StatusChange,
          actor: { kind: ActivityFeedActorKind.System, id: null },
          before: "BLOCKED",
          after: "TODO",
        })}
        layout={layout}
      />
    );
    expect(container).toHaveTextContent("System");
    expect(container).toHaveTextContent("· automatically");
    expect(screen.queryByText("API", { exact: true })).toBeNull();
  });
});

describe("ActivityCard timeline look", () => {
  const PHOTO =
    "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E";
  const statusChange = (actor: ArtifactActivityFeedItem["actor"]) =>
    makeItem({
      action: ArtifactActivityAction.StatusChange,
      actor,
      before: "DRAFT",
      after: "IN_REVIEW",
      createdAt: new Date(2026, 0, 1, 10, 0),
    });
  function renderTimelineRow(item: ReturnType<typeof makeItem>) {
    return render(
      <ActivityCard
        item={item}
        layout={ActivityCardLayout.Timeline}
        now={new Date(2026, 0, 1, 13, 0)}
      />
    );
  }
  /** The avatar: the row's first cell, drawn on the line. */
  const avatarOf = (container: HTMLElement) =>
    container.querySelector<HTMLElement>("[data-slot='avatar']");

  it("reads who, what, when: avatar, name, action, then the time", () => {
    const { container } = renderTimelineRow(
      statusChange({ kind: ActivityFeedActorKind.Human, id: "user_b" })
    );
    expect(container).toHaveTextContent(
      "Dana Reed changed status from Draft to In Review Jan 1, 10:00"
    );
    const avatar = avatarOf(container);
    const name = screen.getByText("Dana Reed");
    const time = container.querySelector("time");
    expect(avatar).not.toBeNull();
    const action = container.querySelector("p");
    expect(action).toHaveTextContent("changed status from Draft to In Review");
    // Document order is the reading order: avatar, name, action, time last.
    expect(avatar?.compareDocumentPosition(name)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(name.compareDocumentPosition(action as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(action?.compareDocumentPosition(time as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it("draws a person's initials when they have no photo", () => {
    const { container } = renderTimelineRow(
      statusChange({ kind: ActivityFeedActorKind.Human, id: "user_b" })
    );
    const avatar = avatarOf(container) as HTMLElement;
    // One initial on every avatar (Nerys, 2026-10-22).
    expect(avatar).toHaveTextContent(ONLY_D);
    expect(avatar.querySelector("img")).toBeNull();
  });

  it("draws a person's photo when they have one", () => {
    useOrganizationUsersMock.mockReturnValue(
      readyQuery([{ ...DANA, avatarUrl: PHOTO }])
    );
    const { container } = renderTimelineRow(
      statusChange({ kind: ActivityFeedActorKind.Human, id: "user_b" })
    );
    const avatar = avatarOf(container) as HTMLElement;
    expect(within(avatar).getByRole("presentation")).toHaveAttribute(
      "src",
      PHOTO
    );
  });

  it("draws the cog for System", () => {
    const { container } = renderTimelineRow(
      statusChange({ kind: ActivityFeedActorKind.System, id: null })
    );
    const avatar = avatarOf(container) as HTMLElement;
    expect(avatar.querySelector("svg.lucide-cog")).not.toBeNull();
  });

  it("draws the robot for an agent, never its key owner's photo", () => {
    useOrganizationUsersMock.mockReturnValue(
      readyQuery([{ ...DANA, avatarUrl: PHOTO }])
    );
    const { container } = renderTimelineRow(
      statusChange({ kind: ActivityFeedActorKind.Agent, id: "user_b" })
    );
    const avatar = avatarOf(container) as HTMLElement;
    expect(avatar.querySelector("svg.lucide-bot")).not.toBeNull();
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar).not.toHaveTextContent("D");
    // The name is still the key owner's, with the API badge.
    expect(screen.getByText("Dana Reed")).toBeInTheDocument();
    expect(screen.getByText("API", { exact: true })).toBeInTheDocument();
  });

  it("leaves the rail card's agent avatar on the key owner's photo", () => {
    useOrganizationUsersMock.mockReturnValue(
      readyQuery([{ ...DANA, avatarUrl: PHOTO }])
    );
    const { container } = render(
      <ActivityCard
        item={statusChange({ kind: ActivityFeedActorKind.Agent, id: "user_b" })}
        layout={ActivityCardLayout.Rail}
      />
    );
    const avatar = avatarOf(container) as HTMLElement;
    expect(avatar.querySelector("img")).toHaveAttribute("src", PHOTO);
  });

  it("truncates a long value and keeps the whole of it in the DOM", () => {
    render(
      <ActivityCard
        item={makeItem({
          action: ArtifactActivityAction.FieldChange,
          before: { field: "title", value: "Old name" },
          after: { field: "title", value: ARTIFACT_TITLE },
        })}
        layout={ActivityCardLayout.Timeline}
      />
    );
    const truncated = screen.getByText(ARTIFACT_TITLE);
    expect(truncated).toHaveClass("truncate");
    // Focusable, so the tooltip with the full value is reachable by keyboard.
    expect(truncated).toHaveAttribute("tabindex", "0");
  });

  it("puts the time in a focusable element carrying the exact instant", () => {
    const { container } = render(
      <ActivityCard
        item={makeItem({
          action: ArtifactActivityAction.StatusChange,
          before: "DRAFT",
          after: "IN_REVIEW",
          // Wall-clock, so the label is the same in every timezone.
          createdAt: new Date(2026, 0, 1, 10, 0),
        })}
        layout={ActivityCardLayout.Timeline}
        now={new Date(2026, 0, 1, 13, 0)}
      />
    );
    const time = container.querySelector("time");
    expect(time).toHaveTextContent("Jan 1, 10:00");
    expect(time).toHaveAttribute(
      "datetime",
      new Date(2026, 0, 1, 10, 0).toISOString()
    );
    expect(time).toHaveAttribute("tabindex", "0");
  });

  it("draws the robot for an agent whose key owner cannot be resolved", () => {
    const { container } = renderTimelineRow(
      statusChange({ kind: ActivityFeedActorKind.Agent, id: "user_gone" })
    );
    const avatar = avatarOf(container) as HTMLElement;
    expect(avatar.querySelector("svg.lucide-bot")).not.toBeNull();
    expect(screen.getByText("Agent")).toBeInTheDocument();
    // No owner, so no badge: the robot and the word already say "agent".
    expect(screen.queryByText("API", { exact: true })).toBeNull();
  });

  it("draws the person glyph, never initials, for an unknown or deleted person", () => {
    const { container } = renderTimelineRow(
      statusChange({ kind: ActivityFeedActorKind.Human, id: "user_gone" })
    );
    const avatar = avatarOf(container) as HTMLElement;
    expect(avatar.querySelector("svg.lucide-user")).not.toBeNull();
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent).toBe("");
    expect(screen.getByText("Unknown user")).toBeInTheDocument();
  });

  it("draws the comment author's avatar on a comment row", () => {
    useOrganizationUsersMock.mockReturnValue(
      readyQuery([{ ...DANA, avatarUrl: PHOTO }])
    );
    const { container } = render(
      <ActivityCommentCard
        authorId="user_b"
        body="Looks good."
        createdAt={new Date(2026, 0, 1, 10, 0)}
        href="#comment-1"
        layout={ActivityCardLayout.Timeline}
        now={new Date(2026, 0, 1, 13, 0)}
      />
    );
    const avatar = avatarOf(container) as HTMLElement;
    expect(avatar.querySelector("img")).toHaveAttribute("src", PHOTO);
    expect(avatar.compareDocumentPosition(screen.getByText("Dana Reed"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    // The card sits below the action, after the time.
    const time = container.querySelector("time") as Node;
    expect(time.compareDocumentPosition(screen.getByText("Looks good."))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it("lays the narrow row out as name and time on line 1, the action on line 2", () => {
    const { container } = renderTimelineRow(
      statusChange({ kind: ActivityFeedActorKind.Human, id: "user_b" })
    );
    // jsdom applies no CSS, so this pins the grid placement classes: below
    // `sm` the row is avatar | name | time, the action spanning under both.
    const row = container.firstElementChild as HTMLElement;
    expect(row).toHaveClass("grid-cols-[24px_minmax(0,1fr)_max-content]");
    const nameCell = screen
      .getByText("Dana Reed")
      .closest(".row-start-1") as HTMLElement;
    expect(nameCell).toHaveClass("col-start-2");
    const timeCell = container
      .querySelector("time")
      ?.closest(".row-start-1") as HTMLElement;
    expect(timeCell).toHaveClass("col-start-3", "sm:col-start-4");
    const actionCell = container.querySelector("p")?.parentElement;
    expect(actionCell).toHaveClass(
      "row-start-2",
      "col-span-2",
      "sm:row-start-1"
    );
    // The avatar's column spans every line, so the line runs past them all.
    const avatarColumn = avatarOf(container)?.closest(".col-start-1");
    expect(avatarColumn).toHaveClass("row-span-3", "sm:row-span-2");
  });
});

describe("ActivityCard directory reads (review R6)", () => {
  const enabledOf = (call: unknown[] | undefined) =>
    (call?.at(-1) as { enabled?: boolean } | undefined)?.enabled;

  it("reads projects and tags only for the rows that name one", () => {
    render(
      <ActivityCard
        item={makeItem({
          action: ArtifactActivityAction.StatusChange,
          before: "DRAFT",
          after: "IN_REVIEW",
        })}
      />
    );
    expect(enabledOf(useProjectsMock.mock.calls.at(-1))).toBe(false);
    expect(enabledOf(useTagsMock.mock.calls.at(-1))).toBe(false);
  });

  it("reads the project directory for a project row", () => {
    render(
      <ActivityCard
        item={makeItem({
          action: ArtifactActivityAction.FieldChange,
          before: { field: "projectId", value: null },
          after: { field: "projectId", value: "018f-b" },
        })}
      />
    );
    expect(enabledOf(useProjectsMock.mock.calls.at(-1))).toBe(true);
    expect(enabledOf(useTagsMock.mock.calls.at(-1))).toBe(false);
  });

  it("reads the tag directory for a tag row", () => {
    render(
      <ActivityCard
        item={makeItem({
          action: ArtifactActivityAction.FieldChange,
          before: { field: "tag", value: null },
          after: { field: "tag", value: "tag_1" },
        })}
      />
    );
    expect(enabledOf(useTagsMock.mock.calls.at(-1))).toBe(true);
    expect(enabledOf(useProjectsMock.mock.calls.at(-1))).toBe(false);
  });
});

describe("ActivityCard pending state markup (review V6)", () => {
  it.each(LAYOUTS)(
    "puts no block element inside a paragraph while names load (%s)",
    (layout) => {
      useOrganizationUsersMock.mockReturnValue(PENDING_QUERY);
      useTagsMock.mockReturnValue(PENDING_QUERY);
      const error = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const { container } = render(
        <>
          <ActivityCard
            item={makeItem({
              action: ArtifactActivityAction.Assignment,
              before: { field: "assigneeId", value: null },
              after: { field: "assigneeId", value: "user_b" },
            })}
            layout={layout}
          />
          <ActivityCard
            item={makeItem({
              id: "event:2",
              action: ArtifactActivityAction.FieldChange,
              before: { field: "tag", value: null },
              after: { field: "tag", value: "tag_1" },
            })}
            layout={layout}
          />
        </>
      );
      expect(container.querySelectorAll("p div")).toHaveLength(0);
      expect(
        container.querySelectorAll('p [data-slot="skeleton"]').length
      ).toBeGreaterThan(0);
      expect(error).not.toHaveBeenCalled();
      error.mockRestore();
    }
  );
});

describe("ActivityCard accessibility of values (review R9)", () => {
  it("tells a screen reader which title is old and which is new", () => {
    const { container } = render(
      <ActivityCard
        item={makeItem({
          action: ArtifactActivityAction.FieldChange,
          before: { field: "title", value: "Old name" },
          after: { field: "title", value: "New name" },
        })}
        layout={ActivityCardLayout.Timeline}
      />
    );
    const hidden = Array.from(container.querySelectorAll(".sr-only")).map(
      (node) => node.textContent?.trim()
    );
    expect(hidden).toEqual(["from", "to"]);
    expect(container).toHaveTextContent(
      "changed the title from Old name to New name"
    );
  });

  it("makes a long tag name reachable by keyboard for its tooltip", () => {
    useTagsMock.mockReturnValue(
      readyQuery([
        { id: "tag_long", name: "release-candidate-october", color: "blue" },
      ])
    );
    render(
      <ActivityCard
        item={makeItem({
          action: ArtifactActivityAction.FieldChange,
          before: { field: "tag", value: null },
          after: { field: "tag", value: "tag_long" },
        })}
        layout={ActivityCardLayout.Timeline}
      />
    );
    const name = screen.getByText("release-candidate-october");
    expect(name.closest('[tabindex="0"]')).not.toBeNull();
  });
});
