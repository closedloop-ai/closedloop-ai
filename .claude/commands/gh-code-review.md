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
- ❌ Do NOT create, edit, or modify any files in the repository (except `.claude/code-review-summary.md`)
- ❌ Do NOT delete inline comments (only resolve threads)
- ❌ Do NOT merge, close, approve, or request changes on the PR
- ❌ Do NOT suggest architectural refactoring without evidence of bugs

---

## Step 1: Create Todo List

**IMMEDIATELY use TodoWrite to create the workflow:**

```
TodoWrite([
  { content: "Get PR info and changed files", status: "pending", activeForm: "Getting PR info" },
  { content: "Read critic-gates.json and select reviewers", status: "pending", activeForm: "Selecting reviewers" },
  { content: "Spawn reviewer agents in parallel", status: "pending", activeForm: "Spawning agents" },
  { content: "Collect and validate agent findings", status: "pending", activeForm: "Validating findings" },
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

Mark todo as `completed`.

---

## Step 3: Read Critic Configuration and Select Reviewers

Mark todo "Read critic-gates.json and select reviewers" as `in_progress`.

Read `.claude/settings/critic-gates.json` and extract:
- **baseCritics**: Always-run critics (typescript-expert, dry-kiss-reviewer)
- **moduleCritics**: Pattern-to-critic mappings
- **reviewBudget**: Max additional critics (default: 5)

### Pattern Matching Algorithm

```python
# Start with base critics
selected_critics = set(critic_config["defaults"]["baseCritics"])

# Combine file paths into context string
pr_context = " ".join(changed_files).lower()

# Match patterns against file paths
for module in critic_config["moduleCritics"]:
    for pattern in module["patterns"]:
        if pattern.lower() in pr_context:
            selected_critics.update(module["critics"])
            break  # Move to next module after first match

# Enforce review budget
base_critics = set(critic_config["defaults"]["baseCritics"])
additional_critics = selected_critics - base_critics
if len(additional_critics) > reviewBudget:
    # Prioritize security critics, then take first N
    additional_critics = list(additional_critics)[:reviewBudget]

final_critics = list(base_critics) + list(additional_critics)
```

Report to user which critics will run and why.

Mark todo as `completed`.

---

## Step 4: Spawn Reviewer Agents

Mark todo "Spawn reviewer agents in parallel" as `in_progress`.

**In a SINGLE message, spawn ALL agents with `run_in_background: true`.**

**Agent Prompt Template:**

```
Review ONLY the changed code in this PR. Return findings as JSON.

**FILES CHANGED IN THIS PR**:
- {filepath_1} ({status_1})
- {filepath_2} ({status_2})
...

**DIFF/PATCH CONTENT** (this is the authoritative source of what changed):
--- {filepath_1} ({status_1}) ---
{patch_content_1}

--- {filepath_2} ({status_2}) ---
{patch_content_2}
...

**CRITICAL RULES - READ CAREFULLY**:
1. Use the DIFF/PATCH CONTENT above as your primary source for reviewing code. Do NOT rely solely on reading local files (they may not exist for newly added files).
2. ONLY flag issues on lines that were ADDED or MODIFIED in this PR (lines starting with + in the diff)
3. Do NOT flag pre-existing issues in unchanged code - even if you see problems
4. If a file is listed but a specific line wasn't changed, do NOT report issues on that line
5. Focus on: new code introduced, modifications to existing code, new patterns being added
6. For newly added files (status: "added"), the entire file content is in the patch - review it from the patch, do not try to Read it from disk
7. Respect inline code comments that justify decisions (e.g., "// Intentionally...", "// Required for...", "// This is fine because...")
8. Do NOT suggest architectural refactoring (e.g., "move this to a new file", "split this function") without evidence of bugs — respect existing code organization
9. Only provide evidence-based feedback citing actual changed code — no "what if" or "might be" criticisms
10. Before suggesting custom helper functions, check if utilities already exist in the codebase

**SEVERITY GUIDELINES - BE STRICT**:
- BLOCKING: Security vulnerabilities that expose data, authentication bypass, SQL injection, XSS, runtime crashes that break the app, data loss/corruption
- HIGH: Bugs that WILL cause errors in production, missing error handling that WILL crash, broken API contracts, race conditions
- MEDIUM: Code quality issues, minor improvements, style suggestions, hypothetical issues

**IMPORTANT**: Most findings should be MEDIUM. Only use HIGH/BLOCKING for issues that WILL cause real problems in production. If you're unsure, use MEDIUM.

**DO NOT use HIGH/BLOCKING for**:
- Style preferences or patterns that "could be better"
- Missing optional features or nice-to-haves
- Hypothetical edge cases that are unlikely
- Configuration suggestions
- Documentation improvements

**Return JSON format**:
{
  "findings": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "severity": "MEDIUM",
      "category": "Code Quality",
      "issue": "Brief description",
      "explanation": "Why this matters",
      "recommendation": "How to fix",
      "code_snippet": "actual code from file",
      "is_new_code": true
    }
  ]
}

If you find NO issues, return: {"findings": []}
Empty findings is a valid response for clean code.
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

## Step 5: Collect and Validate Findings

Mark todo "Collect and validate agent findings" as `in_progress`.

Use `TaskOutput` with `block: true` to collect results from each spawned agent.

### Use the Changed Lines Map from Step 2

Use the **CHANGED_LINES** and **FILE_PATCHES** maps already built in Step 2. Do NOT re-fetch from the API.

- **CHANGED_FILES**: Set of all file paths in FILES_TO_REVIEW
- **CHANGED_LINES**: `{ "path/file.ts": [10, 11, 12, 45, 46], ... }` (already parsed in Step 2)

Only lines starting with `+` (additions) or lines adjacent to changes are valid targets.

### Parse Findings

1. Parse JSON findings from each agent
2. **All validated findings** (BLOCKING, HIGH, and MEDIUM) will receive inline comments AND appear in the summary

### Validate EVERY Finding

For each finding (all severities):

1. **Check if file was changed in PR**:
   - If finding's file NOT in CHANGED_FILES: **DISCARD** (reason: "File not modified in this PR")

2. **Check if line is in the changed lines**:
   - If finding's line NOT in CHANGED_LINES[file]: **DISCARD** (reason: "Line not changed in this PR")
   - Allow ±3 lines tolerance for immediate context

3. **Is this an observation or a bug?** Before checking severity, determine if the finding is even actionable:

   **DISCARD if it's just describing a change:**
   - "Config changed from X to Y" — just change documentation, not a bug
   - "Dependency updated" — unless proven incorrect, this is intentional
   - "Feature flag removed" — unless proven to break code, this is intentional
   - Uses weasel words: "could", "might", "may", "potentially", "risks", "verify that", "ensure that"

   **KEEP if it proves incorrectness:**
   - Cites concrete evidence: specific errors, documentation violations, proven breakage
   - Shows a specific crash path, attack vector, or data corruption scenario

   **If a finding just describes what changed without proving it's wrong, DISCARD it.**

4. **Verify severity with evidence requirements**:

   **For BLOCKING findings, verify:**
   - Is there concrete proof of a security vulnerability, runtime crash, data loss, or broken functionality?
   - Does the agent cite specific evidence (error that WILL throw, attack vector, data corruption path)?
   - **If no concrete proof**: Downgrade to HIGH or MEDIUM

   **For HIGH findings, verify:**
   - Does the agent provide measurable evidence (algorithm complexity, specific type mismatch)?
   - For "broken pattern" claims: Did the agent find 2+ examples of the pattern in the codebase?
   - For performance claims: Is there specific analysis (O(n²) vs O(n), unnecessary loops)?
   - **If claims are subjective or unproven**: Downgrade to MEDIUM

5. **Read the FULL file and verify the issue is real** (CRITICAL — this prevents false positives):

   a. **Get file content**:
      - For **modified** files: Read the ENTIRE local file (not just the changed lines)
      - For **added** files (status: "added" in FILE_STATUSES): Use the patch content from FILE_PATCHES as the source of truth. Do NOT try to Read added files from disk.

   b. **Verify the code snippet matches**: Check that the line exists and contains the code the agent referenced

   c. **Check full-file context to avoid false positives**:
      - Verify imports/dependencies/types exist (avoid "missing import" when it's at the top of the file)
      - Check for error handling around the flagged code (try-catch, guards, validation)
      - Look for type definitions, generics, or overloads that resolve claimed type issues

   d. **Evidence checks by severity**:
      - **For BLOCKING**: Confirm no error handling, guards, or validation exists that would prevent the claimed crash/vulnerability
      - **For HIGH "broken pattern"**: Search the codebase (not just PR files) to find 2+ examples of the claimed established pattern — if you can't find them, **downgrade or discard** (the claim is unsubstantiated)
      - **For HIGH "performance"**: Verify the agent provided concrete analysis (algorithm complexity, specific bottleneck), not just "might be slow"

   e. **Ensure the criticism is not based on assumptions**: Discard findings that are theoretical ("what if...") without concrete proof of breakage

   f. **If all checks pass**: Keep the finding
   g. **If ANY check fails**: **DISCARD** (reason: "False positive") and log which check failed

6. **Check for inline justification comments**: If there are comments near the flagged line like `// Intentionally...`, `// Required for...`, `// This is fine because...` — **DISCARD** the finding (the developer has documented a deliberate choice)

7. **Deduplicate and consolidate by root cause**:

   Group findings by root cause (same category + similar issue text). When multiple findings share the same underlying issue:
   - Keep the finding with the HIGHEST severity as the primary
   - Include all other occurrences as "Other Locations"
   - Post a SINGLE inline comment on the primary location that lists all affected locations

   **Inline comment format for consolidated findings:**

   ````markdown
   **[SEVERITY]** Category

   Issue description

   **Other Locations** (N more):
   - `path/file.ts:87` - same pattern in `functionName()`
   - `path/file.ts:124` - same pattern in `otherFunction()`

   **Recommendation:** How to fix
   ````

   For single-location findings, use the standard format (no "Other Locations" section).

### Discard or Downgrade Reasons

- **DOWNGRADE_TO_MEDIUM**: Claimed HIGH/BLOCKING but it's a style preference or hypothetical
- **DISCARD_FILE_NOT_CHANGED**: Finding is in a file not modified by this PR
- **DISCARD_LINE_NOT_CHANGED**: Finding is on a line that wasn't touched in this PR
- **DISCARD_OBSERVATION_NOT_BUG**: Finding just describes a change without proving it's wrong
- **DISCARD_FALSE_POSITIVE**: Issue doesn't actually exist in code (verified against full file)
- **DISCARD_JUSTIFIED**: Developer has inline comment justifying the decision
- **DISCARD_DUPLICATE**: Already reported by another agent / consolidated into root cause group

**IMPORTANT**: Be strict about HIGH/BLOCKING severity. Downgrade to MEDIUM if it's not a real bug or security issue. All validated findings (all severities) get inline comments posted.

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

2. **For each unresolved thread authored by `symphony-cl`**:
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

Mark todo as `completed`.

---

## Step 7: Post Inline Comments

Mark todo "Post inline comments for validated findings" as `in_progress`.

For each validated finding (all severities):

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

**Comment Format:**

```markdown
**[BLOCKING]** Security

Missing authentication check in server action.

**Recommendation:** Add `const { userId } = await auth()` at the start of the function.

```typescript
// Current code at line 35
export async function getPRDs() {
  // No auth check
```
```

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

**Critics Used:** typescript-expert, security-privacy, dry-kiss-reviewer, ...

### Findings

| Severity | Count |
|----------|-------|
| Blocking | X |
| High | Y |
| Medium | Z |

### BLOCKING Issues (must fix before merge)

1. **[File:Line]** Brief description

### HIGH Issues (should fix)

1. **[File:Line]** Brief description

### MEDIUM Issues (suggestions)

1. **[File:Line]** Brief description

---

**Recommendation:** [Approve this PR | Address blocking issues before merge | Consider high-priority items]
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
