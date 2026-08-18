import type { TurnActor } from "@repo/api/src/types/agent-session";
import { getInitials } from "@repo/app/shared/lib/user-utils";
import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import type { BranchActorColorDomain } from "../lib/branch-actor-domain";

type BranchTraceActorAvatarProps = {
  actor: TurnActor;
  actorDomain: BranchActorColorDomain;
};

/** Branch-only actor identity for the shared Session trace gutter. */
export function BranchTraceActorAvatar({
  actor,
  actorDomain,
}: BranchTraceActorAvatarProps) {
  const name =
    actor.name ?? actor.human ?? actor.harness ?? actorDomain.labelFor(null);
  const colors = actorDomain.colorPairFor(name);

  return (
    <Avatar aria-label={name} className="size-6" title={name}>
      <AvatarFallback
        className="font-medium text-[0.625rem]"
        style={{ background: colors.soft, color: colors.strong }}
      >
        {getInitials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
