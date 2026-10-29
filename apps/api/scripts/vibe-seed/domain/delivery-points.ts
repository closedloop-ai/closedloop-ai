import { SegmentCompleteness } from "@repo/pensero/delivery-client";
import { extractDeliverySegment } from "@repo/pensero/delivery-extractor";
import { runPenseroDeliveryBackfill } from "@/lib/delivery-points/pensero-delivery-backfill";
import type { VibeSeedContext } from "../stage";
import { SEED_DELIVERY_TEAMMATES, type SeedDeliveryPerson } from "./content";
import {
  buildDeliveryFeed,
  type DeliveryFeedPullRequest,
  sliceDeliveryFeed,
} from "./delivery-feed";

/**
 * ISS-12017: Pensero delivery points, written by the scheduled backfill's own
 * pipeline (`runPenseroDeliveryBackfill`: extract, interaction join, match
 * against our pull requests, `persistDeliveryPoints`). Only the HTTP fetch is
 * replaced, through the backfill's `fetchSegment` seam, by a response built
 * from the org's pull requests and parsed with the live extractor. The store
 * upserts on the provider's row id, so a re-run restates the same rows.
 *
 * Runs whether or not the Pensero credential was written: the backfill reads no
 * credential once the fetch is supplied, and the points never reference it.
 */

const WINDOW_DAYS = 28;
const FEED_PULL_REQUEST_LIMIT = 8;
/** First party in the feed's id space; the teammates' ids sit beside it. */
const OWNER_PROVIDER_PERSON_ID = 4100;

export async function seedDeliveryPoints(
  context: VibeSeedContext
): Promise<void> {
  const owner = await context.prisma.user.findUniqueOrThrow({
    where: { id: context.userId },
    select: { email: true, firstName: true, lastName: true },
  });
  const people: SeedDeliveryPerson[] = [
    {
      providerPersonId: OWNER_PROVIDER_PERSON_ID,
      name: [owner.firstName, owner.lastName].filter(Boolean).join(" "),
      email: owner.email,
    },
    ...SEED_DELIVERY_TEAMMATES,
  ];
  const feed = buildDeliveryFeed({
    pullRequests: await readFeedPullRequests(context),
    people,
    now: context.now,
    windowDays: WINDOW_DAYS,
  });
  const report = await runPenseroDeliveryBackfill({
    organizationId: context.organizationId,
    endDate: context.now,
    lookbackDays: WINDOW_DAYS,
    segmentDays: WINDOW_DAYS,
    throttleMs: 0,
    fetchSegment: (segment) =>
      Promise.resolve({
        segment: extractDeliverySegment(
          sliceDeliveryFeed(feed, segment.startDate, segment.endDate)
        ),
        completeness: SegmentCompleteness.Unverified,
        continuationKeysSeen: [],
      }),
  });
  if (report.segmentsFailed.length > 0) {
    throw new Error(
      `delivery backfill failed ${report.segmentsFailed.length} segment(s): ${JSON.stringify(report.segmentsFailed)}`
    );
  }
  context.log(
    `delivery points: ${report.rowsWritten} row(s) written, outcomes ${JSON.stringify(report.outcomeCounts)}`
  );
}

/** The org's pull requests a provider could name: those with a known repository. */
async function readFeedPullRequests(
  context: VibeSeedContext
): Promise<DeliveryFeedPullRequest[]> {
  const rows = await context.prisma.pullRequestDetail.findMany({
    where: {
      organizationId: context.organizationId,
      repositoryFullName: { not: null },
    },
    orderBy: [{ number: "desc" }, { id: "asc" }],
    take: FEED_PULL_REQUEST_LIMIT,
    select: {
      id: true,
      repositoryFullName: true,
      number: true,
      title: true,
      branchArtifact: { select: { name: true } },
    },
  });
  const pullRequests: DeliveryFeedPullRequest[] = [];
  for (const row of rows) {
    if (row.repositoryFullName === null) {
      continue;
    }
    pullRequests.push({
      key: row.id,
      repositoryFullName: row.repositoryFullName,
      number: row.number,
      title: row.title ?? row.branchArtifact.name,
    });
  }
  return pullRequests;
}
