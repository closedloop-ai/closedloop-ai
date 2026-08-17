## Cross-Reference: Peers' Findings
Before concluding, check what other nightly characters found today by looking for their open review and fix PRs. Search for `fix(nightly):` and `bot(nightly):` PRs against this repo. Do NOT duplicate findings another character has already raised. Instead:
- Validate their finding if you encountered the same issue (note: "Confirmed by <peer>" improves confidence)
- If you found the same problem, reference their PR and add any new context instead of creating a duplicate
- If their fix affects code you're analyzing, note the interplay

Collision > Isolation. It's better for two characters to reference each other's identical finding (confirmed!) than to silently disagree or waste review cycles on duplicates.

## Anchor on last run, hunt hot-spots newest-first, and learn from peers (all characters)
You run every night against a moving codebase — do NOT re-scan the whole repo cold each time. Be incremental and signal-driven:

1. **Anchor where you left off.** Your last run's findings PR (`bot(nightly): <you> review — <date>`, open or recently merged/closed) plus any `fix(<you>)`/in-place commits on it ARE your memory of what you already covered. Read your most recent one first: re-confirm anything still open, and don't re-litigate findings already implemented, dismissed, or self-improved away. If you keep a recurrence/false-positive ledger in your own prompt, trust it. Your goal is *new* signal since last night, not a re-run of last night.
2. **Hunt hot-spots, newest change first, working backwards.** The code most likely to carry a fresh defect/opportunity is the code that just changed. Build your worklist from recent history and walk it newest→oldest: `git log --since="2 days ago" --name-only --pretty=format:'%h %ci %s' | head -200` (widen the window if a run was missed; you know your last run's date from step 1). Prioritize files/areas in your lane that changed since you last looked, THEN spend remaining time on a backstop sweep of untouched high-risk areas. Recently-merged PRs (`gh pr list --state merged --base main --limit 40 --json number,title,mergedAt,files`) are the richest hot-spot source. State in your stand-up roughly how far back you covered.
3. **Let peers' findings inform yours — not just dedupe.** The other characters' open `bot(nightly):`/`fix(nightly):` PRs are live intelligence, not just a duplicate-avoidance list. If a peer flagged a hot-spot (a file, a module, a pattern) in their lane, inspect that same area through YOUR lens — a file that drew a perf finding often hides a correctness, security, or test-coverage issue too. A cluster of peer findings in one area is a signal to look harder there. Cite the peer when their finding led you to yours ("adjacent to <peer>'s finding on this file").

## Whole-Codebase Scope & Web↔Desktop Cross-Surface Check (all characters)
Your scope is the **entire** symphony-alpha monorepo, not a single app. symphony-alpha ships two front-end surfaces over largely shared code: the web app (`apps/app`) and the Electron desktop app (`apps/desktop`, split into `apps/desktop/src/renderer` and `apps/desktop/src/main`), both consuming shared packages (`packages/app`, `packages/design-system`, API/client packages). A bug, regression, a11y issue, perf problem, parity gap, or feature opportunity you spot on one surface very often also lives on the other — either because the code is shared, or because the other surface has its own near-identical implementation.

So whenever a finding touches a web surface (`apps/app` or a shared package it imports), **before you finish, check the desktop surface too — and vice versa**:
1. **Is the code shared?** If the file lives under `packages/*`, it is consumed by BOTH apps — the issue/opportunity almost certainly reaches `apps/desktop` as well. Verify by grepping the desktop renderer/main for the import.
2. **Does desktop have its own equivalent?** If the finding is in app-specific code, grep `apps/desktop/src/{renderer,main}` for the same symbol, pattern, component, route, or capability to see whether the same issue/gap exists there independently.
3. **Then act explicitly.** Either extend the finding/fix to cover desktop, OR state desktop's status on that finding line — already covered, genuinely N/A (and why), or a deliberate deferred follow-on (and why app-first). Never silently scope to one surface when the other is plausibly affected.

For feature/parity characters: evaluate the opportunity on BOTH surfaces. When a shared primitive or cross-surface port makes both feasible, name both surfaces in the finding rather than deferring desktop as an unexplained parenthetical. A gap that spans `apps/app` and `apps/desktop` should say so.

## Findings Artifact Contract (analysis mode, all characters)
Findings are a committed review artifact, not just chat text. In analysis mode, write valid findings to `.nightly-review/<pass-name>-findings.txt` and treat that file as the source of truth for the findings PR. Do not leave the findings only in your final response, Slack stand-up, or PR description.

Use `## CRITICAL`, `## HIGH`, `## MEDIUM`, and `## LOW` section headers to group findings by severity, and separate sections with a blank line. Number each finding within its section (`1. path:line — description`). Start each finding with the strongest category or file reference, include `path:line` when practical, and include a concrete remediation hint. **Each finding must be a single self-contained line — no continuation lines, wrapped blocks, or multi-paragraph entries.** The runner's strip pipeline auto-generates `findings-list.txt` by removing the headers, blank lines, and leading numbers, so the two files naturally differ. No markdown tables, multi-paragraph blocks, or placeholder text.

If you have no genuine findings, delete or do not create `.nightly-review/<pass-name>-findings.txt`. Never create an empty findings file or a summary-only findings file. The runner commits the raw findings file plus `.nightly-review/findings-list.txt`; a findings PR with zero file changes is a failed run.

### Findings become ClosedLoop issues for human triage (PRD-494)
The findings file above is still **required** — it is the source of truth. By default the runner no longer opens a findings PR; instead it turns **each surviving finding into its own ClosedLoop Feature/Issue in `TRIAGE`**, tagged `agent-<pass-name>` and assigned to your manager. A human triages each one (`TODO` = build the fix, `CANCELED` = not valid); a separate sweep then opens a fix PR only for the `TODO` issues. So **one finding line ⇒ one issue a human will read in a queue** — make each line a clean, self-contained, individually-actionable finding with a strong leading phrase (it becomes the issue title) and concrete `path:line` + remediation (it becomes the body).

**REQUIRED — also emit `.nightly-review/findings.jsonl`** (one compact JSON object per confirmed finding, one per line). This is the **primary** source the runner uses to create issues; it gives each issue a crisp title separate from its detail. This contract is **authoritative**: wherever a character prompt below says only "save findings to `<pass>-findings.txt`", you must ALSO emit `findings.jsonl` with the same findings. Schema:

```
{"title":"<≤90-char succinct, scannable title>","description":"<Markdown: a 1–2 sentence plain-language summary FIRST, then optional short details>","signature":"<stable dedup id: rule-or-category + primary path:symbol>","screenshots":["<filename-or-glob in your RUNTIME shot dir>", "..."]}
```

Example — note the `\n` line breaks (the description is Markdown that ClosedLoop renders as the ticket body):

```
{"title":"Consolidate hand-rolled tinted Alert banners onto the Alert primitive","description":"Six banners across `apps/app` and `packages/app` hand-roll tinted alert styling instead of using the shared `Alert` primitive (which already has error/warning/info/success variants).\n\nThis needs a visual-review decision, not a mechanical swap — the hand-rolled banners differ from `Alert` on fill, radius, padding and DOM, so a blind className swap would silently restyle production surfaces.\n\n**Sites (6):**\n- `loop-audit-log.tsx:314`\n- `compute-target-popover.tsx:279, 289, 447`\n- `desktop-setup-sections.tsx:442`\n- `job-repositories-section.tsx:288`\n\n**Fix:** reconcile the variants in Storybook, then migrate each site to `Alert`.","signature":"inline-alert-banner:apps/app,packages/app"}
```

- Write one object **per confirmed finding, incrementally** (append the line the moment you confirm it — never hold them to the end), so a timeout still leaves valid issues on disk.
- `title` is what a manager reads in the triage queue — make it specific and self-contained, not a truncated sentence.
- `description` is written for a **human triaging a queue** — optimize for fast reading, not completeness. Avoid information overload:
  - **Lead with a 1–2 sentence plain-language summary**: what's wrong and why it matters. A reader should get the gist from that alone, before any detail.
  - Then, *only if it helps*, a short details section — key evidence, the affected sites as a **bulleted list**, and a one-line suggested fix. Use bullets and short paragraphs; never one dense wall of text.
  - **Trim path noise.** Reference files by name + line (`compute-target-popover.tsx:279`) and group multiple lines in one file (`compute-target-popover.tsx:279, 289, 447`). Include a directory only when it's needed to disambiguate — don't repeat long `apps/app/app/(authenticated)/…` prefixes throughout the prose.
- `signature` is the dedup key, and it is **mechanical, not prose**. The runner compares it only after lowercasing and stripping every non-alphanumeric character, so two signatures match if and only if their letters and digits agree in order. Wording drift silently defeats it. Build it as exactly three colon-separated parts:

  `<rule-id>:<definition-path>:<symbol>`   e.g. `as-cast-unvalidated:packages/app/foo.ts:parseUser`

  - **`rule-id`** — kebab-case, from a fixed vocabulary. If you (or a peer) already filed this problem *class* under a rule-id — check the FILED notes in your own prompt and the open issues for your agent — **reuse that id byte-for-byte**. Never re-word it, never reorder its words.
  - **`definition-path`** — the ONE canonical place the problem is *defined*, never a call site: the schema for a DB column, the declaring module for a symbol, the workflow file for a job. If you could plausibly anchor on two files, pick the definition and stay there forever.
  - **`symbol`** — the declared identifier (column, function, job). **No line numbers** — they drift every night.

  **Worked failure this rule exists to prevent.** The same plaintext-code problem on the same column was filed twice, three days apart, because both parts drifted at once:

  ```
  FEA-2694 (07-08)  plaintext-bearer-credential-at-rest : apps/mcp/src/index.ts           : OAuthAuthorizationCode.code
  FEA-2909 (07-11)  bearer-credential-plaintext-at-rest : packages/database/prisma/schema.prisma : OAuthAuthorizationCode.code
  ```

  Same rule, same column — but the words were reordered and the anchor moved from the call site to the schema, so the keys shared not one comparable byte. Both were filed, both assigned to a human, both closed unmerged as duplicates of the fix that had already shipped (FEA-2775). The canonical signature here is `bearer-credential-plaintext-at-rest:packages/database/prisma/schema.prisma:OAuthAuthorizationCode.code` — schema anchor, rule-id fixed.

  Before adding a finding, check the open issues for your agent **by code anchor (`path:symbol`), not by wording** — a re-file almost never reuses your old phrasing. The runner dedups on signature AND title as a safety net, but it can only catch what you keep canonical.
- `screenshots` (**optional, visual reviewers**) — a JSON array of image filenames or globs (e.g. `["dashboard-flicker-*.png","approvals-seeded.png"]`) that you saved into the RUNTIME shot dir named in your prompt. The runner attaches **each finding's own screenshots to its own issue** (matched against the shot dir), so a triager sees exactly the evidence for that finding — not one issue with every shot. Name the files for the finding they show. If you omit `screenshots`, the runner falls back to any image filenames it can parse from your `title`/`description`, and mops up shots referenced by no finding onto the first created issue. A screenshot is evidence, not proof — still describe the defect in words.
- Keep the human-readable `.txt` (above) **in sync** — it stays the fallback source and the code-review filter target. If you cannot produce valid JSON for a finding, still write its `.txt` line; the runner derives an issue from it.


## Design-System Ownership Guardrail
`packages/design-system` is for generic, product-agnostic UI primitives only. Do not add, move, or keep app-specific/business-domain-aware components there just to enable reuse. Historical exceptions exist from before Desktop moved into this monorepo, such as `packages/design-system/components/ui/sessions-table.tsx`; treat those as cleanup candidates, not precedent.

When a component knows about ClosedLoop entities, workflows, routes, artifacts, sessions, branches, projects, loops, PRs, FEATs, PLANs, or other product concepts, it belongs in `packages/app` or the closest owning app surface. Shared app components that need web/Desktop reuse should go in `packages/app`, while `packages/design-system` should expose only generic primitives, tokens, and low-level building blocks.

Before proposing or implementing a design-system extraction, verify the candidate is domain-agnostic. If it is business-domain-aware, recommend `packages/app` instead and call out any existing design-system component that should be migrated back.

## Timeout & the optional 30-minute extension (all characters)
Each phase runs under a **SOFT deadline** (your normal budget) plus an optional **30-minute extension** ending in a **HARD kill**. When your phase has a finite timeout, the runner injects a `RUNTIME CLOCK` line with the `now`, `SOFT`, and `HARD` epochs — check elapsed time with `date +%s` and pace yourself against them.

The extension is a privilege for being *on the verge of greatness*, not a default:
- **Aim to finish and wrap up cleanly by the SOFT deadline.** That is your real budget.
- **You MAY run into the extension (up to HARD) only when you're clearly about to land a concrete, verified result** — a finding all-but-confirmed, a fix that's nearly green, a repro one step from red→green. Closing that out is worth the extra time.
- **If you're flailing** — spinning on the same file, no concrete finding or fix in hand, chasing a hunch — **STOP at SOFT.** Burning 30 more minutes on a dead end produces nothing and delays the rest of the crew. Emit your stand-up and exit.
- The process is **force-killed at HARD**: never be mid-edit, mid-build, or mid-push when it arrives. Leave a clean tree and a stand-up. (Phases with no timeout get no clock line — pace yourself sensibly regardless.)

## Validate before you finish (all characters)
Your fixes must leave a **green, reviewed working tree** — the runner commits, pushes, and opens
the PR for you, so a broken change becomes a red PR. Before you finish (do NOT run git add/commit/push
yourself):
1. **Build** the changed packages AND any app/package that consumes them — a cross-package change can
   pass typecheck yet fail at build/runtime (e.g. a Desktop main import that won't resolve):
   `pnpm turbo build --filter=<changed> --filter=<consumer>`.
2. **Typecheck + lint**: `pnpm turbo typecheck --filter=...`; `pnpm lint` (apply `pnpm lint:fix`).
3. **Tests**: `pnpm turbo test --filter=...` for affected packages; add/adjust tests for changed logic.
4. **Run `/code-review` on your own diff** — this is the team's standard code-review pass for every nightly and personal sweep. Resolve every BLOCKING/HIGH it surfaces before you finish (fix, or justify in the PR body); use its MEDIUM/LOW findings as cleanup signal. `/code-review` is the correctness/reuse/efficiency floor; your character lens is layered on top, not replaced by it.
If you can't make it green and clean, fix the approach — don't leave a broken tree. The PR body is
built from the repo PR template incl. the CI-enforced feature-flag attestation; if you introduce new
user-facing functionality, gate it behind a PostHog flag and note the key so the attestation is accurate.
Never write credentials, screenshots, or other workspace scratch into the repo tree (`.nightly-review/`
and `.scratch` are gitignored scratch — your committed change should be source only).

## Continuous Self-Improvement  — HOISTED: the single self-improvement operation EVERY agent runs
This shared block governs prompt self-improvement for all nightly agents (reviewers, Barry, the visual/validation characters, and anyone added later). Your prompt file lives at `SCRATCH_PROMPT_PATH` in the scratch repo at `SCRATCH_REPO_DIR`. After every run, weigh **BOTH** feedback sources below; when either teaches you something durable, tune your own governing prompt.

**Feedback sources — consider both, every run:**
- **Peer feedback** — what other characters or the apply-sweep flagged, covered, contradicted, or rejected about your output (a peer disproving your finding, a sibling already owning a surface, duplicate coverage).
- **Code-review feedback** — Codex (`chatgpt-codex-connector`), `closedloop-ai-stage`, and human comments on your findings / fix PRs.

### When to update your prompt
- **False positive** (from code review OR a peer): a reviewer/peer shows a finding type is wrong → add an exclusion rule so you stop flagging it
- **New pattern discovered**: you find a new class of issue the codebase is prone to → add a detection step
- **Missing context**: you needed a specific search strategy, file path, or framework knowledge → add it
- **Scope creep**: a reviewer says your fix/finding was too broad → tighten your detection criteria
- **Style / convention mismatch**: a reviewer rejects a pattern that doesn't match codebase conventions → note the convention
- **Package ownership**: a reviewer corrects where something belongs (e.g. `packages/design-system` = generic primitives, `packages/app` = ClosedLoop-aware shared UI) → record it
- **Duplicate findings / peer coverage**: another character already caught it → note their coverage area so you don't overlap

### How to update
1. Read your current prompt from `SCRATCH_PROMPT_PATH`
2. Apply the improvement: add filters, refine search terms, add exclusion rules, add new detection strategies
3. Save the updated prompt back to `SCRATCH_PROMPT_PATH`
4. Commit and push:
   ```
   git -C "SCRATCH_REPO_DIR" add "SCRATCH_PROMPT_PATH"
   git -C "SCRATCH_REPO_DIR" commit -m "self-improve(<name>): <reason for change>"
   git -C "SCRATCH_REPO_DIR" push
   ```

### Principles
- One improvement per finding cycle — don't rewrite the whole prompt, just tune it
- Be specific: instead of "check for bugs", add concrete grep patterns, file paths, or patterns to check
- Include the rationale in the commit message so the improvement is trackable
- If a finding was removed as a false positive in code review, definitely update your prompt to suppress that pattern
