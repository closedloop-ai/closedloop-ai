/**
 * @file attempt-store.ts
 * @description Persistence and compare-and-swap for the `OnboardingAttempt`
 * run row (ISS-8375).
 *
 * Every method takes `organizationId` and puts it in the Prisma `where` — the
 * org-scoped query IS the authorization check here, and `@@unique([userId,
 * organizationId])` makes that pair the identity a transition arbitrates on.
 */

import { withDb } from "@repo/database";
import { getPrismaErrorCode } from "@/lib/db-utils";
import {
  type RecordWriteInTransaction,
  writeInShape,
  writeRecorded,
} from "@/lib/record-write-in-transaction";
import type { OnboardingWrite } from "../onboarding-receipt";

/** Prisma's unique-constraint violation. */
const PRISMA_UNIQUE_VIOLATION = "P2002";

/**
 * The columns the snapshot and the transition arbitration read. Deliberately
 * not the whole row: `updatedAt` is provenance nothing here branches on.
 * `createdAt` is read: the snapshot's settled fold branches on when the run was
 * started. `host` is read for ONE purpose — the snapshot reports it as
 * `startedOnHost` so the Web shell can stand down for a run Desktop started —
 * and never to restore a state. `restoreOnboardingState` resolves a stored
 * state against the host of whoever is READING (the snapshot query string or
 * the transition command), because that is the surface which has to draw the
 * phase: a run started on Web and reopened on Desktop must recover, and
 * restoring against the stored `Web` would strand it on a screen Desktop never
 * renders.
 */
const ATTEMPT_SELECT = {
  id: true,
  experienceVariant: true,
  host: true,
  state: true,
  revision: true,
  lastCommandId: true,
  accountSkippedAt: true,
  desktopDownloadedAt: true,
  tourCompletedAt: true,
  invitesSentAt: true,
  completedAt: true,
  createdAt: true,
} as const;

export type OnboardingAttemptRecord = {
  id: string;
  experienceVariant: string;
  /** The surface the run started on, as stored; see `ATTEMPT_SELECT`. */
  host: string;
  /** Opaque `PersistedOnboardingState`; parsed by the shared strict schema. */
  state: unknown;
  revision: number;
  lastCommandId: string | null;
  accountSkippedAt: Date | null;
  desktopDownloadedAt: Date | null;
  tourCompletedAt: Date | null;
  /**
   * ISS-11670: when THIS user's own invitation send landed, or `null` when this
   * run still owes the invite step. Stamped by
   * {@link guidedOnboardingAttemptStore.markInvitesSent} from the invitation
   * route, on the same `invited > 0` the org-level marker uses, and seeded from
   * `completedAt` by the column's migration for runs that had already finished
   * — so an already-onboarded reader is not asked again. The org's
   * `invitesSentAt` answers a different question and must not be read in its
   * place — see the column comment in `schema.prisma`.
   */
  invitesSentAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
};

/**
 * Timestamps a transition stamps alongside the state write. Every field is
 * optional and, once written, is never rewritten — each records WHEN something
 * first happened, so re-stamping would move a measured fact.
 *
 * `invitesSentAt` is NOT here: it records a send this server performed, so it
 * is stamped by {@link guidedOnboardingAttemptStore.markInvitesSent} from the
 * invitation route rather than by a posted transition (ISS-11670).
 */
export type OnboardingAttemptMarkers = {
  accountSkippedAt?: Date;
  desktopDownloadedAt?: Date;
  tourCompletedAt?: Date;
  completedAt?: Date;
};

export type OnboardingAttemptWrite = {
  organizationId: string;
  userId: string;
  state: object;
  commandId: string;
  markers: OnboardingAttemptMarkers;
};

export const guidedOnboardingAttemptStore = {
  /** The caller's run, or `null` when they have not started one. */
  find(
    organizationId: string,
    userId: string
  ): Promise<OnboardingAttemptRecord | null> {
    return withDb((db) =>
      db.onboardingAttempt.findFirst({
        where: { organizationId, userId },
        select: ATTEMPT_SELECT,
      })
    );
  },

  /**
   * The compare-and-swap. Returns the number of rows moved: `1` when the
   * caller's `revision` was still current, `0` when it was not.
   *
   * One statement, so the state, the revision bump, the command id, and every
   * marker land together or not at all — a marker written by a second statement
   * could survive a transition that lost the race, leaving a timestamp that says
   * something happened at a revision that never existed.
   *
   * `updateMany` rather than `update` because the tenant guard belongs in the
   * `where`, and `update` only accepts a unique selector.
   *
   * `experienceVariant` and `host` are deliberately NOT in `data`: both are
   * fixed at create so a resumed run cannot switch component trees or claim a
   * different origin surface midway through.
   */
  async compareAndSwap(
    write: OnboardingAttemptWrite & { revision: number },
    recordWrite?: RecordWriteInTransaction<OnboardingWrite>
  ): Promise<number> {
    const swap = () =>
      withDb((db) =>
        db.onboardingAttempt.updateMany({
          where: {
            userId: write.userId,
            organizationId: write.organizationId,
            revision: write.revision,
          },
          data: {
            state: write.state,
            revision: write.revision + 1,
            lastCommandId: write.commandId,
            ...write.markers,
          },
        })
      );
    return await writeInShape(recordWrite, {
      unrecorded: async () => {
        const { count } = await swap();
        return count;
      },
      recorded: (record) =>
        withDb.tx(async (tx) => {
          const { count } = await swap();
          if (count === 1) {
            await record(tx, { changed: true });
          }
          return count;
        }),
    });
  },

  /**
   * Materialize the run on its first accepted transition.
   *
   * Starts at `revision: 1`, not the column default of `0`: the revision counts
   * accepted transitions, and this call IS one. A snapshot with no row reports
   * `revision: 0`, so the client's first command carries `0` and the row it
   * creates is already one ahead of it.
   *
   * Returns `null` when a concurrent request created the row first. That is not
   * an error — it means this command lost an arbitration it must now re-read and
   * settle, exactly like a failed compare-and-swap.
   *
   * `host` records the surface the run started on; see `ATTEMPT_SELECT` for
   * the one thing that reads it.
   */
  async create(
    write: OnboardingAttemptWrite & { experienceVariant: string; host: string },
    recordWrite?: RecordWriteInTransaction<OnboardingWrite>
  ): Promise<OnboardingAttemptRecord | null> {
    // The unique violation is caught OUTSIDE any transaction: a failed insert
    // aborts one, so nothing may run on it afterwards.
    try {
      return await writeRecorded(
        recordWrite,
        () =>
          withDb((db) =>
            db.onboardingAttempt.create({
              data: {
                userId: write.userId,
                organizationId: write.organizationId,
                experienceVariant: write.experienceVariant,
                host: write.host,
                state: write.state,
                revision: 1,
                lastCommandId: write.commandId,
                ...write.markers,
              },
              select: ATTEMPT_SELECT,
            })
          ),
        () => ({ changed: true })
      );
    } catch (error) {
      if (getPrismaErrorCode(error) === PRISMA_UNIQUE_VIOLATION) {
        return null;
      }
      throw error;
    }
  },

  /**
   * Stamp {@link OnboardingAttemptRecord.invitesSentAt} for a send this server
   * performed (ISS-11670), outside any transition.
   *
   * Write-once in ONE statement: `invitesSentAt: null` is part of the `where`,
   * so a second send cannot move a measured fact and nothing reads the row to
   * decide that. It deliberately does NOT touch `revision`, `state` or
   * `lastCommandId` — this is not a transition and must not invalidate a
   * compare-and-swap the client has already composed a command against.
   *
   * Returns the number of rows moved, which is `0` for a caller who has no
   * guided run: inviting from the v1 checklist is not a guided run, and a run
   * they start later is a new one that has not sent anything.
   */
  async markInvitesSent(params: {
    organizationId: string;
    userId: string;
  }): Promise<number> {
    const { count } = await withDb((db) =>
      db.onboardingAttempt.updateMany({
        where: {
          userId: params.userId,
          organizationId: params.organizationId,
          invitesSentAt: null,
        },
        data: { invitesSentAt: new Date() },
      })
    );
    return count;
  },
};
