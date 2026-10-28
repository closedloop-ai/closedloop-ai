/**
 * PLN-2187 T-2.6: an org's switch to unified document comments is read for
 * its PostHog group and latched on the organization row the first time it
 * reads on, so a later unanswered lookup cannot send it back (tamsinb,
 * #8828).
 */
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { log } from "@repo/observability/log";
import { afterAll, describe, expect, it, vi } from "vitest";

const { evaluate } = vi.hoisted(() => ({
  evaluate: vi.fn((): Promise<boolean | null> => Promise.resolve(null)),
}));

vi.mock(
  "@/lib/feature-flags/server-feature-flag-evaluation",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/feature-flags/server-feature-flag-evaluation")
    >()),
    evaluateServerFeatureFlagForOrganization: evaluate,
  })
);

import { createCommittedTestOrganizationTracker } from "@/__tests__/utils/db-helpers";
import { DOCUMENT_UNIFIED_COMMENTS_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";
import {
  DOCUMENT_COMMENTS_SWITCH_LATCHED_EVENT,
  isDocumentCommentsSwitchLatched,
  resolveAndLatchDocumentCommentsSwitch,
} from "./comment-store-switch";

const hasDatabase = Boolean(keys().DATABASE_URL);
const describeIfDb = hasDatabase ? describe : describe.skip;

const tracker = createCommittedTestOrganizationTracker();

function readOrganization(organizationId: string) {
  return withDb((db) =>
    db.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { clerkId: true, documentCommentsSwitchedAt: true },
    })
  );
}

describeIfDb("resolveAndLatchDocumentCommentsSwitch", () => {
  afterAll(async () => {
    await tracker.cleanup();
  });

  it("switches and latches an org the first time the flag reads on for its group", async () => {
    const organizationId = await tracker.create();
    const { clerkId } = await readOrganization(organizationId);
    evaluate.mockResolvedValue(true);

    await expect(
      resolveAndLatchDocumentCommentsSwitch(organizationId)
    ).resolves.toBe(true);
    expect(evaluate).toHaveBeenCalledWith(
      DOCUMENT_UNIFIED_COMMENTS_SERVER_FLAG,
      clerkId
    );
    expect(
      (await readOrganization(organizationId)).documentCommentsSwitchedAt
    ).toBeInstanceOf(Date);
  });

  it("logs the switch once, from the lookup whose write latched it, naming the org and the flag", async () => {
    const organizationId = await tracker.create();
    const info = vi.spyOn(log, "info");
    // Both racing lookups read the org unlatched before either writes.
    let releaseEvaluations: () => void = () => undefined;
    const bothEvaluated = new Promise<void>((resolve) => {
      releaseEvaluations = resolve;
    });
    let evaluations = 0;
    evaluate.mockImplementation(async () => {
      evaluations += 1;
      if (evaluations === 2) {
        releaseEvaluations();
      }
      await bothEvaluated;
      return true;
    });

    await Promise.all([
      resolveAndLatchDocumentCommentsSwitch(organizationId),
      resolveAndLatchDocumentCommentsSwitch(organizationId),
    ]);
    await resolveAndLatchDocumentCommentsSwitch(organizationId);

    const latchedLogs = info.mock.calls.filter(
      ([message]) => message === DOCUMENT_COMMENTS_SWITCH_LATCHED_EVENT
    );
    expect(latchedLogs).toEqual([
      [
        DOCUMENT_COMMENTS_SWITCH_LATCHED_EVENT,
        {
          event: DOCUMENT_COMMENTS_SWITCH_LATCHED_EVENT,
          organizationId,
          flagKey: DOCUMENT_UNIFIED_COMMENTS_SERVER_FLAG.key,
        },
      ],
    ]);
  });

  it("keeps a latched org switched when a later lookup goes unanswered", async () => {
    const organizationId = await tracker.create();
    evaluate.mockResolvedValue(true);
    await resolveAndLatchDocumentCommentsSwitch(organizationId);
    evaluate.mockResolvedValue(null);

    await expect(
      resolveAndLatchDocumentCommentsSwitch(organizationId)
    ).resolves.toBe(true);
  });

  it("leaves an org unswitched and unlatched while the flag reads off", async () => {
    const organizationId = await tracker.create();
    evaluate.mockResolvedValue(false);

    await expect(
      resolveAndLatchDocumentCommentsSwitch(organizationId)
    ).resolves.toBe(false);
    expect(
      (await readOrganization(organizationId)).documentCommentsSwitchedAt
    ).toBeNull();
  });

  it("does not switch an org on an unanswered lookup", async () => {
    const organizationId = await tracker.create();
    evaluate.mockResolvedValue(null);

    await expect(
      resolveAndLatchDocumentCommentsSwitch(organizationId)
    ).resolves.toBe(false);
  });
});

describeIfDb("isDocumentCommentsSwitchLatched", () => {
  afterAll(async () => {
    await tracker.cleanup();
  });

  it("reads an unlatched org as unswitched without evaluating the flag or latching it", async () => {
    const organizationId = await tracker.create();
    evaluate.mockClear();
    evaluate.mockResolvedValue(true);

    await expect(isDocumentCommentsSwitchLatched(organizationId)).resolves.toBe(
      false
    );
    expect(evaluate).not.toHaveBeenCalled();
    expect(
      (await readOrganization(organizationId)).documentCommentsSwitchedAt
    ).toBeNull();
  });

  it("reads an org as switched once its switch is latched", async () => {
    const organizationId = await tracker.create();
    evaluate.mockResolvedValue(true);
    await resolveAndLatchDocumentCommentsSwitch(organizationId);

    await expect(isDocumentCommentsSwitchLatched(organizationId)).resolves.toBe(
      true
    );
  });
});
