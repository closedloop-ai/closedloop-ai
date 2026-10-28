import { createHash } from "node:crypto";
import {
  PenseroDeliveryItemType,
  PenseroDeliveryRole,
} from "@repo/pensero/delivery-contract";
import { toIsoDateOnly } from "@/lib/date-only";
import {
  SEED_DELIVERY_MESSAGING_TITLES,
  SEED_DELIVERY_TICKET_TITLES,
  type SeedDeliveryPerson,
} from "./content";

/**
 * ISS-12017: a Pensero `GET /v1/delivery` response body, in the provider's own
 * wire shape (`packages/pensero/__tests__/fixtures/pensero-delivery-hazards.fixture.json`),
 * built from the org's pull requests. The delivery backfill parses it with the
 * same extractor it runs on a live response.
 */

export type DeliveryFeedPullRequest = {
  /** Stable id the derived provider ids are hashed from. */
  readonly key: string;
  readonly repositoryFullName: string;
  readonly number: number;
  readonly title: string;
};

export type DeliveryFeedInput = {
  readonly pullRequests: readonly DeliveryFeedPullRequest[];
  /** The first person authors; the next one reviews. At least two. */
  readonly people: readonly SeedDeliveryPerson[];
  readonly now: Date;
  readonly windowDays: number;
};

type WireDelivery = {
  date: string;
  item_id: string;
  item_type: string;
  role: string;
  title: string;
  url: string | null;
  delivery: number;
};

type WireUser = {
  user: { id: number; name: string; email: string; username: string };
  deliveries: WireDelivery[];
};

export type DeliveryFeedResponse = {
  start_date: string;
  end_date: string;
  users: WireUser[];
};

const MS_PER_DAY = 86_400_000;
/** Measured values in the provider's tenths, `0` included (it is a measurement). */
const CREATOR_POINTS = [16, 8.5, 3, 12, 0] as const;
const REVIEW_POINTS = [2.2, 0.5, 1.1] as const;
const MESSAGING_POINTS = 0.4;
const TICKET_POINTS = 1.5;

export function buildDeliveryFeed(
  input: DeliveryFeedInput
): DeliveryFeedResponse {
  if (input.people.length < 2) {
    throw new Error("a delivery feed needs an author and a reviewer");
  }
  const users = new Map<number, WireUser>(
    input.people.map((person) => [
      person.providerPersonId,
      { user: wirePerson(person), deliveries: [] },
    ])
  );
  const deliveryDay = (index: number) =>
    toIsoDateOnly(
      new Date(
        input.now.getTime() - ((index * 3) % input.windowDays) * MS_PER_DAY
      )
    );
  for (const [index, pullRequest] of input.pullRequests.entries()) {
    const author = input.people[index % input.people.length];
    const reviewer = input.people[(index + 1) % input.people.length];
    const interactionUrl = `/interactions/pull_request/${providerNumber(`interaction:${pullRequest.key}`)}`;
    users.get(author.providerPersonId)?.deliveries.push({
      date: deliveryDay(index),
      item_id: String(providerNumber(`creator:${pullRequest.key}`)),
      item_type: PenseroDeliveryItemType.PullRequest,
      role: PenseroDeliveryRole.Creator,
      title: pullRequest.title,
      url: interactionUrl,
      delivery: CREATOR_POINTS[index % CREATOR_POINTS.length],
    });
    users.get(reviewer.providerPersonId)?.deliveries.push({
      date: deliveryDay(index),
      item_id: String(providerNumber(`review:${pullRequest.key}`)),
      item_type: PenseroDeliveryItemType.PullRequestReview,
      role: PenseroDeliveryRole.Reviewer,
      title: `Review pull_request: ${pullRequest.repositoryFullName}#${pullRequest.number} with title '${pullRequest.title}'`,
      url: interactionUrl,
      delivery: REVIEW_POINTS[index % REVIEW_POINTS.length],
    });
  }
  for (const [index, title] of SEED_DELIVERY_MESSAGING_TITLES.entries()) {
    const person = input.people[index % input.people.length];
    users.get(person.providerPersonId)?.deliveries.push({
      date: deliveryDay(index + 1),
      item_id: String(providerNumber(`messaging:${title}`)),
      item_type: PenseroDeliveryItemType.Messaging,
      role: PenseroDeliveryRole.Creator,
      title,
      url: null,
      delivery: MESSAGING_POINTS,
    });
  }
  for (const [index, title] of SEED_DELIVERY_TICKET_TITLES.entries()) {
    const person = input.people[(index + 1) % input.people.length];
    users.get(person.providerPersonId)?.deliveries.push({
      date: deliveryDay(index + 2),
      item_id: String(providerNumber(`ticket:${title}`)),
      item_type: PenseroDeliveryItemType.Ticket,
      role: PenseroDeliveryRole.Assignee,
      title,
      url: `/ticketing/ticket/${providerNumber(`ticket-id:${title}`)}`,
      delivery: TICKET_POINTS,
    });
  }
  return {
    start_date: toIsoDateOnly(
      new Date(input.now.getTime() - (input.windowDays - 1) * MS_PER_DAY)
    ),
    end_date: toIsoDateOnly(input.now),
    users: [...users.values()],
  };
}

/** The same response narrowed to one backfill segment's inclusive day range. */
export function sliceDeliveryFeed(
  feed: DeliveryFeedResponse,
  startDate: string,
  endDate: string
): DeliveryFeedResponse {
  return {
    start_date: startDate,
    end_date: endDate,
    users: feed.users.map((entry) => ({
      user: entry.user,
      deliveries: entry.deliveries.filter(
        (delivery) => delivery.date >= startDate && delivery.date <= endDate
      ),
    })),
  };
}

/** The provider's username is email-shaped and differs in case from its email. */
function wirePerson(person: SeedDeliveryPerson): WireUser["user"] {
  const [local, domain] = person.email.split("@");
  const username = `${local.charAt(0).toUpperCase()}${local.slice(1)}@${domain}`;
  return {
    id: person.providerPersonId,
    name: person.name,
    email: person.email,
    username,
  };
}

/** A stable positive provider-style integer id derived from `seed`. */
function providerNumber(seed: string): number {
  return Number.parseInt(
    createHash("sha256").update(seed).digest("hex").slice(0, 7),
    16
  );
}
