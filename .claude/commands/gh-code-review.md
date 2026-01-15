---
description: Run comprehensive code review on PR and post inline comments with approval decision
argument-hint: "[PR_NUMBER] or leave blank to auto-detect"
---

# GitHub PR Code Review

Run a multi-agent code review that posts inline comments to GitHub PR and provides approval decision.

## Usage

```
/gh-code-review              # Auto-detect PR from current branch
/gh-code-review 123          # Review specific PR number
```

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
  { content: "Post inline comments for BLOCKING/HIGH findings", status: "pending", activeForm: "Posting comments" },
  { content: "Post summary comment with approval decision", status: "pending", activeForm: "Posting summary" }
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
Review these files for issues. Return findings as JSON with severity BLOCKING, HIGH, or MEDIUM.

**FILES TO REVIEW**:
- {filepath_1}
- {filepath_2}
...

**RULES**:
- Only flag issues on lines ADDED in the PR (+ lines in diff)
- BLOCKING: Security vulnerabilities, runtime crashes, missing auth, data loss
- HIGH: Performance issues, broken patterns, significant duplication
- MEDIUM: Minor quality issues, small duplication, suggestions

**Return JSON format**:
{
  "findings": [
    {
      "file": "path/to/file.ts",
      "line": 42,
      "severity": "BLOCKING",
      "category": "Security",
      "issue": "Brief description",
      "explanation": "Why this is a problem",
      "recommendation": "How to fix",
      "code_snippet": "actual code from file"
    }
  ]
}
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

### Parse and Filter Findings

1. Parse JSON findings from each agent
2. **Filter by severity** for inline comments:
   - **Post inline comments**: BLOCKING and HIGH severity only
   - **Summary only**: MEDIUM severity (no inline comment)

### Validate Each BLOCKING/HIGH Finding

For each finding that will get an inline comment:

1. **Get the PR diff for the file**:
   ```bash
   gh api repos/<OWNER>/<REPO_NAME>/pulls/<PR_NUMBER>/files
   ```
   Find the file in the response and extract the `patch` field.

2. **Verify the line is in the diff**:
   - Parse diff hunks to extract changed line numbers
   - If finding's line NOT in changed lines: **DISCARD**

3. **Read the full file to confirm issue is real**:
   - Check imports, error handling, types exist
   - Verify the code snippet matches actual code
   - If issue doesn't exist or is already handled: **DISCARD**

4. **Check for duplicates**: Build dedup key `file:line:category`

Track validated findings and discarded findings with reasons.

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

2. **For each unresolved thread from your bot**:
   - Check if `isResolved` is true: SKIP
   - Read current state of file/line
   - If issue is FIXED or line no longer exists: RESOLVE it

3. **Resolve outdated threads**:

```bash
gh api graphql -f query='
mutation($threadId:ID!) {
  resolveReviewThread(input:{threadId:$threadId}) {
    thread { isResolved }
  }
}' -f threadId="<THREAD_ID>"
```

4. **Build dedup map** of remaining unresolved threads: `{file:line:category}`

Mark todo as `completed`.

---

## Step 7: Post Inline Comments

Mark todo "Post inline comments for BLOCKING/HIGH findings" as `in_progress`.

For each validated BLOCKING/HIGH finding:

1. **Check dedup map**: If `file:line:category` already has comment, SKIP
2. **Create inline comment**:

Use the `mcp__github_inline_comment__create_inline_comment` tool if available, OR use gh api:

```bash
gh api repos/<OWNER>/<REPO_NAME>/pulls/<PR_NUMBER>/comments \
  -f body="**[SEVERITY]** Category

Issue description

**Recommendation:** How to fix

\`\`\`
code snippet
\`\`\`" \
  -f path="<FILE_PATH>" \
  -F line=<LINE_NUMBER> \
  -f commit_id="<HEAD_SHA>"
```

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

## Step 8: Post Summary Comment with Approval Decision

Mark todo "Post summary comment with approval decision" as `in_progress`.

**CRITICAL**: This step is MANDATORY, even if there are no findings.

### Determine Approval Status

Based on validated findings:
- **BLOCKING findings > 0**: Request Changes
- **HIGH findings > 3**: Request Changes
- **HIGH findings 1-3 + no BLOCKING**: Comment (needs attention)
- **MEDIUM only or no findings**: Approve

### Find or Create Summary Comment

1. **List existing PR comments**:
```bash
gh api repos/<OWNER>/<REPO_NAME>/issues/<PR_NUMBER>/comments
```

2. **Look for existing bot summary** (comment starting with "## Code Review Summary")

3. **Update existing or create new**:

```bash
# Update existing
gh api -X PATCH repos/<OWNER>/<REPO_NAME>/issues/comments/<COMMENT_ID> \
  -f body="<summary>"

# Or create new
gh api repos/<OWNER>/<REPO_NAME>/issues/<PR_NUMBER>/comments \
  -f body="<summary>"
```

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

### BLOCKING Issues (requires fix before merge)

1. **[File:Line]** Brief description

### HIGH Issues (should fix)

1. **[File:Line]** Brief description

### Validation Summary

- Total findings from agents: X
- Validated: Y
- Discarded: Z (false positives, unchanged lines, etc.)

---

**Recommendation:** [Approve this PR | Address blocking issues before merge | Review high-priority items]
```

### Submit Review

```bash
# Submit official review with approval status
gh pr review <PR_NUMBER> --[approve|request-changes|comment] \
  --body "See summary comment above for details."
```

Mark todo as `completed`.

---

## Arguments

$ARGUMENTS
