import { screen } from "@testing-library/react";

/**
 * What the session-detail Properties pane's Branch row was at one commit.
 *
 * Tri-state on purpose. `absent` and `text` both answer "no href", and
 * collapsing them is how a pane that never rendered at all passes for a row that
 * correctly withheld its link — the vacuous pass an inertness check exists to
 * rule out.
 */
export type BranchRowSample =
  | { kind: "absent" }
  | { kind: "text" }
  | {
      kind: "link";
      href: string;
      /**
       * WHICH anchor element this is, counting from 1.
       *
       * Identity, not just destination. The regression these checks guard is a
       * focused anchor being unmounted out from under the keyboard, and an
       * anchor that is destroyed and rebuilt with the same `href` does exactly
       * that while looking identical to a reader that only compares hrefs. React
       * reuses the DOM node across ordinary re-renders, so this only moves when
       * the element genuinely went away — including when it went away and came
       * back inside a single observer batch, which is otherwise invisible.
       */
      anchor: number;
    };

export type BranchRowWatcher = {
  /**
   * Every state the row has been in since the watcher started, in order, with
   * consecutive duplicates collapsed — so a row that never moved is exactly one
   * entry and any retraction is a second one the failure diff prints.
   */
  samples: () => BranchRowSample[];
};

/**
 * Live observers, disconnected together by {@link stopBranchRowWatchers}.
 *
 * Teardown is centralised rather than left to a `stop()` at the end of each
 * test, because the line that would call it sits AFTER the assertions — so the
 * one run that matters, the failing one, is exactly the run that would leak an
 * observer into every test after it.
 */
const liveObservers = new Set<MutationObserver>();

/** Disconnect every watcher this file started. Call from `afterEach`. */
export function stopBranchRowWatchers(): void {
  for (const observer of liveObservers) {
    observer.disconnect();
  }
  liveObservers.clear();
}

/**
 * Records the Branch row on every DOM commit rather than on a timer.
 *
 * This replaces the `setTimeout(10)` poll loops that used to stand in for "the
 * settled link never retracts" (ISS-7606). Those loops were wrong twice over: a
 * fixed wall-clock window is the banned shape for proving a non-occurrence, and
 * a sampled loop can only see the row at the instants it happens to run, so a
 * retraction that lands and recovers between two samples was invisible to the
 * very check written to catch it. This sees every state the row passes through.
 *
 * It reads no clock at all. `takeRecords()` drains the observer's queue
 * synchronously, so a caller that has already flushed React (`act`) has by
 * construction already flushed this — there is nothing left to wait for.
 *
 * MutationObserver batches, so two commits delivered in the same microtask turn
 * are sampled once, at the later state. That would hide a link that retracts and
 * is restored within one batch — the focus-loss regression, wearing the clothes
 * of no change at all — which is why the link sample carries the anchor's
 * IDENTITY (`anchor`) and not only its `href`: a destroyed-and-rebuilt anchor
 * bumps that counter even when the final DOM is byte-identical. Its own
 * self-test drives that case directly.
 *
 * The one thing still outside its reach is an anchor that keeps the same element
 * and merely takes an interim `href` mid-batch. That is not a retraction, and
 * the final value it settles on is sampled either way.
 */
export function watchBranchRow(labelPattern: RegExp): BranchRowWatcher {
  const recorded: BranchRowSample[] = [];
  let seenAnchor: Element | null = null;
  let anchorCount = 0;
  const record = () => {
    const element = currentAnchor(labelPattern);
    if (element !== null && element !== seenAnchor) {
      anchorCount += 1;
    }
    seenAnchor = element;
    const next = sampleBranchRow(labelPattern, anchorCount);
    const previous = recorded.at(-1);
    if (!(previous && isSameSample(previous, next))) {
      recorded.push(next);
    }
  };
  record();
  const observer = new MutationObserver(record);
  liveObservers.add(observer);
  observer.observe(document.body, {
    attributeFilter: ["href"],
    attributes: true,
    childList: true,
    subtree: true,
  });
  return {
    samples: () => {
      // The observer delivers on a microtask, so a caller asserting straight
      // after `act` would otherwise read a queue whose callback has not run yet.
      // Draining it here is what makes the history synchronous and complete.
      if (observer.takeRecords().length > 0) {
        record();
      }
      return [...recorded];
    },
  };
}

function sampleBranchRow(
  labelPattern: RegExp,
  anchor: number
): BranchRowSample {
  const row = currentRow(labelPattern);
  if (!row) {
    return { kind: "absent" };
  }
  const href = currentAnchor(labelPattern)?.getAttribute("href");
  return href === undefined || href === null
    ? { kind: "text" }
    : { anchor, href, kind: "link" };
}

function currentRow(labelPattern: RegExp): Element | null {
  // `queryAllByText` rather than `queryByText`: the single-match variant THROWS
  // on a duplicate, and a throw inside the observer callback is swallowed by the
  // microtask that runs it, which would silently stop the recording.
  const [label] = screen.queryAllByText(labelPattern);
  return label?.closest("div") ?? null;
}

/**
 * `a[href]` is what `getByRole("link")` resolves to, so this agrees with the
 * suite's own `branchRowHref` reader about what counts as a link.
 */
function currentAnchor(labelPattern: RegExp): Element | null {
  return currentRow(labelPattern)?.querySelector("a[href]") ?? null;
}

function isSameSample(left: BranchRowSample, right: BranchRowSample): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  return left.kind === "link" && right.kind === "link"
    ? left.href === right.href && left.anchor === right.anchor
    : true;
}
