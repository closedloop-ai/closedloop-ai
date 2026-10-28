"use client";

import type { ReactNode } from "react";
import type { GitHubConnectTarget } from "../../github/lib/github-connect-target";
import { GatedMetricIndicatorVariant } from "../../shared/components/gated-metric-indicator";
import {
  BranchesStallCtaKind,
  type BranchesStallCtaSignals,
  DEFAULT_BRANCHES_STALL_CTA_SIGNALS,
  resolveBranchesStallCta,
} from "../lib/branches-stall-cta";
import {
  ConnectGitHubIndicator,
  GitHubConnectScope,
} from "./connect-github-indicator";

/**
 * ISS-10645 — everything a host has to hand the stalled-load slot, in one prop,
 * so the surfaces below it carry one optional capability rather than three.
 */
export type BranchesStallCta = {
  /** What the host observed. @see resolveBranchesStallCta */
  signals?: BranchesStallCtaSignals;
  /**
   * The shell's own sign-up control, rendered only when the reader has no
   * account. Guest mode is shell-local machinery (the desktop's
   * `useRequestGuestAccount`), so the control is the host's to supply; WHETHER
   * it is asked for is decided here, once.
   */
  createAccountAction?: ReactNode;
  /**
   * Where this shell's connect flow goes, resolved the way that shell already
   * resolves it. One value rather than an href plus a handler: the wrong pairing
   * is the FEA-3280 dead click, and ISS-5958 made it a compile error.
   */
  githubConnect?: GitHubConnectTarget;
  /**
   * What this shell's connect handoff DID, rendered under the ask that started
   * it (ISS-11274).
   *
   * The host's, because only the host knows: the desktop leg is two IPC calls
   * whose terminal states (`SignInRequired`, `Failed`) settle in the renderer
   * with nothing else on screen to show them, while a web host navigates away
   * and has no outcome to report. Without this the desktop click is the
   * silent-no-op regression `useDesktopGitHubConnect` exists to prevent — a
   * failed handoff indistinguishable from no handoff at all.
   */
  connectOutcome?: ReactNode;
};

/**
 * The stalled Branches load's one way-out slot.
 *
 * Renders `null` for a reader who has already done everything the listing asks,
 * leaving the shared ladder's Retry as the whole treatment — the same thing the
 * Sessions listing shows, which is the point.
 */
export function BranchesStallCtaSlot({
  connectOutcome,
  createAccountAction,
  githubConnect,
  signals = DEFAULT_BRANCHES_STALL_CTA_SIGNALS,
}: BranchesStallCta) {
  const kind = resolveBranchesStallCta(signals);
  if (kind === BranchesStallCtaKind.CreateAccount) {
    return <>{createAccountAction}</>;
  }
  if (kind === BranchesStallCtaKind.ConnectGitHub) {
    return (
      <div className="flex min-w-0 flex-col items-stretch gap-2">
        <ConnectGitHubIndicator
          connect={githubConnect}
          scope={GitHubConnectScope.List}
          variant={GatedMetricIndicatorVariant.Centered}
        />
        {connectOutcome}
      </div>
    );
  }
  return null;
}
