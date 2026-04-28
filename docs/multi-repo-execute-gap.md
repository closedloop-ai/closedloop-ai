# Multi-Repo EXECUTE — Remaining Work

Tracks the remaining steps to enable the EXECUTE harness command to operate
across the primary repo and its peer (`additionalRepos`) repos with the same
fidelity as PLAN.

## Background

PLN-263 ("Add multi-repo support for plan loops", commit `bf8ba74a`) intentionally
scoped the read-side of multi-repo to PLAN only. PLN-368 ("Add multi-repo
execution result finalization") later added per-repo commit + PR finalization for
EXECUTE. Result: EXECUTE clones peer repos and finalizes per-repo PRs, but the
LLM session **does not get filesystem access to the peers** because
`buildRunLoopArgs` skips `--add-dir` for EXECUTE.

A negative test at
[`harness-agent.test.mjs:1982`](../containers/claude-runner/harness-agent.test.mjs#L1982)
locks the gap in:

```js
test("EXECUTE command omits --add-dir even when additionalRepoPaths provided", () => {
  // ...asserts !args.includes("--add-dir")
});
```

## Where the gap actually is

Verified by inspection — most of the multi-repo plumbing is already command-agnostic:

| Layer | EXECUTE today | Gap? |
|---|---|---|
| API route validator (`run-loop/validators.ts`) | Accepts `additionalRepos` for any command | No |
| Loop service / orchestrator (`loop-orchestrator.ts:432`, `:498`) | `resolveAdditionalRepos` runs unconditionally | No |
| Authorization (`authorizeAdditionalRepos`, `service.ts:341`) | Runs at create time for any command | No |
| GitHub token refresh route (`/loops/{id}/github-token`) | Already issues per-peer tokens for any command | No |
| Harness peer cloning (`cloneAdditionalRepos`, `harness-agent.mjs:3779`) | Runs unconditionally | No |
| Harness token redaction (`registerSecret` per-peer, `:3756`) | Runs unconditionally | No |
| Harness finalization (`finalizeRepos`, `:3559`) | Runs per-repo via `buildRepoList` | No (PLN-368) |
| **Harness `--add-dir` injection (`buildRunLoopArgs`, `:2660-2676`)** | **PLAN only** | **YES** |
| **Harness EXECUTE test (`harness-agent.test.mjs:1982`)** | **Asserts no `--add-dir`** | **YES** |
| `run-loop.sh` (in `closedloop-ai/claude-plugins` repo) | Unverified for EXECUTE | **Verify** |

Note: the only feature-flag layer (`useFeatureFlag("multi-repo-plan")` at
[`plan-editor.tsx:79`](../apps/app/app/(authenticated)/implementation-plans/[slug]/plan-editor.tsx#L79))
is UX-side and gates the regenerate modal. The harness has no flag — it acts on
whatever `additionalRepos` it receives in the context pack. The harness changes
below ship without any flag work.

## Steps

### 1. Harness — wire `--add-dir` for EXECUTE

[`containers/claude-runner/harness-agent.mjs`](../containers/claude-runner/harness-agent.mjs)

Hoist the `--add-dir` loop out of the `switch` in `buildRunLoopArgs` so it
applies to both PLAN and EXECUTE:

```js
function buildRunLoopArgs(runLoopPath, workDir, prdPath, additionalRepoPaths) {
  const args = [runLoopPath, workDir];

  switch (config.command) {
    case LoopCommand.Plan:
      args.push("--max-iterations", String(config.maxIterations || 50));
      break;
    case LoopCommand.Execute:
      args.push("--max-iterations", String(config.maxIterations || 150));
      break;
    default:
      args.push("--max-iterations", String(config.maxIterations || 50));
  }

  if (Array.isArray(additionalRepoPaths)) {
    for (const repoPath of additionalRepoPaths) {
      args.push("--add-dir", repoPath);
    }
  }

  if (prdPath) {
    args.push("--prd", prdPath);
  }

  return { cmd: "bash", args };
}
```

The data already arrives at `buildRunLoopArgs` correctly:
`buildCommand` → `buildRunLoopArgs` already passes `additionalRepoPaths`
([`harness-agent.mjs:3097-3120`](../containers/claude-runner/harness-agent.mjs#L3097-L3120)),
and `cloneAdditionalRepos` returns those paths
([`:3779`](../containers/claude-runner/harness-agent.mjs#L3779))
regardless of command.

### 2. Harness tests — flip the negative assertion

[`containers/claude-runner/harness-agent.test.mjs`](../containers/claude-runner/harness-agent.test.mjs)

Replace the `"EXECUTE command omits --add-dir"` test at line 1982 with the
positive mirror of the PLAN test, asserting two `--add-dir` flags for two paths
and that flag values match. Keep the PLAN test as-is.

Add additionally:
- A "default/unknown command still receives `--add-dir`" test, OR an explicit
  assertion that only PLAN and EXECUTE inject `--add-dir` (depending on what
  Step 1 chooses).
- A regression test: EXECUTE with empty `additionalRepoPaths` must not produce
  any `--add-dir` flags (mirror PLAN's empty-input behavior).

### 3. `run-loop.sh` — confirm EXECUTE forwards `--add-dir`

The script lives in `closedloop-ai/claude-plugins`. Confirm its EXECUTE branch
threads `--add-dir` through to the `claude` CLI invocation (the same way it
does for PLAN). If EXECUTE is hard-coded to a single workspace, file a
companion PR there — without that change the harness flag is inert.

### 4. Verify EXECUTE chain inheritance of `additionalRepos`

Most EXECUTE loops are spawned as children of a parent PLAN loop. Confirm:

- `resolveLoopContext` (in
  [`apps/api/app/documents/[id]/run-loop/run-loop-helpers.ts`](../apps/api/app/documents/[id]/run-loop/run-loop-helpers.ts))
  carries `additionalRepos` from the parent loop into the EXECUTE create call,
  OR the caller (frontend / MCP) re-supplies them on the body. The route at
  [`route.ts:201`](../apps/api/app/documents/[id]/run-loop/route.ts#L201) only
  forwards `body.additionalRepos`; if the body is empty the parent's set is
  lost.
- `regenerate-from-prd` and `request-changes` flows preserve them (PLN-307
  added propagation for change requests — verify EXECUTE follows the same
  path).
- `authorizeAdditionalRepos` is re-invoked at EXECUTE create time so a peer
  whose installation was revoked between PLAN and EXECUTE fails fast.

If inheritance is missing, persist `additionalRepos` on the EXECUTE create
input from the parent loop record, gated on `requiresParent`.

### 5. Finalization safety review

`finalizeRepos` ([`harness-agent.mjs:3559`](../containers/claude-runner/harness-agent.mjs#L3559))
runs per-repo finalization in parallel via `attemptLlmCommit` +
`finalizeRepoWithLlm`. Re-audit for the EXECUTE multi-repo case:
- A peer repo with **no LLM-authored changes** must not produce an empty PR.
  Confirm the safety-commit fallback skips clean peers.
- The PR title/description for peer repos should reference the parent
  document's slug + the primary repo PR for traceability.
- Token refresh under long EXECUTE runs (45-min cadence,
  [`refreshStaleTokens`](../containers/claude-runner/harness-agent.mjs#L3482))
  must cover all peers.

### 6. Documentation

- Update `apps/web/content/docs/mechanisms/multi-repo.mdx` (or equivalent) to
  document EXECUTE behavior and peer-repo PR semantics.
- Update `apps/web/content/docs/resources/release-notes.mdx` once EXECUTE
  multi-repo ships.
- Add a `[mistake]` / `[pattern]` line under "Planning & Verification" or a
  new "Multi-repo" section in
  [`CLAUDE.md`](../CLAUDE.md) describing how the harness grants peer-repo
  access (so future agents don't reintroduce the gap).

### 7. End-to-end test

Add a test (integration or scripted) that:
1. Creates a loop with `command: EXECUTE` and two `additionalRepos`.
2. Asserts the harness invocation includes `--add-dir /workspace/peers/...`
   for each peer.
3. Asserts a per-peer PR is created when the peer has changes, and skipped
   when it does not.
4. Asserts a per-peer token refresh happens at the 45-min boundary on long
   runs (mock the clock).

## Out of scope

- New peer-repo-level features (e.g., per-peer max iterations, per-peer
  prompts). Treat all peers uniformly for v1.
- Changes to the desktop compute provider beyond what is required to forward
  `additionalRepos` (already done per PLN-263).
- `REQUEST_CHANGES` multi-repo behavior — separate ticket; the chain
  RC → EXECUTE will inherit Step 4's behavior automatically once persisted.

## Acceptance criteria

- `buildRunLoopArgs` emits `--add-dir` for each peer path on EXECUTE.
- The negative test at `harness-agent.test.mjs:1982` is replaced by a
  positive test mirroring the PLAN case.
- An EXECUTE loop launched with two `additionalRepos` produces commits and
  PRs in all three repos when each has changes, none in repos with no
  changes.
- Documentation (Step 6) is updated in the same PR that flips the test.
