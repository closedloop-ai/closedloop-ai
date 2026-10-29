export const TimelineMarkerSemantic = {
  HumanSteering: "human-steering",
  Delivery: "delivery",
  FailureLimit: "failure-limit",
} as const;

export type TimelineMarkerSemantic =
  (typeof TimelineMarkerSemantic)[keyof typeof TimelineMarkerSemantic];

export const TIMELINE_MARKER_SEMANTIC_ORDER = [
  TimelineMarkerSemantic.HumanSteering,
  TimelineMarkerSemantic.Delivery,
  TimelineMarkerSemantic.FailureLimit,
] as const satisfies readonly TimelineMarkerSemantic[];

export function getTimelineMarkerSemanticLabel(
  semantic: TimelineMarkerSemantic
): string {
  if (semantic === TimelineMarkerSemantic.Delivery) {
    return "Commits & PRs";
  }
  if (semantic === TimelineMarkerSemantic.FailureLimit) {
    return "Failures & limits";
  }
  return "Human steering";
}

export function getTimelineMarkerSemanticToken(
  semantic: TimelineMarkerSemantic
): string {
  if (semantic === TimelineMarkerSemantic.Delivery) {
    return "var(--success)";
  }
  if (semantic === TimelineMarkerSemantic.FailureLimit) {
    return "var(--destructive)";
  }
  return "var(--primary)";
}

export function getTimelineMarkerSemanticSort(
  semantic: TimelineMarkerSemantic
): number {
  const index = TIMELINE_MARKER_SEMANTIC_ORDER.indexOf(semantic);
  return index === -1 ? TIMELINE_MARKER_SEMANTIC_ORDER.length : index;
}
