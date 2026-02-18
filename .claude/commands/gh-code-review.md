---
description: Run comprehensive code review on PR and post inline comments (comments only, no approval/rejection)
argument-hint: "[PR_NUMBER] or leave blank to auto-detect"
---

# GitHub PR Code Review

Run a multi-agent code review that posts inline comments and a summary to GitHub PR. **Comments only - never approves or requests changes automatically.**

## Usage

```
/gh-code-review              # Auto-detect PR from current branch
/gh-code-review 123          # Review specific PR number
```

## Allowed Actions (Read-Only Review + Comment Management)

- ✅ READ files and analyze the PR diff
- ✅ Create inline review comments for new issues
- ✅ RESOLVE outdated inline comment threads (authored by `symphony-cl`) when issues are fixed
- ✅ Write review summary to `.claude/code-review-summary.md` (workflow handles posting)
- ❌ Do NOT checkout, switch branches, or modify any code
- ❌ Do NOT create, edit, or modify any files in the repository (except `.claude/code-review-summary.md` and `.claude/pr-review-patches.json`)
- ❌ Do NOT delete inline comments (only resolve threads)
- ❌ Do NOT merge, close, approve, or request changes on the PR

---

## Step 1: Create Todo List

**IMMEDIATELY use TodoWrite to create the workflow:**

```
TodoWrite([
  { content: "Get PR info and changed files", status: "pending", activeForm: "Getting PR info" },
  { content: "Run deterministic hygiene checks", status: "pending", activeForm: "Running hygiene checks" },
  { content: "Assess PR and route models", status: "pending", activeForm: "Assessing PR risk" },
  { content: "Spawn reviewer agents in parallel", status: "pending", activeForm: "Spawning agents" },
  { content: "Collect, normalize, and validate findings", status: "pending", activeForm: "Validating findings" },
  { content: "Clean up outdated inline comments", status: "pending", activeForm: "Cleaning up comments" },
  { content: "Post inline comments for validated findings", status: "pending", activeForm: "Posting comments" },
  { content: "Write summary to .claude/code-review-summary.md", status: "pending", activeForm: "Writing summary" }
])
```

---

## Step 2: Get PR Info and Changed Files

Mark todo "Get PR info and changed files" as `in_progress`.

### Parse Arguments

Parse $ARGUMENTS:
- If a number is provided: Use that as PR_NUMBER
- If empty: Get current branch and find associated PR

### Get PR Details

```bash
# Get current repo
gh repo view --json nameWithOwner -q .nameWithOwner
```

Store as **REPO** (format: "owner/repo")

```bash
# If no PR number provided, get from current branch
gh pr view --json number,headRefOid,files
```

Or with explicit PR number:

```bash
gh pr view <PR_NUMBER> --json number,headRefOid,files
```

Extract and store:
- **PR_NUMBER**: The PR number
- **HEAD_SHA**: The `headRefOid` (commit ID for inline comments)
- **FILES_TO_REVIEW**: Array of changed file paths from `files[].path`
- **OWNER**: First part of REPO before `/`
- **REPO_NAME**: Second part of REPO after `/`

### Fetch File Patches (CRITICAL)

**You MUST fetch the actual diff patches from GitHub API now**, before spawning any agents. This ensures agents can review the code even if the local checkout is incomplete (e.g., newly added files may not exist on disk).

```bash
# Fetch full patch data for all changed files
gh api repos/<OWNER>/<REPO_NAME>/pulls/<PR_NUMBER>/files --paginate
```

**Rate Limit Handling**: If you receive a 403 or rate limit error:
1. Wait 60 seconds and retry
2. For very large PRs (300+ files), fetch in batches using `?per_page=100&page=N`

Parse the response and store:
- **FILE_PATCHES**: Map of `{ "path/file.ts": "<patch content>", ... }` from each file's `patch` field
- **CHANGED_LINES**: Map of `{ "path/file.ts": [10, 11, 12, 45, 46], ... }` parsed from patches (only lines starting with `+`)
- **FILE_STATUSES**: Map of `{ "path/file.ts": "added" | "modified" | "removed", ... }` from each file's `status` field

These will be used in Step 4 (agent prompts) and Step 5 (validation).

### Write Patches to Disk (Required)

Write the complete patch data to `.claude/pr-review-patches.json` so the validation step (Step 5) can reference patches without re-fetching from the API:

```json
{
  "pr": PR_NUMBER,
  "headSha": HEAD_SHA,
  "patches": FILE_PATCHES,
  "changedLines": CHANGED_LINES,
  "statuses": FILE_STATUSES
}
```

```bash
# Write the JSON file (use node/python/jq to build valid JSON from the stored data)
```

This file is the single source of truth for all patch data used in subsequent steps.

Mark todo as `completed`.

---

## Step 2.5: Deterministic Hygiene Checks

Mark todo "Run deterministic hygiene checks" as `in_progress`.

Run scripted checks that don't need LLM reasoning. These catch CI artifacts, path leakage, and sensitive files deterministically.

### Hygiene Checks

For each check, iterate over FILES_TO_REVIEW (only files with status "added" or "modified"):

**Check 1: CI artifact detection** — files with absolute CI runner paths in their patch content:
```bash
# Search patch content for CI runner paths WITH line numbers
# Iterate added lines in FILE_PATCHES, record file + line number for each match
# Patterns: /home/runner/, /github/workspace/
```

**Check 2: Path leakage** — absolute machine-specific paths in new files:
```bash
# Search patch content for /Users/, /home/, C:\ patterns WITH line numbers
# Iterate added lines in FILE_PATCHES, record file + line number for each match
# Exclude node_modules references
```

**Check 3: Gitignore drift** — added files that should be ignored:
```bash
# For each file with status "added", check if it matches risky patterns:
# *.local, *.generated, .dev-*, *.env*, *.pem, *.key
git check-ignore --no-index <added_file> 2>/dev/null
```

**Check 4: Sensitive file patterns** — .env files, credentials, private keys in the diff:
```bash
# Check if any added/modified files match: *.env*, credentials*, *.pem, *.key, *secret*
```

### Severity Routing for Hygiene Findings

**Skip entirely** (allowlist — no finding generated):
- Files in `**/test/**`, `**/tests/**`, `**/__tests__/**`
- Files in `**/fixtures/**`, `**/examples/**`, `**/docs/**`
- Markdown and text files: `**/*.md`, `**/*.txt`

**Auto-upgrade to HIGH** (confidence 1.0):
- `.json` config files, package manifests
- `.env*`, `.pem`, `.key` files (secrets/credentials)
- `.ts`, `.tsx`, `.js`, `.jsx` files (runtime code with hardcoded paths)
- Files in project root (e.g., `.dev-environment.json`)

**Everything else**: MEDIUM, confidence 0.9

### Comment Target Strategy for Hygiene Findings

- **Line-specific findings** (grep matched a specific line): Use the **matched line number** as the comment anchor. All hygiene greps should capture line numbers (use `grep -n` or iterate patch lines) so findings anchor to the actual problematic content, not a fixed line.
- **New-file findings** (file status is "added" and the issue is file-level, e.g., shouldn't be committed at all): Use `line: 1` — all lines in a new file are in CHANGED_LINES, so line 1 is always a valid anchor.
- **Modified-file findings with no specific line** (e.g., gitignore drift for a file that exists but should be ignored): If the file is in the PR diff and has changed lines, anchor to the **first changed line** in CHANGED_LINES[file]. If the file is NOT in the diff, mark as `"inline": false` (summary-only).
- **Cross-file findings** (e.g., missing `.gitignore` pattern): If `.gitignore` is in the PR diff, comment on its last changed line. If NOT in the diff, mark as `"inline": false` (summary-only).
- **Summary-only findings** (`"inline": false`): Included in the review summary table but NOT posted as inline PR comments.

### Hygiene Finding Format

Store hygiene findings in the same format as agent findings. Use the actual matched line when available:

```json
{
  "file": "path/to/file",
  "line": 23,
  "severity": "HIGH",
  "category": "Repo Hygiene",
  "issue": "[P1] CI artifact committed — file contains /home/runner/ paths",
  "explanation": "Line 23 contains '/home/runner/work/project/dist/bundle.js'. This is a CI-generated path that should not be committed.",
  "recommendation": "Add this file to .gitignore and remove it from the PR.",
  "priority": 1,
  "confidence": 1.0,
  "inline": true
}
```

Mark todo as `completed`.

---

## Step 3: Assess PR and Route Models

Mark todo "Assess PR and route models" as `in_progress`.

### PR Assessment

Compute these values from FILES_TO_REVIEW:

```
files_changed = len(FILES_TO_REVIEW)

has_security_files = any file path contains: auth, session, payment, rbac, permission, clerk, jwt, middleware
has_data_files = any file path contains: prisma, migration, database
high_risk = has_security_files or has_data_files
```

### Model Routing

Based on PR size and risk, determine model assignments. Evaluate conditions **top-to-bottom**; first match wins:

| Condition | Bug Hunter A | Bug Hunter B | CLAUDE.md Auditor | Codebase Conventions | Validation |
|-----------|-------------|-------------|-------------------|---------------------|------------|
| **Small PR (≤10 files)** | opus | opus | sonnet | sonnet | opus |
| **Medium PR (11-40 files) AND high_risk** | opus | opus | sonnet | sonnet | opus |
| **Medium PR (11-40 files)** | opus | sonnet | sonnet | sonnet | opus |
| **Large PR (41+ files)** | sonnet | sonnet | sonnet | sonnet | opus targeted |

**Large + high_risk note:** The Opus sampling pass (below) already targets the riskiest files with Opus. Do NOT upgrade all agents to Opus for Large PRs — the cost and context pressure outweigh the benefit.

**For large PRs, add Opus sampling pass**: Select up to 5 high-risk hunks via deterministic scoring:

```
For each file in FILES_TO_REVIEW, compute risk score:
  +3  auth/session/payment/permission files (path contains auth|session|payment|rbac)
  +3  database/migration files (path contains prisma|migration|database)
  +2  state management (patch contains useState|useReducer|useMutation)
  +2  API route handlers (path matches app/api/ or route.ts)
  +1  error handling (patch contains catch|throw|try)
  +1  files with >50 changed lines

Sort by score DESC, then by file path ASC (stable tiebreaker).
Take top 5. Feed these to an Opus agent for direct review.
```

### Select Domain Critics (Layer 4)

Read `.claude/settings/critic-gates.json` and extract:
- **baseCritics**: Always-run critics (used for reference, but replaced by Layers 1-2)
- **moduleCritics**: Pattern-to-critic mappings
- **reviewBudget**: Max additional domain critics (from config, currently 5; capped at min(reviewBudget, 2) for Layer 4 to limit cost)

```python
# Only select domain critics for high-stakes areas
selected_domain_critics = []
pr_context = " ".join(FILES_TO_REVIEW).lower()
max_domain_critics = min(critic_config["defaults"]["reviewBudget"], 2)

# Only trigger for security, database, payment modules
high_stakes_modules = [m for m in critic_config["moduleCritics"]
                       if any(p in ["auth", "session", "payment", "prisma", "database", "stripe"]
                              for p in m["patterns"])]

for module in high_stakes_modules:
    for pattern in module["patterns"]:
        if pattern.lower() in pr_context:
            selected_domain_critics.extend(module["critics"])
            break

# Cap at min(reviewBudget, 2) domain critics (sort for deterministic selection across runs)
selected_domain_critics = sorted(set(selected_domain_critics))[:max_domain_critics]
```

Report to user: model routing decision, which agents will run, and domain critics (if any).

Mark todo as `completed`.

---

## Step 4: Spawn Reviewer Agents

Mark todo "Spawn reviewer agents in parallel" as `in_progress`.

### Agent Type (CRITICAL — prevents context overflow)

**ALL agents spawned by this command MUST use `subagent_type: "general-purpose"` in the Task tool call.** Do NOT omit the subagent_type parameter — Claude Code will auto-select `symphony-core:code-reviewer` or `experimental:code-reviewer`, which have 130-330 line system prompts and load additional files at startup. This bloats every sub-agent's context by ~50K+ tokens before your prompt even starts, causing "long context beta" failures on large PRs. The review instructions are already fully specified in the prompt below — a specialized code-reviewer agent is redundant and harmful.

The only exceptions are domain critics (Layer 4), which use their own `symphony-fe:*` subagent types as specified in the critic-agent mapping table.

### Review Architecture — 4 Layers

**Layer 1 — General Bug Detection** (always runs):

| Agent | Role | Focus |
|-------|------|-------|
| Bug Hunter A | Diff-only scan | Syntax/type errors, null/undefined, logic bugs, security, state management |
| Bug Hunter B | Codebase-aware | DRY violations, API contract verification, pattern consistency, import validation |

**Layer 2 — Project Intelligence** (always runs):

| Agent | Role | Focus |
|-------|------|-------|
| CLAUDE.md Auditor | Project rule compliance | Check against ALL CLAUDE.md rules + learned patterns |
| Codebase Conventions | Architectural rules | Data access patterns, type locations, service layer |

**Layer 3 — Codebase-Aware Deep Review** (built into Bug Hunter B's prompt)

**Layer 4 — Domain Amplification** (conditional, from critic-gates.json):
- Only for high-stakes domains (auth, database, payments)
- Max 2 supplementary Sonnet critics
- Run alongside Layers 1-2

### File Partitioning (Critical for Large PRs)

Background agents do NOT have Bash tool access. All review data MUST be provided inline in the agent prompt.

**Partition files across agents to stay within token limits:**

1. **Small PRs (≤30 files)**: Include ALL file patches in each agent's prompt
2. **Medium PRs (31-80 files)**: Partition files so each agent gets at most 30 files
3. **Large PRs (81+ files)**: Cap at 25 files per agent. Create multiple agent instances if needed

### Partition-to-Agent Mapping

Partitions are computed ONCE. Each partition is reviewed by one instance of each active agent type.

**Layer 2 agents skip test files.** CLAUDE.md Auditor and Codebase Conventions focus on production code patterns — exclude `*.test.*`, `*.spec.*`, `__tests__/` files from their partitions. This significantly reduces agent count on test-heavy PRs.

**Total agents** = (full partitions × 2 Bug Hunters) + (non-test partitions × 2 auditors) + domain critics. **Cap at 16 total.** If over budget, merge smallest partitions and limit Layer 2 to 2 partitions max.

### Shared Prompt Prefix (ALL agents get this)

**CRITICAL**: The `mode: standalone` line MUST be present in every agent prompt. If missing, the code-reviewer agent defaults to loop mode which suppresses Critical/High findings.

```
mode: standalone

Review ONLY the changed code in this PR. Return findings as JSON.

<data>
<files_assigned count="{N}" total="{TOTAL}">
- {filepath_1} ({status_1})
- {filepath_2} ({status_2})
...
</files_assigned>

<diff>
--- {filepath_1} ({status_1}) ---
{patch_content_1}

--- {filepath_2} ({status_2}) ---
{patch_content_2}
...
</diff>
</data>

<constraints>
TOOL RESTRICTIONS:
- You MUST NOT use the Bash tool. You do not have Bash access.
- You MUST NOT try to run shell commands, gh api calls, or any terminal commands.
- You CAN use: Read, Grep, Glob tools to explore the local codebase for additional context.
- All patch/diff data is provided in <diff> above. Do NOT try to fetch it from GitHub.

FLAG an issue ONLY when ALL are true:
1. Introduced in this PR (not pre-existing)
2. The original author would likely fix it if aware
3. Does not rely on unstated assumptions
4. Discrete and actionable
5. Concrete evidence cited

Do NOT flag:
- Pre-existing issues, style preferences, linter-catchable issues
- General quality concerns (coverage, docs), pedantic nitpicks
- Hypothetical edge cases dependent on specific inputs/state
</constraints>

<instructions>
JUSTIFICATION COMMENTS:
Inline justification comments (// Intentionally..., // Required for...) REDUCE your
confidence in a finding but do NOT auto-discard.
- Strong justification that addresses your exact concern → discard
- Weak or generic justification → report at confidence 0.5-0.7, note the justification
- No justification → normal confidence assessment

SEVERITY + PRIORITY (use existing severity as primary, add priority as signal):
- BLOCKING (P0): Security vulnerabilities, runtime crashes, data loss/corruption
- HIGH (P1): Bugs that WILL cause errors in production, broken API contracts, race conditions
- MEDIUM (P2): Real code quality issues, DRY violations, minor bugs
- MEDIUM (P3): Suggestions, nice-to-haves

EVIDENCE STANDARDS:
Your EVIDENCE must be concrete. Your DESCRIPTION can express conditional behavior —
what matters is proving the condition exists.
- Can you describe the exact input/state that triggers the bug AND the exact wrong behavior? → HIGH/BLOCKING
- Circumstantial but real evidence → MEDIUM
- Speculation → discard
</instructions>

<examples>
<example name="good-high-finding">
CORRECT — Proven bug with concrete evidence:
{
  "file": "apps/app/components/editable-field.tsx",
  "line": 47,
  "severity": "HIGH",
  "category": "Correctness",
  "issue": "[P1] handleSave double-fires on Enter key then blur",
  "explanation": "onKeyDown handler calls handleSave() on Enter at line 47, then focus moves away triggering onBlur which also calls handleSave() at line 52. Two concurrent API calls mutate the same field — the second overwrites the first with stale data.",
  "recommendation": "Add a `saving` ref guard: if (savingRef.current) return; savingRef.current = true;",
  "code_snippet": "onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}",
  "priority": 1,
  "confidence": 0.95
}
</example>

<example name="good-medium-dry">
CORRECT — DRY violation with concrete prior art:
{
  "file": "apps/app/components/editable-description.tsx",
  "line": 12,
  "severity": "MEDIUM",
  "category": "Code Quality",
  "issue": "[P2] EditableDescription duplicates EditableTitle (apps/app/components/editable-title.tsx)",
  "explanation": "This component shares ~70% structure with EditableTitle: same useState/useRef pattern, same handleSave with trimming, same onKeyDown/onBlur handlers. Only the HTML element (textarea vs input) and placeholder differ.",
  "recommendation": "Extract shared logic into a useEditableField hook or a generic EditableField component parameterized by element type.",
  "code_snippet": "const [value, setValue] = useState(initialValue);",
  "priority": 2,
  "confidence": 0.85
}
</example>

<example name="bad-speculation">
WRONG — Speculation, not a proven bug (DO NOT output findings like this):
{
  "severity": "HIGH",
  "issue": "Removing the config option could break users who depend on it",
  "explanation": "This config was used by some features and removing it might cause issues."
}
Why it's wrong: Uses "could break" and "might cause". No evidence of WHAT breaks or HOW.
</example>

<example name="bad-observation">
WRONG — Observation about a change, not a bug (DO NOT output findings like this):
{
  "severity": "HIGH",
  "issue": "Cache strategy changed from Redis to in-memory",
  "explanation": "The caching approach was changed which may impact performance at scale."
}
Why it's wrong: Documents a change. Uses "may impact". No proven bug — the change is intentional.
</example>
</examples>

Before outputting your findings, reason through each one in <thinking> tags:
- Is this a proven bug or just an observation about a change?
- Does my evidence support the assigned severity?
- Did I check for error handling that prevents this issue?
- Would the original author fix this if they knew? Or would they say "that's intentional"?

Then output your JSON report.

<output_format>
{
  "findings": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "severity": "HIGH",
      "category": "Correctness",
      "issue": "[P1] Brief imperative title under 80 chars",
      "explanation": "One paragraph. Why this is wrong. Cite code and evidence.",
      "recommendation": "How to fix (brief)",
      "code_snippet": "problematic code",
      "priority": 1,
      "confidence": 0.9
    }
  ]
}

If you find NO issues, return: {"findings": []}
Empty findings is a valid response for clean code.
</output_format>
```

### Agent-Specific Prompts

Append these to the shared prefix for each agent:

**Bug Hunter A** (diff-only, model per routing table):
```
You are Bug Hunter A — a diff-only reviewer focused on correctness.

Focus areas:
- Syntax/type errors, null/undefined handling, logic bugs
- Security: injection, auth bypass, data exposure
- State management: double-trigger patterns (onKeyDown + onBlur), stale closures
- API calls: parameter semantics (undefined vs null vs empty string)
- Error handling: missing try-catch on async, unhandled promise rejections

You must use Read, Grep, and Glob tools (NOT Bash) for codebase context.
```

**Bug Hunter B** (codebase-aware, model per routing table):
```
You are Bug Hunter B — a codebase-aware reviewer focused on cross-file issues.

Focus areas:
- DRY: Use Grep to search for similar function/component names. Flag >60% structural
  similarity with existing code. Cite the existing file path.
- API contracts: Read service implementations to verify call correctness.
  Check that parameters match (undefined vs null vs empty string matters).
- Pattern consistency: Find existing examples of similar code, verify new code matches.
- Import validation: Verify imports resolve to real modules.

For DRY claims, one concrete example of prior art is sufficient (cite file path + function name).

IMPORTANT: Read the repository root CLAUDE.md file before starting your review. Use it for
DRY detection (check Learned Patterns for known conventions) and pattern consistency checks.
```

Do NOT embed the full CLAUDE.md in Bug Hunter B's prompt — it consumes orchestrator context. The agent reads the file itself via the Read tool.

**CLAUDE.md Auditor** (sonnet):
```
You are the CLAUDE.md Auditor — you check PR changes against project-specific rules.

Read all applicable CLAUDE.md files:
- Repository root CLAUDE.md
- Any directory-level CLAUDE.md files relevant to changed file paths

For each changed file, check against:
1. Rules tagged [mistake] in CLAUDE.md Learned Patterns — these are HIGH severity
2. Rules tagged [convention] — these are MEDIUM severity
3. Rules tagged [pattern] — these are MEDIUM severity (verify pattern is followed)
4. Explicit rules in the main CLAUDE.md sections (Architecture, Type Definitions, etc.)

For every finding, cite the exact rule text from CLAUDE.md.

Dynamically build your checklist based on changed file types:
- .ts/.tsx in apps/app/ → check data access pattern, type locations
- .ts in apps/api/ → check service layer, route structure, error handling
- .prisma → check migration conventions
- packages/** → check code organization rules
```

**Codebase Conventions** (sonnet):
```
You are the Codebase Conventions reviewer — you verify architectural rules.

Focus areas:
- Data access patterns: Frontend must NOT import @repo/database directly
- Type locations: Shared types in packages/api/src/types/, not duplicated
- Service layer: Routes delegate to services, services handle DB access
- Incomplete changes: Component without export, route without registration
- Import ordering: @repo/* before @/* path aliases

Use Grep and Glob to verify claims. Do NOT flag issues without searching first.
```

**Domain Critics** (from critic-gates.json, if selected in Step 3):

Use the same critic-agent mapping as before, but only for selected domain critics:

| Critic | Subagent Type |
|--------|---------------|
| security-privacy | symphony-fe:security-privacy |
| auth-security-expert | symphony-fe:auth-security-expert |
| database-architect | symphony-fe:database-architect |
| api-architect | symphony-fe:api-architect |
| caching-strategist | symphony-fe:caching-strategist |

**Guard:** If a selected domain critic has no entry in this table, skip it and log a warning
(e.g., `"⚠️ Skipping unmapped critic: {name}"`). This prevents failures when critic-gates.json
adds new critics before this mapping is updated.

Use `model: "sonnet"` for all domain critics.

### Opus Sampling Pass (Large PRs only)

For large PRs (41+ files), spawn an additional Opus agent with the top 5 high-risk files (from Step 3 scoring). This agent uses the Bug Hunter A prompt but reviews only the selected files. It catches bugs Sonnet might miss in the riskiest hunks.

**In a SINGLE message, spawn ALL agents with `run_in_background: true`.**

Mark todo as `completed`.

---

## Step 5: Collect, Normalize, and Validate Findings

Mark todo "Collect, normalize, and validate findings" as `in_progress`.

Use `TaskOutput` with `block: true` to collect results from each spawned agent.

### Step 5.1: Severity Normalization

Normalize ALL agent findings to the schema-valid severity values before any validation:

```
Critical  → BLOCKING
High      → HIGH
Medium    → MEDIUM
Low       → discard (below review threshold)
BLOCKING  → BLOCKING  (already normalized)
HIGH      → HIGH      (already normalized)
MEDIUM    → MEDIUM    (already normalized)
*         → MEDIUM    (unknown severity → safe default, log warning)
```

Case-insensitive matching. Track `normalization_warnings` count for unknown values.

### Step 5.2: Merge Hygiene Findings

Add findings from Step 2.5 (deterministic hygiene) to the normalized agent findings. These are already in the correct format and severity.

### Step 5.3: Mechanical Validation (Layer A — no agents, fast)

**First, apply defaults for optional fields** (prevents undefined branches downstream):
- `finding.priority ??= severity_to_priority(finding.severity)` where BLOCKING→0, HIGH→1, MEDIUM→2
- `finding.confidence ??= 1.0` (agents that don't emit confidence are already validated)
- `finding.inline ??= true`

Then for each finding:

1. **File in PR?** If finding's file NOT in FILES_TO_REVIEW → **DISCARD**
   - Exception: findings with `inline === false` skip this check (summary-only findings from Step 2.5 may reference files outside the PR, e.g., missing .gitignore patterns)
2. **Line in changed lines ±3?** If finding's line NOT within 3 lines of CHANGED_LINES[file] → **DISCARD**
   - Exception: findings with `inline === false` skip this check (summary-only)
3. **Duplicate?** Same file + line (±3) + same category → **MERGE** (keep highest severity). Also merge if same file + line (±3) + same recommendation, even across categories.
4. **Confidence threshold** (severity-gated to prevent suppression):
   - P0/P1 (BLOCKING/HIGH): **never discard on confidence** — always send to validation
   - P2/P3 (MEDIUM): discard if `confidence < 0.5`

### Step 5.4: Agent Validation (Layer B — targeted)

Validate findings where LLM verification adds value. Spawn a single Opus validation agent (use `subagent_type: "general-purpose"`) for:

- **All BLOCKING/HIGH findings** (regardless of confidence)
- **MEDIUM findings involving API contracts, DRY, or cross-file semantics**

Skip validation for:
- MEDIUM findings that are local/simple (confidence is sufficient)
- Findings with priority 3 (suggestions)

**Validation agent prompt:**
```
You are a code review validator. Your job is to verify whether reported findings are real
bugs or false positives. You are the last line of defense against noise.

<data>
<findings>
{findings_json}
</findings>

<patches>
{relevant_patches}
</patches>
</data>

<instructions>
For each finding:
1. Read the file at the reported location (use Read tool, not Bash)
2. Verify the code actually contains the claimed issue at the cited line
3. Check for guards, error handling, try-catch, or validation that prevents the issue
4. If a justification comment exists, assess whether it addresses the actual concern
5. For DRY claims, verify the cited existing code actually exists and is structurally similar
</instructions>

<examples>
<example name="confirmed">
Finding: "handleSave double-fires on Enter then blur" at editable-field.tsx:47
Verification: Read file. Line 47 has onKeyDown calling handleSave on Enter. Line 52 has
onBlur also calling handleSave. No debounce or guard ref exists. → CONFIRMED
</example>
<example name="rejected">
Finding: "Missing null check on user.data" at profile.tsx:23
Verification: Read file. Line 18 has `if (!user?.data) return null;` guard before line 23.
The finding missed existing error handling. → REJECTED (guard exists at line 18)
</example>
<example name="downgrade">
Finding: "HIGH: Unbounded Promise.all on user array" at batch.tsx:15
Verification: Read file. The array comes from a database query with LIMIT 50 at line 8.
Not truly unbounded, but 50 concurrent calls is still suboptimal. → DOWNGRADE to MEDIUM
</example>
</examples>

<output_format>
Return a JSON array with one entry per finding:
[
  { "index": 0, "verdict": "CONFIRMED", "reason": "..." },
  { "index": 1, "verdict": "REJECTED", "reason": "Guard exists at line 18" },
  { "index": 2, "verdict": "DOWNGRADE", "reason": "Array is bounded by LIMIT 50" }
]
</output_format>
```

Apply validation results:
- CONFIRMED → keep as-is
- REJECTED → **DISCARD** (reason: "Rejected by validation")
- DOWNGRADE → lower severity to MEDIUM

### Step 5.5: Deduplication and Consolidation

Group findings by root cause. Two findings share a root cause when ANY of these match:
- Same category + similar issue text
- Same file + overlapping line (±3) + same or equivalent recommendation
- Different categories but describing the same underlying code problem

When multiple findings share the same underlying issue:
- Keep the finding with the HIGHEST severity as the primary
- Include all other occurrences as "Other Locations"
- Post a SINGLE inline comment on the primary location that lists all affected locations

### Normalization Telemetry

If `normalization_warnings > 0`, record for the summary:
```
⚠️ Severity normalization: N findings had non-standard severity values
   (mapped to MEDIUM). Agent output may have drifted from schema.
   Values seen: [list of non-standard values]
```

### Discard Reasons

- **DISCARD_FILE_NOT_CHANGED**: Finding is in a file not modified by this PR
- **DISCARD_LINE_NOT_CHANGED**: Finding is on a line that wasn't touched in this PR
- **DISCARD_LOW_CONFIDENCE**: MEDIUM finding with confidence < 0.5
- **DISCARD_REJECTED**: Rejected by validation agent (with reason)
- **DISCARD_DUPLICATE**: Consolidated into root cause group
- **DOWNGRADE_TO_MEDIUM**: Validation agent downgraded severity

Track validated findings and discarded findings with specific reasons.

Mark todo as `completed`.

---

## Step 6: Clean Up Outdated Inline Comments

Mark todo "Clean up outdated inline comments" as `in_progress`.

**CRITICAL**: This step prevents duplicate comments and resolves fixed issues.

1. **List existing review threads**:

```bash
gh api graphql -f query='
query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      reviewThreads(first:100) {
        nodes {
          id
          isResolved
          path
          line
          comments(first:10) {
            nodes {
              id
              body
              author { login }
            }
          }
        }
      }
    }
  }
}' -f owner="<OWNER>" -f name="<REPO_NAME>" -F number=<PR_NUMBER>
```

2. **For each unresolved thread authored by a review bot** (`symphony-cl`, `closedloop-ai[bot]`, or `closedloop-ai-stage[bot]`):
   - Check if `isResolved` is true: SKIP
   - Read current state of file/line (use FILE_PATCHES for added files)
   - If issue is FIXED or line no longer exists: **RESOLVE** it

**IMPORTANT**: Inline comments must be RESOLVED, never deleted. Resolving preserves the review history while collapsing addressed threads. Symphony summary comments are marked as outdated by the CI workflow, not deleted.

3. **Resolve outdated threads** (with error handling):

```bash
# Resolve thread - capture output to check for errors
RESULT=$(gh api graphql -f query='
mutation($threadId:ID!) {
  resolveReviewThread(input:{threadId:$threadId}) {
    thread { isResolved }
  }
}' -f threadId="<THREAD_ID>" 2>&1)

# Check for errors in response
if echo "$RESULT" | grep -q "errors"; then
  echo "Warning: Failed to resolve thread <THREAD_ID> - continuing"
fi
```

**Error Handling**: If GraphQL mutation fails:
- Log the error but continue processing other threads
- Common failures: thread already resolved, permission denied, thread not found
- Do NOT fail the entire review due to cleanup errors

4. **Build dedup map** of remaining unresolved threads: `{file:line:category}`

Mark todo as `completed`. **Then proceed to Step 7** — posting NEW inline comments is a separate step.

---

## Step 7: Post Inline Comments

**CRITICAL**: This step posts NEW findings from the review agents. It is INDEPENDENT from Step 6 (cleanup). Even if Step 6 found zero existing comments, you MUST still execute this step to post inline comments for each validated finding. Do NOT skip this step.

Mark todo "Post inline comments for validated findings" as `in_progress`.

For each validated finding where `inline !== false` (all severities):

1. **Check dedup map**: If `file:line:category` already has comment, SKIP
2. **Verify line is in diff**: Only post if line exists in CHANGED_LINES[file] (±3 line tolerance)
3. **Create inline comment** (with error handling):

Use the `mcp__github_inline_comment__create_inline_comment` tool if available, OR use gh api:

```bash
# Wrap in error handling - don't fail entire review if one comment fails
COMMENT_RESULT=$(gh api repos/<OWNER>/<REPO_NAME>/pulls/<PR_NUMBER>/comments \
  -f body="**[SEVERITY]** Category

Issue description

**Recommendation:** How to fix

\`\`\`
code snippet
\`\`\`" \
  -f path="<FILE_PATH>" \
  -F line=<LINE_NUMBER> \
  -f commit_id="<HEAD_SHA>" 2>&1) || true

# Check for line resolution errors - these are expected for edge cases
if echo "$COMMENT_RESULT" | grep -q "could not be resolved"; then
  echo "Warning: Could not post comment on <FILE_PATH>:<LINE_NUMBER> - line not in diff"
  # Continue to next finding, don't fail
fi
```

**Error Handling**: If inline comment fails with "line could not be resolved":
- Log warning but continue processing other findings
- Add to summary as "comment skipped - line not in diff"
- Do NOT fail the entire review

**Comment Format (with priority annotation):**

```markdown
**[HIGH]** Correctness

[P1] Double-fire: handleSave triggers on both Enter keydown and blur event.

**Recommendation:** Guard against double-fire by checking if save is already in progress.

```typescript
const handleSave = () => { ... }
```
```

**Consolidated Finding Format** (when multiple findings share root cause):

````markdown
**[SEVERITY]** Category

Issue description

**Other Locations** (N more):
- `path/file.ts:87` - same pattern in `functionName()`
- `path/file.ts:124` - same pattern in `otherFunction()`

**Recommendation:** How to fix
````

**Counter tracking**: Before iterating findings, initialize counters:
- `inline_eligible_count` = number of validated findings where `inline !== false`
- `posted_count = 0`
- `skipped_dedup = 0`
- `skipped_line = 0`
- `failed_api = 0`

Increment within the loop: `posted_count++` after a successful post, `skipped_dedup++` when the dedup map matches, `skipped_line++` when the line is not in the diff, `failed_api++` when the API call fails for any reason (line resolution error, rate limit, permission denied, etc.).

**After posting**: Report counts (e.g., "Posted 5 inline comments, 2 skipped (1 duplicate, 1 line not in diff), 1 failed"). If `posted_count + skipped_dedup + skipped_line + failed_api < inline_eligible_count`, some findings were silently lost — re-check the findings list. Zero posted comments is expected when all findings are legitimately skipped or failed.

Mark todo as `completed`.

---

## Step 8: Write Summary to File

Mark todo "Write summary to .claude/code-review-summary.md" as `in_progress`.

**CRITICAL**: This step is MANDATORY, even if there are no findings.

### Determine Status Label (for summary only)

Based on validated findings, set status label for the summary comment:
- **BLOCKING findings > 0**: "Changes Requested" (label only)
- **HIGH findings > 0 + no BLOCKING**: "Needs Attention" (label only)
- **MEDIUM only or no findings**: "Approved" (label only)

**IMPORTANT**: These are LABELS for the summary comment only. Do NOT use `--approve` or `--request-changes` flags.

### Write Summary to File

Write the summary to `.claude/code-review-summary.md`. The CI workflow will handle marking old summaries as outdated and posting the new one deterministically.

```bash
# Write the summary content to the file
cat > .claude/code-review-summary.md << 'SUMMARY_EOF'
<summary content here>
SUMMARY_EOF
```

**Do NOT** post the summary to GitHub directly. Do NOT use `gh api` to create comments or `gh pr review` to submit a review. The workflow handles all GitHub posting after Claude exits.

### Summary Format

```markdown
## Code Review Summary

**Status:** [Approved | Changes Requested | Needs Attention]

**Reviewers:** Bug Hunter A, Bug Hunter B, CLAUDE.md Auditor,
Codebase Conventions [+ domain specialists if triggered]

### Findings

| Severity | Count |
|----------|-------|
| Blocking | X |
| High | Y |
| Medium | Z |

### BLOCKING Issues (must fix)
1. **[P0] [file:line]** Title

### HIGH Issues (should fix)
1. **[P1] [file:line]** Title

### MEDIUM Issues (consider)
1. **[P2] [file:line]** Title
2. **[P3] [file:line]** Title

**Recommendation:** [Approve | Address blocking/high issues | Consider medium items]
```

Include **summary-only findings** (those with `"inline": false`) in the appropriate severity section — these don't have inline comments but should still be visible in the summary.

If `normalization_warnings > 0`, append after the findings table:
```
⚠️ Severity normalization: N findings had non-standard severity values (mapped to MEDIUM).
```

**Summary constraints:**
- Keep it CONCISE (max 500 words) — no multi-paragraph explanations or lengthy prose
- Do NOT repeat what inline comments already say — just reference file:line
- Focus on actionable findings only
- **NO FOOTER**: Do NOT add any signature, attribution, or footer like "Automated review by Claude Code"

Mark todo as `completed`.

---

## Arguments

$ARGUMENTS
