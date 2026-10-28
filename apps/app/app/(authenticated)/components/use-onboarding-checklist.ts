"use client";

import {
  ChecklistItemId,
  type OnboardingChecklistItem,
} from "@repo/api/src/types/onboarding";
import { useDetectedDesktopOs } from "@repo/app/onboarding/hooks/use-detected-desktop-os";
import { useOnboardingStatus } from "@repo/app/onboarding/hooks/use-onboarding";
import {
  type DetectedPlatform,
  describeDesktopInstallerGap,
  desktopInstallerIsPublished,
  isDesktopOs,
} from "@repo/app/onboarding/lib/desktop-platform-availability";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";

/**
 * The attribute every checklist row carries, stamped with its item id.
 *
 * Declared here rather than inline in the checklist because it is a runtime
 * contract between two components: the checklist produces it, the invite
 * spotlight queries it to find its anchor. Split across two files as bare
 * strings, renaming it on one side compiles fine and the spotlight silently
 * stops firing.
 */
export const CHECKLIST_ITEM_ATTRIBUTE = "data-checklist-item";

/**
 * The element that holds the rows.
 *
 * Separate from the row attribute because the two answer different questions:
 * a row says WHERE to point, the list says WHEN the pointing goes stale. A row
 * is wrapped in a `Link` only while it has an href and is incomplete, so
 * walking up from the row lands on an anchor or on the list depending on state
 * — and an anchor's box does not change when a sibling row is inserted above
 * it, which is exactly the move that invalidates a measurement.
 */
export const CHECKLIST_LIST_ATTRIBUTE = "data-checklist-items";

/** Selector for the rows container. */
export const CHECKLIST_LIST_SELECTOR = `[${CHECKLIST_LIST_ATTRIBUTE}]`;

/** Selector for one checklist row, by the contract value the API returns. */
export function checklistItemSelector(itemId: ChecklistItemId): string {
  return `[${CHECKLIST_ITEM_ATTRIBUTE}="${itemId}"]`;
}

export type OnboardingChecklistView = {
  /** Whether the checklist card is on screen right now. */
  readonly visible: boolean;
  readonly items: readonly OnboardingChecklistItem[];
  readonly completedCount: number;
  readonly totalCount: number;
};

/**
 * One answer to "is the setup checklist showing, and what is in it".
 *
 * Two components need this and they need to agree: the checklist renders from
 * it, and the invite spotlight anchors to a row inside it. Recomputing those
 * conditions in each of them is how two surfaces end up disagreeing about the
 * same fact on the same screen — which is exactly what visual QA caught.
 */
export function useOnboardingChecklist(): OnboardingChecklistView {
  // Refetch when the tab regains focus — `"always"`, not `true`. Unlike every
  // sibling row, the desktop row completes through an action that happens
  // OUTSIDE the browser: the user follows an external download link, installs an
  // app, and that app registers a compute target from a different client. No
  // in-tab mutation ever invalidates this query, and `true` only refetches a
  // STALE query — which, against this query's five-minute `staleTime`, is
  // precisely not the window in which someone downloads, installs and comes
  // back. `"always"` re-checks on the return itself.
  const { data: status } = useOnboardingStatus({
    refetchOnWindowFocus: "always",
  });
  const gdriveEnabled = useFeatureFlagEnabled("google-drive");
  // The visitor's platform, read once and handed straight to the row rewrite
  // below. There is no gate to pick between shapes any more: every item goes
  // through `withPlatformHonestDesktopRow`, which leaves every row but the
  // desktop one untouched.
  const detectedOs = useDetectedDesktopOs();

  const hiddenItemIds = new Set<ChecklistItemId>();
  if (!gdriveEnabled) {
    hiddenItemIds.add(ChecklistItemId.ConnectGoogle);
  }

  const visibleItems = (status?.checklist ?? []).filter(
    (item) => !hiddenItemIds.has(item.id)
  );
  const items = visibleItems.map((item) =>
    withPlatformHonestDesktopRow(item, detectedOs)
  );
  const completedCount = items.filter((item) => item.completed).length;
  const totalCount = items.length;

  // No `completedCount !== totalCount` term: the card shows its completed
  // state and is removed only by the dismiss control (ISS-7089 F4). Vanishing
  // at 100% deleted the card mid-session under the user, and they never saw
  // the finished state.
  const visible =
    status?.wizardCompleted === true &&
    !status.checklistDismissed &&
    totalCount > 0;

  return {
    visible,
    items,
    completedCount,
    totalCount,
  };
}

/**
 * Rewrites the desktop row when the visitor's platform has no published
 * installer (ISS-9651, PRD-685 FR11).
 *
 * The service builds this row server-side, where the visitor's platform is not
 * knowable. It used to resolve that by sending the macOS `.dmg` to every reader,
 * which made this rewrite the only thing standing between a Windows or Linux
 * visitor and a one-click download of an artifact their machine cannot run —
 * and, because the row renders before PostHog's anonymous bootstrap resolves the
 * signed-in user's flags, a thing that had not necessarily run yet. ISS-9708
 * removed the platform from the payload instead: the row now arrives carrying
 * the download channel's release PAGE, which is a correct destination for every
 * reader regardless of what this function does.
 *
 * So the description is what this rewrite is now FOR. The step is still "download
 * the desktop app"; what a reader on an unpublished platform needs to know is
 * that their platform cannot do it yet, and the page will not tell them — it simply has no
 * asset for them. The headline goes in the description rather than the fuller
 * sentence the wizard shows because this row truncates to one line, and a
 * sentence clipped mid-word states nothing at all. The LABEL is left alone.
 *
 * Withholding `href` alongside it is now a CONSERVATIVE choice rather than a
 * necessary one: the page is safe for anyone to open, so a reader sent there
 * loses nothing but finds nothing either. Whether the honest arm should keep
 * suppressing a link that no longer misroutes anybody is ISS-9651's product
 * call, not something to flip while fixing the payload underneath it — this
 * function's behaviour is deliberately unchanged by ISS-9708.
 *
 * Every other row, and the desktop row on a platform whose installer resolves,
 * is returned by identity. A completed row is left alone too: the compute target
 * already registered, so how the user would have installed it is moot.
 */
function withPlatformHonestDesktopRow(
  item: OnboardingChecklistItem,
  detectedOs: DetectedPlatform | null
): OnboardingChecklistItem {
  if (item.id !== ChecklistItemId.DownloadDesktop || item.completed) {
    return item;
  }

  // Platform not resolved yet. Withhold the link without claiming a gap: this
  // arm must not assert an unavailability nobody has measured. Reachable on a
  // warm query cache, where the row commits before the detection effect runs.
  // Since ISS-9708 the link it withholds here is the platform-neutral release
  // page, so this no longer prevents a misroute — see the note above.
  if (detectedOs === null) {
    return { ...item, external: false, href: undefined };
  }

  // An agent that named no desktop OS keeps the row exactly as the service sent
  // it. Unlike the wizard control, this row is a single link with no room to
  // offer one per platform, and it names no platform either -- "Download the
  // desktop app" asserts nothing about the machine reading it, so the link is
  // not a misroute the way a "Download Mac Desktop App" button would be.
  // Withholding it is the capability loss Perrin's ISS-9651 ruling refused, and
  // this is the same link every visitor gets in production today.
  if (!isDesktopOs(detectedOs)) {
    return item;
  }

  if (desktopInstallerIsPublished(detectedOs)) {
    return item;
  }

  return {
    ...item,
    description: describeDesktopInstallerGap(detectedOs).headline,
    external: false,
    href: undefined,
  };
}
