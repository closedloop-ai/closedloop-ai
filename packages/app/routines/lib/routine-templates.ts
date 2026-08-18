/**
 * Starter routine templates for the empty-state gallery (FEA-4349 / PRD-566).
 * Faithful to the frozen prototype at
 * `apps/prototypes/app/p/routines/mock.ts`. Presentational seed data only —
 * not a durable store.
 */

import type { RoutineTemplate } from "./routine-model";
import { RoutineProvider } from "./routine-provider";

export const routineTemplates: readonly RoutineTemplate[] = [
  {
    id: "template-briefing",
    label: "Briefing",
    description: "Summary of your calendar, emails, and messages.",
    scheduleDetail: "Runs weekdays at 7:30 AM CDT",
    provider: RoutineProvider.Claude,
  },
  {
    id: "template-email-triage",
    label: "Email triage",
    description:
      "Categorize and prioritize your inbox, with draft responses for urgent items.",
    scheduleDetail: "Runs weekdays at 10:00 AM CDT",
    provider: RoutineProvider.Claude,
  },
  {
    id: "template-health-check",
    label: "System health check",
    description:
      "Monitor infrastructure and services for errors, outages, and performance issues.",
    scheduleDetail: "Runs daily at 7:00 AM CDT",
    provider: RoutineProvider.Codex,
  },
  {
    id: "template-issue-triage",
    label: "Issue triage",
    description:
      "Review and categorize incoming issues, bugs, and feature requests.",
    scheduleDetail: "Runs weekdays at 10:30 AM CDT",
    provider: RoutineProvider.Claude,
  },
  {
    id: "template-pr-digest",
    label: "PR review digest",
    description:
      "Overview of open PRs, review status, and what needs attention.",
    scheduleDetail: "Runs weekdays at 1:00 PM CDT",
    provider: RoutineProvider.Codex,
  },
  {
    id: "template-dependency-check",
    label: "Dependency update check",
    description:
      "Scan for outdated packages, security patches, and breaking changes.",
    scheduleDetail: "Runs every Monday at 1:30 AM CDT",
    provider: RoutineProvider.Codex,
  },
];
