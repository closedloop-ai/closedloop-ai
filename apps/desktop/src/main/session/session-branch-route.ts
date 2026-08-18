/**
 * @file session-branch-route.ts
 * @description ISS-5567: resolve the desktop branch-detail route id for one
 * session, so the shared session-detail Properties pane can link its Branch row
 * on desktop the way it already does on web.
 *
 * The shared pane (`packages/app/agents/components/detail/agent-session-detail-view.tsx`)
 * gates the link on `session.branch && session.branchArtifactId && getBranchHref`.
 * The desktop renderer supplies `getBranchHref` already, but nothing on the
 * desktop path ever populated `branchArtifactId`, so the row rendered as inert
 * text while the same session linked on web.
 *
 * `branchArtifactId` is the route token the SURFACE's own href builder consumes,
 * not a cloud identifier: web maps it to `/{org}/branches/<artifact uuid>`, and
 * desktop maps it to `/branches/<encodeBranchId(repo, branch)>` — the id its
 * Branches list mints and its branch detail decodes. Producing the desktop form
 * here is what makes one shared component address the right branch on both
 * surfaces.
 *
 * Deliberately NOT on `SyncedAgentSession`: that type is the cloud sync payload
 * (`sanitizeSessionForSync` spreads it whole), so a desktop-encoded id placed
 * there would ship to the cloud and collide with the cloud's own artifact-uuid
 * meaning of the field. This resolves at the desktop-local detail projection
 * instead, which only ever reaches the renderer over IPC.
 */
import {
  encodeBranchId,
  normalizeRepoFullName,
} from "@repo/api/src/types/branch";
import type {
  AgentSessionSyncSource,
  SessionBranchLinkKey,
} from "../agent-sync/agent-session-sync-source.js";
import {
  type BranchDefaultEligibilitySource,
  isEligibleBranchKey,
  resolveBranchProductEligibilitySnapshot,
} from "../branch/shared-branches-default-eligibility.js";

/**
 * The only capability this resolver needs. Narrowed to the one optional method so
 * a test can supply a two-line stub, and so the call site passes the LIVE source
 * object rather than a detached function — `agentDatabase.syncSource` is the
 * db-host forwarding proxy, which resolves a method by dotted path at call time.
 */
type SessionBranchLinkKeySource = Pick<
  AgentSessionSyncSource,
  "loadSessionBranchLinkKeys"
>;

/**
 * The desktop branch-detail route id for a session's branch, or `undefined` when
 * the Branch row must stay plain text.
 *
 * Every gate below resolves to omission rather than a guessed id, because a link
 * to a branch the Branches surface does not serve is worse than the plain text it
 * replaces — it promises a destination and lands on "not found".
 *
 * - No `branch` — a read-only session shipped nothing; the pane already renders
 *   "None".
 * - No loader — an older or fake sync source that predates
 *   `loadSessionBranchLinkKeys`; the field stays omitted and desktop degrades to
 *   exactly its pre-ISS-5567 behavior.
 * - No branch artifact named by the row — the link and the displayed value must
 *   be the same branch, so a session whose branch writes name something else
 *   (a mid-read write, an attribution that outran the artifact) withholds the
 *   link instead of pointing the user at a branch the row does not name.
 * - Authority is missing or the branch is the repository's exact authoritative
 *   default — the Branches detail read applies the same fail-closed policy.
 * - An AMBIGUOUS branch identity: two artifact rows carry the displayed branch
 *   name under different repo scopes (`computeIdentityKey` scopes a branch on
 *   `repoFullName ?? gitDir`, so an `owner/repo` row and a NULL-repo row for the
 *   same name are two rows), and the pane's own repository does not single one
 *   out. The Branches list groups on `(repoFullName, branchName)`, so those are
 *   two DIFFERENT destinations and picking by recency would address whichever
 *   was observed last — or, on an `observed_at` tie, whichever the engine
 *   returned, so one row could address two records on two loads. Withhold rather
 *   than guess (stage review on #4650).
 * - A branch artifact whose repo DISAGREES with the repo the same Properties pane
 *   is showing. The pane's Repository row reads `attribution.repositoryFullName`
 *   (the worktree's remote) while this id must use the branch ARTIFACT's repo (the
 *   Branches list keys on it), and the two are resolved independently. When both
 *   are known and differ, linking would put a contradiction on one screen — the
 *   row naming repo A above a link that opens a branch under repo B — so say
 *   nothing rather than something self-contradictory. One side being unknown is
 *   not a disagreement and does not gate: a lone NULL-repo artifact (the
 *   resolver's cold-registry case) IS the only row the Branches list shows for
 *   that branch, so `local::<branch>` addresses it exactly.
 *
 * A thrown lookup is treated as "unknown", matching the detail projection's other
 * best-effort enrichments: a failed read must never blank or break the pane.
 */
export async function resolveSessionBranchRouteId(input: {
  source: SessionBranchLinkKeySource;
  eligibilitySource?: BranchDefaultEligibilitySource;
  sessionId: string;
  branch: string | null | undefined;
  displayedRepositoryFullName: string | null | undefined;
}): Promise<string | undefined> {
  const {
    source,
    eligibilitySource,
    sessionId,
    branch,
    displayedRepositoryFullName,
  } = input;
  if (!(branch && source.loadSessionBranchLinkKeys)) {
    return undefined;
  }
  const keys = await loadKeys(source, sessionId);
  const key = pickDisplayedBranchKey(
    keys.filter((candidate) => candidate.branchName === branch),
    displayedRepositoryFullName
  );
  if (
    !key ||
    contradictsDisplayedRepository(key, displayedRepositoryFullName)
  ) {
    return undefined;
  }
  const snapshot = await resolveBranchProductEligibilitySnapshot(
    [key],
    eligibilitySource,
    // A session detail projects a best-effort link, but eligibility still
    // awaits the same bounded authority pass and fails closed when unresolved.
    { scope: "list" }
  );
  if (!isEligibleBranchKey(key, snapshot)) {
    return undefined;
  }
  return encodeBranchId({
    repoFullName: key.repoFullName,
    branchName: key.branchName,
  });
}

/**
 * The one branch record the pane can mean, or `null` when that is not decidable.
 *
 * `candidates` are the DISTINCT identities already narrowed to the displayed
 * branch name, so more than one means the same name exists under more than one
 * repo scope. The pane's own Repository row is the only tiebreaker available —
 * when exactly one candidate names it, the link agrees with the row directly
 * above it. Anything else is a coin flip between two real destinations, and the
 * plain text it degrades to is the honest answer.
 */
function pickDisplayedBranchKey(
  candidates: SessionBranchLinkKey[],
  displayedRepositoryFullName: string | null | undefined
): SessionBranchLinkKey | null {
  if (candidates.length <= 1) {
    return candidates[0] ?? null;
  }
  if (!displayedRepositoryFullName) {
    return null;
  }
  const displayed = normalizeRepoFullName(displayedRepositoryFullName);
  const matches = candidates.filter(
    (candidate) =>
      candidate.repoFullName !== null &&
      normalizeRepoFullName(candidate.repoFullName) === displayed
  );
  return matches.length === 1 ? matches[0] : null;
}

/**
 * True when the branch artifact's repo and the repo the pane displays are BOTH
 * known and name different repositories. Both sides go through
 * `normalizeRepoFullName` — the same normalization the artifact-ref persistence
 * and the session attribution each already apply — so a `.git` suffix or casing
 * difference is not mistaken for a real disagreement.
 */
function contradictsDisplayedRepository(
  key: SessionBranchLinkKey,
  displayedRepositoryFullName: string | null | undefined
): boolean {
  if (!(key.repoFullName && displayedRepositoryFullName)) {
    return false;
  }
  return (
    normalizeRepoFullName(key.repoFullName) !==
    normalizeRepoFullName(displayedRepositoryFullName)
  );
}

/** Best-effort lookup: a throwing source resolves to "no keys", never a rejection. */
async function loadKeys(
  source: SessionBranchLinkKeySource,
  sessionId: string
): Promise<SessionBranchLinkKey[]> {
  try {
    return (await source.loadSessionBranchLinkKeys?.(sessionId)) ?? [];
  } catch {
    return [];
  }
}
