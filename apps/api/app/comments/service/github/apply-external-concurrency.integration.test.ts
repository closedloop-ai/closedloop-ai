/**
 * ISS-11212 (PLN-2122 decision 1) against a real Postgres: two `applyExternal`
 * calls for the same comment overlap, and the older delivery's transaction
 * reads the stored state before the newer one commits. The ordering rule must
 * still leave the newer body, which needs the calls serialized; an ambient
 * rollback transaction would put both on one connection and prove nothing, so
 * this suite commits and cleans up its organizations.
 */
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it, vi } from "vitest";

const gate = vi.hoisted(() => {
  let release: () => void = () => undefined;
  let reached: () => void = () => undefined;
  return {
    heldBody: "older",
    holderPid: 0,
    released: new Promise<void>((resolve) => {
      release = resolve;
    }),
    reachedGate: new Promise<void>((resolve) => {
      reached = resolve;
    }),
    release: () => release(),
    reached: () => reached(),
  };
});

vi.mock("./apply-external-upsert", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./apply-external-upsert")>();
  return {
    ...actual,
    applyUpsertEvent: async (
      ...args: Parameters<typeof actual.applyUpsertEvent>
    ) => {
      const [ctx, event] = args;
      const bodies = actual
        .upsertEventComments(event)
        .map((comment) => comment.bodyMarkdown);
      if (bodies.includes(gate.heldBody)) {
        const [backend] = await ctx.tx.$queryRaw<{ pid: number }[]>`
          SELECT pg_backend_pid() AS pid
        `;
        gate.holderPid = backend?.pid ?? 0;
        gate.reached();
        await gate.released;
      }
      return actual.applyUpsertEvent(...args);
    },
  };
});

import {
  applyInput,
  at,
  issueCommentEvent,
  seedGitHubCommentScope,
  storedComment,
} from "@/__tests__/support/comments/github-apply-external.test-fixtures";
import {
  PendingCallState,
  untilSettledOrBlockedBy,
} from "@/__tests__/support/comments/lock-wait.test-fixtures";
import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { applyExternal } from "./apply-external";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const organizations = createCommittedTestOrganizationTracker();

describeIfDb("applyExternal — overlapping deliveries for one comment", () => {
  afterEach(async () => {
    await organizations.cleanup();
  });

  it("keeps the newer body when an older delivery read the stored state first", async () => {
    const scope = await seedGitHubCommentScope(await organizations.create());
    await applyExternal(
      applyInput(scope, [
        issueCommentEvent(1, {
          bodyMarkdown: "original",
          providerUpdatedAt: at(1),
        }),
      ])
    );

    const older = applyExternal(
      applyInput(scope, [
        issueCommentEvent(1, {
          bodyMarkdown: gate.heldBody,
          providerUpdatedAt: at(2),
        }),
      ])
    );
    await gate.reachedGate;
    const newer = applyExternal(
      applyInput(scope, [
        issueCommentEvent(1, {
          bodyMarkdown: "newest",
          providerUpdatedAt: at(3),
        }),
      ])
    );
    expect(await untilSettledOrBlockedBy(newer, gate.holderPid)).toBe(
      PendingCallState.Blocked
    );
    gate.release();
    await Promise.all([older, newer]);

    const stored = await storedComment(scope, 1);
    expect(stored?.comment.plainText).toBe("newest");
    expect(stored?.comment.syncStates[0]?.providerUpdatedAt).toEqual(at(3));
  });
});
