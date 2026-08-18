import type { SessionDetail } from "./mock-detail";

// Prototype-local session presentation pending a separate Sessions review.

const ACTOR_COLOR_TOKENS = [
  "var(--chart-1)",
  "var(--chart-5)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-2)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
  "var(--chart-9)",
  "var(--chart-10)",
] as const;
const PERSON_NAME_PARTS_PATTERN = /\s+/;

export type SessionActorColors = {
  base: string;
  soft: string;
  strong: string;
};

export type SessionActorEntry = {
  colors: SessionActorColors;
  id: string;
  initials: string;
  name: string;
};

function actorColors(index: number): SessionActorColors {
  const base =
    ACTOR_COLOR_TOKENS[index % ACTOR_COLOR_TOKENS.length] ??
    ACTOR_COLOR_TOKENS[0];
  return {
    base,
    soft: `color-mix(in oklch, ${base} 62%, var(--background))`,
    strong: `color-mix(in oklch, ${base} 84%, var(--foreground))`,
  };
}

function initials(name: string): string {
  return name
    .split(PERSON_NAME_PARTS_PATTERN)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function sessionActorId(
  actorId: string | undefined,
  actorName: string | undefined,
  fallbackName: string
): string {
  return actorId ?? actorName ?? fallbackName;
}

export function buildSessionActorEntries(
  detail: SessionDetail
): SessionActorEntry[] {
  const actors = new Map<
    string,
    { id: string; initials: string; name: string }
  >();
  const addActor = (
    actorId: string | undefined,
    actorName: string | undefined,
    actorInitials: string | undefined
  ) => {
    const name = actorName ?? detail.ownerName;
    const id = sessionActorId(actorId, actorName, detail.ownerName);
    if (!actors.has(id)) {
      actors.set(id, {
        id,
        initials: actorInitials ?? initials(name),
        name,
      });
    }
  };

  for (const event of detail.costEvents) {
    addActor(event.actorId, event.actorName, event.actorInitials);
  }
  for (const turn of detail.trace) {
    if (turn.kind !== "idle") {
      addActor(turn.actorId, turn.actorName, turn.actorInitials);
    }
  }
  if (actors.size === 0) {
    addActor(undefined, detail.ownerName, undefined);
  }

  return [...actors.values()].map((actor, index) => ({
    ...actor,
    colors: actorColors(index),
  }));
}
