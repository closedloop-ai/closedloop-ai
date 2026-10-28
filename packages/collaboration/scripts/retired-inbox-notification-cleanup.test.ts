import { RetiredInboxNotificationKind } from "@repo/api/src/types/retired-inbox-notification-kinds";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupRetiredInboxNotifications,
  type InboxNotificationCleanupClient,
  recipientsSchema,
} from "./retired-inbox-notification-cleanup";

/** A live kind this cleanup must never touch, written as Liveblocks stores it. */
const LIVE_KIND = "$assignment";

const ADA = { userId: "user-ada", organizationId: "org-1" };
const BEA = { userId: "user-bea", organizationId: "org-2" };

type StoredNotification = { id: string; kind: string };

function fakeClient(
  stored: Record<string, StoredNotification[]>,
  options: { failListFor?: string; failDeleteOf?: string } = {}
) {
  const deleteInboxNotification = vi.fn(
    (params: { userId: string; inboxNotificationId: string }) => {
      if (params.inboxNotificationId === options.failDeleteOf) {
        return Promise.reject(new Error("delete refused"));
      }
      return Promise.resolve();
    }
  );
  const iterInboxNotifications = vi.fn(function* (criteria: {
    userId: string;
    organizationId?: string;
  }) {
    if (criteria.userId === options.failListFor) {
      throw new Error("list refused");
    }
    for (const notification of stored[
      `${criteria.userId}/${criteria.organizationId}`
    ] ?? []) {
      yield notification;
    }
  });
  return {
    client: {
      iterInboxNotifications,
      deleteInboxNotification,
    } as unknown as InboxNotificationCleanupClient,
    deleteInboxNotification,
    iterInboxNotifications,
  };
}

const STORED = {
  "user-ada/org-1": [
    { id: "in_1", kind: RetiredInboxNotificationKind.LoopCompleted },
    { id: "in_2", kind: LIVE_KIND },
  ],
  "user-bea/org-2": [
    { id: "in_3", kind: RetiredInboxNotificationKind.LoopCompleted },
  ],
};

describe("cleanupRetiredInboxNotifications (ISS-12435)", () => {
  it("only counts in a dry run and deletes nothing", async () => {
    const fake = fakeClient(STORED);

    const report = await cleanupRetiredInboxNotifications({
      client: fake.client,
      recipients: [ADA, BEA],
      apply: false,
    });

    expect(report).toMatchObject({
      apply: false,
      recipients: 2,
      scanned: 3,
      matched: 2,
      deleted: 0,
      failures: [],
    });
    expect(fake.deleteInboxNotification).not.toHaveBeenCalled();
  });

  it("lists each recipient within its own organization", async () => {
    const fake = fakeClient(STORED);

    await cleanupRetiredInboxNotifications({
      client: fake.client,
      recipients: [ADA, BEA],
      apply: false,
    });

    expect(fake.iterInboxNotifications.mock.calls.map(([c]) => c)).toEqual([
      { userId: ADA.userId, organizationId: ADA.organizationId },
      { userId: BEA.userId, organizationId: BEA.organizationId },
    ]);
  });

  it("deletes only retired kinds with --apply", async () => {
    const fake = fakeClient(STORED);

    const report = await cleanupRetiredInboxNotifications({
      client: fake.client,
      recipients: [ADA, BEA],
      apply: true,
    });

    expect(report.deleted).toBe(2);
    expect(fake.deleteInboxNotification.mock.calls.map(([p]) => p)).toEqual([
      { userId: ADA.userId, inboxNotificationId: "in_1" },
      { userId: BEA.userId, inboxNotificationId: "in_3" },
    ]);
  });

  it("records a failed recipient and carries on with the rest", async () => {
    const fake = fakeClient(STORED, {
      failListFor: ADA.userId,
      failDeleteOf: "in_3",
    });

    const report = await cleanupRetiredInboxNotifications({
      client: fake.client,
      recipients: [ADA, BEA],
      apply: true,
    });

    expect(report.deleted).toBe(0);
    expect(report.failures).toEqual([
      { ...ADA, inboxNotificationId: null, error: "list refused" },
      { ...BEA, inboxNotificationId: "in_3", error: "delete refused" },
    ]);
  });

  it("records a thrown non-Error value through String()", async () => {
    const client = {
      iterInboxNotifications: vi.fn(() => {
        throw NON_ERROR_FAILURE;
      }),
      deleteInboxNotification: vi.fn(),
    } as unknown as InboxNotificationCleanupClient;

    const report = await cleanupRetiredInboxNotifications({
      client,
      recipients: [ADA],
      apply: true,
    });

    expect(report.failures).toEqual([
      { ...ADA, inboxNotificationId: null, error: "429" },
    ]);
  });
});

describe("recipientsSchema", () => {
  it("accepts the runbook snapshot shape and refuses a row without an organization", () => {
    expect(recipientsSchema.safeParse([ADA]).success).toBe(true);
    expect(recipientsSchema.safeParse([{ userId: "user-ada" }]).success).toBe(
      false
    );
  });
});

const NON_ERROR_FAILURE = 429;
