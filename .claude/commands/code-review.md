---
description: Run comprehensive code review using critic agents with validation
argument-hint: [scope] - optional: "staged", "branch", or file paths
---

# Comprehensive Code Review

Run a multi-agent code review that validates findings and presents them by severity.

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
  { content: "Parse scope and get files to review", status: "pending", activeForm: "Parsing scope" },
  { content: "Read critic-gates.json configuration", status: "pending", activeForm: "Reading config" },
  { content: "Match files to critics and select reviewers", status: "pending", activeForm: "Matching critics" },
  { content: "Spawn reviewer agents in parallel", status: "pending", activeForm: "Spawning agents" },
  { content: "Collect findings from all agents", status: "pending", activeForm: "Collecting findings" },
  { content: "Validate findings against actual code", status: "pending", activeForm: "Validating findings" },
  { content: "Present findings by severity", status: "pending", activeForm: "Presenting results" }
])
```

---

## Step 2: Parse Scope and Get Files

Mark todo "Parse scope and get files to review" as `in_progress`.

Parse $ARGUMENTS:
- If empty or "branch": Run `git diff --name-only main...HEAD` (default - reviews all changes on current branch)
- If "staged": Run `git diff --cached --name-only`
- If file paths: Use those files directly

Store as **FILES_TO_REVIEW**.

Mark todo as `completed`.

---

## Step 3: Read Critic Configuration

Mark todo "Read critic-gates.json configuration" as `in_progress`.

Read `.claude/settings/critic-gates.json` and extract:
- **baseCritics**: Always-run critics (typescript-expert, dry-kiss-reviewer)
- **moduleCritics**: Pattern-to-critic mappings
- **reviewBudget**: Max additional critics

Mark todo as `completed`.

---

## Step 4: Match Files to Critics

Mark todo "Match files to critics and select reviewers" as `in_progress`.

For each file, check which patterns from `moduleCritics` in `.claude/settings/critic-gates.json` match.

**Pattern matching is defined in critic-gates.json** - do NOT hardcode patterns here. Read the config file for current mappings.

Build **FINAL_CRITICS**: baseCritics + matched critics (deduplicated, respecting reviewBudget).

Report to user which critics will run and why.

Mark todo as `completed`.

---

## Step 5: Spawn Reviewer Agents

Mark todo "Spawn reviewer agents in parallel" as `in_progress`.

Use Task tool to spawn each critic agent with `run_in_background: true`.

**In a SINGLE message, spawn ALL agents:**

For each critic in FINAL_CRITICS:
```
Task(
  subagent_type: "<critic-subagent-type>",
  prompt: "Review ONLY the CHANGED code in these files: [FILES_TO_REVIEW].

CRITICAL: Only report issues on lines that were ADDED or MODIFIED in this branch.
- Do NOT flag pre-existing issues in unchanged code
- Do NOT flag issues in files that weren't changed
- Focus on: new code, modifications, new patterns being introduced

Return findings as: SEVERITY | File:Line | Issue | Recommendation
Severities: BLOCKING (security/crashes), HIGH (significant issues in new code), MEDIUM (minor issues in new code)

If no issues found in the changed code, return 'No issues found in changed code.'",
  run_in_background: true,
  description: "Code review: <critic-name>"
)
```

**Critic Agent Mapping:**

See `.claude/commands/gh-code-review.md` Step 4 for the full critic-to-subagent mapping table.

Common mappings:
- `typescript-expert` → `symphony-fe:typescript-expert`
- `dry-kiss-reviewer` → `dry-kiss-reviewer`
- `security-privacy` → `symphony-fe:security-privacy`
- `code-reviewer` → `symphony-core:code-reviewer`

Mark todo as `completed`.

---

## Step 6: Collect Findings

Mark todo "Collect findings from all agents" as `in_progress`.

Use `TaskOutput` with `block: true` to collect results from each spawned agent.

Parse findings into structured list with:
- Severity (BLOCKING, HIGH, MEDIUM)
- File and line number
- Issue description
- Which agent reported it

Mark todo as `completed`.

---

## Step 7: Validate Findings

Mark todo "Validate findings against actual code" as `in_progress`.

### CRITICAL: Only validate issues on CHANGED lines

First, get the diff to identify which lines were actually changed:

```bash
# Get the actual diff with line numbers
git diff main...HEAD --unified=0
```

Parse the diff to build a map of changed files and their changed line numbers:
- **CHANGED_LINES**: `{ "path/file.ts": [10, 11, 12, 45, 46], ... }`

### For EACH finding:

1. **Check if file is in the diff**:
   - If finding's file NOT in FILES_TO_REVIEW: **DISCARD** (reason: "File not changed in this branch")

2. **Check if line is in the changed lines**:
   - If finding's line NOT in CHANGED_LINES[file]: **DISCARD** (reason: "Line not changed in this branch")
   - Allow ±3 lines tolerance for context (e.g., if line 45 changed, accept findings on lines 42-48)

3. **Read the actual file** at the reported location
4. **Verify the issue exists** in current code
5. **Check for duplicates** - merge if multiple agents reported same issue

### Classify each finding:
- **VALID**: Issue confirmed AND on a changed line
- **DUPLICATE**: Merged with another finding
- **DISCARD_UNCHANGED**: Finding is on code that wasn't modified in this branch
- **DISCARD_FALSE_POSITIVE**: Cannot verify issue in code

**IMPORTANT**: Be aggressive about discarding findings on unchanged code. The purpose of code review is to review the CHANGES, not pre-existing issues in the codebase.

Track all discarded findings with specific reasons.

Mark todo as `completed`.

---

## Step 8: Present Results

Mark todo "Present findings by severity" as `in_progress`.

Output in this format:

```markdown
# Code Review Results

**Scope:** [staged/branch/files]
**Files Reviewed:** [count]
**Critics Used:** [list]

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

[List all high priority issues - same format]

---

## MEDIUM ([count])

[List all medium priority issues - same format]

---

## Validation Summary

- **Total findings from agents:** X
- **Validated (on changed lines):** A
- **Discarded - unchanged code:** B
- **Discarded - false positives:** C
- **Duplicates merged:** D

### Discarded Findings (not on changed lines)
[List any findings that were discarded because they were on unchanged code - this helps track what agents flagged incorrectly]

---

## Summary

| Severity | Count |
|----------|-------|
| Blocking | X |
| High | Y |
| Medium | Z |

**Recommendation:** [action based on findings]
```

Mark todo as `completed`.

---

## Arguments

$ARGUMENTS
