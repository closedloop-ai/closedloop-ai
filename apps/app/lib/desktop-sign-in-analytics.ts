import { DESKTOP_AUTHORIZE_QUERY_PARAMS } from "@repo/api/src/types/desktop-authorize-url";
import { DesktopSignInAnalyticsPath } from "@repo/api/src/types/desktop-sign-in-analytics";
import { clerkClient } from "@repo/auth/server";
import { after } from "next/server";
import { resolveApiOrigin } from "./api-origin";
import type { DesktopAuthorizeRun } from "./desktop-authorize-run";

type ReportSession = {
  userId: string | null;
  getToken: () => Promise<string | null>;
};

/** ISS-11127: only the validated cookie supplies the challenge; never mutate it. */
export function scheduleDesktopSignInAnalyticsReport(
  run: DesktopAuthorizeRun | null,
  resolveSession: () => Promise<ReportSession>
): void {
  if (!run || run.consumed) {
    return;
  }
  try {
    // Capture request-scoped auth before after() leaves the render context.
    // The promise is deliberately not awaited on the redirect path.
    const sessionPromise = resolveSession()
      .then(async (session) => ({
        userId: session.userId,
        token: await session.getToken(),
      }))
      .catch(() => null);
    after(async () => {
      try {
        const session = await sessionPromise;
        if (!session?.userId || (run.userId && run.userId !== session.userId)) {
          return;
        }
        const client = await clerkClient();
        const user = await client.users.getUser(session.userId);
        if (!desktopRunCreatedAccount(run, user)) {
          return;
        }
        const codeChallenge = new URLSearchParams(run.query).get(
          DESKTOP_AUTHORIZE_QUERY_PARAMS.codeChallenge
        );
        const token = session.token;
        if (!(codeChallenge && token)) {
          return;
        }
        await fetch(
          new URL(DesktopSignInAnalyticsPath.Report, resolveApiOrigin()),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ codeChallenge }),
            signal: AbortSignal.timeout(10_000),
          }
        );
      } catch {
        /* ISS-11127: lookup failure cannot affect the auth response or leak values. */
      }
    });
  } catch {
    /* ISS-11127: scheduling is also best effort. */
  }
}

export function desktopRunCreatedAccount(
  run: DesktopAuthorizeRun,
  user: { id: string; createdAt: number } | null
): boolean {
  return (
    user !== null &&
    (run.userId === undefined || run.userId === user.id) &&
    user.createdAt >= run.issuedAt
  );
}
