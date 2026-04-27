# Implementation Plan: CI/CD Baseline Enforcement

## Summary

Establish a common CI/CD quality baseline across the symphony-alpha repository by adding linting, dependency/security scanning, artifact integrity validation, and release metadata capture to existing workflows. Harden all workflow configurations with SHA-pinned actions, explicit least-privilege permissions, and secret minimization. Provide template CI configurations for closedloop-electron and claude-plugins repositories.

**Scope:**
- In-scope: Symphony-alpha CI hardening (lint gate, security scanning, artifact validation, permissions audit, action pinning, release metadata, branch protection compatibility), template workflows for closedloop-electron and claude-plugins
- Out-of-scope: Direct commits to closedloop-electron and claude-plugins repositories (separate repos requiring manual setup), Vercel deployment configuration changes, infrastructure provisioning

## Acceptance Criteria

| ID | Criterion | Source |
|----|-----------|--------|
| AC-001 | Given a PR is opened against symphony-alpha, when CI runs, then lint, type check, test execution, and dependency/security scanning all run and must pass before merge is allowed | Imported plan |
| AC-002 | Given a dependency vulnerability is detected in security scanning, when the CI gate evaluates, then the check fails and merge is blocked until the vulnerability is resolved or explicitly exempted with documented justification | Imported plan |
| AC-003 | Given a build or artifact validation step is defined, when the CI run completes, then the artifact is validated for integrity and the result is reported in the PR check status | Imported plan |
| AC-004 | Given any workflow job in symphony-alpha, when the workflow file is inspected, then it has explicit permissions declarations with no wildcard write-all grants, and all third-party actions are pinned to a specific SHA | Imported plan |
| AC-005 | Given secrets are referenced in a workflow, when the scope of those secrets is evaluated, then no secret has broader access than required for the specific job that uses it | Imported plan |
| AC-006 | Given a release pipeline runs for symphony-alpha, when it completes, then release metadata (version, commit ref, build timestamp, validation outcome) is captured and stored | Imported plan |

## Architecture Decisions

| Decision | Options | Chosen | Rationale |
|----------|---------|--------|----------|
| Security scanning tool | GitHub CodeQL, Snyk, Trivy, npm audit | GitHub Dependency Review Action + npm audit | GitHub Dependency Review Action is free, integrates natively with PR checks, scans for known vulnerabilities in dependency changes. npm audit covers transitive deps. No external service needed. |
| Action pinning strategy | Full SHA pinning, major version tags, Renovate/Dependabot auto-pin | Full SHA pinning with comment annotations | PRD requires "SHA-pinned or equivalent supply-chain protection." SHA pinning is the strongest guarantee. Comment annotations preserve readability. |
| Release metadata storage | GitHub Releases API, workflow artifact, repo file | GitHub Releases API + workflow run artifact | GitHub Releases is the standard mechanism, provides API access and UI. Workflow artifact provides detailed validation logs. |
| Artifact integrity approach | Checksums, container scanning, build attestation | Docker build attestation + image digest verification | Docker buildx supports provenance attestation natively. Image digest (SHA256) provides integrity verification without additional tooling. |
| Vulnerability exemption mechanism | .github/vulnerability-exemptions.yml, inline comments, GitHub security advisories dismissal | .github/vulnerability-exemptions.yml config file | Provides auditable, version-controlled exemption tracking with documented justification per AC-010.2. |
| Cross-repo template strategy | Shared reusable workflows, template files in this repo, manual copy | Template workflow files in .github/workflow-templates/ directory | Templates can be reviewed in this repo, then manually applied to other repos. Reusable workflows require org-level setup not yet in place. |

## Architecture Fit

This feature operates entirely within `.github/workflows/` YAML configuration files and new supporting files (`.github/vulnerability-exemptions.yml`, `.github/workflow-templates/`). No application source code is modified.

- Impacted files/modules: All `.github/workflows/*.yml` files (pr-test.yml, deploy-production.yml, build-container.yml, build-mcp-server.yml, symphony.yml, claude-code-review.yml, dependabot-autofix.yml, cleanup-preview-schemas.yml, enforce-prod-source.yml); new files `.github/vulnerability-exemptions.yml` and `.github/workflow-templates/electron-ci.yml`, `plugins-ci.yml`, `release-metadata.yml`
- State/storage changes: Workflow run artifacts (release metadata JSON, image digests) stored in GitHub Actions artifact storage per run. GitHub Releases created with structured metadata on each production deployment.
- Integration points: GitHub Dependency Review Action reads pnpm-lock.yaml diff on PRs; Docker buildx provenance writes attestation to registry; GitHub Releases API called from deploy-production.yml post-deploy.

## Tasks

### Phase 1: Symphony-Alpha PR CI Baseline

- [x] **T-1.1**: Add a lint job to `.github/workflows/pr-test.yml` that runs `pnpm lint` with explicit permissions (contents: read), matching the existing typecheck/test job patterns *(AC-001)*
- [x] **T-1.2**: Add a security-scan job to `.github/workflows/pr-test.yml` using the GitHub Dependency Review Action (actions/dependency-review-action) to scan PR dependency changes for known vulnerabilities, configured to fail on high/critical severity *(AC-001, AC-002)*
- [x] **T-1.3**: Create `.github/vulnerability-exemptions.yml` with a schema for documenting exempted vulnerabilities (CVE ID, justification, expiry date, approver) and configure the dependency review action to reference it *(AC-002)*
- [x] **T-1.4**: Add explicit permissions blocks to the typecheck and test jobs in `.github/workflows/pr-test.yml` (currently missing; should be contents: read) *(AC-004)*

### Phase 2: Action SHA Pinning

- [x] **T-2.1**: Pin all third-party actions in `.github/workflows/pr-test.yml` to full commit SHAs with version comment annotations (actions/checkout, pnpm/action-setup, actions/setup-node) *(AC-004)*
- [x] **T-2.2**: Pin all third-party actions in `.github/workflows/deploy-production.yml` to full commit SHAs (actions/checkout, actions/setup-node, actions/create-github-app-token) *(AC-004)*
- [x] **T-2.3**: Pin all third-party actions in `.github/workflows/build-container.yml` to full commit SHAs (actions/checkout, actions/create-github-app-token, aws-actions/configure-aws-credentials, aws-actions/amazon-ecr-login, docker/setup-buildx-action) *(AC-004)*
- [x] **T-2.4**: Pin all third-party actions in `.github/workflows/build-mcp-server.yml` to full commit SHAs *(AC-004)*
- [x] **T-2.5**: Pin all third-party actions in `.github/workflows/symphony.yml` to full commit SHAs *(AC-004)*
- [x] **T-2.6**: Pin all third-party actions in `.github/workflows/claude-code-review.yml` to full commit SHAs *(AC-004)*
- [x] **T-2.7**: Pin all third-party actions in `.github/workflows/dependabot-autofix.yml` to full commit SHAs *(AC-004)*
- [x] **T-2.8**: Pin all third-party actions in `.github/workflows/cleanup-preview-schemas.yml` and `.github/workflows/enforce-prod-source.yml` to full commit SHAs *(AC-004)*

### Phase 3: Permissions Audit and Secret Minimization

- [x] **T-3.1**: Audit and tighten permissions in `.github/workflows/deploy-production.yml` - move workflow-level permissions to job-level and verify each permission is necessary for the specific steps *(AC-004, AC-005)*
- [x] **T-3.2**: Audit and verify permissions in `.github/workflows/symphony.yml` jobs - ensure no job has broader permissions than required for its specific steps *(AC-004, AC-005)*
- [x] **T-3.3**: Audit secret references across all workflows to verify each secret is only available in the job that needs it (not workflow-level env), documenting findings as inline comments *(AC-005)*

### Phase 4: Artifact Integrity and Build Validation

- [x] **T-4.1**: Add Docker build attestation (provenance) and image digest capture/verification to `.github/workflows/build-container.yml` using buildx provenance flags, and output the digest as a workflow artifact *(AC-003)*
- [x] **T-4.2**: Add Docker build attestation and image digest capture/verification to `.github/workflows/build-mcp-server.yml` following the same pattern as T-4.1 *(AC-003)*
- [x] **T-4.3**: Add a build-validation job to `.github/workflows/pr-test.yml` that runs `pnpm build` for affected packages and reports success/failure as a PR check *(AC-003)*

### Phase 5: Release Metadata Capture

- [x] **T-5.1**: Add a release metadata capture step to `.github/workflows/deploy-production.yml` that creates a structured JSON object with version (git describe), commit ref, build timestamp, validation outcomes (health checks), and uploads it as a workflow artifact *(AC-006)*
- [x] **T-5.2**: Add a GitHub Release creation step to `.github/workflows/deploy-production.yml` that creates a release tagged with the deployment version, including the changelog and release metadata *(AC-006)*

### Phase 6: Cross-Repository CI Templates

- [x] **T-6.1**: Create `.github/workflow-templates/electron-ci.yml` template for closedloop-electron with jobs for lint, type check, test, packaging validation, code signing validation, installer integrity check, and dependency scanning - all with explicit permissions and SHA-pinned actions *(AC-001, AC-003, AC-004)*
- [x] **T-6.2**: Create `.github/workflow-templates/plugins-ci.yml` template for claude-plugins with jobs for lint, type check, test, packaging/tool validation, compatibility checks, and dependency scanning - all with explicit permissions and SHA-pinned actions *(AC-001, AC-003, AC-004)*
- [x] **T-6.3**: Create `.github/workflow-templates/release-metadata.yml` reusable workflow template for release metadata capture that can be used by all three repositories *(AC-006)*

### Phase 7: Manual Verification

- [ ] **T-7.1** [MANUAL]: Apply electron-ci.yml template to closedloop-electron repository and verify all CI checks pass on a test PR *(AC-001, AC-004)*
- [ ] **T-7.2** [MANUAL]: Apply plugins-ci.yml template to claude-plugins repository and verify all CI checks pass on a test PR *(AC-001, AC-004)*
- [ ] **T-7.3** [MANUAL]: Configure GitHub branch protection rulesets on all three repositories to require status checks passing before merge and required reviews for production branches *(AC-001)*
- [ ] **T-7.4** [MANUAL]: Verify that security scanning failures actually block merge by opening a test PR with a known vulnerable dependency *(AC-002)*
- [ ] **T-7.5** [MANUAL]: Trigger a production deployment and verify release metadata (version, commit ref, timestamp, validation outcome) is captured in the GitHub Release *(AC-006)*
- [ ] **T-7.6** [MANUAL]: Verify full CI pipeline completes within 15 minutes on symphony-alpha *(AC-001)*

## API & Data Impacts

No application API endpoints are added or modified. All changes are confined to GitHub Actions workflow YAML files and supporting configuration.

- GitHub Actions REST API: deploy-production.yml will call the GitHub Releases API (POST /repos/{owner}/{repo}/releases) to create versioned releases with metadata (T-5.2). This requires a `contents: write` permission scoped to that specific job.
- Workflow artifacts: Each container build job (build-container.yml, build-mcp-server.yml) will upload an artifact containing the image digest (SHA256). Each production deployment will upload a release metadata JSON artifact. Artifacts are retained per GitHub Actions default retention policy.
- No database schema changes. No new environment variables required beyond secrets already present (GITHUB_TOKEN is available by default; existing AWS credentials and app tokens are already configured).

## Risks & Constraints

| Risk | Mitigation |
|------|------------|
| SHA-pinned actions become stale as upstream releases patch security vulnerabilities | Document SHA values with version comments (e.g., # v4.1.0) so Dependabot can identify and auto-update them |
| pnpm build in T-4.3 adds significant CI time and may exceed the 15-minute target | Scope build-validation to changed packages using `pnpm turbo build --filter=[HEAD^1]`; measure baseline before enforcing as hard gate |
| Dependency Review Action may flag transitive vulnerabilities in devDependencies with no direct fix available | Configure vulnerability-exemptions.yml with time-limited exemptions; team must document justification per AC-002 |
| contents: write required for GitHub Release creation (T-5.2) widens permissions on deploy-production.yml | Scope contents: write to the release creation job only, not the full workflow |
| Template workflows (T-6.1, T-6.2) may diverge from actual repo toolchains in closedloop-electron and claude-plugins | Templates include inline comments marking toolchain-specific placeholders; manual application step (T-7.1, T-7.2) validates fit |
| Self-hosted runners used in symphony.yml may have different permission boundaries than GitHub-hosted runners | Audit symphony.yml permissions (T-3.2) accounts for this; no runner migration is in scope |

## Test Plan

- [ ] Unit: No application unit tests are added or modified. Workflow YAML syntax is validated by GitHub Actions on push (syntax errors surface as workflow parse failures before any job runs).
- [ ] Integration: Open a draft PR against symphony-alpha after T-1.1 through T-1.4 are merged to verify the lint, security-scan, typecheck, test, and build-validation jobs all appear in the PR checks UI and report correct pass/fail status.
- [ ] Integration: After T-2.1 through T-2.8, confirm no workflow fails due to SHA resolution errors by triggering each affected workflow on a test branch.
- [ ] Integration: After T-5.1 and T-5.2, trigger a staging deployment and confirm a GitHub Release is created with a populated metadata artifact (version field, commit ref, timestamp, and validation outcome all non-empty).
- [ ] E2E: T-7.4 (manual) - open a test PR introducing a known-vulnerable npm package and confirm the security-scan check fails and blocks merge.
- [ ] E2E: T-7.5 (manual) - trigger a production deployment end-to-end and verify the GitHub Release artifact contains all required metadata fields.
- [ ] E2E: T-7.6 (manual) - measure full CI pipeline wall-clock time on symphony-alpha to confirm it stays under 15 minutes.

## Rollback

All changes in this plan are additive edits to GitHub Actions workflow YAML files. No application code, database schema, or infrastructure is modified.

- To revert a specific workflow change: `git revert <commit>` targeting the relevant workflow file. GitHub Actions picks up the reverted YAML immediately on the next trigger.
- To revert action SHA pinning: restore the original version tag references from git history. The prior workflow file is always available via `git show <commit>:.github/workflows/<file>.yml`.
- To disable the security-scan gate without removing it: set `fail-on-severity: critical` (raising the threshold) or temporarily comment out the security-scan job needs dependency in the merge gate.
- The vulnerability-exemptions.yml file can be updated to exempt a blocking CVE as an immediate unblock while a proper fix is developed.
- Template files in `.github/workflow-templates/` are not applied to any live CI until manually copied to the target repo (T-7.1, T-7.2); removing them from symphony-alpha has no operational impact on other repos.
- GAP-002 (rollback awareness for identifying last known-good artifact) is not resolved in this plan; GitHub Releases history provides a manual lookup path for prior known-good deployments.

## Open Questions

- [ ] Q-001: Should the vulnerability exemption file support time-limited exemptions that auto-expire, or permanent exemptions only? *(Recommended: Time-limited with expiry date field; expired exemptions re-trigger the failure)*
- [ ] Q-002: For closedloop-electron, what are the specific code signing and installer integrity validation commands/tools? The PRD mentions these gates but does not specify tooling. *(Recommended: Use electron-builder's built-in code signing verification for the platform; defer specifics to the electron repo team)*

## Gaps

- [ ] **GAP-001**: PRD requires CI baseline for closedloop-electron and claude-plugins but this repo only has direct access to symphony-alpha. Template workflows are provided but applying them requires manual action in those repositories.
- [ ] **GAP-002**: PRD specifies "rollback awareness (ability to identify last known-good artifact)" but does not define how rollback identification should work - whether via GitHub Releases tagging, a status file, or deployment history lookup.
- [ ] **GAP-003**: PRD mentions "notification hooks on release events" but does not specify which notification channels beyond the existing Slack integration in deploy-production.yml.
- [ ] **GAP-004**: PRD states "pipeline configuration changes must themselves pass the CI gate" (self-hosting) but does not specify whether workflow YAML changes should trigger a dry-run or validation step beyond standard CI checks.

## Visual References

No visual references attached.