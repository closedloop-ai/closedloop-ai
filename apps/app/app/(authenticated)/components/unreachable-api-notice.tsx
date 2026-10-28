import { buttonVariants } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Link2Off } from "lucide-react";
import { hostnameOf } from "@/lib/api-origin";

type UnreachableApiNoticeProps = {
  /** The host the browser is on, as the request carried it. */
  readonly host: string;
  /** `NEXT_PUBLIC_APP_URL` — the configured, stable address for this app. */
  readonly stableAppUrl: string;
};

/**
 * The whole authenticated shell for a per-deployment preview address, which
 * cannot reach the API (ISS-9797).
 *
 * `resolveApiOrigin` derives the API host from the host the browser is on, and
 * a deployment hash has no API twin, so every client-side read is CORS-blocked
 * — 50 of 50 requests in the ticket's captured trace. The shell rendered
 * anyway: `Teams unavailable` in the sidebar, `— Unavailable` on every summary
 * card, an error state on every list. Each of those is a claim about the user's
 * data, and all of them were false. The operator's 2026-09-12 ruling kept the
 * rewrite and asked for this screen instead.
 *
 * It REPLACES the shell rather than sitting inside it, because the sidebar is
 * one of the surfaces that lies; leaving the chrome up would keep
 * `Teams unavailable` on screen next to the sentence explaining that no team
 * data can be loaded here. There is nothing behind the chrome to return to —
 * every route on this host fails identically.
 *
 * The condition is read from the address, never from a failed fetch, so the
 * copy states what this link is rather than guessing why data is missing.
 */
export function UnreachableApiNotice({
  host,
  stableAppUrl,
}: UnreachableApiNoticeProps) {
  const stableHost = readHost(stableAppUrl);

  // A real `main`: the shell normally owns this document's single landmark
  // (`SidebarInset`), and it does not render here, so without this the document
  // has none at all. `no-nested-main-landmark` exempts this file for the same
  // reason it exempts the renderer's root error boundary (ISS-4673).
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center p-6">
      <EmptyState
        action={
          // Offered only when it actually goes somewhere else: on a preview
          // build the configured URL can be this same dead host, and a button
          // that reloads the screen you are reading is the failure this screen
          // exists to remove. BOTH sides are normalized, because the request
          // host can carry `:443` where the parsed URL host drops it, and the
          // raw compare then reads one address as two (davetho PR review).
          stableHost && hostnameOf(stableHost) !== hostnameOf(host) ? (
            <a className={buttonVariants()} href={stableAppUrl}>
              Open {stableHost}
            </a>
          ) : null
        }
        description={`${host} is a one-off preview build with no matching API deployment, so nothing on this page can load data.`}
        icon={Link2Off}
        title="This preview link can't reach the API"
        titleAs="h1"
      />
    </main>
  );
}

/** The host of a configured URL, or `null` if it is not parseable. */
function readHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
