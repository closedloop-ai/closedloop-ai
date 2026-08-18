/**
 * ISS-5464: the local detail reader's tab payload plus its honest truncation
 * flags, in ONE place.
 *
 * Both local detail builders in `shared-agent-components-api.ts`
 * (`buildUnresolvedOnlyDetail` and `getAgentComponentDetailLocal`) return the
 * same four fields under the same rules, and the rules are easy to get subtly
 * wrong — which is the bug this exists to prevent. The renderer used to infer
 * truncation from `sessionsTab.length >= AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS`,
 * a constant only the CLOUD read applies; this reader caps at nothing, so that
 * inference announced truncations that never happened. The fact is stated here
 * instead, by the producer, from what it actually holds.
 */

import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";

/** The four tab fields every local detail carries. */
type LocalDetailSessionTabs = Pick<
  AgentComponentDetail,
  | "sessionsTab"
  | "sessionsTabTruncated"
  | "branchesTab"
  | "branchesTabTruncated"
>;

/**
 * `sessionsTab` is short only when the local sessions source could not project
 * some of the ids that used the component — this reader applies no row cap — and
 * that is exactly the disclosure the tab's notice makes.
 *
 * `branchesTab` is always empty here: the local reader has no branch-attribution
 * projection at all, so the empty array is not a bounded SAMPLE of anything. It
 * is "this source cannot report branches", which the tab's empty state already
 * says, so the truncation flag stays false rather than claiming rows were cut.
 */
export function localDetailSessionTabs(
  sessionsTab: AgentComponentDetail["sessionsTab"],
  requestedSessionIds: readonly string[]
): LocalDetailSessionTabs {
  return {
    sessionsTab,
    sessionsTabTruncated: sessionsTab.length < requestedSessionIds.length,
    branchesTab: [],
    branchesTabTruncated: false,
  };
}
