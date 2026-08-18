/**
 * ISS-4795 / ISS-4796 — the cloud-side version-skew guard for slash-command
 * component keys.
 *
 * The desktop fixes (`component-invocation-command-candidates.ts`,
 * `component-invocation-stored-candidates.ts`,
 * `definition-content-collector.ts`) route every LOCAL producer through
 * `normalizeCommandComponentKey` / `isAdmissibleCommandComponentKey`. That is
 * necessary but not sufficient: desktop auto-update is not guaranteed, so an
 * older supported build keeps posting `//clear` and `/...` through the component
 * inventory and usage sync lanes, where those keys were accepted and persisted
 * verbatim. Cloud inventory would be re-polluted right after the desktop fix
 * lands — exactly the failure mode the ISS-4778 skill-shadow guard
 * (`app/desktop/components/sync/skill-shadow-guard.ts`) exists to prevent for
 * its own phantom.
 *
 * So the same two rules are enforced HERE, at the trust boundary, using the same
 * shared helpers the desktop uses — no second copy of the normalization:
 *
 *   - NORMALIZE: collapse a leading run of slashes to exactly one, so a skewed
 *     client's `//clear` merges into the one `/clear` identity instead of
 *     minting a second component with its own usage population.
 *   - ADMIT: reject a key that names no command (`/`, `/...`, `/…`), so a
 *     truncated command-palette display string never becomes an inventory row.
 *
 * Deliberately scoped to `command`-kind rows. Every other kind's key is passed
 * through untouched — a skill or tool key that happens to start with `/` is a
 * legitimate identity and is none of this guard's business.
 *
 * NOT applied to the invocation-generation lane. A generation's
 * `externalGenerationId` is a hash the desktop computed over the rows it sent,
 * and the server re-derives it from the STORED rows, with `componentKey` in
 * `INVOCATION_HASH_SELECT`; rewriting a staged row pre-hash would make that
 * re-derivation diverge and reject the generation permanently. That lane
 * normalizes POST-hash, the same way `skill-shadow-normalization.ts` does.
 */
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import type { SyncedComponentUsage } from "@repo/api/src/types/agent-session";
import {
  isAdmissibleCommandComponentKey,
  normalizeCommandComponentKey,
} from "@repo/lib/sessions/command-user-turn-id";
import type { DesktopAgentComponentsPayload } from "./desktop-agent-sessions-schema";
import { earliestTimestamp, latestTimestamp } from "./iso-timestamp-bounds";

/**
 * The inventory row this guard runs on: the INGEST schema's parsed row, not the
 * `SyncedComponent` wire mirror. The guard sits at the
 * `POST /desktop/components/sync` trust boundary, so it only ever sees rows zod
 * has already folded (`harness`/`componentKey` are `string | null`, never
 * absent), and the rows it returns flow straight on into the skill-shadow guard
 * and the upsert fan-out, which are typed the same way. Typing it as the wire
 * mirror would re-widen those fields back to optional and break that hand-off.
 */
type SyncedComponentRow = DesktopAgentComponentsPayload["components"][number];

/**
 * The admitted form of a `command` key, or `null` when the key names no command
 * and the row must be dropped. A non-command kind returns its key unchanged.
 */
export function admitComponentKey(
  componentKind: string,
  componentKey: string
): string | null {
  if (componentKind !== AgentComponentKind.Command) {
    return componentKey;
  }
  const normalized = normalizeCommandComponentKey(componentKey);
  return isAdmissibleCommandComponentKey(normalized) ? normalized : null;
}

/**
 * Normalize and admit the `command` rows in an INVENTORY sync payload.
 *
 * Both `componentKey` and `externalId` are rewritten, because the writer falls
 * back to `externalId` when `componentKey` is absent
 * (`buildVersionUpsert` / `mapSyncedComponentToUpsert`) — normalizing only one
 * would leave the other free to mint the duplicate identity this guard exists to
 * prevent. Returns the components that should be ingested.
 */
export function admitSyncedCommandComponents(
  components: readonly SyncedComponentRow[]
): SyncedComponentRow[] {
  const admitted: SyncedComponentRow[] = [];
  for (const component of components) {
    if (component.componentKind !== AgentComponentKind.Command) {
      admitted.push(component);
      continue;
    }
    const externalId = admitComponentKey(
      component.componentKind,
      component.externalId
    );
    if (externalId === null) {
      continue;
    }
    // ABSENT is not REJECTED. `admitComponentKey` returns `null` to mean "this
    // key names no command", and the ingest schema separately folds an omitted
    // `componentKey` to `null` — so a single nullable cannot carry both facts.
    // Testing presence BEFORE admission keeps them apart. Collapsing them
    // dropped every command row that simply ships without a `componentKey`
    // (the common case: the writer's identity is `componentKey ?? externalId`),
    // which would have deleted real inventory on the first sync after this
    // guard landed rather than only the placeholders it targets.
    if (component.componentKey == null) {
      admitted.push({ ...component, externalId });
      continue;
    }
    const componentKey = admitComponentKey(
      component.componentKind,
      component.componentKey
    );
    // A PRESENT key that names no command makes the row inadmissible: it is the
    // field the writer will actually key on.
    if (componentKey === null) {
      continue;
    }
    admitted.push({ ...component, componentKey, externalId });
  }
  return admitted;
}

/**
 * Normalize and admit the `command` rows in a USAGE sync payload, MERGING any
 * rows that collapse onto the same identity.
 *
 * The merge is the part a naive filter gets wrong. A skewed client can report
 * both `/clear` and `//clear` in one payload; once normalized they share the
 * `(kind, key, branch)` natural key, and the downstream per-row upsert would let
 * the second row overwrite the first rather than add to it — silently losing the
 * invocations the split was supposed to reunite. Counters are summed and the
 * timestamp window is widened to cover both, which is the same arithmetic the
 * ISS-4778 usage fold applies when it collapses a phantom into its skill.
 */
export function admitSyncedCommandUsage(
  usages: readonly SyncedComponentUsage[]
): SyncedComponentUsage[] {
  const merged: SyncedComponentUsage[] = [];
  const indexByIdentity = new Map<string, number>();
  for (const usage of usages) {
    const componentKey = admitComponentKey(
      usage.componentKind,
      usage.componentKey
    );
    if (componentKey === null) {
      continue;
    }
    // Same ABSENT-is-not-REJECTED split as the inventory guard above. A usage
    // row reported with no `externalComponentId` is the norm — it resolves by
    // `componentKey` — and the session-sync schema folds that omission to
    // `null`, so treating `null` as a rejection dropped every ordinary usage
    // row instead of only the placeholder-keyed ones. The reported value is
    // carried through unchanged when absent, so an omitted field stays omitted.
    const reportedExternalId = usage.externalComponentId;
    const externalComponentId =
      reportedExternalId == null
        ? reportedExternalId
        : admitComponentKey(usage.componentKind, reportedExternalId);
    if (reportedExternalId != null && externalComponentId === null) {
      continue;
    }
    const next = { ...usage, componentKey, externalComponentId };
    const identity = `${next.componentKind}\u0000${componentKey}\u0000${next.gitBranch?.trim() ?? ""}`;
    const existingIndex = indexByIdentity.get(identity);
    if (existingIndex === undefined) {
      indexByIdentity.set(identity, merged.length);
      merged.push(next);
      continue;
    }
    merged[existingIndex] = mergeUsage(merged[existingIndex], next);
  }
  return merged;
}

/** Sum two usage buckets that normalized onto the same identity. */
function mergeUsage(
  left: SyncedComponentUsage,
  right: SyncedComponentUsage
): SyncedComponentUsage {
  return {
    ...left,
    invocations: left.invocations + right.invocations,
    errorCount: left.errorCount + right.errorCount,
    firstInvokedAt: earliestTimestamp(
      left.firstInvokedAt,
      right.firstInvokedAt
    ),
    lastInvokedAt: latestTimestamp(left.lastInvokedAt, right.lastInvokedAt),
    // A version hash describes ONE revision, so two merged buckets cannot both
    // be described by it. Keep whichever side actually carried one; when they
    // disagree the surviving value is still a revision this identity really ran.
    componentVersionHash:
      left.componentVersionHash ?? right.componentVersionHash,
  };
}
