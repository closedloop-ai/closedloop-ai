import type { TurnActor } from "@repo/api/src/types/agent-session";
import { getInitials } from "@repo/app/shared/lib/user-utils";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { UNATTRIBUTED_ACTOR_LABEL } from "../lib/branch-actor-domain";

type BranchTraceActorAvatarProps = {
  actor: TurnActor;
  /**
   * The actor's photo, when the host resolved a real person (ISS-12666). The
   * initials stay mounted underneath, so a missing or failed image shows them.
   */
  imageUrl?: string | null;
};

/**
 * Actor identity for the shared Session trace gutter, on the Branch combined
 * trace and (ISS-12666) the standalone Session trace. `role="img"` lets the
 * actor's name reach assistive technology; a bare span cannot carry one.
 * It draws one initial on the shared avatar colours (Nerys, 2026-10-22);
 * the actor's colour stays on the timeline and its legend.
 */
export function BranchTraceActorAvatar({
  actor,
  imageUrl,
}: BranchTraceActorAvatarProps) {
  const name =
    actor.name ?? actor.human ?? actor.harness ?? UNATTRIBUTED_ACTOR_LABEL;

  return (
    <Avatar aria-label={name} className="size-6" role="img" title={name}>
      <AvatarImage alt="" src={imageUrl || undefined} />
      <AvatarFallback className="text-[0.625rem]">
        {getInitials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
