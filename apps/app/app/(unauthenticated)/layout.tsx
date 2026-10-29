import { Link } from "@repo/navigation/link";
import Image from "next/image";
import type { ReactNode } from "react";
import { env } from "@/env";
import {
  ClerkLoadFailureNotice,
  HideWhenClerkFailed,
} from "./clerk-load-failure-notice";

type AuthLayoutProps = {
  readonly children: ReactNode;
};

function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <main className="relative grid min-h-dvh lg:grid-cols-2">
      {/* Left — wordmark + centered auth card. min-h-dvh with its own scroll so
          a tall Clerk card (error banner, extra providers) is always reachable
          under the root body's overflow-hidden. */}
      <div className="flex min-h-dvh flex-col overflow-y-auto px-6 py-10 lg:px-10">
        {/* Links to the marketing site, not `/`: the app root sends a
            signed-out visitor into sign-up. self-start keeps the hit target
            on the wordmark rather than stretching across the whole column. */}
        <Link
          aria-label="Closedloop home"
          className="inline-flex self-start"
          href={env.NEXT_PUBLIC_WEB_URL}
        >
          <Image
            alt="Closedloop logo"
            className="dark:hidden"
            height={30}
            src="/logo.svg"
            width={200}
          />
          <Image
            alt="Closedloop logo"
            className="hidden dark:block"
            height={30}
            src="/logo-dark.svg"
            width={200}
          />
        </Link>

        <div className="flex flex-1 items-center justify-center py-8">
          {/* ISS-11429: the notice REPLACES the page's content while Clerk's
              status is `error`, rather than appearing beside it. On `/sign-up`
              and `/sign-in` the embed renders nothing in that state anyway; on
              `/sso-callback` and `/connect/github` a phase-driven panel Clerk's
              failure never advances stayed up, so the screen said the sign-in
              was still running and that it had failed, at once. Mounted on the
              LAYOUT so all four screens are covered by one statement instead of
              four. */}
          <div className="flex w-full max-w-sm flex-col gap-4">
            <HideWhenClerkFailed>{children}</HideWhenClerkFailed>
            <ClerkLoadFailureNotice />
          </div>
        </div>
      </div>

      {/* Right — product showcase over the brand gradient (hidden on mobile).
          Near full-bleed: a slim p-3 gutter, the gradient panel owns the rest of
          the half so the art fills its frame instead of floating in dead space. */}
      <div className="hidden h-full p-3 lg:block">
        <div
          className="flex h-full w-full items-end justify-end overflow-hidden rounded-2xl pl-12"
          style={{ background: "var(--brand-gradient)" }}
        >
          <Image
            alt="Closedloop product screenshot"
            className="max-h-full w-auto object-contain"
            height={920}
            priority
            src="/sign-in-screenshot.png"
            width={993}
          />
        </div>
      </div>
    </main>
  );
}

export default AuthLayout;
