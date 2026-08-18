"use client";

import { GitHubConnectReturnStatus } from "@repo/api/src/types/github-status";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { cn } from "@repo/design-system/lib/utils";

/**
 * Which branch surface renders the notice, selecting only its chrome:
 * - `list` — the branches table header, a rounded inline card (the `Alert`
 *   default chrome).
 * - `detail` — the branch detail view, a full-width bottom-border banner.
 *
 * The copy is identical across variants; the variant picks chrome only.
 */
export const GitHubConnectReturnVariant = {
  List: "list",
  Detail: "detail",
} as const;
export type GitHubConnectReturnVariant =
  (typeof GitHubConnectReturnVariant)[keyof typeof GitHubConnectReturnVariant];

type NoticeContent = {
  variant: "success" | "error";
  message: string;
  /**
   * `connected` is a passive confirmation, so it announces politely via
   * `role="status"` / `aria-live="polite"`; `error` omits these so it keeps
   * `Alert`'s default assertive `role="alert"`.
   */
  polite?: boolean;
};

const NOTICE_CONTENT: Record<GitHubConnectReturnStatus, NoticeContent> = {
  [GitHubConnectReturnStatus.Connected]: {
    variant: "success",
    message: "GitHub is connected. Branch data is refreshing.",
    polite: true,
  },
  [GitHubConnectReturnStatus.Error]: {
    variant: "error",
    message: "GitHub did not connect. Local branch data is still available.",
  },
};

// The `detail` surface wants a full-width bottom-border banner rather than the
// `Alert` default rounded card, so it drops the rounding/all-around border and
// swaps in a bottom border with the detail-view horizontal padding.
const VARIANT_CLASS_NAME: Record<GitHubConnectReturnVariant, string> = {
  [GitHubConnectReturnVariant.List]: "",
  [GitHubConnectReturnVariant.Detail]:
    "rounded-none border-x-0 border-t-0 px-4",
};

function isNoticeStatus(
  status: string | null
): status is GitHubConnectReturnStatus {
  return (
    status === GitHubConnectReturnStatus.Connected ||
    status === GitHubConnectReturnStatus.Error
  );
}

/**
 * Post-OAuth GitHub connect/return banner shared by the web branches list and
 * detail pages. Routes both the connected and error states through the shared
 * design-system `Alert` (`success`/`error` variants) so they track the theme
 * via semantic tokens instead of the raw `emerald`/`red` Tailwind scales the
 * pages previously hand-rolled (FEA-4067). Statuses come from the canonical
 * `GitHubConnectReturnStatus` contract that the OAuth callback writer sets.
 */
export function GitHubConnectReturnNotice({
  status,
  variant = GitHubConnectReturnVariant.List,
}: {
  status: string | null;
  variant?: GitHubConnectReturnVariant;
}) {
  if (!isNoticeStatus(status)) {
    return null;
  }
  const content = NOTICE_CONTENT[status];
  // Only the passive success case overrides `Alert`'s default assertive
  // `role="alert"`; the error case passes neither so the default stands.
  const politeProps = content.polite
    ? { role: "status" as const, "aria-live": "polite" as const }
    : {};
  return (
    <Alert
      className={cn(VARIANT_CLASS_NAME[variant])}
      variant={content.variant}
      {...politeProps}
    >
      <AlertDescription>{content.message}</AlertDescription>
    </Alert>
  );
}
