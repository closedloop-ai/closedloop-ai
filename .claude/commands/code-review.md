---
description: Run comprehensive code review using 4-layer critic agents with validation
argument-hint: [scope] - optional: "staged", "branch", or file paths
---

# Comprehensive Code Review

Run a multi-agent code review with 4-layer architecture, deterministic hygiene checks, model routing, and validated findings.

<!-- MAINTENANCE: Steps 2.5, 3, 4, and 5 share architecture with gh-code-review.md.
     Sections that must stay in sync: hygiene checks, agent prompts, severity routing,
     model routing table, domain critic selection, and validation pipeline.
     Key difference: this command uses git diff (local), gh-code-review uses GitHub API.
     This command outputs to terminal; gh-code-review posts inline comments. -->

## Usage

```
/code-review              # Review all changes on current branch vs main (default)
/code-review staged       # Review only staged changes
/code-review file1 file2  # Review specific files
```

---

## Step 1: Create Todo List

**IMMEDIATELY use TodoWrite to create the workflow:**

```
TodoWrite([
  { content: "Parse scope and get diff data", status: "pending", activeForm: "Parsing scope" },
  { content: "Run deterministic hygiene checks", status: "pending", activeForm: "Running hygiene checks" },
  { content: "Assess scope and route models", status: "pending", activeForm: "Assessing risk" },
  { content: "Spawn reviewer agents in parallel", status: "pending", activeForm: "Spawning agents" },
  { content: "Collect, normalize, and validate findings", status: "pending", activeForm: "Validating findings" },
  { content: "Present findings by severity", status: "pending", activeForm: "Presenting results" }
])
```

---

## Step 2: Parse Scope and Get Diff Data

Mark todo "Parse scope and get diff data" as `in_progress`.

### Parse Arguments

Parse $ARGUMENTS and store **DIFF_SCOPE** (the resolved git diff arguments used by all subsequent diff commands):
- If empty or "branch": `DIFF_SCOPE="main...HEAD"` (default — reviews all changes on current branch)
- If "staged": `DIFF_SCOPE="--cached"`
- If file paths: `DIFF_SCOPE="main...HEAD -- <files>"`

### Get Diff Data (lightweight — no full patches yet)

```bash
# Get file list (small output)
git diff --name-only $DIFF_SCOPE

# Get file statuses (small output)
git diff --name-status $DIFF_SCOPE

# Get machine-parseable LOC counts (tab-separated: added \t removed \t file)
git diff --numstat $DIFF_SCOPE

# Get changed line ranges (no context, just hunk headers — for CHANGED_RANGES)
git diff -U0 $DIFF_SCOPE
```

**Do NOT run `git diff $DIFF_SCOPE` (full patches with context) here.** For large diffs (10K+ LOC), the full patch output exceeds tool output limits and gets truncated. Patches are fetched by each reviewer agent in Step 4.

**`-U0` is safe here** — it outputs only hunk headers and changed lines (no context), so output is roughly 1x the changed line count, not 4x. For a 10K LOC PR this is ~800K chars ≈ 200K tokens. If FILES_TO_REVIEW exceeds 200 files, fetch `-U0` in batches of 100 files.

Parse and store:
- **FILES_TO_REVIEW**: Array of changed file paths
- **FILE_STATUSES**: Map of `{ "path/file.ts": "added" | "modified" | "removed", ... }` parsed from `--name-status` output (A=added, M=modified, D=removed, R=renamed)
- **FILE_LOC**: Map of `{ "path/file.ts": { added: N, removed: M }, ... }` parsed from `--numstat` output (machine-readable, no truncation unlike `--stat`)
- **TOTAL_LOC**: Sum of all added + removed across all files (used for model routing in Step 3)
- **CHANGED_RANGES**: Map of `{ "path/file.ts": { added: [[10,15], [45,47]], removed: [[20,22]] }, ... }` parsed from `-U0` hunk headers (`@@ -start,count +start,count @@`). Tracks BOTH added and removed ranges — removed ranges catch bugs introduced by deleting guards/checks.

Mark todo as `completed`.

---

## Step 2.5: Deterministic Hygiene Checks

Mark todo "Run deterministic hygiene checks" as `in_progress`.

Run scripted checks that don't need LLM reasoning. These catch CI artifacts, path leakage, and sensitive files deterministically.

**Hygiene runs in the orchestrator using lightweight grep commands** — no sub-agent needed. The `-U0` output from Step 2 already contains the changed lines without context bloat, and CHANGED_RANGES is already parsed. Hygiene checks operate on file paths and the `-U0` patch lines.

For checks that need patch content (Checks 1-2), use targeted grep on the `-U0` output already in context, or run scoped `git diff -U0` per-file for matches. These are small outputs.

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

**Line fallback for file-level findings** (applies to all checks):
- If a grep matched a specific content line → use that line number
- If the finding is file-level (e.g., Check 3/4 matched by filename pattern, not content) and file status is "added" → use `line: 1` (all lines are changed)
- If the finding is file-level and file status is "modified" → use the first entry in CHANGED_LINES[file]

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
  "recommendation": "Add this file to .gitignore and remove it from the branch.",
  "priority": 1,
  "confidence": 1.0
}
```

Mark todo as `completed`.

---

## Step 3: Assess Scope and Route Models

Mark todo "Assess scope and route models" as `in_progress`.

### Scope Assessment

Compute these values from FILES_TO_REVIEW and FILE_LOC:

```
files_changed = len(FILES_TO_REVIEW)
total_changed_loc = TOTAL_LOC  # from Step 2

has_security_files = any file path contains: auth, session, payment, rbac, permission, clerk, jwt, middleware
has_data_files = any file path contains: prisma, migration, database
high_risk = has_security_files or has_data_files
```

### Model Routing

Route models based on **total changed LOC + risk**, not file count. A 10K LOC PR in 8 files is not "Small."

| Condition | Bug Hunter A | Bug Hunter B | CLAUDE.md Auditor | Codebase Conventions | Validation |
|-----------|-------------|-------------|-------------------|---------------------|------------|
| **Small (≤500 LOC) OR high_risk** | opus | opus | sonnet | sonnet | opus |
| **Medium (501-2000 LOC)** | opus | sonnet | sonnet | sonnet | opus |
| **Large (2001+ LOC)** | sonnet | sonnet | sonnet | sonnet | opus targeted |

**For large diffs, add Opus sampling pass**: Select up to 5 high-risk files via deterministic scoring:

```
For each file in FILES_TO_REVIEW, compute risk score using PATH-ONLY signals
(no patch content — orchestrator does not fetch patches):

  +3  auth/session/payment/permission files (path contains auth|session|payment|rbac)
  +3  database/migration files (path contains prisma|migration|database)
  +2  API route handlers (path matches app/api/ or route.ts)
  +2  middleware files (path contains middleware)
  +1  files with >50 changed lines (from FILE_LOC)
  +1  test files with >100 changed lines (unusually large test changes)

Sort by score DESC, then by file path ASC (stable tiebreaker).
Take top 5. Feed these to an Opus agent for direct review.
```

### Select Domain Critics (Layer 4)

Read `.claude/settings/critic-gates.json` and extract:
- **baseCritics**: Always-run critics (used for reference, but replaced by Layers 1-2)
- **moduleCritics**: Pattern-to-critic mappings
- **reviewBudget**: Max additional domain critics (capped at 2 for Layer 4)

```python
# Only select domain critics for high-stakes areas
selected_domain_critics = []
file_context = " ".join(FILES_TO_REVIEW).lower()
max_domain_critics = min(critic_config["defaults"]["reviewBudget"], 2)

# Only trigger for security, database, payment modules
high_stakes_modules = [m for m in critic_config["moduleCritics"]
                       if any(p in ["auth", "session", "payment", "prisma", "database", "stripe"]
                              for p in m["patterns"])]

for module in high_stakes_modules:
    for pattern in module["patterns"]:
        if pattern.lower() in file_context:
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

**CONTEXT BUDGET WARNING:** The orchestrator must NOT read source files or fetch patches itself. All file reading and patch fetching is delegated to sub-agents. The orchestrator's context should contain ONLY: file lists, statuses, LOC counts, risk scores, and agent results (small JSON). If the orchestrator reads source files or fetches diffs, it will exhaust its context window on large PRs and fail.

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

### File Partitioning (Critical for Large Diffs)

**Agents self-fetch patches.** The orchestrator does NOT fetch patch content — it only passes lightweight metadata (file list, statuses, DIFF_SCOPE). Each agent runs `git diff` itself to get its assigned files' patches. This keeps the orchestrator's context small regardless of PR size.

**Partition files using LOC budget, not file count.** File count is unreliable — a 20-file PR where each file changes 500 LOC will overflow the agent context just as easily as an 80-file PR.

Use FILE_LOC from Step 2 to partition:

1. **LOC budget per partition: 400 changed lines** (added + removed). `git diff` output is ~4x larger than the changed line count due to context lines, hunk headers, and diff markers. So 400 changed lines ≈ 1600 lines of patch ≈ 130K chars ≈ 32K tokens — leaving plenty of headroom under the 200K token standard context window for the prompt template, CLAUDE.md, and system prompt overhead.
2. Sort FILES_TO_REVIEW by FILE_LOC descending (largest files first — greedy bin-packing).
3. For each file, add to the current partition. If adding would exceed the 400 LOC budget, start a new partition.
4. **Single-file overflow (hunk-level chunking)**: If a single file exceeds 400 LOC, split it by hunks using CHANGED_RANGES from Step 2. Group consecutive hunk ranges into chunks of ≤400 LOC each, and assign each chunk to a separate partition. Tell the agent the line range to review: `file.ts (modified, lines 1-200 of 800)`. The agent fetches only that range: `git diff $DIFF_SCOPE -- file.ts | head -n <approx_lines>` or uses Read to inspect the relevant section.
5. **Max 20 files per partition** even if LOC budget allows more (keeps agent prompts manageable).

### Shared Prompt Prefix (ALL agents get this)

**CRITICAL**: The `mode: standalone` line MUST be present in every agent prompt. If missing, the code-reviewer agent defaults to loop mode which suppresses Critical/High findings.

**CRITICAL**: Do NOT embed patch content in the agent prompt. Agents self-fetch patches using Bash. The orchestrator only passes the file list, statuses, and DIFF_SCOPE. This prevents the orchestrator's context window from filling up with redundant patch data.

```
mode: standalone

Review ONLY the changed code. Return findings as JSON.

<data>
<diff_scope>{DIFF_SCOPE}</diff_scope>

<files_assigned count="{N}" total="{TOTAL}">
- {filepath_1} ({status_1}, ~{loc_1} LOC)
- {filepath_2} ({status_2}, ~{loc_2} LOC)
...
</files_assigned>
</data>

<fetch_patches>
FIRST, fetch your assigned patches using Bash:
  git diff {DIFF_SCOPE} -- {filepath_1} {filepath_2} ...

If you have more than 15 files, fetch in batches of 15 to stay within tool output limits.
Parse the patches to identify changed lines (lines starting with `+`, using `@@ ... +start,count @@` hunk headers for absolute line numbers).
</fetch_patches>

<constraints>
TOOL USAGE:
- Use Bash ONLY for `git diff` to fetch your assigned patches. No other shell commands.
- Use Read, Grep, Glob tools to explore the local codebase for additional context.

FLAG an issue ONLY when ALL are true:
1. Introduced in this changeset (not pre-existing)
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

{CLAUDE_MD_CONTENT}
```

Include the full CLAUDE.md content (from repository root) in Bug Hunter B's prompt so it has project context for DRY and convention checks.

**CLAUDE.md Auditor** (sonnet):
```
You are the CLAUDE.md Auditor — you check changes against project-specific rules.

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

Use the same critic-agent mapping, but only for selected domain critics:

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

### Opus Sampling Pass (Large Diffs only)

For large diffs (41+ files), spawn an additional Opus agent with the top 5 high-risk files (from Step 3 scoring). This agent uses the Bug Hunter A prompt but reviews only the selected files. It catches bugs Sonnet might miss in the riskiest hunks. **Limit the Opus agent's partition to ≤300 LOC** — keep well within standard context. If the top 5 files exceed 300 LOC, reduce to fewer files until the budget fits.

**Batched agent fan-out with concurrency cap:**
- **≤6 agents total**: Spawn ALL in a single message with `run_in_background: true`
- **7-12 agents**: Spawn in 2 batches (first batch starts, collect results with `TaskOutput`, then spawn second batch)
- **13+ agents**: Spawn in batches of 6, collecting each batch before spawning the next

This prevents hitting Claude Code's concurrency/timeout limits on massive PRs with many partitions.

Mark todo as `completed`.

---

## Step 5: Collect, Normalize, and Validate Findings

Mark todo "Collect, normalize, and validate findings" as `in_progress`.

Use `TaskOutput` with `block: true` to collect results from each spawned agent.

### Agent Failure Recovery

If any agent fails (context overflow, subscription limits, timeout), do NOT abandon the review:

1. **Log the failure**: Record which agent failed and why (e.g., `"Bug Hunter A partition 2: context overflow"`)
2. **Halve the failed partition**: Split the failed partition's files into two sub-partitions (by LOC budget ÷ 2) and re-spawn with `model: "haiku"` and `subagent_type: "general-purpose"` (smallest context footprint for recovery)
3. **Second failure → skip with warning**: If the halved partition also fails, log a warning (`"⚠️ Partition X skipped — {N} files not reviewed due to agent failures"`) and continue. Do NOT fall back to reviewing in the main conversation — this would load patches into the orchestrator's context and recreate the overflow problem on large PRs. The skipped files will be listed in the output so the user can review them manually.
4. **Continue collecting**: Do not block on failures — collect results from successful agents while recovering failed ones.

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

Then for each finding (using CHANGED_RANGES from Step 2, which tracks both added AND removed ranges):

1. **File in scope?** If finding's file NOT in FILES_TO_REVIEW → **DISCARD**
2. **Line in changed range ±3?** Check if finding's line falls within 3 lines of ANY range in CHANGED_RANGES[file] — both `added` and `removed` ranges. Bugs introduced by deleting guards/checks (e.g., removing an auth check) produce findings near removed lines, not added lines. Checking only added lines would discard these real regressions. → **DISCARD** if not within ±3 of any changed range.
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
</data>

<instructions>
For each finding:
1. Read the file at the reported location (use Read tool)
2. Verify the code actually contains the claimed issue at the cited line
3. Check for guards, error handling, try-catch, or validation that prevents the issue
4. If a justification comment exists, assess whether it addresses the actual concern
5. For DRY claims, verify the cited existing code actually exists and is structurally similar

Do NOT rely on embedded patches — always Read the actual file for verification.
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

### Step 5.5: Cross-Partition Synthesis (Large Diffs only)

For PRs with **2+ partitions**, agents review isolated file subsets and cannot detect cross-partition issues (e.g., API shape changed in one partition, callers broken in another). Run a lightweight synthesis pass:

Spawn a single sonnet agent (use `subagent_type: "general-purpose"`) with:
- The **file list with statuses** (not patches — keep orchestrator lean)
- A **1-line summary per finding** collected so far (file, line, issue title, severity)
- Instructions to check for **cross-file contract drift**:
  1. Fetch signatures of changed API routes/services/types using `git diff -U0 $DIFF_SCOPE -- <api files>` (only the changed function signatures, not full patches)
  2. Grep callers of changed interfaces across the full codebase
  3. Flag mismatches between changed signatures and their call sites
  4. Report as new findings with category "Cross-Partition"

Skip this step for single-partition reviews (no cross-partition blind spots possible).

### Step 5.6: Deduplication and Consolidation

Group findings by root cause. Two findings share a root cause when ANY of these match:
- Same category + similar issue text
- Same file + overlapping line (±3) + same or equivalent recommendation
- Different categories but describing the same underlying code problem

When multiple findings share the same underlying issue:
- Keep the finding with the HIGHEST severity as the primary
- Include all other occurrences as "Other Locations"

### Normalization Telemetry

If `normalization_warnings > 0`, record for the output:
```
⚠️ Severity normalization: N findings had non-standard severity values
   (mapped to MEDIUM). Agent output may have drifted from schema.
   Values seen: [list of non-standard values]
```

### Discard Reasons

- **DISCARD_FILE_NOT_CHANGED**: Finding is in a file not modified in this changeset
- **DISCARD_LINE_NOT_CHANGED**: Finding is on a line that wasn't touched in this changeset
- **DISCARD_LOW_CONFIDENCE**: MEDIUM finding with confidence < 0.5
- **DISCARD_REJECTED**: Rejected by validation agent (with reason)
- **DISCARD_DUPLICATE**: Consolidated into root cause group
- **DOWNGRADE_TO_MEDIUM**: Validation agent downgraded severity

Track validated findings and discarded findings with specific reasons.

Mark todo as `completed`.

---

## Step 6: Present Results

Mark todo "Present findings by severity" as `in_progress`.

Output in this format:

```markdown
# Code Review Results

**Scope:** [staged/branch/files]
**Files Reviewed:** [count]
**Reviewers:** Bug Hunter A, Bug Hunter B, CLAUDE.md Auditor,
Codebase Conventions [+ domain specialists if triggered]
**Model Routing:** [Small/Medium/Large] — [model assignments summary]

---

## Repo Hygiene ([count])

[List any hygiene findings from deterministic checks]

### Finding Title
**File:** `path/file.ts:line`
**Issue:** [description]
**Recommendation:** [fix]

---

## BLOCKING ([count])

[List all blocking issues]

### Issue Title
**File:** `path/file.ts:line`
**Reported by:** [agent(s)]
**Issue:** [description]
**Recommendation:** [fix]

---

## HIGH ([count])

[List all high priority issues — same format]

---

## MEDIUM ([count])

[List all medium priority issues — same format]

---

## Validation Summary

- **Total findings from agents:** X
- **Hygiene findings:** H
- **Validated (confirmed):** A
- **Discarded — file not changed:** B
- **Discarded — line not changed:** C
- **Discarded — low confidence:** D
- **Discarded — rejected by validation:** E
- **Duplicates merged:** F
- **Downgraded to MEDIUM:** G

### Discarded Findings
[List discarded findings grouped by discard reason — helps track agent accuracy]

---

## Summary

| Severity | Count |
|----------|-------|
| Blocking | X |
| High | Y |
| Medium | Z |

**Recommendation:** [action based on findings]
```

**Consolidated Finding Format** (when multiple findings share root cause):

```markdown
### Issue Title
**File:** `path/file.ts:line`
**Reported by:** [agent(s)]
**Issue:** [description]

**Other Locations** (N more):
- `path/file.ts:87` — same pattern in `functionName()`
- `path/file.ts:124` — same pattern in `otherFunction()`

**Recommendation:** [fix]
```

If `normalization_warnings > 0`, append after the validation summary:
```
⚠️ Severity normalization: N findings had non-standard severity values (mapped to MEDIUM).
```

Mark todo as `completed`.

---

## Arguments

$ARGUMENTS
