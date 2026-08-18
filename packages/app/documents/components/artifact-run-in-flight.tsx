"use client";

/**
 * The in-flight treatment for an artifact with an active generation run.
 *
 * ISS-5474 removed every user-facing run-state treatment from artifact surfaces
 * and deliberately declined to invent a replacement; ISS-5508 then added the
 * narrowest possible thing, a sentence explaining ONE disabled control, with no
 * identity, status, link, or Loop noun. This goes further on purpose and ships
 * behind a flag, default off, because the gap those tickets left is real: a
 * freshly created artifact with a run against it renders as a blank page, and
 * nothing on the page says work is happening or where to watch it.
 *
 * WHAT IT MUST NOT SAY. The active set behind `isActiveGenerationStatus` is
 * `PENDING | QUEUED | RUNNING`, and `mapLoopStatus` folds BOTH `LoopStatus.Pending`
 * and `LoopStatus.Blocked` onto `PENDING` — so a run deferred behind an
 * unapproved dependency is "active" while `startedAt` is null and no work has
 * begun. Claiming it is running would assert execution the system cannot back,
 * on exactly the state a user is most likely to sit in. The copy therefore
 * branches on `startedAt` rather than using one blanket phrase.
 *
 * "run" and "session" are the nouns; "Loop" is not a user-facing concept
 * (ISS-4477).
 */

import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import type { GenerationStatus } from "@repo/api/src/types/document";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@repo/design-system/components/ui/empty";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { ArrowRightIcon, Loader2Icon } from "lucide-react";
import { loopCommandLabels } from "../../shared/components/status-badge";
import { formatRelativeTime } from "../../shared/lib/date-utils";
import { isRunInFlight } from "../lib/generation-status-utils";

/**
 * `GenerationStatus.command` (the lowercase run-loop vocabulary) to the
 * uppercase `LoopCommand` whose canonical label the treatment renders.
 *
 * Written out rather than derived by uppercasing, because nothing enforces that
 * the two vocabularies stay case transforms of each other and they already do
 * not line up: this union carries `chat` and `explore` while omitting
 * `bootstrap` and `manual`, both of which `LoopCommand` has. An exhaustive
 * `Record` over the closed union means adding a member fails `tsc` here instead
 * of silently degrading a real command to the generic noun at the user.
 */
const RUN_LABEL_COMMANDS: Record<
  NonNullable<GenerationStatus["command"]>,
  LoopCommand
> = {
  plan: LoopCommand.Plan,
  execute: LoopCommand.Execute,
  chat: LoopCommand.Chat,
  request_changes: LoopCommand.RequestChanges,
  request_prd_changes: LoopCommand.RequestPrdChanges,
  generate_prd: LoopCommand.GeneratePrd,
  explore: LoopCommand.Explore,
  decompose: LoopCommand.Decompose,
  evaluate_prd: LoopCommand.EvaluatePrd,
  evaluate_plan: LoopCommand.EvaluatePlan,
  evaluate_code: LoopCommand.EvaluateCode,
  evaluate_feature: LoopCommand.EvaluateFeature,
};

/**
 * The command's label, read from the canonical map rather than re-typed.
 *
 * A command the map does not know — a version-skewed server sending a member
 * this build has never heard of — degrades to a generic noun instead of
 * rendering a raw enum at the user.
 */
function runLabel(command: GenerationStatus["command"]): string {
  if (!command) {
    return "Run";
  }
  const loopCommand = RUN_LABEL_COMMANDS[command];
  return loopCommand ? loopCommandLabels[loopCommand] : "Run";
}

function formatInitiator(
  initiatedBy: GenerationStatus["initiatedBy"]
): string | null {
  if (!initiatedBy) {
    return null;
  }
  const name = [initiatedBy.firstName, initiatedBy.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name.length > 0 ? name : null;
}

type RunDetailProps = {
  generationStatus: GenerationStatus;
};

/**
 * The one-line state, which is the part that must stay honest.
 *
 * A started run gets its elapsed time. A run that has not started gets
 * "Queued" and no timestamp, because there is no queued-at on the contract and
 * inventing one from `startedAt` would print the wrong number.
 *
 * The elapsed clause carries `aria-live="off"`. The treatment as a whole is a
 * polite live region so it is ANNOUNCED when it appears, but a polite region
 * re-announces on every content change, and this clause ticks over once a
 * minute for the ten-to-twenty minutes the run lasts — a screen-reader user
 * would hear the whole sentence read back at them fifteen times. Suppressing
 * updates for that one span keeps the appearance announcement and drops the
 * repeat.
 */
function RunDetail({ generationStatus }: Readonly<RunDetailProps>) {
  const who = formatInitiator(generationStatus.initiatedBy);
  const by = who ? ` by ${who}` : "";
  if (!generationStatus.startedAt) {
    return <>{`Queued${by}`}</>;
  }
  return (
    <>
      {"Started "}
      <span aria-live="off">
        {formatRelativeTime(generationStatus.startedAt)}
      </span>
      {by}
    </>
  );
}

type SessionLinkProps = {
  orgSlug: string;
  sessionArtifactId: string;
  label: string;
};

/**
 * The link to the work itself.
 *
 * Rendered only when there is something to link to — see the call sites, which
 * branch on `sessionArtifactId` rather than on this element, since a JSX
 * element is always truthy and a `link ? … : null` ternary would keep the
 * wrapper (and its column gap) around nothing. `sessionArtifactId` is written
 * after the run starts, so an active generation legitimately has none for its
 * first moments. A disabled or dead "View session" would be worse than no link:
 * it tells the user there is somewhere to go and then refuses to take them.
 */
function SessionLink({
  orgSlug,
  sessionArtifactId,
  label,
}: Readonly<SessionLinkProps>) {
  return (
    <Link
      aria-label={`View the session for this ${label} run`}
      className="inline-flex items-center gap-1 font-medium text-sm hover:underline"
      href={`/${orgSlug}/sessions/${sessionArtifactId}`}
    >
      View session
      <ArrowRightIcon aria-hidden="true" className="size-3.5" />
    </Link>
  );
}

type ArtifactRunInFlightProps = {
  generationStatus: GenerationStatus | undefined;
  orgSlug: string;
  /**
   * `panel` takes the content area, for an artifact with nothing to read yet.
   * `banner` sits above existing content and never hides it — these runs take
   * ten to twenty minutes, and blocking a readable artifact for that long to
   * announce a background job is a worse trade than the announcement is worth.
   */
  variant: "panel" | "banner";
  className?: string;
};

/**
 * Renders nothing when no run is active, so call sites can mount it
 * unconditionally.
 *
 * `role="status"` so the treatment is announced when it appears rather than
 * only being seen: a user who pressed Generate and is watching the page is
 * exactly the person who needs to know it took.
 */
export function ArtifactRunInFlight({
  generationStatus,
  orgSlug,
  variant,
  className,
}: Readonly<ArtifactRunInFlightProps>) {
  if (!(generationStatus && isRunInFlight(generationStatus))) {
    return null;
  }
  const label = runLabel(generationStatus.command);
  const { sessionArtifactId } = generationStatus;
  const detail = <RunDetail generationStatus={generationStatus} />;

  if (variant === "banner") {
    return (
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/40 px-4 py-2",
          className
        )}
        role="status"
      >
        <Loader2Icon
          aria-hidden="true"
          className="size-4 shrink-0 animate-spin text-muted-foreground"
        />
        <span className="font-medium text-sm">{label}</span>
        <span className="text-muted-foreground text-sm">{detail}</span>
        {sessionArtifactId ? (
          <span className="ml-auto">
            <SessionLink
              label={label}
              orgSlug={orgSlug}
              sessionArtifactId={sessionArtifactId}
            />
          </span>
        ) : null}
      </div>
    );
  }

  // Composed from the same DS primitives `EmptyState` is built from rather than
  // calling `EmptyState` itself: that wrapper renders its icon with a fixed
  // `size-6` and no way to animate it, and the motion is the point here -- a
  // static glyph reads as "nothing is happening", which is the opposite of the
  // state. Composing keeps its spacing and type steps instead of re-declaring
  // them.
  return (
    <Empty className={cn("py-12", className)} role="status">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Loader2Icon aria-hidden="true" className="size-6 animate-spin" />
        </EmptyMedia>
        <EmptyTitle>{label}</EmptyTitle>
        <EmptyDescription>{detail}</EmptyDescription>
      </EmptyHeader>
      {sessionArtifactId ? (
        <EmptyContent>
          <SessionLink
            label={label}
            orgSlug={orgSlug}
            sessionArtifactId={sessionArtifactId}
          />
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
