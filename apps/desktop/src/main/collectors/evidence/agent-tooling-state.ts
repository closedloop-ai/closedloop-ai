/**
 * @file agent-tooling-state.ts
 * @description FEA-4010 (AA-09 C1): state roots owned by agent TOOLING that is
 * not itself a harness — published plugins, extensions and skill packs that run
 * INSIDE one or more harnesses and keep per-run bookkeeping in the user's
 * repository.
 *
 * Why this is not a `HarnessAdapter.isAgentStatePath` entry: ownership is
 * orthogonal to the harness. A plugin writes the SAME tree whether it was driven
 * from Claude Code or Codex, so hanging it off one harness adapter would miss the
 * other and imply a relationship that does not exist.
 *
 * It sits beside its only consumer (`mutation-kind.ts`) rather than in
 * `adapters/`, which holds exactly one `HarnessAdapter` implementation per
 * harness and nothing else. Filing a non-adapter there also made the
 * evidence/↔adapters/ dependency two-way, since `claude-adapter.ts` imports
 * `isUnderTempRoot` back out of `mutation-kind.ts`. Concrete third-party path
 * literals are fine here: the anti-over-fitting guard scopes vendor literals out
 * of `evidence-model.ts` and `build-session-evidence.ts` specifically, and this
 * module is neither.
 *
 * The bar for an entry here is that the tool is PUBLISHED and its state layout is
 * a documented part of its contract — the same standing a harness's own state
 * directory has. A root that only one organization's private setup produces does
 * NOT belong here; that would be over-fitting the classifier to one customer.
 *
 * Each entry is an inverse allowlist, because that is how these tools actually
 * declare themselves: the root is generated state EXCEPT for the handful of
 * user-authored files the tool asks you to commit.
 */

type ToolingStateRoot = {
  /** Matches the owned directory, capturing everything beneath it. */
  root: RegExp;
  /** Paths under the root that are USER-AUTHORED, so NOT bookkeeping. */
  committed: RegExp;
};

/**
 * The Closedloop plugin suite (code review, loops), distributed publicly from
 * `closedloop-ai/claude-plugins` and required for parts of the platform to run.
 * Everything it puts in `.closedloop-ai/` is per-run bookkeeping — review scope,
 * run plans, PR snapshots, thread ledgers, generated summaries — except the
 * bootstrap script and the `settings/` tree, which users author and commit.
 *
 * That split is the tool's OWN declaration rather than an inference: its
 * `.gitignore` stanza is `.closedloop-ai/*` with negations for exactly
 * `loops-setup.sh` and `settings/`. Mirroring the tool's published ignore rules
 * is what makes the inverse form safe here, where a blanket match on a harness's
 * `.claude/` directory would not be (see `claude-adapter.ts`, which allowlists).
 */
const CLOSEDLOOP_PLUGIN_STATE: ToolingStateRoot = {
  root: /(?:^|[\\/])\.closedloop-ai[\\/](.+)$/,
  committed: /^(?:loops-setup\.sh$|settings[\\/])/,
};

const TOOLING_STATE_ROOTS: readonly ToolingStateRoot[] = [
  CLOSEDLOOP_PLUGIN_STATE,
];

/**
 * True when `path` is bookkeeping written by a known agent TOOL rather than work
 * on the project.
 *
 * This is the case the audit called out and the reason it matters: one corpus
 * session's ENTIRE mutation signal is six writes to the code-review plugin's own
 * `.closedloop-ai/` tree, and it reported 40% `implement` on the strength of
 * them. A second logs seven such writes as implement islands inside a declared
 * review walk. In both, nothing in the project changed.
 *
 * Unknown roots return false, so anything not listed keeps the `MutateCode`
 * default and this can only ever remove an over-claim.
 */
export function isAgentToolingStatePath(path: string): boolean {
  for (const { root, committed } of TOOLING_STATE_ROOTS) {
    const match = root.exec(path);
    if (match && !committed.test(match[1])) {
      return true;
    }
  }
  return false;
}
