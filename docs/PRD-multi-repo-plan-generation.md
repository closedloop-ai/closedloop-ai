# PRD: Multi-Repository Plan Generation & Cross-Repo Context

**Owner:** Mike Angstadt | **Status:** Draft | **Target:** Q1 2026

---

## Summary

Enable Symphony to generate implementation plans with full context from multiple repositories, and provide a GitHub Action that checks out 2+ repos during plan generation so the planning agent can reason about intra-dependencies (e.g., API contracts, shared types, database schemas). Convert the repository selection UI from single-select to multi-select so users can scope PRDs and plans to multiple codebases from a single artifact.

---

## Context

### Problem

Today, Symphony generates plans in the context of a single repository checkout. When a feature spans multiple codebases (e.g., a backend API endpoint + frontend consumer, or a shared library + downstream services), the planning agent has no visibility into the other repository. This causes:

1. **Blind spots in plans**: The planner generates tasks that reference API endpoints, types, or patterns it can't verify exist in the other repo
2. **Sequential manual coordination**: Engineers must generate a plan for repo A, then switch context and generate a separate plan for repo B, manually ensuring they're compatible
3. **Cross-repo dependency detection is post-hoc**: Symphony-core's existing `CROSS_REPO_DISCOVERY` phase can detect that cross-repo work is *needed*, but it can only generate a separate PRD for the other repo — it cannot produce a unified plan that accounts for both codebases simultaneously
4. **Repository selection is single-select**: The `TargetRepositoryFields` component only allows selecting one repository, forcing users to create duplicate artifacts for multi-repo features

**Evidence:**
- The existing `PRD-multi-repo-orchestration.md` explicitly defers plan generation across repos to V2 (Q-001: "Should plan generation also fan out to multiple repositories?")
- Symphony-core's `cross-repo-prd-generation.md` documents a workaround (generate a separate PRD via symlink), which is manual and disconnected from the primary plan
- The `symphony-setup` action already supports `checkout_cross_repo` and `cross_repo_name` inputs, but neither the `plan` nor `execute` jobs use them
- Beta users report that plans for features spanning frontend/backend repos produce lower-quality implementations because the planner guesses at contracts rather than reading them

### Why Now

- The multi-repo execution PRD (fan-out) is in progress — plan generation with multi-repo context is the natural prerequisite for high-quality multi-repo execution
- `symphony-setup` action already has the cross-repo checkout plumbing (`checkout_cross_repo`, `cross_repo_name` inputs) — we just need to activate it
- Symphony-core's phase pipeline already has a `CROSS_REPO_DISCOVERY` phase slot — this PRD enhances it from "detect and warn" to "detect and plan with full context"
- Single-select repo UI is the #1 UX friction point blocking multi-repo workflows

### Hypothesis

**If** we give the planning agent simultaneous read access to multiple repositories during plan generation and convert repository selection to multi-select, **then** the generated plans will correctly model cross-repo dependencies (shared types, API contracts, database schemas), **resulting in** higher-quality implementations that require fewer manual corrections and enabling true multi-repo execution from a single plan.

**Success looks like:**
- Plans generated with multi-repo context reference correct types, endpoints, and patterns from both repos (verified by code review)
- 30%+ of new plans use 2+ repo context within 30 days of launch
- Reduction in "plan amendment" cycles for cross-repo features (baseline: 2.3 amendments → target: <1.5)

**Kill criteria:**
- <10% adoption of multi-repo plan generation after 60 days
- Plan generation time exceeds 15 minutes for 2-repo context (currently ~5 min for single repo)
- No measurable improvement in plan quality for cross-repo features (assessed by code review pass rate)

### Personas

**Primary: Full-Stack Engineer at Multi-Repo Organization**
- Works on features spanning a backend service and a frontend app (or two services)
- Needs Symphony to understand how both codebases relate — shared API types, database schemas, authentication patterns
- Current workaround: generates plan in repo A, manually cross-references repo B, amends the plan

**Secondary: Platform Engineer Managing Shared Libraries**
- Updates to shared packages require coordinated changes in consuming repos
- Needs the planner to understand dependency direction: which repo provides types vs. consumes them
- Current workaround: generates separate plans per repo, manually ensures compatibility

---

## Scope

### V1 MVP: In Scope

**US-001: Multi-Select Repository Picker**

**As a** full-stack engineer scoping a cross-repo feature,
**I want to** select multiple repositories when creating a PRD or implementation plan,
**So that** I can indicate all codebases involved in the feature from a single artifact.

**Acceptance Criteria:**

- **AC-001.1**: Given I am editing a PRD or implementation plan metadata panel, when I interact with the "Target Repository" field, then I see a multi-select dropdown allowing 1-5 repositories to be selected simultaneously
- **AC-001.2**: Given I have selected 2 repositories (e.g., `closedloop-ai/astoria-service` and `closedloop-ai/astoria-frontend`), when I view the artifact metadata, then both repositories are displayed as tags/chips with their full names
- **AC-001.3**: Given I have selected multiple repositories, when I select a different set of repositories, then the branch selection resets for any newly-added repositories and auto-populates their default branches
- **AC-001.4**: Given I have existing artifacts with a single `targetRepo` value, when I view them after this feature launches, then they display correctly as a single-item selection (backward compatible)

---

**US-002: Multi-Repo Branch Configuration**

**As a** full-stack engineer targeting specific branches across repos,
**I want to** configure target branches independently per selected repository,
**So that** each repo's plan execution targets the correct branch.

**Acceptance Criteria:**

- **AC-002.1**: Given I have selected 2 repositories, when I view the branch configuration, then I see a branch dropdown per repository (not a single shared branch)
- **AC-002.2**: Given I add a new repository to my selection, when the branch dropdown loads, then it auto-selects that repository's default branch
- **AC-002.3**: Given I remove a repository from my multi-select, when the selection updates, then its branch configuration is also removed

---

**US-003: GitHub Action for Multi-Repo Plan Generation**

**As a** Symphony platform operator,
**I want** the plan generation GitHub Action to checkout and mount multiple repositories,
**So that** the planning agent has full read access to all selected codebases during plan generation.

**Acceptance Criteria:**

- **AC-003.1**: Given an issue is annotated with 2 target repositories, when `@symphony-cl plan` is triggered, then the GitHub Action checks out both repositories — the primary at the workspace root and the secondary at `.other-repo/`
- **AC-003.2**: Given both repositories are checked out, when the planning agent runs the `CROSS_REPO_DISCOVERY` phase, then it can read files from `.other-repo/` to verify API endpoints, types, and patterns
- **AC-003.3**: Given the runner has access to both repos, when plan generation completes, then `plan.json` includes a `targetRepositories` array listing all repos and their branches
- **AC-003.4**: Given a plan was generated with multi-repo context, when the plan is posted to the GitHub issue, then the comment indicates which repositories were included in the planning context
- **AC-003.5**: Given the GitHub App token is generated, when the action creates the token, then the `repositories` parameter includes all target repositories (not just the current repo + claude_code)

---

**US-004: Cross-Repo Dependency Detection in Plans**

**As a** full-stack engineer reviewing a generated plan,
**I want** the plan to explicitly identify cross-repo dependencies between tasks,
**So that** I can understand which changes in repo A depend on changes in repo B.

**Acceptance Criteria:**

- **AC-004.1**: Given a plan for a feature spanning a backend and frontend repo, when the plan is generated with both repos in context, then tasks that depend on code in the other repo include a `crossRepoDependency` annotation (e.g., "Depends on POST /api/v1/meals in astoria-service")
- **AC-004.2**: Given the planner detects that a required API endpoint already exists in the secondary repo, when the plan is finalized, then it references the existing endpoint by file path and does NOT generate a task to create it
- **AC-004.3**: Given the planner detects that a required API endpoint does NOT exist, when the plan is finalized, then it generates a clearly-labeled task scoped to the secondary repo, indicating it must be implemented there
- **AC-004.4**: Given the plan includes tasks for multiple repos, when the plan is rendered in the UI, then tasks are visually grouped or tagged by their target repository

---

**US-005: Data Model Evolution for Multi-Repo Targeting**

**As a** Symphony platform developer,
**I want** the artifact data model to support multiple target repositories with per-repo branch configuration,
**So that** the system can persist and query multi-repo scoping without schema hacks.

**Acceptance Criteria:**

- **AC-005.1**: Given the Prisma schema is updated, when a new artifact is created with 2 target repositories, then the data is persisted correctly and queryable
- **AC-005.2**: Given existing artifacts have `targetRepo` (singular string) values, when the migration runs, then existing data is preserved and readable through the new schema (backward compatible)
- **AC-005.3**: Given the API types in `packages/api/src/types/artifact.ts` are updated, when both `apps/api` and `apps/app` consume them, then there are no type errors

---

### V1 MVP: Out of Scope

- **Per-repo differential plans**: V1 generates a single unified plan with multi-repo context. Per-repo plan splitting is V2.
- **More than 2 repos in planning context**: V1 supports primary + one secondary checkout. 3+ repo context is V2 (requires workspace mount strategy).
- **Auto-detection of related repos**: V1 requires manual multi-select. Automatic "this repo always pairs with that repo" is V2.
- **Cross-repo execution orchestration**: Covered by the separate `PRD-multi-repo-orchestration.md`. This PRD focuses on plan *generation* quality.
- **Server-side plan generation**: Plans are generated in GitHub Actions runners. Server-side generation is a separate initiative.

### Success Metrics

**Primary (Plan Quality):**
- Plans generated with 2-repo context have 40% fewer "missing dependency" amendments vs. single-repo plans
- Code review pass rate for multi-repo plans: >80% on first review (baseline for single-repo: 70%)

**Secondary (Adoption):**
- 30% of new plans use multi-repo context within 30 days
- Multi-select repository picker used on 50% of PRDs for organizations with 2+ connected repos

**Guardrails:**
- Plan generation time with 2-repo context: P95 < 10 minutes (current single-repo P95: ~5 min)
- Zero regressions in single-repo plan quality
- Backward compatibility: all existing artifacts readable without data loss

---

## Open Questions

### Plan Structure

- **Q-001**: Should `plan.json` tasks include a `targetRepo` field per task, or should repo scoping be at the plan level only?
  - **Current assumption:** Per-task `targetRepo` annotation for tasks that touch the secondary repo. All other tasks implicitly target the primary repo.
  - **Decision needed by:** Design review

- **Q-002**: How should the plan markdown render cross-repo tasks — inline with repo badges, or in separate sections per repo?
  - **Current assumption:** Inline with `[astoria-service]` prefix badges on task titles.
  - **Decision needed by:** UX review

### Data Model

- **Q-003**: Should we use a JSON array column for `targetRepos` or a separate join table (`ArtifactTargetRepository`)?
  - **Current assumption:** JSON array column (`targetRepos: Json`) with structure `[{repo: "owner/name", branch: "main"}]`. Simpler, avoids join table overhead, sufficient for 1-5 repos.
  - **Alternative:** Join table for better queryability and foreign key integrity.
  - **Decision needed by:** Schema review

- **Q-004**: Should the legacy `targetRepo`/`targetBranch` string fields be preserved alongside the new multi-repo field, or migrated?
  - **Current assumption:** Preserve for backward compatibility during transition. New code reads from `targetRepos` array; old code reads from `targetRepo`/`targetBranch`. Migration backfills `targetRepos` from existing values.
  - **Decision needed by:** Sprint planning

### GitHub Action

- **Q-005**: For the multi-repo checkout, should the secondary repo be at `.other-repo/` (matching existing convention) or a named directory like `.repos/{repo-name}/`?
  - **Current assumption:** `.other-repo/` for V1 (matches existing `symphony-setup` and `.repo-metadata.json` convention). Named directories for V2 when 3+ repos are supported.
  - **Decision needed by:** Implementation

- **Q-006**: Should the issue body specify target repositories, or should the action read them from the artifact metadata in the Symphony Alpha API?
  - **Current assumption:** Target repos are encoded in the GitHub issue body (e.g., via a metadata block or labels). The action parses them and passes to `symphony-setup`. This avoids adding an API call from the runner to Symphony Alpha.
  - **Alternative:** Action calls Symphony Alpha API to fetch artifact metadata including target repos.
  - **Decision needed by:** Architecture review

---

## Compliance & Risk

### PHI/PII Assessment

- [ ] Does this feature store or process Protected Health Information (PHI)? **No**
- [ ] Does this feature collect or display Personally Identifiable Information (PII)? **No**
- [ ] Does this feature involve user-generated content visible to other users? **No** (plans are org-scoped)

**Assessment:** No PHI/PII concerns. Repository names and branch names are non-sensitive metadata.

### Access Requirements

- **GitHub App Permissions:** Existing permissions sufficient (`contents: read/write` on target repos). The `create-github-app-token` step already accepts a `repositories` list — we just need to include all target repos.
- **Database:** Migration to add `targetRepos` JSON column to Artifact table (non-breaking additive change).
- **No new infrastructure** required — uses existing GitHub Actions runner environment.

### Dependencies & Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| **GitHub App token scope**: Token must include all target repos | Low | High (plan fails) | Validate repo access in `symphony-setup` before starting plan generation |
| **Runner disk space**: Checking out 2 large repos fills runner disk | Low | Medium (OOM/disk full) | Use `fetch-depth: 1` (shallow clone) for secondary repo; monitor runner metrics |
| **Plan generation time increase**: 2-repo context doubles investigation time | Medium | Medium (UX degradation) | Cap secondary repo file reads; use targeted discovery agents rather than full code map |
| **Backward compatibility**: Existing single-repo artifacts break | Low | High (data loss) | Preserve legacy fields; migration backfills; dual-read pattern during transition |
| **Cross-repo token permissions**: Org A's runner accessing Org B's repo | N/A | Critical | GitHub App tokens are scoped per-installation; multi-tenant isolation is inherent in GitHub App auth model |

### Rollback Plan

- **Feature flag:** `ENABLE_MULTI_REPO_PLAN_CONTEXT` (environment variable)
- **DB rollback:** `targetRepos` is an additive column; dropping it is safe (legacy fields preserved)
- **Action rollback:** Revert `symphony.yml` to skip secondary repo checkout; plan generation falls back to single-repo mode
- **Rollback SLA:** 10 minutes (revert workflow file + restart)

---

## Analytics

### Key Events (PostHog)

| Event | Trigger | Key Properties |
|-------|---------|----------------|
| `Artifact Repository Selection Changed` | User adds/removes repo in multi-select | `repository_count`, `repositories[]`, `artifact_subtype` |
| `Plan Generated With Multi Repo Context` | Plan generation completes with 2+ repos | `repository_count`, `primary_repo`, `secondary_repos[]`, `cross_repo_dependencies_found` (int), `generation_duration_seconds` |
| `Cross Repo Dependency Detected` | Planner identifies a dependency on secondary repo | `dependency_type` (api_endpoint, shared_type, db_schema), `source_repo`, `target_repo`, `blocking` (bool) |

### Platform & Coverage

- **Web only** (Symphony Alpha is web-only)
- **Tracking via:** PostHog SDK in `packages/analytics`
- **GitHub Action telemetry:** Emit events via `--emit-events` flag to JSONL (existing pattern)

---

## Technical Design Notes

### UI: Multi-Select Repository Picker

**Current:** `TargetRepositoryFields` component at `apps/app/components/artifact-editor/target-repository-fields.tsx` uses Shadcn `<Select>` (single-select) for repository and branch.

**Change:** Replace with a multi-select pattern. Options:
1. Use Shadcn `<Command>` + `<Popover>` multi-select combo (already in design system)
2. Each selected repo gets its own branch dropdown rendered below the multi-select

**Component structure:**
```
<MultiRepoSelector>
  <RepoMultiSelect />           // Multi-select combobox
  <SelectedRepoList>            // List of selected repos
    <RepoCard repo="A">        // Per-repo card
      <BranchSelect repo="A"/> // Branch dropdown for repo A
    </RepoCard>
    <RepoCard repo="B">
      <BranchSelect repo="B"/>
    </RepoCard>
  </SelectedRepoList>
</MultiRepoSelector>
```

**Props change:**
```typescript
// Before (single)
targetRepo: string;
targetBranch: string;

// After (multi)
targetRepos: Array<{ repo: string; branch: string }>;
```

### Data Model

**Option A: JSON column (recommended for V1)**
```prisma
model Artifact {
  // ... existing fields
  targetRepo    String?  @map("target_repo")      // PRESERVED for backward compat
  targetBranch  String?  @map("target_branch")    // PRESERVED for backward compat
  targetRepos   Json?    @map("target_repos")     // NEW: [{repo: "owner/name", branch: "main"}]
}
```

**Migration strategy:**
1. Add `targetRepos` as nullable JSON column
2. Backfill: `UPDATE artifact SET target_repos = json_build_array(json_build_object('repo', target_repo, 'branch', target_branch)) WHERE target_repo IS NOT NULL`
3. New writes populate both `targetRepos` (array) and `targetRepo`/`targetBranch` (first element, for backward compat)
4. Reads prefer `targetRepos`; fall back to legacy fields

### GitHub Action Changes

**`symphony.yml` plan job modifications:**

1. **Parse target repos from issue metadata:**
   ```yaml
   - name: Parse Target Repositories
     id: parse_repos
     run: |
       # Extract target repos from issue body metadata block
       # Format in issue: <!-- symphony:repos=owner/repoA,owner/repoB -->
       REPOS=$(echo "$ISSUE_BODY" | grep -oP '(?<=symphony:repos=)[^\s]+' || echo "")
       PRIMARY=$(echo "$REPOS" | cut -d',' -f1)
       SECONDARY=$(echo "$REPOS" | cut -d',' -f2 -s)
       echo "primary=$PRIMARY" >> "$GITHUB_OUTPUT"
       echo "secondary=$SECONDARY" >> "$GITHUB_OUTPUT"
   ```

2. **Expand GitHub App token scope:**
   ```yaml
   - name: Generate GitHub App Token
     uses: actions/create-github-app-token@v2
     with:
       repositories: ${{ github.event.repository.name }},claude_code,${{ steps.parse_repos.outputs.secondary }}
   ```

3. **Activate cross-repo checkout in symphony-setup:**
   ```yaml
   - name: Symphony Setup
     uses: ./.github/actions/symphony-setup
     with:
       github_token: ${{ steps.token.outputs.token }}
       checkout_cross_repo: ${{ steps.parse_repos.outputs.secondary != '' }}
       cross_repo_name: ${{ steps.parse_repos.outputs.secondary }}
   ```

4. **Write `.repo-metadata.json` for symphony-core:**
   ```yaml
   - name: Configure Cross-Repo Metadata
     if: steps.parse_repos.outputs.secondary != ''
     run: |
       cat > .claude/.repo-metadata.json << EOF
       {
         "repoType": "primary",
         "crossRepo": {
           "targetRepo": "secondary",
           "repoName": "${{ steps.parse_repos.outputs.secondary }}",
           "symlinkPath": ".other-repo"
         }
       }
       EOF
   ```

### Symphony-Core Integration

The existing `CROSS_REPO_DISCOVERY` phase in the orchestrator already supports reading from `.other-repo/` via the repo metadata convention. With the secondary repo actually checked out (vs. just a symlink or absent), this phase transitions from "detect and warn" to "detect and incorporate."

**No changes needed to symphony-core orchestrator phases** — the phases already handle:
- Reading `.repo-metadata.json` to find the secondary repo path
- Using discovery agents (`backend-discovery`, `frontend-discovery`) scoped to `.other-repo/`
- Creating `cross-repo-needs.json` with verified dependency information
- Annotating the implementation plan with cross-repo dependency markers

The improvement is purely environmental: the secondary repo is now *actually present* at `.other-repo/` instead of potentially absent.

---

## Relationship to Existing PRDs

This PRD is **complementary to** `PRD-multi-repo-orchestration.md`:

| Aspect | Multi-Repo Orchestration (existing) | Multi-Repo Plan Generation (this PRD) |
|--------|--------------------------------------|----------------------------------------|
| **Focus** | Execution fan-out: dispatch workflows to N repos | Plan quality: generate plans with N-repo context |
| **When** | After plan is finalized, user clicks "Execute" | During plan generation (`@symphony-cl plan`) |
| **Repos involved** | All selected repos get the same plan executed | Primary + 1 secondary repo provide read context |
| **Output** | N pull requests (one per repo) | 1 unified plan with cross-repo annotations |
| **UI change** | Execution status dashboard | Multi-select repo picker (shared) |

**Shared dependency:** Both PRDs require converting `TargetRepositoryFields` to multi-select. This PRD covers that UI change since it's a prerequisite for both.

---

## Future Enhancements (V2+)

- **3+ repo context**: Mount additional repos at `.repos/{name}/` with a directory-based discovery strategy
- **Per-repo plan splitting**: After generating a unified plan, automatically split into per-repo implementation plans for independent execution
- **Auto-detection of related repos**: Infer repo relationships from import maps, API client codegen, or shared dependency declarations
- **Cached repo context**: Pre-index secondary repos on Symphony Alpha infrastructure to avoid full checkout during plan generation
- **Contract validation**: After plans for both repos are generated, validate that API contracts (request/response types) are compatible

---

**Last Updated:** February 11, 2026
**Next Review:** After V1 implementation sprint
