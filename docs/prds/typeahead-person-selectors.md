# Typeahead Person Selectors

**Owner:** Mike | **Status:** Draft | **Target:** Q1 2026

---

## Summary

Convert all person-selection fields (Approver, Owner, etc.) in the Symphony Alpha UI to use the existing `UserSelectPopover` typeahead component, replacing plain text inputs with searchable member dropdowns.

---

## Context

### Problem

The Approver field in PRD forms uses a plain text input, requiring users to manually type names. This creates friction:
- Users must remember exact names/spellings
- No validation that the person exists in the organization
- Inconsistent UX compared to Owner fields that already use typeahead

### Hypothesis

We believe replacing text inputs with typeahead selectors will reduce form completion time and errors for PMs and engineers, measured by fewer invalid/misspelled approver names and faster form submissions.

### Personas

- **Primary:** Product Manager — Creates PRDs and needs to assign approvers quickly
- **Secondary:** Engineer — Reviews implementation plans and occasionally creates artifacts

---

## Scope

### In (MVP)

- Replace Approver text input with `UserSelectPopover` in:
  - `new-prd-modal.tsx` — PRD creation form
  - `prd-editor.tsx` — PRD details panel
- Populate dropdown with organization members (same data source as Owner fields)
- Store approver as user ID (not free-text name) for data integrity

### Out (Deferred)

- Migration of existing free-text approver data to user IDs — handle gracefully by displaying stored text if no user match
- Adding new person-selection fields elsewhere — future PRDs can extend this pattern
- Multi-select approvers — single approver is sufficient for MVP

### Success Metrics

| Metric | Baseline | Target | How Measured |
|--------|----------|--------|--------------|
| Invalid approver names | Unknown | 0 | DB query for approver values not matching any user |
| Form completion time | TBD | -20% | Observational timing in user sessions |

### Kill Criteria

If users report the typeahead is slower than typing free-text names, revisit the UX.

---

## Compliance & Risk

No PHI involved. Organization member data is already accessible via existing API endpoints used for Owner selection.

### Dependencies & Risks

| Risk/Dependency | Mitigation | Owner |
|-----------------|------------|-------|
| Existing free-text approver data | Display as-is; don't break existing PRDs | Eng |
| Organization member list not loaded | Reuse `useTeamMembers` hook pattern from project forms | Eng |

---

## Open Questions

- **Q-001:** ~~Should we store approver as user ID or continue storing display name?~~ **Resolved:** Store as user ID for data integrity; display name can be derived. Existing free-text values remain as-is (backwards compatible).

---

## User Stories

### US-001: Typeahead approver in PRD creation

**As a** PM, **I want** to select an approver from a searchable dropdown when creating a PRD **so that** I can quickly find the right person without typing their full name.

**Priority:** P0

**Acceptance Criteria:**

- **AC-001.1:** Given a user is creating a new PRD, when they click on the Approver field, then a popover opens with a searchable list of organization members
- **AC-001.2:** Given the popover is open, when user types in the search input, then results filter by name and email (case-insensitive)
- **AC-001.3:** Given search results are displayed, when a result is shown, then it displays the member's avatar, name, and email
- **AC-001.4:** Given a user clicks on a member in the list, when selected, then the popover closes and the selected member's name and avatar appear in the trigger button
- **AC-001.5:** Given a user selects a member, when they submit the form, then the PRD is created with that member's user ID stored in the `approver` field
- **AC-001.6:** Given no approver is selected, when form is submitted, then PRD is created with null approver (field is optional)
- **AC-001.7:** Given the modal opens, when organization members are loading, then the popover displays a loading state until data arrives
- **AC-001.8:** Given the organization has no members, when the popover opens, then it displays "No users found" empty state

---

### US-002: Typeahead approver in PRD editor

**As a** PM, **I want** to change the approver of an existing PRD using a searchable dropdown **so that** I can reassign approval without retyping names.

**Priority:** P0

**Acceptance Criteria:**

- **AC-002.1:** Given a user opens the PRD details panel, when viewing the Approver field, then it displays as a `UserSelectPopover` component (not a text input)
- **AC-002.2:** Given an approver is already set (stored as user ID), when viewing the field, then the approver's name and avatar are displayed in the trigger button
- **AC-002.3:** Given an approver is already set, when the popover opens, then the current approver has a checkmark indicator in the list
- **AC-002.4:** Given an approver was set as free-text (legacy data), when viewing the field, then the raw text is displayed in the trigger button
- **AC-002.5:** Given a legacy free-text approver, when the popover opens, then no item is pre-selected (user can select a real member to upgrade the data)
- **AC-002.6:** Given user selects a different member, when selection is made, then the change is persisted immediately (auto-save on selection)
- **AC-002.7:** Given user clicks "Clear selection" in the popover, when cleared, then the approver field is set to null and auto-saved
- **AC-002.8:** Given a save fails (network error), when error occurs, then a toast notification appears and the previous value is restored
- **AC-002.9:** Given the details panel is opened, when members are loading, then the popover is disabled until data arrives

---

### US-003: Backwards compatibility for legacy approver data

**As a** user viewing a PRD with a free-text approver, **I want** the approver name to still display correctly **so that** existing PRDs don't appear broken.

**Priority:** P0

**Acceptance Criteria:**

- **AC-003.1:** Given a PRD has `approver` stored as free-text string (legacy), when viewing the PRD in any context, then the text is displayed as-is without modification
- **AC-003.2:** Given a PRD has `approver` stored as a valid user ID, when viewing the PRD, then the user's display name (firstName + lastName) is shown
- **AC-003.3:** Given a PRD has `approver` stored as a user ID, when that user has an avatar, then the avatar is displayed alongside the name
- **AC-003.4:** Given a PRD has `approver` stored as a user ID for a deleted/deactivated user, when viewing, then "Unknown User" is displayed gracefully
- **AC-003.5:** Given a PRD has `approver` as null/empty, when viewing, then the field shows placeholder text like "Select approver" or "No approver assigned"
- **AC-003.6:** Given the API returns a PRD, when `approver` is a valid user ID, then the API response includes resolved user details (name, avatar) for display
- **AC-003.7:** Given a legacy free-text approver is updated via the typeahead, when saved, then the old text is replaced with the new user ID (one-way upgrade)

---

## Technical Notes

- Reuse existing `UserSelectPopover` component from `@repo/design-system`
- Use `useTeamMembers` hook or create `useOrganizationMembers` hook for member data
- Schema change: `approver` field type remains string (can hold ID or legacy text)
- API change: Accept user ID; resolve to display name in responses
- Consider adding `approverId` field in future for cleaner separation (out of scope for MVP)

---

*Stories expanded during refinement. Implementation details determined by engineering.*
