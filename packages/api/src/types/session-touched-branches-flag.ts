/**
 * @file session-touched-branches-flag.ts
 * @description Shared key for the closed-by-default session-detail "Branches"
 * row (ISS-8427, under the ISS-4779 closed-by-default UI policy).
 *
 * OFF ⇒ the Properties pane renders the single-branch "Branch" row byte-for-byte
 * as it does today: one name, one destination, the other touched branches
 * unmentioned. ON ⇒ the same pane renders the plural "Branches" row, one pill
 * per branch the session touched, each addressing its own branch detail.
 *
 * This is a perceivable change and not a bug fix that restores intended
 * behavior: the label changes word, the row changes shape, and a session that
 * touched six branches goes from one pill to six. The gate is what keeps that
 * out of users' hands until the row's large-count treatment is decided — the
 * uncapped list is deliberate (capping would rank branches, which nobody has
 * ranked) but it has not been signed off, and a default-off gate is what lets
 * the code land without the decision landing with it.
 *
 * Both surfaces mount `SessionPropertiesPanel` through the shared
 * `AgentSessionDetailView`, so the gate must exist on both or the row leaks on
 * the ungated one. Both surfaces read it as a PostHog flag — the desktop
 * renderer resolves the signed-in account's PostHog assignment from the same
 * key space `apps/app` reads — and both alias THIS constant so the two strings
 * cannot drift. It lives in `@repo/api` because that is the only
 * dependency-free module both surfaces can import.
 */
export const SESSION_TOUCHED_BRANCHES_FLAG_KEY =
  "session-touched-branches" as const;
