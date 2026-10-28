/**
 * ISS-12017: the delivery-points stage's synthetic Pensero response. The feed
 * is parsed by the provider package's own extractor, so these cases pin that a
 * built response survives the parse the live backfill applies, and that the
 * stage hands the backfill a fetch seam answering per segment.
 */
import {
  PenseroDeliveryItemType,
  PenseroInteractionKind,
} from "@repo/pensero/delivery-contract";
import { extractDeliverySegment } from "@repo/pensero/delivery-extractor";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runPenseroDeliveryBackfill: vi.fn(),
}));

vi.mock("@/lib/delivery-points/pensero-delivery-backfill", () => ({
  runPenseroDeliveryBackfill: mocks.runPenseroDeliveryBackfill,
}));

import { SEED_DELIVERY_TEAMMATES } from "../vibe-seed/domain/content";
import {
  buildDeliveryFeed,
  sliceDeliveryFeed,
} from "../vibe-seed/domain/delivery-feed";
import { seedDeliveryPoints } from "../vibe-seed/domain/delivery-points";
import type { VibeSeedContext } from "../vibe-seed/stage";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const WINDOW_DAYS = 28;
const PULL_REQUESTS = [
  {
    key: "pr-a",
    repositoryFullName: "acme/web",
    number: 41,
    title: "Add saved views to the branch list",
  },
  {
    key: "pr-b",
    repositoryFullName: "acme/api",
    number: 7,
    title: "Cap the session export page size",
  },
];
const PEOPLE = [
  { providerPersonId: 1, name: "Ada Owner", email: "ada@acme.test" },
  ...SEED_DELIVERY_TEAMMATES,
];

function feed() {
  return buildDeliveryFeed({
    pullRequests: PULL_REQUESTS,
    people: PEOPLE,
    now: NOW,
    windowDays: WINDOW_DAYS,
  });
}

describe("buildDeliveryFeed", () => {
  it("builds a response the live extractor accepts without rejecting a row", () => {
    const segment = extractDeliverySegment(feed());
    expect(segment.rowsRejected).toStrictEqual([]);
    expect(segment.peopleRejected).toBe(0);
    expect(segment.peopleSeen).toBe(PEOPLE.length);
    // A creator and a review row per pull request, plus the non-PR rows.
    expect(segment.rows.length).toBeGreaterThan(PULL_REQUESTS.length * 2);
  });

  it("names each pull request only on its review row, joined to its creator row by interaction", () => {
    const rows = extractDeliverySegment(feed()).rows;
    for (const pullRequest of PULL_REQUESTS) {
      const [owner, repo] = pullRequest.repositoryFullName.split("/");
      const review = rows.find(
        (row) =>
          row.itemType === PenseroDeliveryItemType.PullRequestReview &&
          row.pullRequest?.number === pullRequest.number
      );
      expect(review?.pullRequest).toStrictEqual({
        owner,
        repo,
        number: pullRequest.number,
      });
      const creator = rows.find(
        (row) =>
          row.itemType === PenseroDeliveryItemType.PullRequest &&
          row.title === pullRequest.title
      );
      expect(creator?.pullRequest).toBeNull();
      expect(creator?.interaction?.kind).toBe(
        PenseroInteractionKind.PullRequest
      );
      expect(creator?.interaction).toStrictEqual(review?.interaction);
      expect(creator?.person.email).not.toBe(review?.person.email);
    }
  });

  it("derives the same provider ids on every build", () => {
    const ids = (built: ReturnType<typeof feed>) =>
      built.users.flatMap((entry) =>
        entry.deliveries.map((delivery) => delivery.item_id)
      );
    expect(ids(feed())).toStrictEqual(ids(feed()));
    expect(new Set(ids(feed())).size).toBe(ids(feed()).length);
  });

  it("dates every row inside the window ending at now", () => {
    const built = feed();
    for (const entry of built.users) {
      for (const delivery of entry.deliveries) {
        expect(delivery.date >= built.start_date).toBe(true);
        expect(delivery.date <= built.end_date).toBe(true);
      }
    }
    expect(built.end_date).toBe("2026-10-05");
  });

  it("refuses a feed with nobody to review", () => {
    expect(() =>
      buildDeliveryFeed({
        pullRequests: PULL_REQUESTS,
        people: PEOPLE.slice(0, 1),
        now: NOW,
        windowDays: WINDOW_DAYS,
      })
    ).toThrow("a delivery feed needs an author and a reviewer");
  });
});

describe("sliceDeliveryFeed", () => {
  it("keeps only the rows inside the segment's inclusive day range", () => {
    const sliced = sliceDeliveryFeed(feed(), "2026-10-05", "2026-10-05");
    const dates = sliced.users.flatMap((entry) =>
      entry.deliveries.map((delivery) => delivery.date)
    );
    expect(dates.length).toBeGreaterThan(0);
    expect(new Set(dates)).toStrictEqual(new Set(["2026-10-05"]));
    expect(sliced.users).toHaveLength(PEOPLE.length);
  });
});

describe("seedDeliveryPoints", () => {
  beforeEach(() => {
    mocks.runPenseroDeliveryBackfill.mockResolvedValue({
      segmentsFailed: [],
      rowsWritten: 0,
      outcomeCounts: {},
    });
  });

  it("runs the backfill over the org's pull requests through the fetch seam", async () => {
    const context = {
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      log: vi.fn(),
      prisma: {
        user: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            email: "ada@acme.test",
            firstName: "Ada",
            lastName: "Owner",
          }),
        },
        pullRequestDetail: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "pr-a",
              repositoryFullName: "acme/web",
              number: 41,
              title: null,
              branchArtifact: { name: "feat/saved-views" },
            },
          ]),
        },
      },
    } as unknown as VibeSeedContext;

    await seedDeliveryPoints(context);

    expect(mocks.runPenseroDeliveryBackfill).toHaveBeenCalledTimes(1);
    const options = mocks.runPenseroDeliveryBackfill.mock.calls[0][0];
    expect(options).toMatchObject({
      organizationId: "org-1",
      endDate: NOW,
      throttleMs: 0,
    });
    const fetched = await options.fetchSegment({
      startDate: "2026-09-08",
      endDate: "2026-10-05",
    });
    const reviewed = fetched.segment.rows.filter(
      (row: { pullRequest: { number: number } | null }) =>
        row.pullRequest?.number === 41
    );
    expect(reviewed).toHaveLength(1);
    expect(
      fetched.segment.rows.some(
        (row: { title: string }) => row.title === "feat/saved-views"
      )
    ).toBe(true);
  });

  it("fails the stage when a segment could not be fetched", async () => {
    mocks.runPenseroDeliveryBackfill.mockResolvedValue({
      segmentsFailed: [{ segment: {}, error: "boom" }],
      rowsWritten: 0,
      outcomeCounts: {},
    });
    const context = {
      organizationId: "org-1",
      userId: "user-1",
      now: NOW,
      log: vi.fn(),
      prisma: {
        user: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            email: "ada@acme.test",
            firstName: null,
            lastName: null,
          }),
        },
        pullRequestDetail: { findMany: vi.fn().mockResolvedValue([]) },
      },
    } as unknown as VibeSeedContext;

    await expect(seedDeliveryPoints(context)).rejects.toThrow(
      "delivery backfill failed 1 segment(s)"
    );
  });
});
