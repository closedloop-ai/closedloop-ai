/**
 * @file component-usage-attribution.ts
 * @description ISS-7795: per-invocation token attribution for skills and
 * commands, read from the harness's own per-turn attribution stamp.
 *
 * Claude stamps every assistant record with `attributionSkill` — the skill or
 * slash command whose execution that turn served — and the same record carries
 * `message.usage`, the provider's own reported counts. So the accurate number
 * for one invocation is already in the transcript: it needs joining, not
 * estimating, and no tokenizer is involved.
 *
 * Why this beats bracketing the invocation positionally: a skill's turns are
 * not a contiguous slice. A nested skill runs inside its caller's span, and the
 * caller resumes afterwards, so a start/end bracket would charge the caller for
 * its callee. Reading the per-turn stamp attributes each round-trip to the
 * component that actually caused it, and re-entry after a nested call lands
 * back on the same invocation rather than opening a second one.
 */
import { foldComponentUsage } from "../component-usage";
import type { NormalizedComponentUsage } from "../types";
import { foldDedupMap } from "../usage-dedup";
import { extractDedupedUsage } from "./claude-usage";

/** One assistant record held for the dedup pass, in transcript order. */
type UsageRecord = { entry: Record<string, unknown>; iso: string | null };

/**
 * An invocation this pass can attribute to: the component key the harness would
 * stamp for it, the moment it opened, and the object to hang the result on.
 */
type AttributionTarget<T> = {
  key: string;
  at: string | null;
  target: T;
};

/**
 * Strip a leading slash so a `/foo` command entry compares equal to the
 * `attributionSkill` the harness stamps for it, which never carries one.
 */
function attributionKey(value: string): string {
  return value.startsWith("/") ? value.slice(1) : value;
}

/**
 * Fold one invocation's records into a single usage row.
 *
 * Dedup runs per invocation over the SAME canonical extractor the session total
 * uses, so a round-trip repeated across records collapses exactly as it does
 * there. Each billable turn belongs to one invocation — every record sharing a
 * `message.id` is one assistant message and therefore carries one
 * `attributionSkill` — so the per-invocation dedup keys partition the session's
 * rather than overlapping, and no turn is counted twice.
 */
function foldInvocationUsage(
  records: readonly UsageRecord[]
): NormalizedComponentUsage | undefined {
  return foldComponentUsage(
    foldDedupMap(extractDedupedUsage([...records])).tokensByModel
  );
}

/**
 * Group usage-bearing assistant records by the invocation that caused them.
 *
 * Openings are ordered by their own timestamp and become eligible as the record
 * stream reaches them, so a stamp is charged to the most recent invocation of
 * that component at or before the turn. A stamp naming a component with no
 * opening yet — a skill entered before the transcript's first usage record, or
 * one whose entry the parser never saw — attributes to nothing rather than to
 * the wrong invocation.
 */
function groupRecordsByTarget<T>(
  openings: readonly AttributionTarget<T>[],
  records: readonly UsageRecord[]
): Map<T, UsageRecord[]> {
  const ordered = [...openings]
    .filter((opening) => opening.at !== null)
    .sort((left, right) => (left.at ?? "").localeCompare(right.at ?? ""));
  const grouped = new Map<T, UsageRecord[]>();
  const openByKey = new Map<string, T>();
  let next = 0;
  for (const record of records) {
    const iso = record.iso;
    while (
      next < ordered.length &&
      iso !== null &&
      (ordered[next].at ?? "") <= iso
    ) {
      openByKey.set(ordered[next].key, ordered[next].target);
      next += 1;
    }
    const stamped = record.entry.attributionSkill;
    if (typeof stamped !== "string" || stamped.length === 0) {
      continue;
    }
    const target = openByKey.get(attributionKey(stamped));
    if (target === undefined) {
      continue;
    }
    const bucket = grouped.get(target);
    if (bucket) {
      bucket.push(record);
    } else {
      grouped.set(target, [record]);
    }
  }
  return grouped;
}

/**
 * ISS-7795: attach measured per-invocation usage to every skill and command the
 * harness attributed turns to.
 *
 * Mutates in place because both lists are the parser's own freshly-built
 * objects and the invocation materializer reads them by identity. An invocation
 * the harness never stamped is left without `usage` — an absent value, never a
 * zero, because "no telemetry" and "measured zero" are different facts.
 */
export function attachComponentUsage(
  skills: Array<{
    name: string;
    normalizedName?: string;
    timestamp: string | null;
    usage?: NormalizedComponentUsage;
  }>,
  slashCommands: Array<{
    name: string;
    normalizedName?: string;
    timestamp: string;
    usage?: NormalizedComponentUsage;
  }>,
  assistantUsageRecords: readonly UsageRecord[]
): void {
  if (assistantUsageRecords.length === 0) {
    return;
  }
  const openings: AttributionTarget<{ usage?: NormalizedComponentUsage }>[] = [
    ...skills.map((skill) => ({
      key: attributionKey(skill.normalizedName ?? skill.name),
      at: skill.timestamp,
      target: skill,
    })),
    ...slashCommands.map((command) => ({
      key: attributionKey(command.normalizedName ?? command.name),
      at: command.timestamp,
      target: command,
    })),
  ];
  for (const [target, records] of groupRecordsByTarget(
    openings,
    assistantUsageRecords
  )) {
    const usage = foldInvocationUsage(records);
    if (usage) {
      target.usage = usage;
    }
  }
}
