import { DESKTOP_EMAIL_CALLBACK_TIMEOUT_MS } from "@repo/api/src/types/desktop-authorize-url";
import type { DesktopSignInAnalyticsRegistration } from "@repo/api/src/types/desktop-sign-in-analytics";
import { Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { clerkService } from "@/lib/auth/clerk-service";
import { hashToken } from "@/lib/auth/token-hash";
import { aliasDesktopAnalytics } from "@/lib/desktop-analytics-capture";

/** Security decision 4b/4c, ISS-11127: 15-minute email ceiling plus five minutes. */
export const SIGN_IN_ANALYTICS_TTL_MS =
  DESKTOP_EMAIL_CALLBACK_TIMEOUT_MS + 5 * 60_000;
export const SIGN_IN_ANALYTICS_LIVE_ROW_CAP = 1000;

export const desktopSignInAnalyticsService = {
  async register(input: DesktopSignInAnalyticsRegistration): Promise<void> {
    try {
      const challengeHash = hashToken(input.codeChallenge);
      await withDb.tx(async (db) => {
        // Serialize the count/insert across instances; the cap is global (4c).
        await db.$queryRaw(
          Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(11127)`
        );
        const now = new Date();
        await db.desktopSignInAnalyticsAttempt.deleteMany({
          where: { expiresAt: { lte: now } },
        });
        const live = await db.desktopSignInAnalyticsAttempt.count();
        if (live >= SIGN_IN_ANALYTICS_LIVE_ROW_CAP) {
          log.warn("Desktop sign-in analytics live-row cap reached", {
            status: "warn",
            code: "registration_cap_reached",
            cap: SIGN_IN_ANALYTICS_LIVE_ROW_CAP,
          });
          return;
        }
        await db.desktopSignInAnalyticsAttempt.createMany({
          data: [
            {
              challengeHash,
              flowId: input.flowId,
              createdAt: now,
              expiresAt: new Date(now.getTime() + SIGN_IN_ANALYTICS_TTL_MS),
            },
          ],
          skipDuplicates: true,
        });
      });
    } catch {
      // Bound values may appear in Prisma errors: never log the error object (4b).
      log.warn("Desktop sign-in analytics unavailable", {
        status: "warn",
        code: "registration_failed",
      });
    }
  },

  async report(codeChallenge: string, clerkUserId: string): Promise<void> {
    try {
      const challengeHash = hashToken(codeChallenge);
      const entry = await withDb((db) =>
        db.desktopSignInAnalyticsAttempt.findFirst({
          where: { challengeHash, expiresAt: { gt: new Date() } },
          select: { createdAt: true, expiresAt: true },
        })
      );
      // Misses never spend a Clerk request (4a).
      if (!entry) {
        return;
      }
      const user = await clerkService.getUser(clerkUserId);
      if (user.createdAt === undefined || !Number.isFinite(user.createdAt)) {
        return;
      }
      const createdAt = new Date(user.createdAt);
      // Failed window checks leave the entry intact; concurrent reports consume once.
      const rows = await withDb((db) =>
        db.$queryRaw<{ flowId: string }[]>(Prisma.sql`
        DELETE FROM desktop_sign_in_analytics_attempt
        WHERE challenge_hash = ${challengeHash}
          AND expires_at > NOW()
          AND created_at <= ${createdAt} AND expires_at >= ${createdAt}
        RETURNING flow_id AS "flowId"
      `)
      );
      if (rows[0]) {
        aliasDesktopAnalytics({
          distinctId: clerkUserId,
          alias: rows[0].flowId,
        });
      }
    } catch {
      log.warn("Desktop sign-in analytics unavailable", {
        status: "warn",
        code: "report_failed",
      });
    }
  },
};
