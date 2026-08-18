"use client";

import type { AgentSessionLastSyncTarget } from "@repo/api/src/types/agent-session";
import { ComputeTargetSyncTable } from "@repo/app/compute/components/compute-target-sync-table";
import { formatRelativeTime } from "@repo/app/shared/lib/date-utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Separator } from "@repo/design-system/components/ui/separator";
import {
  ArrowRightIcon,
  Clock3Icon,
  FolderGit2Icon,
  HardDriveDownloadIcon,
} from "lucide-react";
import type { ReactNode } from "react";

/**
 * ISS-4828: the Compute Target Freshness card's description.
 *
 * Orients, and leaves the specifics to the column headers, which is the register
 * its sibling cards use ("Token usage and cost by model.").
 *
 * ISS-5280 (review) replaced the previous line — "Last successful sync per
 * compute target, even when there was nothing new to send." — for two reasons.
 * It argued the ISS-4828 bug fix rather than describing the card, which only
 * lands for a reader who already knows the old behaviour was wrong; and it made
 * a claim about ONE column that the fallback in {@link resolveLastSyncLabel}
 * cannot always honour. When a version-skewed producer omits the accepted-sync
 * field, "Last Sync" falls back to the landed-data watermark, which ISS-4678
 * narrowed so that it does NOT advance on an accepted zero-row batch — so on
 * exactly those rows the old description asserted the opposite of what the value
 * measures. A description that names no single column cannot go stale that way.
 */
const FRESHNESS_CARD_DESCRIPTION = "Sync freshness per compute target.";

const NEVER_SYNCED_LABEL = "Never";

export function ContextCards({
  targets,
}: Readonly<{
  targets: AgentSessionLastSyncTarget[];
}>): ReactNode {
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock3Icon className="h-4 w-4" />
            Compute Target Freshness
          </CardTitle>
          <CardDescription>{FRESHNESS_CARD_DESCRIPTION}</CardDescription>
        </CardHeader>
        <CardContent>
          <ComputeTargetSyncTable
            rows={targets.map((target) => ({
              id: target.computeTargetId,
              lastSeenLabel: formatRelativeTime(target.lastSeenAt),
              lastDataLabel: resolveLastDataLabel(target),
              lastSyncLabel: resolveLastSyncLabel(target),
              machineName: target.machineName,
              online: target.isOnline,
              ownerLabel: resolveOwnerLabel(target.owner),
            }))}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FolderGit2Icon className="h-4 w-4" />
            Working Context
          </CardTitle>
          <CardDescription>
            The monitoring view preserves repository and worktree hints from the
            desktop sync.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="flex items-start gap-3">
            <HardDriveDownloadIcon className="mt-0.5 h-4 w-4 text-muted-foreground" />
            <div>
              <div className="font-medium">Historical backfill</div>
              <p className="text-muted-foreground">
                Once a compute target reconnects, historical sessions are
                backfilled into the org view automatically.
              </p>
            </div>
          </div>
          <Separator />
          <div className="flex items-start gap-3">
            <ArrowRightIcon className="mt-0.5 h-4 w-4 text-muted-foreground" />
            <div>
              <div className="font-medium">Session detail</div>
              <p className="text-muted-foreground">
                Open any session row to inspect token usage, agents, and the
                event timeline captured from the desktop monitor.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * ISS-4828: the value behind the card's "Last Sync" column.
 *
 * `lastAgentSessionSyncAttemptAt` — the last batch the cloud ACCEPTED (ISS-4827),
 * which is what "last successful sync" has always claimed to mean. It supersedes
 * `lastAgentSessionSyncAt`, the LANDED-DATA watermark that ISS-4678 narrowed so
 * that an accepted batch carrying zero rows no longer advances it. That
 * narrowing is why the card could render "online · last seen 20s ago · last sync
 * 3 days ago" for a target that was in fact syncing perfectly well with nothing
 * new to send.
 *
 * The accepted-sync field is optional on the wire (a version-skewed producer, or
 * the desktop's local usage summary, may omit it), so an absent value falls back
 * to the landed-data watermark rather than regressing a populated row to
 * "Never" — a target can never look LESS synced than it did before ISS-4828.
 */
function resolveLastSyncLabel(target: AgentSessionLastSyncTarget): string {
  const timestamp =
    target.lastAgentSessionSyncAttemptAt ?? target.lastAgentSessionSyncAt;
  return timestamp ? formatRelativeTime(timestamp) : NEVER_SYNCED_LABEL;
}

/**
 * ISS-4828 (review, PR #4256): the value behind the card's "Last New Data"
 * column — `lastAgentSessionSyncAt`, when session rows from this target last
 * LANDED.
 *
 * "Last Sync" is the accepted-batch watermark; without this companion column the
 * landed-data signal — "is this machine actually sending anything?" — would
 * leave the screen entirely, and the two questions the card exists to answer
 * would collapse into one.
 */
function resolveLastDataLabel(target: AgentSessionLastSyncTarget): string {
  return target.lastAgentSessionSyncAt
    ? formatRelativeTime(target.lastAgentSessionSyncAt)
    : NEVER_SYNCED_LABEL;
}

function resolveOwnerLabel(owner: AgentSessionLastSyncTarget["owner"]): string {
  return (
    [owner.firstName, owner.lastName].filter(Boolean).join(" ") || owner.email
  );
}
