/**
 * Seed template content for artifact types.
 * These templates provide structure and guidance for creating artifacts.
 */

export const PRD_TEMPLATE = `# Product Requirements Document

## Overview

*Provide a high-level summary of what this feature or product does and why it matters. Include the problem being solved and the value it delivers to users.*

## Background

*Describe the context that led to this work. Include relevant user research, business metrics, or strategic initiatives that inform this decision.*

## Goals & Success Metrics

*What does success look like? Define measurable outcomes.*

- **Goal 1:** [Description]
  - **Metric:** [How we'll measure it]
  - **Target:** [Specific target value]
- **Goal 2:** [Description]
  - **Metric:** [How we'll measure it]
  - **Target:** [Specific target value]

## User Stories

*Describe the key user journeys this feature enables.*

### Story 1: [Title]

**As a** [type of user]
**I want to** [perform some action]
**So that** [I can achieve some goal]

### Story 2: [Title]

**As a** [type of user]
**I want to** [perform some action]
**So that** [I can achieve some goal]

## Requirements

### Functional Requirements

*What the system must do.*

1. **[Requirement 1]:** [Description]
2. **[Requirement 2]:** [Description]
3. **[Requirement 3]:** [Description]

### Non-Functional Requirements

*Performance, security, scalability, accessibility, etc.*

- **Performance:** [e.g., page load time, API response time]
- **Security:** [e.g., authentication, authorization, data protection]
- **Accessibility:** [e.g., WCAG compliance level]
- **Scalability:** [e.g., expected load, concurrent users]

## User Experience

*Describe the key interactions and design considerations.*

### Key Workflows

1. **[Workflow 1]:** [Step-by-step description]
2. **[Workflow 2]:** [Step-by-step description]

### Edge Cases & Error States

- **[Edge Case 1]:** [How to handle it]
- **[Edge Case 2]:** [How to handle it]

## Technical Considerations

*Highlight any technical constraints, dependencies, or architecture decisions.*

- **Dependencies:** [External services, APIs, libraries]
- **Constraints:** [Technical limitations, browser support, etc.]
- **Architecture:** [High-level technical approach]

## Acceptance Criteria

*Specific, testable conditions that must be met for this work to be considered complete.*

- [ ] [Criterion 1]
- [ ] [Criterion 2]
- [ ] [Criterion 3]
- [ ] [Criterion 4]

## Open Questions

*List any unresolved questions or decisions that need to be made.*

1. **[Question 1]:** [Description]
2. **[Question 2]:** [Description]

## Out of Scope

*Explicitly call out what is NOT included in this work.*

- [Item 1]
- [Item 2]

## Timeline & Milestones

*Key dates and phases.*

- **Design Review:** [Date]
- **Development Start:** [Date]
- **Internal Testing:** [Date]
- **Launch:** [Date]

## Risks & Mitigations

*What could go wrong and how we'll address it.*

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| [Risk 1] | [High/Med/Low] | [High/Med/Low] | [Strategy] |
| [Risk 2] | [High/Med/Low] | [High/Med/Low] | [Strategy] |
`;

export const ISSUE_TEMPLATE = `# Issue

## Description

*Provide a clear, concise description of the issue or feature request. What needs to be addressed?*

## Context

*Why is this important? What prompted this issue? Include any relevant background information.*

## Proposed Solution

*If applicable, describe how you think this should be solved. For feature requests, outline the desired functionality.*

## Acceptance Criteria

*Define what "done" looks like. Be specific and testable.*

- [ ] [Criterion 1]
- [ ] [Criterion 2]
- [ ] [Criterion 3]

## Steps to Reproduce (if applicable)

*For bugs or issues with existing functionality, provide step-by-step instructions.*

1. [Step 1]
2. [Step 2]
3. [Step 3]

**Expected Behavior:** [What should happen]

**Actual Behavior:** [What actually happens]

## Additional Context

*Include screenshots, error messages, logs, or any other relevant information.*

## Dependencies

*List any related issues, blockers, or dependencies.*

- Depends on: [Issue #]
- Blocks: [Issue #]
- Related to: [Issue #]

## Technical Notes

*Optional: Include any technical considerations, architecture decisions, or implementation hints.*

## Priority

*Indicate urgency and impact.*

- **Urgency:** [High / Medium / Low]
- **Impact:** [High / Medium / Low]
`;

export const BUG_TEMPLATE = `# Bug Report

## Summary

*Provide a one-line summary of the bug.*

## Description

*Describe the bug in detail. What is happening that shouldn't be?*

## Steps to Reproduce

*Provide step-by-step instructions to reproduce the issue.*

1. [Step 1]
2. [Step 2]
3. [Step 3]
4. [Observe the issue]

## Expected Behavior

*What should happen when following the steps above?*

## Actual Behavior

*What actually happens? Be specific about what's wrong.*

## Environment

*Provide details about where the bug occurs.*

- **Browser:** [e.g., Chrome 120, Safari 17, Firefox 121]
- **OS:** [e.g., macOS 14.2, Windows 11, iOS 17]
- **Device:** [e.g., Desktop, iPhone 15, iPad]
- **Application Version:** [e.g., v1.2.3, commit hash]
- **URL:** [e.g., https://app.example.com/page]

## Screenshots / Videos

*Attach visual evidence if available. Screenshots, screen recordings, or animated GIFs are very helpful.*

[Attach or paste screenshots here]

## Error Messages / Logs

*Include any error messages, console logs, or stack traces.*

\`\`\`
[Paste error messages or logs here]
\`\`\`

## Additional Context

*Any other information that might be relevant.*

- **Frequency:** [Always / Sometimes / Rarely]
- **User Impact:** [How many users are affected?]
- **Workaround:** [Is there a temporary workaround?]

## Severity

*How critical is this bug?*

- **Critical:** System is unusable, data loss, security issue
- **High:** Major functionality broken, no workaround
- **Medium:** Feature partially broken, workaround exists
- **Low:** Minor issue, cosmetic, edge case

## Related Issues

*Link to related bugs, feature requests, or PRs.*

- Related to: [Issue #]
- Duplicate of: [Issue #]
- Caused by: [PR #]
`;
