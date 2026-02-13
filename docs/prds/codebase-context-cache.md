# Codebase Context Cache

**Owner:** Mike | **Status:** Draft | **Target:** Q1 2026

---

## Summary

Auto-generate and cache a "code context model" for each connected GitHub repo so that PRD generation is grounded in actual codebase architecture, patterns, and conventions. Context updates continuously via webhooks as the code evolves.

---

## Context

### Problem

PRDs created in Symphony lack awareness of the target codebase. PMs write requirements that don't account for existing patterns, architecture constraints, or conventions—leading to back-and-forth with engineering and plans that miss the mark.

### Hypothesis

We believe auto-generated codebase context will produce higher-quality PRDs for PMs, measured by reduced feasibility questions and PRDs that correctly reference existing patterns.

### Personas

- **Primary:** Product Manager — Needs to write PRDs that are technically grounded without deep-diving into code
- **Secondary:** Engineer — Uses Symphony for planning and benefits from context-aware outputs

---

## Scope

### In (MVP)

- On GitHub repo connect, trigger initial codebase scan
- Generate a "CLAUDE.md-style" context summary containing:
  - Project purpose / what it does
  - Tech stack & key dependencies
  - Architecture overview (monorepo structure, service boundaries, layers)
  - Key conventions & patterns
  - Module/interface summary (where things live, key abstractions)
- Store in existing `codebaseSummary` field on Project (from PR #85)
- Update context incrementally on push webhooks
- PRD generation surfaces relevant context when user is working on that repo

### Out (Deferred)

- Per-repo storage — MVP uses project-level storage; per-repo context when multi-repo projects are supported
- Vector database / semantic search — future enhancement for richer querying
- Dependency graph visualization — useful but not MVP
- Structured code map with full interface contracts — MVP is freeform markdown, structured schema is fast-follow

### Success Metrics

| Metric | Baseline | Target | How Measured |
|--------|----------|--------|--------------|
| PRDs reference actual codebase patterns | 0% | >50% | Manual review of generated PRDs |
| PM satisfaction with PRD quality | TBD | +20% | Survey |
| Eng feasibility pushback on PRDs | TBD | -30% | Tracked in sprint retros |

### Kill Criteria

If PRD quality improvement is not noticeable in user feedback after 2 sprints, revisit the context model schema.

---

## Compliance & Risk

No PHI involved. Caching code metadata from repos already accessible via GitHub integration—no new access patterns.

### Dependencies & Risks

| Risk/Dependency | Mitigation | Owner |
|-----------------|------------|-------|
| GitHub webhook reliability | Implement retry logic, manual refresh option | Eng |
| Context model gets stale | Continuous updates on push, timestamp visibility | Eng |
| Large repos slow to scan | Incremental updates, background processing | Eng |

---

## Open Questions

- **Q-001:** ~~What's the ideal context model schema?~~ **Resolved:** Freeform markdown for MVP. Upgrade to structured JSON when we know what queries we need.
- **Q-002:** ~~How do we handle monorepos with multiple logical projects?~~ **Resolved:** One context per repo. Monorepos get a single comprehensive context doc.
- **Q-003:** ~~Should users be able to edit/augment the generated context?~~ **Resolved:** Yes, editable. Users can customize the generated context like a CLAUDE.md.
- **Q-004:** ~~How does this integrate with PR #85's existing schema?~~ **Resolved:** Use PR #85's `codebaseSummary` and `lastIndexedAt` fields on Project. Auto-generate what's currently manually uploaded. Per-repo storage deferred until multi-repo projects are supported.

---

## User Stories

### US-001: Initial repo scan on GitHub connect

**As a** PM, **I want** Symphony to automatically analyze my codebase when I connect a GitHub repo **so that** I don't have to manually describe the architecture.

**Priority:** P0

**Acceptance Criteria:**

- **AC-001.1:** Given a project without a connected repo, when user completes GitHub repo connection, then a background job is queued to scan the repo
- **AC-001.2:** Given the scan job is running, when it completes successfully, then `codebaseSummary` is populated with markdown content
- **AC-001.3:** Given the scan job completes, when the summary is saved, then `lastIndexedAt` is set to current timestamp
- **AC-001.4:** Given a large repo (>10k files), when scan is triggered, then it completes within 5 minutes without timeout
- **AC-001.5:** Given scan fails (API error, rate limit), when failure occurs, then error is logged and user can retry via manual refresh

---

### US-002: Continuous context updates

**As a** PM, **I want** the codebase context to stay current as the code changes **so that** my PRDs reflect the latest architecture.

**Priority:** P0

**Acceptance Criteria:**

- **AC-002.1:** Given a connected repo with existing context, when a push to default branch is received via webhook, then a context update job is queued
- **AC-002.2:** Given multiple pushes in quick succession, when webhooks arrive, then updates are debounced (max 1 update per 5 minutes)
- **AC-002.3:** Given an update job runs, when it completes, then only changed sections of context are regenerated (incremental update)
- **AC-002.4:** Given context is updated, when update completes, then `lastIndexedAt` is refreshed
- **AC-002.5:** Given user has manually edited context, when auto-update runs, then user edits are preserved (merged, not overwritten)

---

### US-003: Context-aware PRD generation

**As a** PM, **I want** PRD generation to reference the cached codebase context **so that** my requirements align with existing patterns and conventions.

**Priority:** P0

**Acceptance Criteria:**

- **AC-003.1:** Given a project with cached context, when user initiates PRD generation, then context is included in the generation prompt
- **AC-003.2:** Given context includes tech stack info, when PRD is generated, then PRD references appropriate technologies (not hallucinated ones)
- **AC-003.3:** Given context includes architecture patterns, when PRD includes technical scope, then it aligns with existing patterns
- **AC-003.4:** Given a project without cached context, when PRD generation runs, then generation proceeds without context (graceful degradation)
- **AC-003.5:** Given context is stale (>7 days old), when PRD generation runs, then user sees a warning that context may be outdated

---

### US-004: View cached context

**As a** PM or engineer, **I want** to view the cached context for a repo **so that** I can verify what Symphony knows about my codebase.

**Priority:** P1

**Acceptance Criteria:**

- **AC-004.1:** Given a project with cached context, when user views project settings, then they see a "Codebase Context" section
- **AC-004.2:** Given context exists, when user expands the section, then full markdown content is displayed with proper formatting
- **AC-004.3:** Given context exists, when viewing, then `lastIndexedAt` timestamp is displayed (e.g., "Last updated: Jan 24, 2026")
- **AC-004.4:** Given no context exists, when user views the section, then they see "No codebase context. Connect a GitHub repo to generate."

---

### US-005: Edit cached context

**As a** PM or engineer, **I want** to edit the generated context **so that** I can add nuance or correct inaccuracies the auto-generator missed.

**Priority:** P1

**Acceptance Criteria:**

- **AC-005.1:** Given user is viewing cached context, when they click "Edit", then context becomes editable in a markdown editor
- **AC-005.2:** Given user is editing, when they click "Save", then changes are persisted to `codebaseSummary`
- **AC-005.3:** Given user is editing, when they click "Cancel", then changes are discarded
- **AC-005.4:** Given user has made edits, when auto-update runs later, then user sections are preserved (not overwritten)
- **AC-005.5:** Given user wants to discard edits, when they click "Reset to Generated", then context reverts to last auto-generated version

---

### US-006: Manual context refresh

**As a** user, **I want** to manually trigger a context refresh **so that** I can ensure the cache is current if webhooks failed.

**Priority:** P2

**Acceptance Criteria:**

- **AC-006.1:** Given user is viewing codebase context, when they click "Refresh", then a new scan job is queued
- **AC-006.2:** Given refresh is in progress, when user views the section, then they see a loading indicator
- **AC-006.3:** Given refresh completes, when new context is saved, then UI updates with new content and timestamp
- **AC-006.4:** Given user has made edits, when they trigger refresh, then they see a confirmation dialog warning edits may be affected

---

## Technical Notes

- Storage: Reuse PR #85's `codebaseSummary` (string) and `lastIndexedAt` (Date) on Project
- Webhook: Listen for push events to main/default branch
- Processing: Background job to avoid blocking user actions
- Format: Freeform markdown (like a CLAUDE.md)
- Future: Per-repo storage when multi-repo projects are supported; vector/graph indexing for semantic search

---

*Stories expanded during refinement. Implementation details determined by engineering.*
