/**
 * Seed template content for artifact types.
 * These templates provide structure and guidance for creating artifacts.
 */

export const PRD_TEMPLATE = `# Product Requirements Document

> For smaller features or experiments, sections marked *(optional)* can be omitted.
> If a section is not yet known, add it to **Open Questions**. If a section does not apply, mark it **N/A** and include an explanation for why it does not apply. Do not invent details.
> Keep this document concrete. Prefer specific users, workflows, constraints, metrics, and decisions over generic statements.

## Overview

Summarize what is being proposed, who it is for, and why it matters. Keep this short and concrete.

## Problem Statement

Describe the current pain or limitation in concrete terms. Include who is affected, what happens today, how severe the problem is, and why solving it now matters. Do not jump to the solution yet.

## Background

Describe the context that led to this work. Include only relevant research, metrics, prior decisions, incidents, customer feedback, or strategic drivers.

## Target Users / Consumers

Define the users, consumers, or internal teams affected by this work. All user stories below should reference one of these groups.

- **[User type 1]:** [Description — who they are, what they care about]
- **[User type 2]:** [Description — who they are, what they care about]

## Goals & Success Metrics

Define the outcomes this work is intended to create. Use measurable results where possible.

- **Goal 1:** [Description]
  - **Metric:** [How success will be measured]
  - **Baseline:** [Current value, if known]
  - **Target:** [Specific target value]
- **Goal 2:** [Description]
  - **Metric:** [How success will be measured]
  - **Baseline:** [Current value, if known]
  - **Target:** [Specific target value]

## User Stories

Describe the most important user journeys, system interactions, and/or API flows where relevant this work must support. Focus on the critical few, not every possible scenario. Each story includes its own acceptance criteria.

### User Story 1: [Title]

**As a** [target user], **I want to** [action], **so that** [outcome].

#### Acceptance Criteria

- [ ] [Criterion 1] *(FR#)*
- [ ] [Criterion 2] *(FR#)*

### User Story 2: [Title]

**As a** [target user], **I want to** [action], **so that** [outcome].

#### Acceptance Criteria

- [ ] [Criterion 1] *(FR#)*
- [ ] [Criterion 2] *(FR#)*

## Requirements

### Functional Requirements

List what the system must do. Each requirement should be specific, testable, and tagged with a priority.

1. **[FR1] [P0] [Requirement 1]:** [Description]
2. **[FR2] [P0] [Requirement 2]:** [Description]
3. **[FR3] [P1] [Requirement 3]:** [Description]
4. **[FR4] [P2] [Requirement 4]:** [Description]

> **P0** = Must have for launch. **P1** = Should have, cut only under pressure. **P2** = Nice to have, cut first.

### Non-Functional Requirements

Capture system qualities and operating constraints that matter for release. If a category does not apply, mark it **N/A**.

- **Performance:** [e.g., page load time, API response time]
- **Security:** [e.g., authentication, authorization, data protection]
- **Accessibility:** [e.g., WCAG compliance level]
- **Scalability:** [e.g., expected load, concurrent users]
- **Reliability:** [e.g., uptime, retry behavior, recovery expectations]
- **Observability:** [e.g., logs, metrics, alerts needed to operate this]
- **Privacy / Compliance:** [e.g., PII handling, auditability, policy requirements]

## User Experience

Describe the key interactions and design considerations. For developer-facing or backend work, describe the developer experience.

### Key Workflows

1. **[Workflow 1]:** [Step-by-step description]
2. **[Workflow 2]:** [Step-by-step description]

### Edge Cases & Error States

- **[Edge Case 1]:** [What can go wrong]
  - **Response:** [How the system should respond]
- **[Edge Case 2]:** [What can go wrong]
  - **Response:** [How the system should respond]

## Technical Considerations

Highlight important technical constraints, dependencies, and architecture choices. This should inform implementation without turning the PRD into a full design doc.

- **System Dependencies:** [External services, APIs, libraries]
- **Team Dependencies:** [Other teams whose work this depends on or blocks]
- **Constraints:** [Technical limitations, browser support, etc.]
- **Architecture:** [High-level technical approach]
- **Migration / Backfill:** [Data migrations, compatibility constraints, rollout coordination]

## Alternatives Considered *(optional)*

Briefly summarize realistic alternatives that were considered and why they were not chosen.

- **Option 1:** [Approach and tradeoffs]
- **Option 2:** [Approach and tradeoffs]

## Analytics & Instrumentation

Describe how success metrics and operational behavior will be measured. If no new instrumentation is needed, state that explicitly.

- **Events:** [e.g., feature usage, workflow completion, error encountered]
- **Dashboards:** [Where metrics will be visualized]
- **Data Sources:** [What systems provide the data]

## Assumptions

List statements being treated as true for the purposes of this PRD. If any assumption is wrong, the plan may need to change.

1. [Assumption 1]
2. [Assumption 2]

## Open Questions

List unresolved questions, decisions, or dependencies that could materially affect scope, timing, or implementation.

1. **[Question 1]:** [Description]
2. **[Question 2]:** [Description]

## Out of Scope

Explicitly call out what is not included in this work so adjacent ideas do not silently expand scope.

- [Item 1]
- [Item 2]

## Rollout Strategy *(optional)*

Describe how this work will be released, enabled, and, if necessary, disabled.

- **Rollout approach:** [Feature flag / phased rollout / A-B test / big bang]
- **Initial audience:** [e.g., internal only, 10% of users, enterprise tier]
- **GA criteria:** [What must be true before full rollout]
- **Rollback plan:** [How to disable if something goes wrong]

## Milestones *(optional)*

List major phases and deliverables. Use relative timing or target dates only if they are meaningful and reasonably credible.

| Phase | Deliverable | Target |
|-------|-------------|--------|
| Design | [Reviewed mockups / wireframes] | [Date or relative timing] |
| Build | [Core functionality complete] | [Date or relative timing] |
| Test | [QA complete, acceptance criteria met] | [Date or relative timing] |
| Launch | [Released to initial audience] | [Date or relative timing] |

## Risks & Mitigations

List the main things that could go wrong and how the team plans to reduce or respond to them.

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| [Risk 1] | [High/Med/Low] | [High/Med/Low] | [Strategy] |
| [Risk 2] | [High/Med/Low] | [High/Med/Low] | [Strategy] |
`;
