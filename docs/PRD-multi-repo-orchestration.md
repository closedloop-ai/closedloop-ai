# PRD: Multi-Repository Workflow Orchestration

**Author:** Product Team
**Date:** January 2026
**Status:** Draft
**Target Release:** Q1 2026

---

## Summary

**What:** Enable engineering teams to execute ClosedLoop implementation plans across multiple repositories simultaneously, creating PRs in parallel across their entire codebase from a single action in the ClosedLoop Alpha UI.

**Why:** Enterprise customers have monorepo and multi-repo architectures. Today, ClosedLoop can only generate and execute plans for a single repository at a time. This forces teams to manually coordinate changes across multiple repos, losing the productivity benefits of AI-powered implementation.

**Who:** Engineering teams at organizations with multi-repo architectures (microservices, frontend/backend splits, shared libraries) who need coordinated feature delivery across codebases.

**Impact:** Reduce time-to-PR for cross-repo features from hours of manual coordination to minutes of automated orchestration. Unlock ClosedLoop for enterprise customers who can't adopt monorepos.

---

## Context

### Problem

**Current pain:** When engineers need to implement features that span multiple repositories (e.g., API changes + frontend updates, or shared library updates + consumer updates), they must:

1. Generate a plan for repo #1 in ClosedLoop
2. Execute and review PR for repo #1
3. Generate a separate plan for repo #2
4. Execute and review PR for repo #2
5. Manually coordinate timing, dependencies, and PR reviews across repos

This manual process is error-prone, time-consuming, and defeats the purpose of AI-powered development. Teams waste hours coordinating what should be an atomic change.

**Evidence:**
- Beta customer feedback: "We love ClosedLoop but can't use it for most of our work because our architecture is split across 6 repos"
- Support tickets from teams asking "How do I make ClosedLoop work with microservices?"
- Competitive gap: GitHub Copilot Workspace supports multi-file editing but not multi-repo coordination

**Why now:**
- We have paying customers blocked on multi-repo support
- Foundation is solid (single-repo workflows are stable, auth is working, GitHub App integration is proven)
- Window of opportunity before competitors ship multi-repo AI tooling

### Hypothesis

**If** we enable users to select multiple repositories when creating an implementation plan, **then** they'll be able to coordinate cross-repo changes through ClosedLoop instead of manual PR juggling, **resulting in** faster feature delivery and expanded TAM to enterprise customers with distributed architectures.

**Success looks like:**
- 40%+ of implementation plans are scoped to 2+ repositories within 30 days of launch
- Average time from "execute" to "all PRs created" < 5 minutes for 10-repo plans
- Zero cross-organization security incidents (multi-tenant isolation works)

**Kill criteria:**
- <10% adoption of multi-repo plans after 60 days (feature isn't solving a real problem)
- >3 critical security issues in first 30 days (multi-tenant isolation is broken)
- Execution time exceeds 30 seconds for typical 3-repo plan (too slow, defeats UX benefit)

### Personas

**Primary: Senior/Staff Engineer at Enterprise SaaS Company**
- Manages feature delivery across 4-10 microservices
- Coordinates backend API changes with frontend updates
- Frustrated by tooling that assumes monorepo architecture
- Needs: Speed + safety + visibility into multi-repo execution status

**Secondary: Platform/DevEx Engineer**
- Maintains shared libraries consumed by 20+ internal repositories
- Breaking changes require coordinated updates across consumers
- Current process: Slack threads + manual PR tracking spreadsheets
- Needs: Bulk execution + fault tolerance (some repos can fail without blocking others)

---

## Scope

### V1 MVP: In Scope

**Plan Generation with Multi-Repo Selection:**
- ✅ Select 1+ repositories when creating an implementation plan
- ✅ Primary repository is used for plan generation (existing behavior)
- ✅ Selected repositories are stored and displayed in plan metadata

**Parallel Execution:**
- ✅ "Execute" button triggers GitHub Actions workflows in **all selected repositories simultaneously**
- ✅ Each repository gets its own PR with the implementation plan as context
- ✅ Execution status dashboard shows real-time progress for all repositories
- ✅ Failed executions can be manually retried (max 3 attempts)

**Multi-Tenant Security:**
- ✅ Organization-level isolation enforced in all database queries
- ✅ GitHub App authentication scoped to user's organization
- ✅ Correlation IDs include organization ID to prevent cross-tenant pollution

**Fault Tolerance:**
- ✅ Track execution state per repository (PENDING → RUNNING → SUCCESS/FAILURE)
- ✅ Partial failures don't block successful executions
- ✅ Manual retry button for failed executions
- ✅ Execution history preserved for audit/debugging

### V1 MVP: Out of Scope

**Automated Features (Future):**
- ❌ Automatic retry with exponential backoff (V1 = manual retry only)
- ❌ Pre-flight validation that repos have workflow files registered
- ❌ Cross-repository dependency detection or ordering
- ❌ Consolidated PR that references all related PRs

**Optimization (Future PRD):**
- ❌ Codebase context caching on ClosedLoop Alpha infrastructure
- ❌ Server-side plan generation (bypass GitHub Actions for faster iteration)
- ❌ Differential plan generation per repository (V1 = same plan for all repos)

**Advanced Workflows:**
- ❌ Conditional execution (run in repo B only if repo A succeeds)
- ❌ Staged rollout (deploy to staging repos first, then production)
- ❌ Multi-tenant repo sharing (Agency managing multiple client orgs)

### Success Metrics

**Primary (Business Impact):**
- **Adoption:** 40% of new implementation plans use 2+ repositories within 30 days
- **Expansion:** 3+ enterprise customers upgrade plans due to multi-repo support

**Secondary (UX Quality):**
- **Performance:** P95 execution latency < 5 minutes for 10-repo plans
- **Reliability:** <2% of executions fail due to orchestration bugs (not user code)
- **Retry Success Rate:** >80% of manual retries succeed on first attempt

**Guardrails (Security & Compliance):**
- **Zero** cross-organization data leaks (repos from Org A visible to Org B)
- **Zero** GitHub API rate limit errors causing customer-visible failures
- **100%** of executions tracked with audit trail (who, what, when, which repos)

---

## User Stories

### US-001: Select Multiple Repositories for Implementation Plan

**As a** senior engineer coordinating a cross-repo feature
**I want to** select multiple repositories when generating an implementation plan
**So that** I can execute the same plan across all affected repositories without manual duplication

**Acceptance Criteria:**

- **AC-001.1**: Given I'm creating a new implementation plan from a PRD, when I reach the repository selection step, then I see a multi-select dropdown of all repositories in my project
- **AC-001.2**: Given I've selected 2+ repositories, when the plan is generated, then the plan metadata displays all selected repositories
- **AC-001.3**: Given I'm viewing an existing implementation plan, when I check the plan details, then I can see which repositories are in scope (even if plan was created before multi-repo support)
- **AC-001.4**: Given I select a repository that's already been deleted from the project, when I view the plan, then I see a warning that the repository is no longer available but the historical reference is preserved

### US-002: Execute Plan Across Multiple Repositories Simultaneously

**As a** senior engineer with a multi-repo plan
**I want to** click one "Execute" button and have PRs created in all repositories in parallel
**So that** I don't waste time manually triggering execution repo-by-repo

**Acceptance Criteria:**

- **AC-002.1**: Given I have an implementation plan scoped to 3 repositories, when I click "Execute Plan", then GitHub Actions workflows are triggered in all 3 repositories within 5 seconds
- **AC-002.2**: Given the execution has started, when I navigate to the execution status page, then I see real-time status for each repository (PENDING/RUNNING/SUCCESS/FAILURE)
- **AC-002.3**: Given 1 repository fails while 2 succeed, when I review the results, then the 2 successful PRs are still created and I can see the error details for the failed repository
- **AC-002.4**: Given all executions complete, when I view the status dashboard, then I see clickable links to all created PRs

### US-003: Monitor Execution Status Per Repository

**As a** senior engineer who initiated a multi-repo execution
**I want to** see real-time status for each repository on a single dashboard
**So that** I know when it's safe to review PRs and can identify failures quickly

**Acceptance Criteria:**

- **AC-003.1**: Given I initiated an execution for 5 repositories, when I navigate to the execution status page, then I see a table with one row per repository showing: repository name, status, PR link (if created), and execution time
- **AC-003.2**: Given an execution is RUNNING, when I keep the status page open, then the status auto-refreshes every 10 seconds without requiring a page reload
- **AC-003.3**: Given I've navigated away from the status page, when I return after 5 minutes, then the status reflects the current state (no stale data)
- **AC-003.4**: Given I'm viewing the status on a backgrounded browser tab, when the execution completes, then polling stops automatically to save resources (uses Page Visibility API)

### US-004: Retry Failed Executions

**As a** senior engineer whose execution failed in 1 of 5 repositories
**I want to** retry just the failed repository without re-running successful ones
**So that** I can recover from transient errors (network issues, GitHub API rate limits) without wasting time

**Acceptance Criteria:**

- **AC-004.1**: Given a repository execution has FAILED status, when I click the "Retry" button for that repository, then a new GitHub Actions workflow is triggered with the same plan context
- **AC-004.2**: Given I've retried the same repository 3 times, when I attempt a 4th retry, then the retry button is disabled and I see a message "Maximum retries reached (3/3)"
- **AC-004.3**: Given a retry succeeds, when I view the execution history, then I see both the original failed attempt and the successful retry with timestamps
- **AC-004.4**: Given I retry a repository that failed 10 minutes ago, when the retry is triggered, then it uses the current state of the repository (not the state from 10 minutes ago)

### US-005: Multi-Tenant Security Enforcement

**As a** ClosedLoop Alpha platform operator
**I want** organization-level isolation enforced on all multi-repo operations
**So that** customers can never see or execute workflows in other organizations' repositories

**Acceptance Criteria:**

- **AC-005.1**: Given I'm authenticated as a user in Organization A, when I call the execute API, then the backend validates my organization ID matches the plan's organization before dispatching workflows
- **AC-005.2**: Given a webhook arrives from GitHub for a completed workflow, when the backend processes it, then it validates the correlation ID's embedded organization ID matches the stored organization ID before updating database records
- **AC-005.3**: Given I'm viewing the execution status page, when the page fetches execution data, then the API only returns GitHubActionRun records belonging to my organization (even if correlation IDs collide across orgs)
- **AC-005.4**: Given Organization A and Organization B both have a repository named "api-service", when I select repositories for my plan, then I only see repositories from my organization (no cross-org leakage)

### US-006: Preserve Execution Audit Trail

**As a** platform engineer investigating why a deployment failed
**I want** permanent execution history with full context for each attempt
**So that** I can debug failures and prove compliance with change management processes

**Acceptance Criteria:**

- **AC-006.1**: Given an execution completed 30 days ago, when I navigate to the execution history page, then I see all execution attempts (original + retries) with timestamps, statuses, and correlation IDs
- **AC-006.2**: Given I'm viewing execution history, when I click on a specific execution, then I see: triggering user, plan content snapshot, selected repositories, GitHub workflow run links, and any error messages
- **AC-006.3**: Given a repository was deleted after execution, when I view old execution records, then the repository name is preserved (soft delete or historical reference)
- **AC-006.4**: Given I need to export execution data for compliance auditing, when I query the database, then all GitHubActionRun records include organizationId (non-nullable) for proper tenant attribution

---

## Open Questions

### Plan Generation & Scoping

- **Q-001**: Should plan generation also fan out to multiple repositories, or only execution?
  - **Current assumption:** Plan generation uses primary repository only (V1 MVP). Execute step runs same plan across all selected repos.
  - **Alternative:** Generate repo-specific plans by running plan generation in each repo's context (higher quality but slower and more complex).
  - **Decision needed by:** Sprint planning (impacts V1 scope)

- **Q-002**: How should plan content be structured for multi-repo scenarios?
  - **Current assumption:** Single unified plan artifact applied to all repositories (V1 MVP).
  - **Alternative:** Plan with sections per repository, or separate plan artifacts linked by parent ID.
  - **Decision needed by:** Design review (impacts database schema and UI)

### Execution & Error Handling

- **Q-003**: What happens if some repos succeed and others fail during execution?
  - **Current assumption:** Partial failures are allowed. Successful PRs remain open, failed repos show error state and can be retried (V1 MVP).
  - **Alternative:** All-or-nothing rollback (complex, requires PR deletion automation).
  - **Decision needed by:** Beta testing (based on user feedback)

- **Q-004**: What retry strategy should be used for transient failures?
  - **Current assumption:** Manual retry only, max 3 attempts per repository (V1 MVP).
  - **Alternative:** Automatic retry with exponential backoff (defer to V2 due to complexity).
  - **Decision needed by:** Post-V1 (based on failure rate data)

### Workflow Registration & Validation

- **Q-005**: Should ClosedLoop validate that user repos have workflow files before execution?
  - **Current assumption:** No pre-flight validation. Execution fails with helpful error if workflow file missing (V1 MVP).
  - **Alternative:** GitHub API check for `.github/workflows/symphony-dispatch.yml` existence before dispatch (adds latency).
  - **Decision needed by:** Alpha testing (measure failure rate due to missing workflows)

### GitHub App Permissions

- **Q-006**: How to handle org-level GitHub App installation vs per-repo permissions?
  - **Current assumption:** GitHub App installed at organization level, scoped to selected repositories during installation (V1 MVP).
  - **Alternative:** Require explicit per-repo permissions grants (more granular but worse UX).
  - **Decision needed by:** Security review (compliance requirement check)

### Session Management

- **Q-007**: How should session resumability work across browser refreshes?
  - **Current assumption:** Execution state stored in database, UI polls for updates. Browser refresh = page reload with fresh data (V1 MVP).
  - **Alternative:** WebSocket connection for real-time updates + session reconnection logic (defer to V2).
  - **Decision needed by:** UX testing (measure pain of page reloads during long executions)

---

## Compliance & Risk

### Multi-Tenant Data Isolation (CRITICAL)

**Risk:** Organization A could potentially trigger workflows in Organization B's repositories or view their execution status if tenant boundaries aren't enforced.

**Mitigation:**
- All database queries filtered by `organizationId` extracted from Clerk auth context
- Correlation IDs embed organization ID in format `{env}:{orgId}:{runId}` for webhook validation
- GitHubActionRun table has non-nullable `organizationId` column (enforced at schema level)
- Code review checklist item: "Does this query filter by orgId?"

**Compliance requirement:** SOC 2 Type II requires logical isolation between tenants.

### GitHub API Rate Limits

**Risk:** Dispatching workflows to 100+ repositories could hit GitHub API rate limits (5000 req/hour for Apps).

**Mitigation:**
- V1 uses parallel dispatch with `Promise.allSettled()` (no artificial delays)
- Monitor rate limit headers and implement exponential backoff if approaching limit
- Document recommended max: 50 repositories per execution for V1

**Escalation path:** If customers need >50 repos, prioritize GitHub Enterprise Server support (higher rate limits).

### Orphaned Workflow Runs

**Risk:** If ClosedLoop Alpha crashes or database transaction fails mid-dispatch, we could trigger GitHub workflows without corresponding GitHubActionRun records (zombie executions).

**Mitigation:**
- Two-phase commit: Create all GitHubActionRun records BEFORE dispatching workflows
- Correlation ID in workflow inputs allows matching orphaned runs back to plans
- Dead-letter queue pattern for webhooks that arrive before DB commit completes

**Rollback plan:** Manual script to query GitHub API for workflow runs and backfill missing database records.

### Backward Compatibility

**Risk:** Changing correlation ID format from `{env}:{runId}` to `{env}:{orgId}:{runId}` breaks in-flight workflows.

**Mitigation:**
- Support both V1 and V2 correlation ID formats during transition period (2 weeks)
- Webhook handler attempts V2 parse first, falls back to V1 parse
- New executions use V2 format only
- After 2 weeks, remove V1 support (all in-flight workflows completed)

**Rollback plan:** Feature flag to revert to V1 format if widespread failures detected.

### Access Requirements

- **GitHub:** Organization-level GitHub App installation with `contents: write`, `pull_requests: write`, `actions: read` permissions
- **Database:** Migration permissions to add non-nullable column to GitHubActionRun table
- **AWS S3:** Existing bucket for artifact storage (no new permissions needed)

**PHI/PII Assessment:**
- **No PHI/PII stored** in plan content or execution records
- Repository names are metadata, not protected data
- GitHub usernames are public information, not PII under GDPR

---

## Analytics

### Key Events (PostHog)

Track these events to validate hypothesis and measure success metrics:

**Plan Generation Events:**
- `Plan Created` - Fired when user saves a new implementation plan
  - Properties:
    - `repository_count` (integer) - Number of repositories selected
    - `is_multi_repo` (boolean) - True if repository_count > 1
    - `primary_repository` (string) - Name of primary repo used for plan generation
    - `project_id` (string) - Project ID for segmentation
    - `plan_type` (string) - "Implementation Plan" | "PRD" | etc.

**Execution Events:**
- `Execution Started` - Fired when user clicks "Execute Plan"
  - Properties:
    - `plan_id` (string) - Artifact ID
    - `repository_count` (integer) - Number of repos in execution
    - `execution_mode` (string) - "Single" | "Multi" for segmentation

- `Execution Completed` - Fired when all repositories finish (success or failure)
  - Properties:
    - `plan_id` (string)
    - `total_repositories` (integer)
    - `successful_repositories` (integer)
    - `failed_repositories` (integer)
    - `execution_duration_seconds` (integer) - Time from start to completion
    - `outcome` (string) - "AllSuccess" | "PartialSuccess" | "AllFailed"

- `Execution Retry Triggered` - Fired when user retries a failed repository
  - Properties:
    - `repository_id` (string)
    - `retry_attempt` (integer) - 1, 2, or 3
    - `original_failure_reason` (string) - Error category

**Status Monitoring Events:**
- `Execution Status Viewed` - Fired when user navigates to execution status page
  - Properties:
    - `plan_id` (string)
    - `has_active_executions` (boolean)
    - `repositories_in_flight` (integer)

### Conversion Funnel

Track adoption of multi-repo feature:

1. User creates plan with 1 repo (baseline)
2. User creates plan with 2+ repos (adoption signal)
3. User executes multi-repo plan (usage confirmation)
4. User views execution status (engagement)
5. User merges at least 1 PR (value delivered)

**Target:** 40% of users who create 5+ plans should create at least 1 multi-repo plan within 30 days.

### Platform & Coverage

- **Web only** (Next.js static export)
- **Tracking via:** PostHog SDK in `packages/analytics`
- **No mobile instrumentation** (ClosedLoop Alpha is web-only product)

---

## Dependencies & Risks

### External Dependencies

- **GitHub App Permissions:** Requires customers to install/update GitHub App with expanded repository access
  - **Risk:** Customers may be blocked by security review (IT approval required)
  - **Mitigation:** Provide GitHub App permission justification doc for security teams

- **Repository Workflow Files:** Customers must add `.github/workflows/symphony-dispatch.yml` to each repository
  - **Risk:** Onboarding friction, execution failures if workflow missing
  - **Mitigation:** Auto-generate workflow file template in onboarding flow (future enhancement)

### Internal Dependencies

- **Clerk Auth Context:** Requires `organizationId` to be reliably available in all authenticated requests
  - **Risk:** If Clerk session expires during execution, webhook processing could fail
  - **Mitigation:** Use correlation ID lookup as fallback if auth context unavailable

- **S3 Artifact Storage:** Execution outputs uploaded to S3 bucket
  - **Risk:** S3 outage would block webhook completion (orphaned database records)
  - **Mitigation:** Dead-letter queue for webhooks, manual backfill script

### Technical Risks

**High Risk:**
- **Cross-tenant data leak:** If organization filtering fails, users could see other orgs' executions
  - **Probability:** Low (if code review enforces orgId checks)
  - **Impact:** Critical (security incident, SOC 2 failure)
  - **Mitigation:** Mandatory code review checklist + integration tests covering org isolation

**Medium Risk:**
- **GitHub API rate limits:** Parallel dispatch to 50+ repos could hit rate limits
  - **Probability:** Medium (depends on customer repo count)
  - **Impact:** Medium (execution failures, poor UX)
  - **Mitigation:** Monitor rate limit headers, implement backoff, document limits

**Low Risk:**
- **Database transaction failures:** Partial writes could create inconsistent state
  - **Probability:** Low (Postgres is reliable)
  - **Impact:** Medium (orphaned records, audit trail gaps)
  - **Mitigation:** Two-phase commit pattern, idempotency checks

---

## Release & Operations

### Rollout Plan

**Phase 1: Alpha (Week 1-2)**
- Enable multi-repo selection for 2-3 internal test users
- Test with 2-3 repositories max per plan
- Focus: Multi-tenant isolation validation, basic execution flow

**Phase 2: Beta (Week 3-4)**
- Expand to 10 beta customers (hand-selected power users)
- Allow up to 10 repositories per plan
- Focus: Performance measurement, failure rate analysis, UX feedback

**Phase 3: GA (Week 5)**
- Enable for all users (feature flag removed)
- No repository count limit (but document recommended max of 50)
- Focus: Monitor adoption metrics, rate limit alerts, security monitoring

### Success Criteria for Phase Advancement

**Alpha → Beta:**
- Zero cross-tenant security issues in internal testing
- <5% execution failure rate due to orchestration bugs
- P95 latency < 10 seconds for 3-repo execution

**Beta → GA:**
- 60%+ beta users create at least 1 multi-repo plan
- <2% execution failure rate in beta
- Zero critical bugs filed by beta users

### Monitoring & Alerts

**Critical Alerts:**
- Cross-organization data leak (query returns wrong orgId)
- GitHub API rate limit exceeded (429 responses)
- Database transaction rollback rate >1% (indicates infrastructure issue)

**Warning Alerts:**
- Execution failure rate >5% (may indicate workflow file issues)
- P95 execution latency >10 minutes (performance degradation)
- Retry rate >30% (indicates execution reliability problem)

### Rollback Plan

**Feature flag:** `ENABLE_MULTI_REPO_ORCHESTRATION` (environment variable)

**Rollback scenarios:**
1. **Security issue:** Disable multi-repo selection in UI (fall back to single-repo only)
2. **Performance issue:** Reduce max repository count to 5 via runtime config
3. **Data corruption:** Revert database migration, restore from backup, disable webhook processing

**Rollback SLA:** 15 minutes from incident detection to feature disabled.

---

## Future Enhancements (V2+)

These are explicitly out of scope for V1 but documented for roadmap planning:

### Automatic Retry & Dead-Letter Queue
- Automatic exponential backoff retry for transient failures (network errors, rate limits)
- Dead-letter queue for webhooks that arrive before database commits
- **Value:** Reduce manual retry burden, improve fault tolerance

### Pre-Flight Validation
- GitHub API check for workflow file existence before dispatch
- Estimated execution time based on repository size
- **Value:** Catch configuration errors earlier, set user expectations

### Differential Plan Generation
- Generate repository-specific plans based on each repo's codebase context
- Cross-repo dependency detection and ordering
- **Value:** Higher quality implementations, better handling of polyglot repos

### Codebase Context Caching
- Cache repository code context on ClosedLoop Alpha infrastructure
- Run plan generation server-side without GitHub Actions (faster iteration)
- **Value:** Reduce GitHub Actions costs, improve plan generation speed

### Consolidated PR Tracking
- Create meta-issue linking all related PRs across repositories
- Visualize cross-repo PR approval status on single dashboard
- **Value:** Easier coordination for reviewers, better audit trail

---

## Appendix

### Related Documents
- Implementation Plan: `.claude/runs/20260119-220835/implementation-plan.md`
- Investigation Log: `.claude/runs/20260119-220835/investigation-log.md`
- Technical Design Doc: (to be created by engineering)

### Glossary
- **Plan Scope:** The set of repositories associated with an implementation plan
- **Fan-Out Execution:** Parallel dispatch of workflows to multiple repositories
- **Correlation ID:** Unique identifier linking workflow runs back to ClosedLoop Alpha execution records
- **Multi-Tenant Isolation:** Ensuring Organization A cannot access Organization B's data
- **Dead-Letter Queue:** Queue for webhook events that fail processing for retry/investigation

### Design Mocks
(To be added: Figma links for repository selector UI, execution status dashboard)

---

**Last Updated:** January 20, 2026
**Next Review:** After beta phase completion
