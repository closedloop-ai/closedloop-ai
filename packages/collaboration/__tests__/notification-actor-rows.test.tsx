// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOTIFICATION_ACTOR_NAME_PLACEHOLDER_CLASS_NAME,
  NOTIFICATION_ACTOR_ROW_CLASS_NAME,
} from "../client/notification-actor";

// Stub `InboxNotification.Custom` / `.Avatar` so the domain components render
// without a Liveblocks provider tree. The stub surfaces the three things
// ISS-5010 changes as inspectable DOM: the visible title, the `aside` slot the
// actor avatar occupies, and the link target.
vi.mock("@liveblocks/react-ui", () => ({
  InboxNotification: {
    Custom: ({
      title,
      href,
      aside,
      children,
      className,
    }: {
      title: ReactNode;
      href: string;
      aside?: ReactNode;
      children: ReactNode;
      className?: string;
    }) => (
      <a className={className} data-testid="notification" href={href}>
        {/* Liveblocks renders the 36px aside column only when `aside` is
            truthy, so the stub must too: whether the gutter exists at all is
            what these tests are asserting. */}
        {aside ? <span data-testid="aside">{aside}</span> : null}
        <span data-testid="title">{title}</span>
        {children}
      </a>
    ),
    Avatar: ({
      userId,
      "aria-hidden": ariaHidden,
    }: {
      userId: string;
      "aria-hidden"?: "false" | "true";
    }) => (
      <span
        aria-hidden={ariaHidden}
        data-testid="actor-avatar"
        data-user-id={userId}
      />
    ),
  },
}));

type MockUserResult =
  | { isLoading: true }
  | { isLoading: false; user?: { name: string } }
  | { isLoading: false; error: Error };

const userDirectory = new Map<string, MockUserResult>();

vi.mock("@liveblocks/react", () => ({
  useUser: (userId: string): MockUserResult =>
    // Liveblocks resolves unknown ids to `undefined` via `createResolveUsers`,
    // so an id absent from the directory is a resolved-but-unknown user.
    userDirectory.get(userId) ?? { isLoading: false, user: undefined },
}));

const ENTITY_URL = "https://app.example.com/closedloop-ai/documents/iss-1";
const OTHER_ENTITY_URL =
  "https://app.example.com/closedloop-ai/documents/iss-2";

type AssignmentData = {
  entityType?: string;
  entityTitle?: string;
  entityUrl?: string;
  actorId?: unknown;
};

type MentionData = AssignmentData & { commentPreview?: string };

/**
 * The text of every `<strong>` inside the headline. The emphasis is the thing
 * under test, not decoration: it anchors the row on what you are clicking
 * through to, and it is what marks where the entity type ends and the entity
 * title begins.
 */
function emphasisedRuns(title: HTMLElement): string[] {
  return Array.from(title.querySelectorAll("strong")).map(
    (node) => node.textContent ?? ""
  );
}

function makeNotification(kind: string, data: AssignmentData | MentionData) {
  return {
    id: `in_${kind}`,
    kind,
    activities: [{ id: "ac_1", data }],
  };
}

async function renderAssignment(
  data: AssignmentData,
  showActor?: boolean,
  className?: string
) {
  const { AssignmentNotification } = await import(
    "../client/assignment-notification"
  );
  type Props = Parameters<typeof AssignmentNotification>[0];
  const notification = makeNotification(
    "$assignment",
    data
  ) as unknown as Props["inboxNotification"];
  return render(
    <AssignmentNotification
      className={className}
      inboxNotification={notification}
      showActor={showActor}
    />
  );
}

async function renderMention(data: MentionData, showActor?: boolean) {
  const { MentionNotification } = await import(
    "../client/mention-notification"
  );
  type Props = Parameters<typeof MentionNotification>[0];
  const notification = makeNotification(
    "$mention",
    data
  ) as unknown as Props["inboxNotification"];
  return render(
    <MentionNotification
      inboxNotification={notification}
      showActor={showActor}
    />
  );
}

beforeEach(() => {
  userDirectory.clear();
  userDirectory.set("user_emma", {
    isLoading: false,
    user: { name: "Emma Chen" },
  });
  userDirectory.set("user_raj", {
    isLoading: false,
    user: { name: "Raj Patel" },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("AssignmentNotification — actor rows off (default)", () => {
  it("renders the passive headline and no actor avatar", async () => {
    await renderAssignment({
      entityType: "artifact",
      entityTitle: "Fix session transcripts",
      entityUrl: ENTITY_URL,
      actorId: "user_emma",
    });

    expect(screen.getByTestId("title")).toHaveTextContent(
      "You were assigned to artifact Fix session transcripts"
    );
    // The actor is on the payload but must stay hidden while the flag is off,
    // so the gate cannot leak the new treatment.
    expect(screen.queryByTestId("actor-avatar")).toBeNull();
    expect(screen.getByTestId("title").textContent).not.toContain("Emma Chen");
  });

  it("carries no actor-row class, so inbox.css cannot reach the row", async () => {
    await renderAssignment({
      entityType: "artifact",
      entityTitle: "Fix session transcripts",
      entityUrl: ENTITY_URL,
      actorId: "user_emma",
    });

    // Everything ISS-5010 restyles is scoped to this class. Without it on the
    // row, the stylesheet ships inert — including for the built-in Liveblocks
    // thread rows that already show avatars in this same list.
    expect(screen.getByTestId("notification")).not.toHaveClass(
      NOTIFICATION_ACTOR_ROW_CLASS_NAME
    );
  });

  it("reserves no aside gutter, keeping the row's current left edge", async () => {
    await renderAssignment({
      entityType: "artifact",
      entityTitle: "Fix session transcripts",
      entityUrl: ENTITY_URL,
      actorId: "user_emma",
    });

    expect(screen.queryByTestId("aside")).toBeNull();
  });
});

describe("the actor-row styling hook", () => {
  it("is the class inbox.css is written against", () => {
    // inbox.css cannot import this constant, so pin the literal here: renaming
    // the class without editing the stylesheet would silently unstyle the rows.
    expect(NOTIFICATION_ACTOR_ROW_CLASS_NAME).toBe(
      "cl-inbox-notification-actor-row"
    );
  });
});

describe("AssignmentNotification — actor rows on", () => {
  it("leads each row with its own actor, so two assignments are distinguishable from the first character", async () => {
    const first = await renderAssignment(
      {
        entityType: "artifact",
        entityTitle: "Fix session transcripts",
        entityUrl: ENTITY_URL,
        actorId: "user_emma",
      },
      true
    );
    const firstTitle = first.getByTestId("title").textContent ?? "";
    first.unmount();

    const second = await renderAssignment(
      {
        entityType: "artifact",
        entityTitle: "Exporting a filtered Sessions view",
        entityUrl: OTHER_ENTITY_URL,
        actorId: "user_raj",
      },
      true
    );
    const secondTitle = second.getByTestId("title").textContent ?? "";

    expect(firstTitle).toBe(
      "Emma Chen assigned you artifact Fix session transcripts"
    );
    expect(secondTitle).toBe(
      "Raj Patel assigned you artifact Exporting a filtered Sessions view"
    );
    // The defect ISS-5010 reports: consecutive rows sharing a leading run of
    // boilerplate. Assert they now diverge immediately.
    expect(firstTitle.charAt(0)).not.toBe(secondTitle.charAt(0));
    expect(firstTitle.startsWith("You were assigned to")).toBe(false);
  });

  it("keeps the emphasis on the entity title, not on the leading actor name", async () => {
    await renderAssignment(
      {
        entityType: "artifact",
        entityTitle: "Fix session transcripts",
        entityUrl: ENTITY_URL,
        actorId: "user_emma",
      },
      true
    );

    // Bolding the name instead would move the bold mass to the front of the
    // line the moment the lookup resolved, while the actor-less fallback row
    // beside it still bolds the entity title.
    expect(emphasisedRuns(screen.getByTestId("title"))).toEqual([
      "Fix session transcripts",
    ]);
  });

  it("marks the row so inbox.css reaches the flagged rows and nothing else", async () => {
    await renderAssignment(
      {
        entityType: "artifact",
        entityTitle: "Fix session transcripts",
        entityUrl: ENTITY_URL,
        actorId: "user_emma",
      },
      true
    );

    expect(screen.getByTestId("notification")).toHaveClass(
      NOTIFICATION_ACTOR_ROW_CLASS_NAME
    );
  });

  it("keeps a className Liveblocks already passed the row", async () => {
    await renderAssignment(
      {
        entityType: "artifact",
        entityTitle: "Fix session transcripts",
        entityUrl: ENTITY_URL,
        actorId: "user_emma",
      },
      true,
      "custom-row"
    );

    const row = screen.getByTestId("notification");
    expect(row).toHaveClass("custom-row");
    expect(row).toHaveClass(NOTIFICATION_ACTOR_ROW_CLASS_NAME);
  });

  it("renders the actor's avatar in the aside slot, keyed to the actor id", async () => {
    await renderAssignment(
      {
        entityType: "artifact",
        entityTitle: "Fix session transcripts",
        entityUrl: ENTITY_URL,
        actorId: "user_emma",
      },
      true
    );

    const avatar = screen.getByTestId("actor-avatar");
    expect(avatar).toHaveAttribute("data-user-id", "user_emma");
    // The headline already names the actor, and the Liveblocks avatar carries
    // that same name as its alt text, so it must not be announced twice.
    expect(avatar).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("notification")).toHaveAttribute(
      "href",
      ENTITY_URL
    );
  });

  it("falls back to the passive headline when the payload carries no actor", async () => {
    await renderAssignment(
      {
        entityType: "artifact",
        entityTitle: "Fix session transcripts",
        entityUrl: ENTITY_URL,
      },
      true
    );

    expect(screen.getByTestId("title")).toHaveTextContent(
      "You were assigned to artifact Fix session transcripts"
    );
    expect(screen.queryByTestId("actor-avatar")).toBeNull();
  });

  it("falls back to the passive headline — never a fabricated name — when the actor cannot be resolved", async () => {
    // A user who has left the org: `createResolveUsers` maps the id to
    // `undefined`, so there is no name to show.
    await renderAssignment(
      {
        entityType: "artifact",
        entityTitle: "Fix session transcripts",
        entityUrl: ENTITY_URL,
        actorId: "user_departed",
      },
      true
    );

    const title = screen.getByTestId("title").textContent ?? "";
    expect(title).toBe("You were assigned to artifact Fix session transcripts");
    expect(title).not.toContain("Someone");
    expect(title).not.toContain("Unknown");
    expect(title).not.toContain("user_departed");
    // No half-rendered actor: the avatar is withheld along with the name.
    expect(screen.queryByTestId("actor-avatar")).toBeNull();
    // The gutter still stands, empty. Dropping it would give this row a
    // different left edge from the resolved assignment row above it, inside a
    // single notification kind, which reads as a glitch rather than a category.
    expect(screen.getByTestId("aside")).toBeInTheDocument();
  });

  it("holds the actor-led shape, with a bar where the name will land, while the lookup is in flight", async () => {
    userDirectory.set("user_pending", { isLoading: true });

    await renderAssignment(
      {
        entityType: "artifact",
        entityTitle: "Fix session transcripts",
        entityUrl: ENTITY_URL,
        actorId: "user_pending",
      },
      true
    );

    // Loading is not Unknown: there IS an actor, we just cannot name them yet.
    // The avatar renders (Liveblocks paints its own placeholder) and the
    // headline keeps the word order it will have once the name lands, so the
    // row swaps one bar for a name instead of rewriting its whole sentence
    // under a reader mid-scan. It still asserts nothing about who acted.
    expect(screen.getByTestId("actor-avatar")).toHaveAttribute(
      "data-user-id",
      "user_pending"
    );
    const title = screen.getByTestId("title");
    expect(title.textContent?.trim()).toBe(
      "assigned you artifact Fix session transcripts"
    );
    expect(
      title.querySelector(`.${NOTIFICATION_ACTOR_NAME_PLACEHOLDER_CLASS_NAME}`)
    ).toBeInTheDocument();
    expect(title.textContent).not.toContain("You were assigned");
  });

  it("keeps the loading placeholder out of the announced headline", async () => {
    userDirectory.set("user_pending", { isLoading: true });

    await renderAssignment(
      {
        entityType: "artifact",
        entityTitle: "Fix session transcripts",
        entityUrl: ENTITY_URL,
        actorId: "user_pending",
      },
      true
    );

    // The row will not guess at a name, and it will not invent a spoken
    // stand-in for one either.
    expect(
      screen
        .getByTestId("title")
        .querySelector(`.${NOTIFICATION_ACTOR_NAME_PLACEHOLDER_CLASS_NAME}`)
    ).toHaveAttribute("aria-hidden", "true");
  });

  it("falls back to the passive headline when the actor lookup errors", async () => {
    userDirectory.set("user_broken", {
      isLoading: false,
      error: new Error("resolveUsers failed"),
    });

    await renderAssignment(
      {
        entityType: "artifact",
        entityTitle: "Fix session transcripts",
        entityUrl: ENTITY_URL,
        actorId: "user_broken",
      },
      true
    );

    expect(screen.getByTestId("title")).toHaveTextContent(
      "You were assigned to artifact Fix session transcripts"
    );
    expect(screen.queryByTestId("actor-avatar")).toBeNull();
  });

  it("ignores a non-string actorId arriving off the wire", async () => {
    await renderAssignment(
      {
        entityType: "artifact",
        entityTitle: "Fix session transcripts",
        entityUrl: ENTITY_URL,
        actorId: { id: "user_emma" },
      },
      true
    );

    expect(screen.getByTestId("title")).toHaveTextContent(
      "You were assigned to artifact Fix session transcripts"
    );
    expect(screen.queryByTestId("actor-avatar")).toBeNull();
  });
});

describe("MentionNotification", () => {
  it("keeps the passive headline and no avatar while actor rows are off", async () => {
    await renderMention({
      entityType: "session",
      entityTitle: "Nightly review",
      entityUrl: ENTITY_URL,
      actorId: "user_emma",
      commentPreview: "can you take a look?",
    });

    expect(screen.getByTestId("title")).toHaveTextContent(
      "You were mentioned in a comment on session Nightly review"
    );
    expect(screen.queryByTestId("actor-avatar")).toBeNull();
  });

  it("leads with the actor and keeps the comment preview when actor rows are on", async () => {
    await renderMention(
      {
        entityType: "session",
        entityTitle: "Nightly review",
        entityUrl: ENTITY_URL,
        actorId: "user_emma",
        commentPreview: "can you take a look?",
      },
      true
    );

    expect(screen.getByTestId("title")).toHaveTextContent(
      "Emma Chen mentioned you in session Nightly review"
    );
    expect(screen.getByTestId("actor-avatar")).toHaveAttribute(
      "data-user-id",
      "user_emma"
    );
    // "mentioned you in session Nightly review" is three nouns in a row without
    // it, with nothing marking where the type ends and the title starts.
    expect(emphasisedRuns(screen.getByTestId("title"))).toEqual([
      "Nightly review",
    ]);
    expect(screen.getByText("can you take a look?")).toBeInTheDocument();
  });

  it("holds the actor-led shape while the mentioning actor is still loading", async () => {
    userDirectory.set("user_pending", { isLoading: true });

    await renderMention(
      {
        entityType: "session",
        entityTitle: "Nightly review",
        entityUrl: ENTITY_URL,
        actorId: "user_pending",
        commentPreview: "can you take a look?",
      },
      true
    );

    const title = screen.getByTestId("title");
    expect(title.textContent?.trim()).toBe(
      "mentioned you in session Nightly review"
    );
    expect(
      title.querySelector(`.${NOTIFICATION_ACTOR_NAME_PLACEHOLDER_CLASS_NAME}`)
    ).toBeInTheDocument();
  });

  it("falls back to the passive headline when the mentioning actor cannot be resolved", async () => {
    await renderMention(
      {
        entityType: "session",
        entityTitle: "Nightly review",
        entityUrl: ENTITY_URL,
        actorId: "user_departed",
        commentPreview: "can you take a look?",
      },
      true
    );

    expect(screen.getByTestId("title")).toHaveTextContent(
      "You were mentioned in a comment on session Nightly review"
    );
    expect(screen.queryByTestId("actor-avatar")).toBeNull();
    // Same as the assignment row: the gutter is held for every flagged row of
    // this kind, empty when there is nobody to show.
    expect(screen.getByTestId("aside")).toBeInTheDocument();
    // The body is unaffected by the actor being unknown.
    expect(screen.getByText("can you take a look?")).toBeInTheDocument();
  });
});
