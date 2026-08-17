import { Link } from "@repo/navigation/link";
import Image from "next/image";
import type { ReactNode } from "react";
import { env } from "@/env";

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
        {/* Links to the marketing site, not `/`: the app root resolves to the
            authenticated shell, which redirects a signed-out visitor into
            sign-up. self-start keeps the hit target on the wordmark rather than
            stretching across the whole column. */}
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
          <div className="w-full max-w-sm">{children}</div>
        </div>
      </div>

      {/* Right — product showcase over the brand gradient (hidden on mobile).
          Near full-bleed: a slim p-3 gutter, the gradient panel owns the rest of
          the half so the art fills its frame instead of floating in dead space. */}
      <div className="hidden h-full p-3 lg:block">
        <div
          className="flex h-full w-full items-center justify-end overflow-hidden rounded-2xl pl-12"
          style={{ background: "var(--brand-gradient)" }}
        >
          <Image
            alt="Closedloop product screenshot"
            className="max-h-full w-auto object-contain"
            height={1191}
            priority
            src="/CL-SS3.png"
            width={1060}
          />
        </div>
      </div>
    </main>
  );
}

export default AuthLayout;
