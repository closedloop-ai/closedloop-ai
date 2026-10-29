import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@closedloop-ai/design-system/components/ui/alert";
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import { buildSettingsPanelRoute } from "@repo/api/src/types/settings-route-links";
import { LinkIcon } from "lucide-react";
import { z } from "zod";
import { DesktopAuthStatus } from "../../../shared/contracts";
import { useDesktopAuthOptional } from "../../shared-agent-sessions/desktop-auth-provider";
import { useDesktopIdentity } from "../../shared-agent-sessions/use-desktop-identity";
import { useWebAppOrigin } from "../../shared-agent-sessions/use-web-app-origin";
import {
  COMPUTE_TARGET_LINK_BLOCK_ACTION_LABEL,
  COMPUTE_TARGET_LINK_BLOCK_TITLE,
} from "./compute-target-link-block-copy";

/**
 * ISS-11426 — the recovery path for a compute target the cloud refuses as not
 * owned by the signed-in account.
 *
 * The condition is `target_not_owned`, a no-budget-burn environmental class, so
 * the lane defers with every retry budget intact and never dead-letters. Nothing
 * was lost and nothing advances either: measured 2026-09-28, one production
 * install had 5,131 of its 5,219 sync batches refused across two days while the
 * sync panel stayed green and the person using it had no action available. This
 * is that action.
 *
 * It is offered for the OWNERSHIP refusal alone. An org-policy denial arrives as
 * `feature_disabled` since the server coded the two apart, only an org admin can
 * change it, and relinking would do nothing — so the latch behind this alert
 * never records it, and this surface never offers the relink for it.
 *
 * THE COPY CLAIMS ONLY WHAT THE LATCH CAN BACK (tamsinb). It does not name the
 * lanes — `LANE_OWNERSHIP_ROLE` decides which ones feed the latch and that set
 * is not the set a sentence here could keep up with, so "uploads have stopped"
 * is the claim rather than an enumeration that would be wrong the next time a
 * lane is wired. And it does not say the target belongs to a DIFFERENT ACCOUNT:
 * `findOwnedById` is `{ id, organizationId, userId }`, so it also misses for
 * the same person in another org and for a target that has been deleted. What
 * is true in every one of those is that the workspace will not accept this
 * machine's target and that relinking is the remedy, which is what it says.
 *
 * The copy claims nothing about the backlog it cannot back. `adoptStrandedOutboxRows`
 * (`main/agent-sync/adopt-stranded-outbox-rows.ts`) already adopts rows stranded
 * under a RETIRED compute target onto the device's current source key where
 * ownership is provable, and PARKS rows owned by another account for that
 * account rather than dropping them — which is why "nothing has been lost" is a
 * statement and "resume syncing" is an instruction rather than a promise about
 * which historical rows move.
 *
 * The destination is the cloud Settings → Connected Devices PANEL, which lists
 * the account's registered desktops (ISS-12784 R6), rather than a new
 * device-linking flow in this renderer. Built through `buildSettingsPanelRoute`
 * rather than hand-spelled: `/<slug>/settings/compute-targets` is NOT a page, so
 * that path falls through to `[...unmatched]` and `notFound()`, and the alert's
 * whole reason for existing is to offer an action that works (tamsinb). The
 * panel is reached by deep link (`?panel=connected-devices`), and naming it by
 * contract is also what keeps this from silently rotting the next time the
 * panel id moves.
 *
 * An absolute `https://` href is the only destination this renderer can offer
 * (the same constraint `artifact-web-href.ts` records): it hosts no settings
 * routes, so the Electron window-open handler hands the click to the browser.
 */
const linkBlockSchema = z.object({
  // Genuinely nullable: the lane can be refused before it can name the target
  // it presented. Every other field is REQUIRED, with no `.catch` default —
  // a per-field default would turn a payload this build cannot read into a
  // confident "you are blocked" carrying a fabricated date and no target, which
  // is worse than reading it as not blocked.
  refusedComputeTargetId: z.string().nullable(),
  // At least 1: a block exists because a batch was refused, so a zero here is a
  // shape this build does not understand rather than a block with no refusals.
  refusedBatchCount: z.number().int().min(1),
  firstRefusedAt: z.string().min(1),
});

export type ComputeTargetLinkBlockView = z.infer<typeof linkBlockSchema>;

/**
 * Project the block out of the runtime-status payload, or null when nothing is
 * blocked.
 *
 * VALIDATED rather than asserted, like the sibling `connectionSecurity` read on
 * this surface: the payload arrives over IPC from a main process that may be
 * older than this renderer, and a shape this build cannot read must degrade to
 * "not blocked" rather than render an alert built from `undefined`.
 */
export function parseComputeTargetLinkBlock(
  value: unknown
): ComputeTargetLinkBlockView | null {
  const parsed = linkBlockSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function ComputeTargetLinkBlockAlert({
  block,
}: {
  block: ComputeTargetLinkBlockView | null;
}) {
  // Ungated: "ISS-11426 - this should not be behind a FF" (operator ruling,
  // Marisol Ashgrove, 2026-10-05). The body is a separate component so the account
  // and origin reads that build its destination happen ONLY while the alert is
  // actually shown. Hoisting them here would make an unblocked Settings tab pay
  // an extra `getSettings` IPC on every mount — measured as a real regression
  // against `settings-panel-global-sandbox.test.ts`, which pins that the tab
  // does not re-read settings after an update.
  return block ? <LinkBlockAlertBody /> : null;
}

function LinkBlockAlertBody() {
  // OPTIONAL auth read: not every `DesktopAppPanel` mount wraps a provider (most
  // of its suites do not), and no provider reads the same as signed out — the
  // org-scoped link is withheld rather than guessed.
  const authState = useDesktopAuthOptional()?.state ?? null;
  const { identity } = useDesktopIdentity(
    authState?.status ?? DesktopAuthStatus.SignedOut,
    authState?.userId ?? null
  );
  const { origin: webAppOrigin } = useWebAppOrigin();
  const organizationSlug = identity?.organizationSlug ?? null;
  // Null while either input is unresolved, which withholds the action rather
  // than offering a link that would 404. The org slug must come from whichever
  // cloud this desktop is configured against, never a hardcoded host.
  const connectedDevicesHref =
    organizationSlug && webAppOrigin
      ? `${webAppOrigin}/${organizationSlug}${buildSettingsPanelRoute({
          panel: SettingsPanelId.ConnectedDevices,
        })}`
      : null;
  return (
    <Alert variant="destructive">
      <LinkIcon aria-hidden="true" className="size-4" />
      <AlertTitle>{COMPUTE_TARGET_LINK_BLOCK_TITLE}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          Your workspace is not accepting this machine&apos;s compute target, so
          uploads have stopped. Nothing captured locally has been lost, and none
          of it is reaching the cloud. Link this machine to the account you are
          signed in to to resume syncing.
        </p>
        {connectedDevicesHref === null ? null : (
          <Button asChild size="sm" variant="outline">
            <a href={connectedDevicesHref} rel="noreferrer" target="_blank">
              {COMPUTE_TARGET_LINK_BLOCK_ACTION_LABEL}
            </a>
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
