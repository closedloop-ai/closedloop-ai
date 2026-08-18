/**
 * @file work-item-occurrences.ts
 * @description FEA-4010 (AA-10): the PURE per-occurrence stream of work-item slug
 * mentions in a session, each carrying the transcript time it happened at.
 *
 * WHY THIS EXISTS. `session_artifact_links` is a session-level ROLLUP — one row
 * per (session, artifact, relation) — which is the right shape for "this session
 * touched FEA-1224". But `work_item_ref` is a PER-SEGMENT label, and a session
 * that works several artifacts is the normal case, not an anomaly. Projecting the
 * rollup onto segments can therefore only answer "which single artifact wins for
 * the whole session", and the resolver's final tie-break is a code-point compare —
 * so a slug mentioned ONCE, incidentally, beat one mentioned 97 times purely
 * because `FEA-11…` sorts before `FEA-12…`, and that winner was then smeared
 * across every segment including idle.
 *
 * Nothing needs a new timestamp to fix that. Every mention already sits in a
 * timestamped message or tool use; the rollup simply discards which one. This
 * module preserves that, so the resolver can scope a label to the segment whose
 * span actually contains the mention.
 *
 * SCOPE DISCIPLINE. This is deliberately NOT a second detector. It mirrors the
 * scan surface of the extractor's bare-slug pass — message text plus tool INPUT,
 * after code-fence stripping — and shares that module's `stripCodeFences` and the
 * `@repo/api` slug-prefix SSOT, so a new slug family or fence rule lands in both
 * at once. It never invents a reference: the linker remains the authority on WHAT
 * a session is linked to, and these occurrences only say WHEN each link was
 * exercised. The resolver intersects them with the persisted candidates.
 *
 * CASE. The extractor runs two recognizers on purpose: its prose pass
 * (`CLOSEDLOOP_SLUG_RE`) is case-SENSITIVE, because a link minted from a stray
 * lowercase `fea-123` would be a false artifact; its branch/cwd pass
 * (`CLOSEDLOOP_SLUG_BRANCH_RE`) is case-INSENSITIVE and uppercases, because real
 * branches are spelled `ci/pause-arm-shadow-fea-2172`. This module needs the
 * branch spelling — it is the strongest statement of what a segment is working
 * on — and it CANNOT mint anything, since the resolver keeps only slugs the
 * linker already persisted. So it takes the recall-oriented recognizer for both
 * surfaces and normalizes to upper case, matching what the extractor stores.
 * Case-sensitivity here bought no precision and cost the branch signal outright:
 * with it, `019effc3` — a session the audit records as entirely FEA-2159, on
 * branch `kaiticarp/fea-2159-…` — resolved to FEA-1899 on 10 of 13 active
 * segments, because the only spelling of the true item was invisible.
 *
 * Tool OUTPUT is excluded for the same reason the extractor excludes it: a slug
 * appearing in a file the agent READ is incidental context, not work on that item.
 */
import { buildSlugPrefixAlternation } from "@repo/api/src/types/slug-prefix";
import type { NormalizedSession } from "../types.js";
import { stripCodeFences } from "./artifact-ref-extractor.js";
import { flattenTextValues } from "./parser-utils.js";
import { collectSessionToolUses } from "./session-tool-uses.js";

/**
 * A Closedloop slug mention, in any case. Built from the same prefix SSOT the
 * extractor uses, so the two recognizers cannot drift apart on which families
 * exist; see the CASE note in the file header for why this one is insensitive.
 */
const SLUG_RE = new RegExp(
  String.raw`\b(?:${buildSlugPrefixAlternation()})-\d+\b`,
  "gi"
);

/** One work-item slug mention, at the transcript time it occurred. */
export type WorkItemOccurrence = {
  /**
   * The slug, upper-cased (e.g. `FEA-1224`) — the spelling the extractor stores
   * on `artifacts.slug`, so the resolver can intersect the two directly however
   * the mention was written.
   */
  slug: string;
  /** Transcript event time of the message / tool use carrying the mention. */
  occurredAtMs: number;
};

/** Epoch-ms for a transcript timestamp, or null when it is absent/unparseable. */
function timestampMs(timestamp: string | null | undefined): number | null {
  if (!timestamp) {
    return null;
  }
  const ms = Date.parse(timestamp);
  return Number.isNaN(ms) ? null : ms;
}

/** Locale-independent code-point comparison (never `localeCompare`). */
function compareSlugs(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/** Appends every slug mention in `text` at `occurredAtMs`, upper-cased. */
function collectFrom(
  text: string,
  occurredAtMs: number,
  into: WorkItemOccurrence[]
): void {
  for (const match of stripCodeFences(text).matchAll(SLUG_RE)) {
    into.push({ slug: match[0].toUpperCase(), occurredAtMs });
  }
}

/**
 * Every work-item slug mention in a session, ordered by time (ties broken by
 * slug, so the result is byte-identical across input orderings and hosts).
 *
 * Pure and deterministic: no IO, no clock, no randomness. A mention whose
 * carrying record has no usable timestamp is dropped rather than guessed at — it
 * cannot be scoped to a segment, and the session-level rollup still carries the
 * link itself.
 */
export function extractWorkItemOccurrences(
  session: NormalizedSession
): WorkItemOccurrence[] {
  const occurrences: WorkItemOccurrence[] = [];
  for (const message of session.messages ?? []) {
    const ms = timestampMs(message.timestamp);
    if (ms !== null && message.text) {
      collectFrom(message.text, ms, occurrences);
    }
  }
  // The linker's own deduped parent-plus-sidecar stream, not `session.toolUses`:
  // a Task-spawned sub-agent's tools never reach the parent array, so scanning it
  // alone would miss every slug named only inside delegated work — while the
  // linker still persists the link, leaving a candidate the stream can never
  // place in time. Sharing the traversal also means the dual-push dedup and the
  // sidecar-fencing rules cannot drift between the two.
  for (const { tu } of collectSessionToolUses(session)) {
    const ms = timestampMs(tu.timestamp);
    if (ms === null) {
      continue;
    }
    for (const text of flattenTextValues(tu.input)) {
      collectFrom(text, ms, occurrences);
    }
  }
  return occurrences.sort(
    (a, b) => a.occurredAtMs - b.occurredAtMs || compareSlugs(a.slug, b.slug)
  );
}
