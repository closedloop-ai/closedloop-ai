import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AssignmentEntityType,
  computeNewMentions,
  detectAssigneeChange,
  MentionEntityType,
  sendAssignmentNotification,
  sendMentionNotification,
} from "../server/inbox-notifications";

const mocks = vi.hoisted(() => ({
  liveblocksConstructor: vi.fn(),
  liveblocksSecret: "sk_test-secret-key" as string | undefined,
  logError: vi.fn(),
  triggerInboxNotification: vi.fn(),
}));

vi.mock("@liveblocks/node", () => {
  class MockLiveblocks {
    triggerInboxNotification = mocks.triggerInboxNotification;

    constructor(options: { secret: string }) {
      mocks.liveblocksConstructor(options);
    }
  }

  return { Liveblocks: MockLiveblocks };
});

vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError },
}));

vi.mock("../server/keys", () => ({
  keys: () => ({ LIVEBLOCKS_SECRET: mocks.liveblocksSecret }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.liveblocksSecret = "sk_test-secret-key";
  mocks.triggerInboxNotification.mockResolvedValue(undefined);
});

/**
 * `detectAssigneeChange` is the gatekeeper deciding whether an assignment
 * notification fires. It had no direct coverage (FEA-3047), and its sole
 * consumer `assignment-notifications.ts` has no test — so a regression in any
 * of its four branches would silently mis-fire or drop notifications.
 *
 * Each branch below is asserted independently, plus the precedence between them
 * (the guards are ordered, so an input matching two guards must still return
 * null) and the first-assignment case, where there is no previous assignee.
 */

const ACTOR = "user_actor";
const ASSIGNEE = "user_assignee";
const OTHER = "user_other";

describe("inbox notification delivery", () => {
  it("does not construct a Liveblocks client when the secret is unset", async () => {
    mocks.liveblocksSecret = undefined;

    await expect(
      sendAssignmentNotification({
        assigneeUserId: ASSIGNEE,
        actorUserId: ACTOR,
        organizationId: "org_123",
        entityType: AssignmentEntityType.Feature,
        entityTitle: "Notification coverage",
        entityUrl: "/features/ISS-7628",
        subjectId: "ISS-7628",
      })
    ).resolves.toBeUndefined();

    expect(mocks.liveblocksConstructor).not.toHaveBeenCalled();
    expect(mocks.triggerInboxNotification).not.toHaveBeenCalled();
  });

  it("sends the assignment payload through Liveblocks", async () => {
    await sendAssignmentNotification({
      assigneeUserId: ASSIGNEE,
      actorUserId: ACTOR,
      organizationId: "org_123",
      entityType: AssignmentEntityType.Feature,
      entityTitle: "Notification coverage",
      entityUrl: "/features/ISS-7628",
      subjectId: "ISS-7628",
    });

    expect(mocks.liveblocksConstructor).toHaveBeenCalledWith({
      secret: "sk_test-secret-key",
    });
    expect(mocks.triggerInboxNotification).toHaveBeenCalledWith({
      userId: ASSIGNEE,
      kind: "$assignment",
      subjectId: "ISS-7628",
      tenantId: "org_123",
      activityData: {
        entityType: AssignmentEntityType.Feature,
        entityTitle: "Notification coverage",
        entityUrl: "/features/ISS-7628",
        actorId: ACTOR,
      },
    });
  });

  it("sends the mention payload through Liveblocks", async () => {
    await sendMentionNotification({
      mentionedUserId: ASSIGNEE,
      actorUserId: ACTOR,
      organizationId: "org_123",
      entityType: MentionEntityType.Branch,
      entityTitle: "Branch notification coverage",
      entityUrl: "/branches/branch_123",
      commentPreview: "Please review this branch",
      subjectId: "comment_123",
    });

    expect(mocks.triggerInboxNotification).toHaveBeenCalledWith({
      userId: ASSIGNEE,
      kind: "$mention",
      subjectId: "comment_123",
      tenantId: "org_123",
      activityData: {
        entityType: MentionEntityType.Branch,
        entityTitle: "Branch notification coverage",
        entityUrl: "/branches/branch_123",
        actorId: ACTOR,
        commentPreview: "Please review this branch",
      },
    });
  });

  it("logs the raw error and resolves when Liveblocks rejects", async () => {
    const providerError = new Error("Liveblocks unavailable");
    mocks.triggerInboxNotification.mockRejectedValueOnce(providerError);

    await expect(
      sendMentionNotification({
        mentionedUserId: ASSIGNEE,
        actorUserId: ACTOR,
        organizationId: "org_123",
        entityType: MentionEntityType.Branch,
        entityTitle: "Branch notification coverage",
        entityUrl: "/branches/branch_123",
        commentPreview: "Please review this branch",
        subjectId: "comment_123",
      })
    ).resolves.toBeUndefined();

    expect(mocks.logError).toHaveBeenCalledWith(
      "Failed to send mention notification",
      {
        error: providerError,
        userId: ASSIGNEE,
        subjectId: "comment_123",
        entityType: MentionEntityType.Branch,
      }
    );
  });

  it("does not notify an actor who assigns an entity to themselves", async () => {
    await sendAssignmentNotification({
      assigneeUserId: ACTOR,
      actorUserId: ACTOR,
      organizationId: "org_123",
      entityType: AssignmentEntityType.Feature,
      entityTitle: "Notification coverage",
      entityUrl: "/features/ISS-7628",
      subjectId: "ISS-7628",
    });

    expect(mocks.liveblocksConstructor).not.toHaveBeenCalled();
    expect(mocks.triggerInboxNotification).not.toHaveBeenCalled();
  });

  it("does not notify an actor who mentions themselves", async () => {
    await sendMentionNotification({
      mentionedUserId: ACTOR,
      actorUserId: ACTOR,
      organizationId: "org_123",
      entityType: MentionEntityType.Session,
      entityTitle: "Session notification coverage",
      entityUrl: "/sessions/session_123",
      commentPreview: "Note to self",
      subjectId: "comment_456",
    });

    expect(mocks.liveblocksConstructor).not.toHaveBeenCalled();
    expect(mocks.triggerInboxNotification).not.toHaveBeenCalled();
  });
});

describe("detectAssigneeChange", () => {
  describe("returns null when there is no assignee to notify", () => {
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["empty string", ""],
    ])("new assignee is %s", (_label, newAssigneeId) => {
      expect(detectAssigneeChange(newAssigneeId, OTHER, ACTOR)).toBeNull();
    });
  });

  it("returns null when the assignee is unchanged", () => {
    expect(detectAssigneeChange(ASSIGNEE, ASSIGNEE, ACTOR)).toBeNull();
  });

  it("returns null when the actor assigned the entity to themselves", () => {
    expect(detectAssigneeChange(ACTOR, OTHER, ACTOR)).toBeNull();
  });

  it("returns the new assignee id on a real change by another user", () => {
    expect(detectAssigneeChange(ASSIGNEE, OTHER, ACTOR)).toBe(ASSIGNEE);
  });

  it("returns the new assignee id on a first assignment (no previous)", () => {
    expect(detectAssigneeChange(ASSIGNEE, null, ACTOR)).toBe(ASSIGNEE);
    expect(detectAssigneeChange(ASSIGNEE, undefined, ACTOR)).toBe(ASSIGNEE);
  });

  it("returns null when self-assigning an already-held entity (both guards)", () => {
    // Matches the unchanged AND the self-assignment guard — ordering must not
    // let it fall through to a notification.
    expect(detectAssigneeChange(ACTOR, ACTOR, ACTOR)).toBeNull();
  });

  it("does not notify the actor when they unassign and reassign to themselves", () => {
    expect(detectAssigneeChange(ACTOR, null, ACTOR)).toBeNull();
  });
});

/**
 * `computeNewMentions` decides who gets an @-mention inbox ping for a trace
 * comment write (FEA-3490). It is the guard that keeps an edit from re-pinging
 * people who were already mentioned, and keeps you from pinging yourself. Each
 * rule is asserted independently plus their interaction on an edit.
 */
describe("computeNewMentions", () => {
  it("notifies every mention on a create (no previous mentions)", () => {
    expect(computeNewMentions([ASSIGNEE, OTHER], [], ACTOR)).toEqual([
      ASSIGNEE,
      OTHER,
    ]);
  });

  it("excludes the actor's self-mention", () => {
    expect(computeNewMentions([ACTOR, OTHER], [], ACTOR)).toEqual([OTHER]);
  });

  it("de-duplicates repeated mentions, preserving first-seen order", () => {
    expect(computeNewMentions([OTHER, ASSIGNEE, OTHER], [], ACTOR)).toEqual([
      OTHER,
      ASSIGNEE,
    ]);
  });

  it("on an edit, notifies only the newly-added mention, not existing ones", () => {
    // OTHER was already mentioned before the edit; only ASSIGNEE is new.
    expect(computeNewMentions([OTHER, ASSIGNEE], [OTHER], ACTOR)).toEqual([
      ASSIGNEE,
    ]);
  });

  it("returns nothing when an edit adds no new mentions", () => {
    expect(computeNewMentions([OTHER], [OTHER], ACTOR)).toEqual([]);
  });

  it("does not re-notify on a body-only edit that retains the same mentions", () => {
    expect(
      computeNewMentions([OTHER, ASSIGNEE], [OTHER, ASSIGNEE], ACTOR)
    ).toEqual([]);
  });
});
