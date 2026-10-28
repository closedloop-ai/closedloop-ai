/**
 * @file component-usage-budget.ts
 * @description T-8.6 / FEA-3029 / ISS-6884 — the desktop PRODUCER budgeting for
 * a session's `components[]` (per-session `agent_component_session_usage` rows)
 * before they are emitted on the sync wire.
 *
 * Extracted from the grandfathered `sync-source.ts` (shrink-only) as a pure,
 * unit-testable helper, mirroring the sibling `artifact-ref-budget.ts`. The
 * mapping to the wire shape and the whole-group sendability rule are one
 * cohesive responsibility with a single caller, so they own a module rather
 * than another 100 lines of the reader.
 */

import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import type { SyncedComponentUsage } from "@repo/api/src/types/agent-session";
import { MAX_SYNCED_COMPONENT_USAGE } from "@repo/api/src/types/agent-session";
import { MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS } from "@repo/lib/harness/launch-attribution";
import type { SqliteComponentUsageRow } from "./db-row-types.js";

/**
 * T-8.6: Maximum `SyncedComponentUsage` entries per session PAYLOAD. References
 * the shared `MAX_SYNCED_COMPONENT_USAGE` cap (FEA-3322) so the desktop slice and
 * the cloud wire schema can never diverge — if they did, a session whose payload
 * usage exceeds the cloud cap would fail validation and never sync at all.
 *
 * ISS-6884: this is a PER-PAYLOAD transport bound, not a population bound. The
 * usage set is emitted here IN FULL and `chunkOversizedSession` paginates it
 * across sync parts, each part within this cap.
 */
export const MAX_SESSION_COMPONENT_USAGE = MAX_SYNCED_COMPONENT_USAGE;

/**
 * FEA-3029 / ISS-6884: drop only the (kind,key) groups no single payload can
 * ever carry whole. `selectComponentUsageRows` orders rows by
 * (session, kind, key, git_branch), so every (kind,key) group's per-branch rows
 * are contiguous.
 *
 * A group must never be emitted PARTIALLY: `persistSessionComponentUsage` treats
 * the payload's branch set for a present group as authoritative and
 * `deleteMany`s every branch bucket `notIn` it, so a half-sent group silently
 * drops the missing branch's already-synced invocations from component detail
 * and the token-trend. Conversely a group ABSENT from a payload is left
 * untouched — which is what makes paginating whole groups across sync parts
 * safe, on new and old servers alike.
 *
 * ISS-6884: this used to also cap the TOTAL at MAX_SESSION_COMPONENT_USAGE,
 * which made that transport bound a permanent population bound — the row order
 * is deterministic and the table carries no sync cursor, so the same subset was
 * re-sent forever and the remainder never reached the cloud at all. The set is
 * now emitted IN FULL and `chunkOversizedSession` paginates it across sync parts
 * on these same whole-group boundaries, each part within the wire cap.
 *
 * A group whose OWN branch rows exceed the per-payload cap is still dropped in
 * full: the cloud wire schema caps `components` at that limit and rejects the
 * WHOLE batch (up to 200 sessions) on overflow, and splitting the group across
 * parts would trip the authoritative-branch-set prune above. Its rows are simply
 * not synced (an absent group leaves any previously synced cloud rows untouched),
 * and later groups are unaffected.
 */
export function dropUnsendableComponentGroups(
  usageRows: SqliteComponentUsageRow[],
  onDropped?: (group: SqliteComponentUsageRow, branchRows: number) => void
): SqliteComponentUsageRow[] {
  const sendable: SqliteComponentUsageRow[] = [];
  let index = 0;
  while (index < usageRows.length) {
    const groupStart = index;
    const head = usageRows[groupStart];
    while (
      index < usageRows.length &&
      usageRows[index].component_kind === head.component_kind &&
      usageRows[index].component_key === head.component_key
    ) {
      index++;
    }
    if (index - groupStart > MAX_SESSION_COMPONENT_USAGE) {
      // Unsendable on its own; skip it and keep scanning so later groups are
      // never starved by it. ISS-6884: this is now the ONLY component-usage row
      // loss left in the reader, and it is permanent — the read is deterministic
      // and the table carries no cursor — so it is reported rather than silent,
      // mirroring the activity-tiling overflow above.
      onDropped?.(head, index - groupStart);
      continue;
    }
    for (let cursor = groupStart; cursor < index; cursor++) {
      sendable.push(usageRows[cursor]);
    }
  }
  return sendable;
}

/**
 * T-8.6: Map per-session component usage rows to the SyncedComponentUsage wire
 * shape. ISS-6884: the FULL set is emitted — `chunkOversizedSession` paginates
 * it across sync parts on whole (kind,key) boundaries so no row is dropped for
 * transport. Returns an empty spread object when there are no sendable usage
 * rows (so the `components` key is omitted from the payload entirely — an absent
 * array never clears previously synced rows).
 */
export function buildBoundedComponentUsage(
  usageRows: SqliteComponentUsageRow[],
  onDropped?: (group: SqliteComponentUsageRow, branchRows: number) => void,
  firstAttributedSkill?: string | null
): { components: SyncedComponentUsage[] } | Record<string, never> {
  if (usageRows.length === 0) {
    return {};
  }
  const sendable = dropUnsendableComponentGroups(usageRows, onDropped);
  // Possible only when every (kind,key) group individually exceeds the per-payload
  // cap: emit nothing (omit the key) so the cloud leaves previously synced rows
  // untouched, rather than an empty `components: []`.
  if (sendable.length === 0) {
    return {};
  }
  const components: SyncedComponentUsage[] = sendable.map((row) => ({
    componentKind: row.component_kind,
    componentKey: row.component_key,
    externalComponentId: row.agent_component_id ?? null,
    harness: row.harness ?? null,
    invocations: row.invocations,
    errorCount: row.error_count,
    firstInvokedAt: row.first_invoked_at ?? null,
    lastInvokedAt: row.last_invoked_at ?? null,
    // FEA-2990: carry the per-event branch attribution additively. Map the ''
    // no-branch sentinel back to null so the cloud reads it as "no per-event
    // branch" and applies the session-level fallback.
    gitBranch: row.git_branch === "" ? null : row.git_branch,
    // FEA-2923: hash-at-invocation attribution (null when uncollected).
    componentVersionHash: row.component_version_hash ?? null,
    // ISS-7259: flag the existing row rather than adding a second one, so the
    // skill is never counted as both an invocation and an attribution. Omitted
    // when false — an older cloud must not be able to tell a build that never
    // sent it from one that sent "no".
    ...(firstAttributedSkill != null &&
    row.component_kind === LAUNCH_ATTRIBUTED_COMPONENT_KIND &&
    row.component_key === firstAttributedSkill
      ? { isFirstAttributedSkill: true }
      : {}),
  }));
  return { components };
}

/**
 * The only kind a launch attribution can name. The facet's skill member is a
 * Claude `attributionSkill`, so matching it against a tool or hook key of the
 * same name would flag an unrelated component.
 */
const LAUNCH_ATTRIBUTED_COMPONENT_KIND = AgentComponentKind.Skill;

/**
 * ISS-7259: the skill a session's persisted launch attribution names, for
 * {@link buildBoundedComponentUsage} to flag on that skill's existing row.
 *
 * Bounded by the facet's own {@link MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS}: an
 * over-long value is not a skill name, and the write side already refuses it, so
 * admitting one here would match nothing while putting unbounded text on a
 * comparison path.
 */
export function readLaunchAttributedSkill(
  metadata: Record<string, unknown> | null | undefined
): string | null {
  const facet = metadata?.harnessLaunchAttribution;
  if (typeof facet !== "object" || facet === null) {
    return null;
  }
  const skill = (facet as Record<string, unknown>).firstAttributedSkill;
  return typeof skill === "string" &&
    skill.length > 0 &&
    skill.length <= MAX_LAUNCH_ATTRIBUTION_VALUE_CHARS
    ? skill
    : null;
}

/**
 * The `components[]` field for one session, with its oversized-group log and its
 * ISS-7259 launch flag resolved from the session's own metadata.
 *
 * Wraps {@link buildBoundedComponentUsage} so the reader keeps one call rather
 * than the argument list and the log sentence: `sync-source.ts` is over the size
 * ceiling and shrink-only, and every rule this applies is documented in this
 * module.
 */
export function buildSessionComponentUsageField(
  usageRows: SqliteComponentUsageRow[],
  metadata: Record<string, unknown> | null | undefined,
  onOversizedGroup: (message: string) => void
): { components: SyncedComponentUsage[] } | Record<string, never> {
  return buildBoundedComponentUsage(
    usageRows,
    (group, branchRows) =>
      onOversizedGroup(
        `component usage group (${group.component_kind}, ${group.component_key}) has ${branchRows} branch rows, past the ${MAX_SESSION_COMPONENT_USAGE}-row per-payload cap; DROPPING the group (a partial group would make the cloud prune delete its other branches) — its rows do not sync`
      ),
    readLaunchAttributedSkill(metadata)
  );
}
