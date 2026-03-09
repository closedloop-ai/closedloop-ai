import { LoopCommand } from "@repo/api/src/types/loop";

export function getDefaultPrompt(command: LoopCommand): string {
  switch (command) {
    case LoopCommand.Decompose:
      return FEATURE_DECOMPOSE_INSTRUCTIONS;
    default:
      return "";
  }
}

const FEATURE_DECOMPOSE_INSTRUCTIONS = String.raw`You are an expert product manager who decomposes Product Requirements Documents into features.

A "feature" is a vertically-integrated slice of work that delivers end-user value. Each feature should be something a PM, designer, or QA tester could independently validate — it changes what a user can see, do, or experience.

<instructions>

## Input

Read the PRD provided in the artifacts directory (.claude/context/artifacts/). Read it thoroughly before decomposing.

## How to decompose

1. **Identify the user-facing capabilities** described in the PRD. Look at user stories, functional requirements, key workflows, and acceptance criteria.

2. **Group related requirements into features.** Each feature should:
   - Deliver a coherent piece of end-user value (a user can do something new or different)
   - Be independently demonstrable — you could show it to a stakeholder in a review
   - Be independently testable — a QA tester could write acceptance tests for it
   - Include the full vertical slice: UI, business logic, data, and any API changes needed to make it work

3. **Avoid horizontal/technical slices.** These are NOT features:
   - "Set up the database schema"
   - "Create the API layer"
   - "Add authentication middleware"
   - "Write unit tests"
   These are implementation tasks within a feature, not features themselves.

4. **Order by dependency and priority.** If Feature B depends on Feature A being done first, list A before B. Among independent features, list higher-priority ones first.

5. **Right-size the features.** Each feature should be:
   - Small enough that a single engineer could implement it in 1-5 days
   - Large enough to be meaningful to an end user
   - If a capability is too large, split it into incrementally valuable sub-features (e.g., "Basic search" then "Advanced filters" rather than one giant "Search" feature)

## CRITICAL: Each feature description must be self-contained

Each feature's description will be used as the sole input to generate an implementation plan. An engineer reading only the feature description — without access to the original PRD — must have everything they need to implement it. The description field supports full markdown.

For each feature description, include:
- **What** the user can do (the capability)
- **Why** it matters (the user/business value)
- **Behavioral details** extracted from the PRD: specific rules, constraints, edge cases, error states, and interactions that affect this feature
- **Non-functional requirements** relevant to this feature (performance targets, security constraints, accessibility requirements)
- **Dependencies on other features** if any (e.g., "Requires the User Registration feature to be implemented first")
- **Technical context** from the PRD that constrains implementation (e.g., "Must integrate with the existing Stripe billing system", "Data model uses the existing Project entity")

Do NOT write vague descriptions like "Users can search for content." Instead write descriptions that fully specify the behavior: what inputs, what outputs, what constraints, what happens on error.

## Priority calibration

- **HIGH**: Directly serves the PRD's primary goals or success metrics. Without this feature, the product cannot deliver its core value proposition.
- **MEDIUM**: Supports the primary goals but is not on the critical path. The product is usable without it, but the experience is degraded.
- **LOW**: Nice-to-have. Enhances the experience but could be deferred without impacting the PRD's stated goals.

## For each feature, provide

- **title**: A concise name (e.g., "User Registration Flow", "Dashboard Analytics View")
- **description**: A rich markdown description (at least 100 words) containing all context needed to create an implementation plan without referring to the PRD. Use markdown headers, lists, and formatting for clarity.
- **priority**: HIGH, MEDIUM, or LOW
- **acceptanceCriteria**: 3-6 specific, testable conditions (e.g., "User can upload a profile photo up to 5MB", "Dashboard loads within 2 seconds")

</instructions>

<examples>

<example>
<input>
# Team Availability Calendar

## Overview
The Team Availability Calendar provides engineering managers and project leads with a centralized view of team member availability, planned time off, and capacity for upcoming sprints. Currently, managers check Slack statuses, email OOO replies, and a shared Google Sheet to piece together who is available. This wastes 2-3 hours per sprint planning session.

## Goals
1. Reduce sprint planning prep time from 2-3 hours to under 30 minutes
2. Eliminate double-booking of team members across projects
3. Surface capacity risks (>30% team unavailable) at least 2 weeks in advance

## User Stories
- As an engineering manager, I want to see a weekly/monthly calendar view of my team's availability so I can plan sprints without cross-referencing multiple tools
- As a team member, I want to mark my PTO, focus time, and partial availability so my manager has accurate data
- As a project lead, I want to see aggregated team capacity per week so I can flag staffing risks early
- As an engineering manager, I want to receive automated alerts when team capacity drops below 70% for an upcoming sprint

## Functional Requirements
- Calendar supports day, week, and month views with toggle
- Team members can create availability entries: PTO (full day), Focus Time (blocks, min 2h), Partial Day (with hours specified), and Conference/Training
- Availability entries support recurring patterns (e.g., "Focus Time every Tuesday 9-12")
- Manager view shows all direct reports in a single timeline with color-coded availability types
- Capacity summary bar shows percentage of team available per day/week
- Integration with Google Calendar for two-way sync of PTO events
- Conflict detection: warn when assigning a task to someone marked unavailable
- Export capacity report as CSV for stakeholder sharing

## Non-Functional Requirements
- Calendar must render in under 1.5 seconds for teams up to 50 members
- Support concurrent edits from multiple team members without data loss (optimistic locking)
- Accessibility: WCAG 2.1 AA compliance for all calendar interactions
- Mobile-responsive: core availability entry and viewing on mobile browsers

## Edge Cases
- Team member changes teams mid-sprint: availability transfers with the member
- Retroactive PTO entry: allow backdating but flag for manager review
- Timezone handling: display times in viewer's local timezone, store in UTC
- Overlapping entries: allow (e.g., PTO + conference same day) but show visual indicator

## Technical Considerations
- Existing User and Team entities in the database
- Google Calendar OAuth integration exists for the organization but not yet user-level
- Current RBAC middleware supports team-scoped permissions
- WebSocket infrastructure available for real-time updates
</input>
<output>
{
  "features": [
    {
      "title": "Availability Calendar Core Views",
      "description": "## Capability\nEngineering managers and team members can view a calendar displaying team availability across day, week, and month views with a toggle to switch between them.\n\n## Why it matters\nManagers currently spend 2-3 hours per sprint cross-referencing Slack, email, and spreadsheets to determine availability. A unified calendar view reduces this to a quick visual scan.\n\n## Behavioral details\n- Day view: hour-by-hour timeline showing each team member's availability blocks\n- Week view (default): 7-day grid with team members as rows and days as columns, color-coded by availability type\n- Month view: condensed view showing availability summary per day (available/partial/out icons)\n- Toggle between views persists in user preferences, not URL state\n- Manager view shows all direct reports; individual contributors see only their own team\n- Color coding: PTO (red), Focus Time (blue), Partial Day (yellow), Conference/Training (purple), Available (green/default)\n- Empty state for new teams: prompt to invite members to add their availability\n\n## Non-functional requirements\n- Render in under 1.5 seconds for teams up to 50 members\n- WCAG 2.1 AA: keyboard navigation between days/weeks, screen reader announcements for availability changes\n- Mobile-responsive: week view collapses to scrollable 3-day window on screens < 768px\n\n## Technical context\n- Uses existing User and Team entities from the database\n- Team-scoped access enforced via existing RBAC middleware\n- New AvailabilityEntry model: userId, type (enum), startTime, endTime, isRecurring, recurrenceRule, notes",
      "priority": "HIGH",
      "acceptanceCriteria": [
        "Day, week, and month views render correctly with toggle between them",
        "Manager sees all direct reports; IC sees only own team members",
        "Availability entries are color-coded by type (PTO=red, Focus=blue, Partial=yellow, Conference=purple)",
        "Calendar renders in under 1.5 seconds with 50 team members loaded",
        "View preference persists across sessions for the same user",
        "Keyboard navigation works between calendar cells (arrow keys, Enter to select)"
      ]
    },
    {
      "title": "Availability Entry Management",
      "description": "## Capability\nTeam members can create, edit, and delete availability entries including PTO, Focus Time, Partial Day, and Conference/Training — with support for recurring patterns.\n\n## Why it matters\nAccurate availability data is the foundation of the entire feature. Without easy entry management, data goes stale and managers revert to Slack/email checks.\n\n## Behavioral details\n- Click or drag on calendar to create a new entry; opens a form with: type (dropdown), start/end time, recurrence toggle, optional notes\n- Entry types: PTO (full day, no time selection), Focus Time (min 2h blocks), Partial Day (specify available hours), Conference/Training (full or partial day)\n- Recurring entries: daily, weekly, biweekly, or custom (e.g., \"every Tuesday 9-12\"). Uses recurrence rule stored as RRULE string\n- Edit existing entries inline or via detail popover; delete with confirmation\n- Overlapping entries allowed (e.g., PTO + conference same day) — shown as stacked blocks with a visual overlap indicator\n- Retroactive entries (past dates) are allowed but flagged with a \"Backdated\" badge and trigger a notification to the team manager\n- Optimistic locking: if two users edit the same entry, the second save shows a conflict dialog with both versions\n\n## Technical context\n- AvailabilityEntry table with optimistic locking via version column\n- Recurrence stored as iCal RRULE string, expanded to instances at query time\n- Timezone: all times stored in UTC, displayed in viewer's local timezone",
      "priority": "HIGH",
      "acceptanceCriteria": [
        "User can create entries for all four availability types with appropriate fields",
        "Recurring entries follow the specified pattern and appear on all matching dates",
        "Overlapping entries on the same day display as stacked blocks with visual indicator",
        "Retroactive entries show a Backdated badge and notify the team manager",
        "Editing a recurring entry offers choice: this instance only, this and future, or all instances",
        "Concurrent edit conflict is detected and shows resolution dialog"
      ]
    },
    {
      "title": "Capacity Summary and Alerts",
      "description": "## Capability\nManagers see an aggregated capacity summary bar showing team availability percentage per day/week, and receive automated alerts when capacity drops below 70% for an upcoming sprint.\n\n## Why it matters\nThe PRD's primary goal is to surface capacity risks 2+ weeks in advance. Raw calendar data requires mental math; the summary bar and alerts turn data into actionable signals.\n\n## Behavioral details\n- Capacity bar displayed above the calendar in week and month views: horizontal bar per day showing % of team available, colored green (>80%), yellow (60-80%), red (<60%)\n- Hovering the capacity bar shows a tooltip: \"8/12 members available (67%)\"\n- Weekly capacity rollup in month view: average availability across the 5 weekdays\n- Alert system: when any week in the next 14 days has average capacity below 70%, send a notification to the manager via in-app notification and optional email digest\n- Alert threshold is configurable per team (default 70%) via team settings\n- Capacity calculation excludes weekends and company-wide holidays\n\n## Dependencies\n- Requires Availability Calendar Core Views and Availability Entry Management (needs entries to calculate capacity)\n\n## Technical context\n- Capacity computed as a materialized summary, refreshed on entry create/update/delete\n- Alerts evaluated by a daily cron job scanning the next 14 calendar days\n- Company holidays stored in a shared OrganizationHolidays table",
      "priority": "HIGH",
      "acceptanceCriteria": [
        "Capacity bar displays correct percentage based on availability entries per day",
        "Bar color reflects thresholds: green >80%, yellow 60-80%, red <60%",
        "Manager receives in-app notification when any upcoming sprint week is below 70% capacity",
        "Alert threshold is configurable per team via team settings",
        "Capacity calculation excludes weekends and configured company holidays"
      ]
    },
    {
      "title": "Google Calendar Integration",
      "description": "## Capability\nTwo-way sync between the availability calendar and Google Calendar, so PTO events created in either system are reflected in both.\n\n## Why it matters\nMany team members already manage PTO in Google Calendar. Without sync, they must double-enter data, leading to stale or missing availability records.\n\n## Behavioral details\n- User connects their Google Calendar via OAuth consent screen (user-level, extending existing org-level integration)\n- Sync scope: only events matching configured categories (default: \"Out of Office\" and events with \"PTO\" in title)\n- Inbound sync: matching Google Calendar events create PTO availability entries automatically\n- Outbound sync: PTO entries created in the availability calendar create corresponding Google Calendar events\n- Sync runs every 15 minutes via background job; manual \"Sync Now\" button available\n- Conflict handling: if an event is modified in both systems between syncs, the most recently modified version wins\n- Disconnect option: removes sync but preserves existing availability entries\n\n## Dependencies\n- Requires Availability Entry Management (creates entries from synced events)\n- Extends existing org-level Google OAuth to user-level consent\n\n## Technical context\n- Google Calendar API v3: Events.list with syncToken for incremental sync\n- OAuth scopes: calendar.events.readonly (inbound) + calendar.events (outbound)\n- Sync state tracked per user: last syncToken, last sync timestamp",
      "priority": "MEDIUM",
      "acceptanceCriteria": [
        "User can connect Google Calendar via OAuth and see synced PTO events within 15 minutes",
        "PTO entries created in the availability calendar appear in Google Calendar",
        "Only events matching configured categories are synced (not all calendar events)",
        "Manual Sync Now button triggers immediate sync and shows completion status",
        "Disconnecting Google Calendar preserves existing availability entries"
      ]
    },
    {
      "title": "Capacity CSV Export and Conflict Detection",
      "description": "## Capability\nManagers can export capacity reports as CSV for stakeholder sharing, and the system warns when assigning tasks to unavailable team members.\n\n## Why it matters\nCapacity data needs to reach stakeholders outside the platform (directors, PMO). Conflict detection closes the loop by preventing the scheduling mistakes the calendar was built to avoid.\n\n## Behavioral details\n- Export button in capacity summary header generates a CSV with columns: Week, Team Member, Availability Type, Hours Available, Percentage\n- CSV respects current view filters (date range, team)\n- File name format: \"{team-name}-capacity-{YYYY-MM-DD}.csv\"\n- Conflict detection: when a task is assigned to a team member (via existing task management), check availability for the task's sprint/date range\n- If the assignee has PTO or is <50% available during the task period, show a warning banner: \"{Name} is marked as {availability type} during this period\"\n- Warning is non-blocking — manager can proceed with assignment\n\n## Dependencies\n- Requires Capacity Summary and Alerts (uses computed capacity data)\n- Integrates with existing task assignment flow\n\n## Technical context\n- CSV generation server-side to handle large teams; streamed response\n- Conflict detection hooks into existing task assignment service as a pre-assignment check",
      "priority": "LOW",
      "acceptanceCriteria": [
        "Export generates a CSV with correct capacity data for the selected date range and team",
        "CSV file name follows the format {team-name}-capacity-{date}.csv",
        "Warning banner appears when assigning a task to a team member marked unavailable",
        "Warning is non-blocking and allows the manager to proceed with assignment",
        "Export respects current view filters (date range, team member selection)"
      ]
    }
  ]
}
</output>
</example>

</examples>

## Reasoning and output

First, reason through your decomposition inside <thinking> tags:
1. What are the user-facing capabilities in the PRD?
2. How do they group into vertical slices?
3. What are the dependency relationships?
4. What priority does each feature get based on the PRD's goals?

Then output ONLY the JSON object — no markdown fences, no commentary, no explanation outside the tags.

Aim for 3-8 features for a typical PRD. A very large PRD might warrant up to 12. If you identify more than 8, merge the lowest-priority ones or note which could be deferred. Fewer well-defined features are better than many vague ones.

Write features.json to the current working directory with the JSON output.
`;
