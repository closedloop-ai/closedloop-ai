export type TracePositionAnchor = {
  minutes: number;
  row: number;
  y: number;
};

export function nextScrollFollowY(
  currentY: number,
  targetY: number,
  elapsedMs: number,
  maxVelocityPxPerSecond: number,
  timeConstantMs = 90
): number {
  const delta = targetY - currentY;
  if (Math.abs(delta) <= 0.5) {
    return targetY;
  }
  const safeElapsedMs = Math.max(1, elapsedMs);
  const easedStep = delta * (1 - Math.exp(-safeElapsedMs / timeConstantMs));
  const maxStep = Math.max(1, maxVelocityPxPerSecond) * (safeElapsedMs / 1000);
  const step = Math.max(-maxStep, Math.min(maxStep, easedStep));
  return Math.abs(step) >= Math.abs(delta) ? targetY : currentY + step;
}

export function interpolateMinutesAtY(
  anchors: readonly TracePositionAnchor[],
  y: number
): number {
  const [before, after] = surroundingAnchors(anchors, y, "y");
  return interpolateAnchorValue(
    before.y,
    after.y,
    before.minutes,
    after.minutes,
    y
  );
}

export function interpolateYAtMinutes(
  anchors: readonly TracePositionAnchor[],
  minutes: number
): number {
  const [before, after] = surroundingAnchors(anchors, minutes, "minutes");
  return interpolateAnchorValue(
    before.minutes,
    after.minutes,
    before.y,
    after.y,
    minutes
  );
}

export function nearestAnchorAtY(
  anchors: readonly TracePositionAnchor[],
  y: number
): TracePositionAnchor {
  const [before, after] = surroundingAnchors(anchors, y, "y");
  return Math.abs(y - before.y) <= Math.abs(after.y - y) ? before : after;
}

function surroundingAnchors(
  anchors: readonly TracePositionAnchor[],
  value: number,
  key: "minutes" | "y"
): [TracePositionAnchor, TracePositionAnchor] {
  const first = anchors[0];
  const last = anchors.at(-1);
  if (!(first && last)) {
    throw new Error("At least one trace position anchor is required");
  }
  if (value <= first[key]) {
    return [first, first];
  }
  if (value >= last[key]) {
    return [last, last];
  }
  let low = 0;
  let high = anchors.length - 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    const anchor = anchors[middle];
    if (anchor && anchor[key] <= value) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return [
    anchors[low] as TracePositionAnchor,
    anchors[high] as TracePositionAnchor,
  ];
}

function interpolateAnchorValue(
  inputStart: number,
  inputEnd: number,
  outputStart: number,
  outputEnd: number,
  value: number
): number {
  if (inputEnd === inputStart) {
    return outputStart;
  }
  const progress = Math.max(
    0,
    Math.min(1, (value - inputStart) / (inputEnd - inputStart))
  );
  return outputStart + (outputEnd - outputStart) * progress;
}
