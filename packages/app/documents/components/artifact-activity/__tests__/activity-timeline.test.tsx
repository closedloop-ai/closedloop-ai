/**
 * The Activity tab's presentational pieces, rendered in every state
 * (ISS-12117, ISS-12330): the timeline entry, the comment box (short, long, unavailable)
 * and the timeline (rows, empty, loading, error, has more, loading more, load
 * more failed). Fixtures are the story fixtures, so the stories and these
 * tests render the same rows.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_CATALOG,
  ACTIVITY_FIXTURE_LINKS,
  ACTIVITY_FIXTURE_NOW,
  ATLAS,
  BACKEND_TAG,
  COMMENT_LONG,
  COMMENT_SHORT,
  COMMENT_UNAVAILABLE,
  EMILY,
  FRONTEND_TAG,
  JAKE,
  newestFirst,
  ORION,
  RYAN,
} from "../activity-catalog.fixtures";
import { ActivityCommentEntry } from "../activity-comment-entry";
import { ActivityEntry, formatActivityTime } from "../activity-entry";
import { DOCUMENT_EXAMPLE_ROWS } from "../activity-example-timelines.fixtures";
import { ActivityTimeline } from "../activity-timeline";

const settled = <T,>(data: T[]) => ({
  data,
  isPending: false,
  isError: false,
  fetchStatus: "idle",
});

// The fixtures read the real query keys, so each hook module is mocked
// partially: only the read hook is replaced by a settled directory.
vi.mock("@repo/app/users/hooks/use-users", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useOrganizationUsers: () => settled([EMILY, JAKE, RYAN]),
}));
vi.mock("@repo/app/projects/hooks/use-projects", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useProjects: () => settled([ATLAS, ORION]),
}));
vi.mock("@repo/app/tags/hooks/use-tags", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTags: () => settled([FRONTEND_TAG, BACKEND_TAG]),
}));
vi.mock("@repo/app/shared/components/user-link", () => ({
  UserLink: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@repo/navigation/link", () => ({
  Link: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a className={className} href={href}>
      {children}
    </a>
  ),
}));

const NOW = ACTIVITY_FIXTURE_NOW;
const COMMENTED = /commented/;
const LONG_BODY_START = /I went through the whole timeline/;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ActivityEntry", () => {
  it("reads who, what, when: avatar, Actor [badge], phrase · context, time", () => {
    const { container } = render(
      <ActivityEntry
        actor="Emily Carter"
        avatar={<span data-testid="avatar" />}
        badge={<span>API</span>}
        createdAt={new Date(2026, 9, 7, 10, 32)}
        now={NOW}
        suffix="bulk update"
      >
        changed status
      </ActivityEntry>
    );
    expect(container).toHaveTextContent(
      "Emily Carter API changed status · bulk update Oct 7, 10:32"
    );
    // The avatar leads the row; no dot is drawn beside it.
    expect(
      screen
        .getByTestId("avatar")
        .compareDocumentPosition(screen.getByText("Emily Carter"))
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(container.querySelector(".rounded-full.size-2\\.5")).toBeNull();
  });

  it("gives an exact 24-hour time, with the year only when it is not now's", () => {
    // Wall-clock dates, so the labels are the same in every timezone.
    expect(formatActivityTime(new Date(2026, 8, 1, 9, 5), NOW)).toBe(
      "Sep 1, 09:05"
    );
    expect(formatActivityTime(new Date(2026, 8, 1, 21, 40), NOW)).toBe(
      "Sep 1, 21:40"
    );
    expect(formatActivityTime(new Date(2025, 11, 30, 16, 0), NOW)).toBe(
      "Dec 30, 2025, 16:00"
    );
  });

  it("renders the future detail and attachments slots only when given", () => {
    const { rerender } = render(
      <ActivityEntry actor="Emily" avatar={null} createdAt={NOW} now={NOW}>
        edited
      </ActivityEntry>
    );
    expect(screen.queryByText("Detail body")).toBeNull();
    rerender(
      <ActivityEntry
        actor="Emily"
        attachments={<span>Attached file</span>}
        avatar={null}
        createdAt={NOW}
        detail={<span>Detail body</span>}
        now={NOW}
      >
        edited
      </ActivityEntry>
    );
    expect(screen.getByText("Detail body")).toBeInTheDocument();
    expect(screen.getByText("Attached file")).toBeInTheDocument();
  });
});

describe("ActivityCommentEntry", () => {
  function renderComment(row: typeof COMMENT_SHORT, actor = "Jake Morrison") {
    if (row.kind !== "comment") {
      throw new Error("expected a comment row");
    }
    return render(
      <ActivityCommentEntry
        actor={actor}
        avatar={null}
        body={row.body}
        createdAt={row.createdAt}
        href={row.href}
        now={NOW}
        unavailable={row.unavailable}
      />
    );
  }

  it("shows who commented, when, the body, and a link to the comment", () => {
    if (COMMENT_SHORT.kind !== "comment") {
      throw new Error("expected a comment row");
    }
    const { container } = renderComment(COMMENT_SHORT);
    expect(container).toHaveTextContent(
      `Jake Morrison commented ${formatActivityTime(COMMENT_SHORT.createdAt, NOW)}`
    );
    expect(screen.getByText(COMMENTED)).toBeInTheDocument();
    expect(
      screen.getByText("Looks good. Can we keep the actor avatar on the line?")
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View comment" })).toHaveAttribute(
      "href",
      "#comment-cm-short"
    );
  });

  it("clamps a long body to three lines", () => {
    renderComment(COMMENT_LONG, "Ryan Brooks");
    const body = screen.getByText(LONG_BODY_START);
    expect(body).toHaveClass("line-clamp-3");
  });

  it("offers Copy link as the only action, and nothing to reply with", async () => {
    const user = userEvent.setup();
    renderComment(COMMENT_SHORT);
    await user.click(screen.getByRole("button", { name: "More actions" }));
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("Copy link");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("says an unavailable comment is gone, with no link and no menu", () => {
    renderComment(COMMENT_UNAVAILABLE, "Emily Carter");
    expect(
      screen.getByText("This comment is no longer available.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View comment" })).toBeNull();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });
});

describe("ActivityTimeline", () => {
  const rows = newestFirst(DOCUMENT_EXAMPLE_ROWS);

  it("renders every row, newest first, as one list", () => {
    render(
      <ActivityTimeline links={ACTIVITY_FIXTURE_LINKS} now={NOW} rows={rows} />
    );
    const items = within(
      screen.getByRole("list", { name: "Activity" })
    ).getAllByRole("listitem");
    expect(items).toHaveLength(DOCUMENT_EXAMPLE_ROWS.length);
    expect(items[0]).toHaveTextContent(
      "Emily Carter reassigned from Jake Morrison to Emily Carter Oct 7, 09:20"
    );
    expect(items.at(-1)).toHaveTextContent(
      "Emily Carter created this document"
    );
  });

  it("links the related artifact the host can resolve", () => {
    render(
      <ActivityTimeline
        links={ACTIVITY_FIXTURE_LINKS}
        now={NOW}
        rows={[ACTIVITY_CATALOG.P2.row]}
      />
    );
    expect(
      screen.getByRole("link", {
        name: "PRD-751 Activity timeline requirements",
      })
    ).toHaveAttribute("href", "#PRD-751");
  });

  it("promises edits and comments when a Document has none", () => {
    render(<ActivityTimeline rows={[]} />);
    expect(screen.getByText("No activity yet")).toBeInTheDocument();
    expect(
      screen.getByText("Edits and comments on this artifact will appear here.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("shows a busy status while the first page loads", () => {
    render(<ActivityTimeline loading rows={[]} />);
    expect(
      screen.getByRole("status", { name: "Loading activity" })
    ).toHaveAttribute("aria-busy", "true");
  });

  it("shows an error with retry, never an empty history, when the load fails", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ActivityTimeline error onRetry={onRetry} rows={[]} />);
    expect(screen.getByText("Couldn't load activity")).toBeInTheDocument();
    expect(screen.queryByText("No activity yet")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("ends in Load more while older pages exist", async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    render(
      <ActivityTimeline hasMore now={NOW} onLoadMore={onLoadMore} rows={rows} />
    );
    const button = screen.getByRole("button", { name: "Load more" });
    // At the END of the list: after the last row in document order.
    const list = screen.getByRole("list", { name: "Activity" });
    expect(list.compareDocumentPosition(button)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    await user.click(button);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("swaps Load more for a busy row while the next page loads", () => {
    render(
      <ActivityTimeline
        hasMore
        loadingMore
        now={NOW}
        onLoadMore={vi.fn()}
        rows={rows}
      />
    );
    expect(
      screen.getByRole("status", { name: "Loading more activity" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("keeps the loaded rows when the next page fails, with its own retry", async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    render(
      <ActivityTimeline
        hasMore
        loadMoreError
        now={NOW}
        onLoadMore={onLoadMore}
        rows={rows}
      />
    );
    expect(
      within(screen.getByRole("list", { name: "Activity" })).getAllByRole(
        "listitem"
      )
    ).toHaveLength(rows.length);
    expect(screen.getByText("Couldn't load more activity")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});
