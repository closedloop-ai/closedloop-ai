import { ReadSource } from "@repo/api/src/types/read-source";
import { describeCloudReadCutover } from "./cloud-read-cutover-copy";
import { useDesktopCloudReadCutover } from "./desktop-app-core-provider";

export type CloudReadCutoverBadge = {
  /** The sentence explaining WHY this source is in play; `undefined` ⇒ nothing to say. */
  detail: string | undefined;
  /** The read is known to be short — see `ReadSourceBadge`'s `incomplete`. */
  incomplete: boolean;
};

/**
 * ISS-5477: the read-source badge's cutover extras, derived once.
 *
 * Every desktop surface that shows a `ReadSourceBadge` — Dashboard, Sessions,
 * Branches — needs the same two answers, and the explanation has to be on ALL
 * of them: Sessions is the screen someone opens when they think their history
 * vanished, so it must not be the one that stays quiet while the dashboard
 * explains itself. Deriving it here (rather than in each view) is what keeps
 * the three from drifting into three different explanations of one state.
 *
 * Desktop-only by construction: it reads the desktop import/sync backlog, which
 * is why the shared `@repo/app` toolbars take these as passthrough props rather
 * than deriving them — the web app has no such backlog.
 */
export function useCloudReadCutoverBadge(
  readSource: ReadSource | undefined
): CloudReadCutoverBadge {
  const cutover = useDesktopCloudReadCutover();
  // ISS-5714: the reason has to describe the store THIS surface read, not the
  // store the mode picked. They differ offline, where Branches keeps serving
  // cached cloud rows while Sessions drops to local.
  const detail = describeCloudReadCutover(cutover, readSource);
  return {
    detail,
    // A cloud read still carrying an explanation is a cloud read we already
    // know is short (the bounded fail-open, or the latch holding us there while
    // newer local work catches up). A drained cloud read has no detail at all,
    // and a local read is complete — neither is "incomplete".
    incomplete: readSource === ReadSource.Cloud && detail !== undefined,
  };
}
