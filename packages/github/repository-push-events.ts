import type { Octokit } from "@octokit/rest";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { z } from "zod";

const EVENTS_PER_PAGE = 100;
const MAX_EVENT_PAGES = 3;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const ZERO_SHA_RE = /^0+$/;

const eventSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string(),
  actor: z
    .looseObject({
      id: z.number().int().positive().refine(Number.isSafeInteger),
      login: z.string().min(1),
    })
    .nullable(),
  repo: z.looseObject({ name: z.string().min(1) }),
  payload: z.looseObject({
    push_id: z
      .number()
      .int()
      .positive()
      .refine(Number.isSafeInteger)
      .optional(),
    ref: z.string().optional(),
    before: z.string().optional(),
    head: z.string().optional(),
  }),
  created_at: z.iso.datetime(),
});

/** A recent exact-ref event awaiting actor-kind and new-commit verification. */
export type RecentBranchPushEvent = {
  eventId: string;
  pushId?: string;
  beforeSha: string;
  afterSha: string;
  providerUserId: string;
  providerLogin: string;
  observedAt: Date;
};

export type RecentBranchPushEvidence = {
  events: RecentBranchPushEvent[];
  availability: BranchIdentityAvailability;
};

/** Read GitHub's bounded recent Events window without claiming lifetime coverage. */
export async function getRecentBranchPushEvents(
  octokit: Pick<Octokit, "request">,
  input: { owner: string; repo: string; branchName: string }
): Promise<RecentBranchPushEvidence> {
  const events = new Map<string, RecentBranchPushEvent>();
  const repositoryName = `${input.owner}/${input.repo}`.toLowerCase();
  const ref = `refs/heads/${input.branchName}`;

  for (let page = 1; page <= MAX_EVENT_PAGES; page++) {
    let raw: unknown;
    try {
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/events",
        {
          owner: input.owner,
          repo: input.repo,
          per_page: EVENTS_PER_PAGE,
          page,
        }
      );
      raw = response.data;
    } catch {
      return evidenceAfterRead(events, page === 1);
    }
    if (!Array.isArray(raw)) {
      return evidenceAfterRead(events, page === 1);
    }
    for (const item of raw) {
      const parsed = eventSchema.safeParse(item);
      if (!parsed.success) {
        continue;
      }
      const event = parsed.data;
      if (
        event.type !== "PushEvent" ||
        event.repo.name.toLowerCase() !== repositoryName ||
        event.payload.ref !== ref ||
        !event.actor ||
        event.actor.login.toLowerCase() === "ghost" ||
        !event.payload.before ||
        !event.payload.head ||
        !SHA_RE.test(event.payload.before) ||
        !SHA_RE.test(event.payload.head) ||
        ZERO_SHA_RE.test(event.payload.head) ||
        event.payload.before.toLowerCase() === event.payload.head.toLowerCase()
      ) {
        continue;
      }
      events.set(event.id, {
        eventId: event.id,
        ...(event.payload.push_id
          ? { pushId: String(event.payload.push_id) }
          : {}),
        beforeSha: event.payload.before.toLowerCase(),
        afterSha: event.payload.head.toLowerCase(),
        providerUserId: String(event.actor.id),
        providerLogin: event.actor.login,
        observedAt: new Date(event.created_at),
      });
    }
    if (raw.length < EVENTS_PER_PAGE) {
      break;
    }
  }

  return evidenceAfterRead(events, false);
}

function evidenceAfterRead(
  events: ReadonlyMap<string, RecentBranchPushEvent>,
  firstPageFailed: boolean
): RecentBranchPushEvidence {
  return {
    events: [...events.values()],
    availability: firstPageFailed
      ? BranchIdentityAvailability.Unavailable
      : BranchIdentityAvailability.Incomplete,
  };
}
