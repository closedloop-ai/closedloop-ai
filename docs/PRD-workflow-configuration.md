# PRD: Workflow Configuration Settings

**Feature**: Org-Level Workflow Defaults with Per-Cycle Overrides
**Status**: Draft
**Created**: 2026-01-20
**Owner**: Product

---

## Summary

Expose Claude Code's `/plan` and `/execute` command-line options as organization-level configuration defaults in ClosedLoop Alpha. Allow users to override these defaults when creating individual Cycles (workflows). This enables teams to standardize their planning and execution behavior while maintaining flexibility for special cases.

**Impact**: Engineering teams and product managers can configure their preferred workflow settings once at the org level, reducing cognitive overhead and ensuring consistency across projects. Advanced users retain full control via per-Cycle overrides.

---

## Context

### Problem

Currently, Claude Code's planning and execution workflows (`/plan`, `/plan-exp`, `/execute`) support rich configuration through command-line flags. However, ClosedLoop Alpha users must manually specify these options each time they create a Cycle. This leads to:

1. **Repetitive configuration** — Users repeatedly set the same preferences (e.g., `--interactive`, `--use-codex`)
2. **Inconsistent workflows** — Teams lack a way to standardize behavior across projects
3. **Discovery friction** — Many users don't know about available flags or their benefits
4. **Lost productivity** — Time spent on configuration instead of actual planning/execution

### Hypothesis

By exposing Claude Code's workflow flags as:
1. **Organization-level defaults** (set once, apply to all Cycles)
2. **Per-Cycle overrides** (optional customization for special cases)

We will reduce configuration overhead, improve workflow consistency, and surface powerful but hidden features to users who don't know they exist.

### Evidence

- Claude Code CLI supports 8+ configuration flags for `/plan` and `/plan-exp`
- `/execute` has implicit configurability (test behavior, code review, max iterations)
- Engineering teams in pre-PMF startups benefit from standardization with escape hatches
- Current ClosedLoop Alpha UI has no visibility into these options

### Personas

**Primary**: Engineering Lead / Tech Lead
- Sets organizational standards for planning and execution
- Wants consistency across team workflows
- Needs to enforce quality gates (e.g., always run tests, always use interactive mode)

**Secondary**: Product Manager
- Creates Cycles frequently
- Wants sensible defaults with minimal configuration
- Occasionally needs to override for special cases (e.g., skip tests for prototypes)

**Tertiary**: Individual Contributor Engineer
- Follows org standards without thinking about configuration
- Benefits from guardrails and consistency

---

## Scope

### In Scope (MVP)

**Phase 1: Org-Level Configuration**

Expose the following Claude Code configuration options as organization-level settings:

**Planning Configuration (`/plan` and `/plan-exp`)**:
1. **Enable Interactive Mode** (`--interactive`) — Prompt for questions during curation (default: `false`)
2. **Use Codex CLI** (`--use-codex`) — Use Codex instead of Task agents for solve/draft phases (default: `false`)
3. **Force Simple Planning** (`--force-simple`) — Use lightweight planning pathway (default: `false`) [/plan only]
4. **Force Full Planning** (`--force-full`) — Force full planning pipeline (default: `false`) [/plan only]
5. **No-Code Draft Plan** (`--no-code-draft-plan`) — Create high-level plan without code, pause for async approval (default: `false`) [/plan only]
6. **Emit Events** (`--emit-events`) — Enable orchestration telemetry logging (default: `disabled`)
   - When enabled, specify JSONL output path or use default (`$RUN/events.jsonl`)

**Execution Configuration (`/execute`)**:
1. **Run Tests** — Whether to run tests after implementation (default: `true`)
2. **Run Code Review** — Whether to run code review after implementation (default: `true`)
3. **Max Fix Iterations** — Maximum iterations for fixing Critical/High issues (default: `2`)
4. **Auto-Detect Validation Commands** — Automatically detect lint/test/build commands from project (default: `true`)

**Phase 2: Per-Cycle Overrides**

Add an optional "Advanced Configuration" section to the Cycle creation UI:
- Display org-level defaults with clear labels
- Allow per-Cycle override of any org-level setting
- Show diff between org defaults and Cycle-specific overrides (if any)
- Persist overrides in Cycle metadata

### Out of Scope

- Custom workflows beyond Claude Code's existing `/plan` and `/execute` commands
- Real-time configuration updates (changes apply to new Cycles only)
- User-level preferences (org-level only for MVP)
- Configuration versioning or rollback
- `--requirements <path>` flag (file-based, not UI-friendly for MVP)
- `--attachment <path>` flag (file upload handled separately)

### Success Metrics

**Adoption**:
- 70%+ of orgs configure at least one org-level default within first 2 weeks
- 90%+ of Cycles use org-level defaults without overrides
- 10% of Cycles use at least one override (showing flexibility is valued)

**Efficiency**:
- Time to create a Cycle decreases by 20% (fewer clicks, less configuration)
- Support tickets about "how to enable X" decrease by 50%

**Quality**:
- Teams using `--interactive` or code review see 30% fewer post-implementation bugs

### Kill Criteria

- Less than 30% of orgs configure any defaults after 1 month → feature not valuable
- More than 50% of Cycles override defaults → standardization isn't working

---

## Compliance & Risk

**PHI Assessment**: Not applicable — configuration metadata does not touch patient data.

**Access Requirements**:
- Org-level configuration: Admin or Owner role only
- Per-Cycle overrides: Any user who can create Cycles

**Dependencies**:
- Requires ClosedLoop Alpha to support org-level settings storage
- Requires Cycle metadata schema to store per-Cycle overrides
- May need to coordinate with Claude Code CLI versioning if flags change

**Risks**:
- **Misconfiguration**: Admins could set bad defaults that break workflows
  - Mitigation: Provide clear tooltips, validation, and "reset to defaults" option
- **Flag deprecation**: Claude Code CLI might change flags in future versions
  - Mitigation: Version configuration schema, allow backward compatibility

---

## Analytics

Track the following events using PostHog (following ClosedLoop event instrumentation standards):

### Events

**Org Configuration Events**:
1. **Org Workflow Settings Updated**
   - Properties:
     - `organization_id` (string)
     - `updated_by_user_id` (string)
     - `settings_changed` (array of strings: `["interactive_mode", "use_codex", ...]`)
     - `previous_values` (object: key-value pairs of old settings)
     - `new_values` (object: key-value pairs of new settings)
   - Platform: Web

**Cycle Creation Events**:
2. **Cycle Created With Config Override**
   - Properties:
     - `cycle_id` (string)
     - `organization_id` (string)
     - `created_by_user_id` (string)
     - `overridden_settings` (array of strings: `["run_tests", "max_fix_iterations", ...]`)
     - `override_values` (object: key-value pairs of overridden settings)
   - Platform: Web

3. **Cycle Created With Org Defaults**
   - Properties:
     - `cycle_id` (string)
     - `organization_id` (string)
     - `created_by_user_id` (string)
     - `org_defaults_applied` (object: key-value pairs of applied defaults)
   - Platform: Web

**Validation Events**:
4. **Workflow Config Validation Failed**
   - Properties:
     - `organization_id` (string)
     - `user_id` (string)
     - `validation_errors` (array of strings: error messages)
     - `attempted_settings` (object: settings that failed validation)
   - Platform: Web

---

## Open Questions

**Q-001**: Should we expose `--emit-events` path configuration in the UI, or always use a default path?
- **Proposed answer**: Use default path (`$RUN/events.jsonl`) for MVP, expose path customization later if needed

**Q-002**: Should org-level defaults apply retroactively to existing Cycles?
- **Proposed answer**: No — only new Cycles inherit org defaults. Existing Cycles retain their creation-time settings.

**Q-003**: Do we need role-based access control for who can override org defaults on a per-Cycle basis?
- **Proposed answer**: No for MVP — any user who can create Cycles can override. Add RBAC in Phase 2 if abuse occurs.

**Q-004**: Should we provide "presets" (e.g., "Quick Planning", "Thorough Planning") to help users configure defaults?
- **Proposed answer**: Yes, but as a Phase 2 enhancement. Start with explicit toggles for MVP.

**Q-005**: How should we handle conflicts between `--force-simple` and `--force-full` (mutually exclusive)?
- **Proposed answer**: Radio button group in UI (Simple / Full / Auto), prevent both from being enabled simultaneously.

---

## User Stories

### US-001: Configure Org-Level Planning Defaults

**As an** engineering lead
**I want to** set organization-wide defaults for planning workflows
**So that** all team members use consistent planning behavior without manual configuration

**Acceptance Criteria**:

**AC-001.1**: Given I am an admin, when I navigate to Organization Settings → Workflow Configuration, then I see a "Planning Defaults" section with toggles for:
- Enable Interactive Mode
- Use Codex CLI
- Force Simple Planning
- Force Full Planning
- No-Code Draft Plan
- Emit Events (with optional path field)

**AC-001.2**: Given I enable "Interactive Mode" and save, when any team member creates a new Cycle, then the Cycle inherits `--interactive` flag by default.

**AC-001.3**: Given I enable "Force Simple Planning", when I attempt to also enable "Force Full Planning", then the UI prevents both from being active and shows a validation error.

**AC-001.4**: Given I configure defaults and click "Save", then a confirmation message appears and an analytics event "Org Workflow Settings Updated" is sent.

---

### US-002: Configure Org-Level Execution Defaults

**As an** engineering lead
**I want to** set organization-wide defaults for execution workflows
**So that** code quality standards are enforced consistently across all projects

**Acceptance Criteria**:

**AC-002.1**: Given I am an admin, when I navigate to Organization Settings → Workflow Configuration, then I see an "Execution Defaults" section with:
- Toggle: Run Tests (default: enabled)
- Toggle: Run Code Review (default: enabled)
- Number input: Max Fix Iterations (default: 2, range: 1-5)
- Toggle: Auto-Detect Validation Commands (default: enabled)

**AC-002.2**: Given I disable "Run Tests" and save, when any Cycle reaches execution phase, then tests are skipped unless explicitly overridden at the Cycle level.

**AC-002.3**: Given I set "Max Fix Iterations" to 3, when execution attempts to fix Critical/High issues, then it stops after 3 iterations regardless of remaining issues.

**AC-002.4**: Given I configure execution defaults, when I click "Save", then settings are persisted and applied to new Cycles immediately.

---

### US-003: Override Defaults When Creating a Cycle

**As a** product manager
**I want to** override org-level defaults when creating a specific Cycle
**So that** I can customize workflow behavior for special cases (e.g., prototypes, experiments)

**Acceptance Criteria**:

**AC-003.1**: Given I am creating a new Cycle, when I expand the "Advanced Configuration" section, then I see all org-level defaults displayed with their current values and override toggles.

**AC-003.2**: Given org defaults have "Interactive Mode" disabled, when I enable the override toggle and set "Interactive Mode" to enabled, then this Cycle uses `--interactive` despite the org default.

**AC-003.3**: Given I override multiple settings, when I save the Cycle, then a visual diff shows which settings differ from org defaults.

**AC-003.4**: Given I create a Cycle with overrides, when the Cycle is created, then an analytics event "Cycle Created With Config Override" is sent with details of overridden settings.

**AC-003.5**: Given I create a Cycle without any overrides, when the Cycle is created, then an analytics event "Cycle Created With Org Defaults" is sent.

---

### US-004: View Effective Configuration for a Cycle

**As a** developer
**I want to** view the effective configuration for an existing Cycle
**So that** I understand which planning and execution settings are active

**Acceptance Criteria**:

**AC-004.1**: Given I am viewing a Cycle details page, when I navigate to the "Configuration" tab, then I see all planning and execution settings with their current values.

**AC-004.2**: Given a Cycle has overridden settings, when I view the Configuration tab, then overridden settings are highlighted or badged to distinguish them from org defaults.

**AC-004.3**: Given a Cycle is using all org defaults, when I view the Configuration tab, then I see a message "Using organization defaults" with a link to org settings.

---

### US-005: Reset Org Defaults to Recommended Values

**As an** admin
**I want to** reset org-level defaults to ClosedLoop's recommended configuration
**So that** I can recover from misconfiguration or start fresh

**Acceptance Criteria**:

**AC-005.1**: Given I am on the Org Settings → Workflow Configuration page, when I click "Reset to Recommended Defaults", then a confirmation dialog appears warning that this will replace all current settings.

**AC-005.2**: Given I confirm the reset, when the action completes, then all settings are restored to:
- Planning: Interactive Mode (off), Use Codex (off), Force Simple (off), Force Full (off), No-Code Draft (off), Emit Events (off)
- Execution: Run Tests (on), Run Code Review (on), Max Fix Iterations (2), Auto-Detect Validation (on)

**AC-005.3**: Given defaults are reset, when the action completes, then an analytics event "Org Workflow Settings Updated" is sent showing the reset action.

---

## Technical Notes

**Data Model**:

```typescript
// Organization-level settings
interface OrgWorkflowConfig {
  organizationId: string;
  planning: {
    interactiveMode: boolean;
    useCodex: boolean;
    forceSimple: boolean;
    forceFull: boolean;
    noCodeDraftPlan: boolean;
    emitEvents: boolean;
    emitEventsPath?: string; // optional custom path
  };
  execution: {
    runTests: boolean;
    runCodeReview: boolean;
    maxFixIterations: number; // 1-5
    autoDetectValidation: boolean;
  };
  updatedAt: Date;
  updatedBy: string; // user ID
}

// Per-Cycle overrides
interface CycleWorkflowConfig {
  cycleId: string;
  overrides?: {
    planning?: Partial<OrgWorkflowConfig['planning']>;
    execution?: Partial<OrgWorkflowConfig['execution']>;
  };
  createdAt: Date;
}
```

**Implementation Phases**:

1. **Backend**: Add `OrgWorkflowConfig` and `CycleWorkflowConfig` tables/schemas
2. **API**: CRUD endpoints for org settings, Cycle override support
3. **UI**: Org settings page, Cycle creation override UI, Cycle details view
4. **Integration**: Pass resolved config to Claude Code CLI when executing workflows
5. **Analytics**: Instrument all config-related events

**Edge Cases**:
- If org defaults change after Cycle creation, existing Cycles are unaffected
- If a flag is removed from Claude Code CLI, gracefully ignore deprecated settings
- Validate mutually exclusive flags (`--force-simple` vs `--force-full`)

---

## Design Mockups

(To be added by design team)

**Required screens**:
1. Organization Settings → Workflow Configuration page
2. Cycle Creation → Advanced Configuration section
3. Cycle Details → Configuration tab

---

## Next Steps

1. Review and approve this PRD
2. Design mockups for org settings and Cycle override UI
3. Expand user stories with detailed AC for implementation
4. Estimate engineering effort and prioritize for sprint planning
5. Export to Jira using `/jira-prd-export`
