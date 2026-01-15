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

For each file, check which patterns from moduleCritics match:

| Pattern | Critics |
|---------|---------|
| auth, session, clerk, jwt | security-privacy, auth-security-expert |
| component, ui, design-system | design-system-expert, react-component-architect |
| api, rest, fetch, query | api-architect, caching-strategist |
| database, prisma, cache | database-architect, caching-strategist |
| test, vitest, jest, e2e | test-strategist |

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
  prompt: "Review these files for issues: [FILES_TO_REVIEW]. Return findings as: SEVERITY | File:Line | Issue | Recommendation. Severities: BLOCKING, HIGH, MEDIUM.",
  run_in_background: true,
  description: "Code review: <critic-name>"
)
```

**Critic Agent Mapping:**

| Critic | Subagent Type |
|--------|---------------|
| typescript-expert | symphony-fe:typescript-expert |
| dry-kiss-reviewer | dry-kiss-reviewer |
| security-privacy | symphony-fe:security-privacy |
| auth-security-expert | symphony-fe:auth-security-expert |
| navigation-expert | symphony-fe:navigation-expert |
| web-platform-expert | symphony-fe:web-platform-expert |
| web-build-expert | symphony-fe:web-build-expert |
| api-architect | symphony-fe:api-architect |
| caching-strategist | symphony-fe:caching-strategist |
| state-management-architect | symphony-fe:state-management-architect |
| react-component-architect | symphony-fe:react-component-architect |
| design-system-expert | symphony-fe:design-system-expert |
| database-architect | symphony-fe:database-architect |
| realtime-architect | symphony-fe:realtime-architect |
| test-strategist | symphony-fe:test-strategist |
| ci-cd-architect | symphony-fe:ci-cd-architect |
| observability-architect | symphony-fe:observability-architect |
| analytics-integration-expert | symphony-fe:analytics-integration-expert |
| code-reviewer | symphony-core:code-reviewer |

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

For EACH finding:

1. **Read the actual file** at the reported location
2. **Verify the issue exists** in current code
3. **Check for duplicates** - merge if multiple agents reported same issue
4. **Classify finding:**
   - VALID: Issue confirmed in code
   - DUPLICATE: Merged with another finding
   - DISCARD: Cannot verify in code (false positive)

Track discarded findings with reasons.

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

- **Total findings:** X from Y agents
- **Validated:** A
- **Discarded:** B (list with reasons)
- **Duplicates merged:** C

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
