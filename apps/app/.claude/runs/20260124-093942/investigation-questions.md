# Open Questions

> Questions discovered during investigation and validation that require clarification before or during implementation.

## Organization Access Control

- **Q-001**: [Visibility] Should the Organization tab be visible to all organization members or only admins?
  - Note: `<OrganizationProfile />` shows appropriate content based on role automatically
  - Investigation suggests showing to all members and letting Clerk handle permission-based UI

## Role Management

- **Q-002**: [Custom Roles] Are custom organization roles needed beyond the default `org:admin` and `org:member` roles?
  - Note: Current codebase only uses `orgId`, no custom role references found
  - Investigation suggests starting with defaults and adding custom roles later if needed

## UI Placement

- **Q-003**: [OrganizationSwitcher Placement] Should the OrganizationSwitcher be added to the settings page or kept in the sidebar/header?
  - Current state: Using `UserButton` in sidebar footer
  - Options: Add to settings page under Organization section, optionally also in sidebar header

## Admin Functionality

- **Q-004**: [Admin Controls] What specific admin controls beyond member management are needed?
  - Clerk provides: member invites, role changes, member removal, verified domains, delete org
  - Clarification needed: Are additional custom admin features required beyond what Clerk provides?
