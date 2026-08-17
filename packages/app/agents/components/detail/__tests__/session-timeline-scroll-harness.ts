import type {
  ActivityBucket,
  TurnItem,
} from "@repo/api/src/types/agent-session";

/**
 * Shared fixtures for the Session Timeline → transcript scroll suites.
 *
 * Extracted for ISS-5124, which adds a second suite over the same three shapes
 * (a persisted activity bucket, a DB-projection prompt row, and the
 * scroll-aware rect stub that makes "did the transcript actually move?"
 * answerable in jsdom). Copying them would have put the harness that DEFINES
 * the behavioral witness in two files, where the two copies can drift and one
 * suite starts silently proving something the other does not.
 */

/** A persisted cost bucket, defaulted to the costed/jumpable shape. */
export function makeTimelineBucket(
  overrides: Partial<ActivityBucket> & Pick<ActivityBucket, "label" | "tl0">
): ActivityBucket {
  return {
    cIn: 0.5,
    cOut: 0.3,
    cCache: 0.1,
    total: 1,
    toolStart: 0,
    byModel: { "gpt-5.5": { cIn: 0.5, cOut: 0.3, cCache: 0.1 } },
    ...overrides,
  };
}

/**
 * A DB-projection prompt turn. Carries NO `transcriptIdentity`, exactly like a
 * real projection that minted different ids than the cloud parser, so a
 * translation has to fall back to nearest-time.
 *
 * `t` is taken verbatim rather than validated: ISS-5124's shape is a projection
 * whose rows carry no PARSEABLE instant, which is precisely what makes
 * `alignBucketRowsToTranscript` unable to repair the buckets pointed at them.
 *
 * `tMs` therefore DEFAULTS to `Date.parse(options.t)` — including the `NaN` an
 * untimed row yields — rather than being left off. The `prompt` variant of
 * `TurnItem` declares `tMs: number` as REQUIRED, so an optional field forced
 * through with `as TurnItem` would have built a shape the production projection
 * cannot emit, and it routed `getTurnItemMs` down its `t`-reparsing fallback
 * instead of the `typeof item.tMs === "number"` branch a real row takes. Both
 * branches answer `NaN` here, so the suites' verdicts are unchanged — but the
 * fixture now proves the demotion against the shape production actually
 * produces, and the removed cast means a future divergence in `TurnItem` fails
 * typecheck rather than being silently absorbed.
 */
export function makeDbPromptRow(options: {
  row: number;
  sessionId: string;
  t: string;
  text: string;
  tMs?: number;
}): TurnItem {
  return {
    type: "prompt",
    _row: options.row,
    t: options.t,
    tMs: options.tMs ?? Date.parse(options.t),
    cum: 0,
    actor: {
      name: null,
      sessionId: options.sessionId,
      human: "Ada",
      color: "#000",
    },
    text: options.text,
  };
}

/**
 * An assistant response turn, the counterpart to {@link makeDbPromptRow}.
 *
 * ISS-5843 needed this: `buildTraceGroups` coalesces consecutive turns that
 * share a `side` and an `actor.sessionId`, so a fixture of back-to-back prompts
 * renders as ONE `[data-row]` anchor and every timeline jump lands on it. A
 * suite asserting WHERE a click lands cannot use a transcript with one landable
 * row, so alternate this with prompts to get one anchor per turn — the shape a
 * real conversation has anyway.
 */
export function makeDbSayRow(options: {
  row: number;
  sessionId: string;
  t: string;
  text: string;
  tMs?: number;
}): TurnItem {
  return {
    type: "say",
    _row: options.row,
    t: options.t,
    tMs: options.tMs ?? Date.parse(options.t),
    cum: 0,
    actor: {
      name: "assistant",
      sessionId: options.sessionId,
      human: "Ada",
      color: "#000",
    },
    text: options.text,
  };
}

/**
 * Lay the rendered rows out 1000px apart and let each rect track
 * `scroller.scrollTop`, exactly as a real layout does. A fixed-rect stub cannot
 * express "the anchor is already where we are" — it reports the same offset no
 * matter where the scroller sits, so every click looks like a scroll. This one
 * reproduces the reported symptom: a second click that resolves onto the anchor
 * already in place computes a ~0 delta and does not move.
 */
export function stubScrollAwareRowRects(scroller: HTMLElement): void {
  const rows = [...document.querySelectorAll<HTMLElement>(".st [data-row]")];
  rows.forEach((row, index) => {
    const layoutTop = index * 1000;
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        const top = layoutTop - scroller.scrollTop;
        return {
          top,
          left: 0,
          width: 800,
          height: 24,
          bottom: top + 24,
          right: 800,
          x: 0,
          y: top,
          toJSON() {
            /* jsdom rect stub */
          },
        };
      },
    });
  });
}
