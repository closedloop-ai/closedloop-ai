import type {
  ProjectSummaryOwner,
  ProjectSummaryRow,
} from "@repo/app/projects/lib/project-summary-row"; // Cross-slice: project pages render the shipped project list (ISS-12938).
import { WEB_MASTER_BASE_PATH } from "../mock";

type Owner = ProjectSummaryOwner;
type ProjectRow = ProjectSummaryRow;

/**
 * The clock this fixture's relative labels ("4 days ago") were authored
 * against. The portable surface takes its clock as a prop precisely so a
 * prototype can replay a frozen date instead of drifting every day.
 */
export const WEB_MASTER_PROJECTS_NOW_MS = Date.parse(
  "2026-08-14T12:00:00-05:00"
);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HOURS_AGO_PATTERN = /^(\d+) hours? ago$/;
const DAYS_AGO_PATTERN = /^(\d+) days? ago$/;

const kaito = person("Kaito Castellane", "KC");
const ottilie = person("Ottilie Eastwick", "AE");
const daveth = person("Daveth Oakhurst", "DO");
const jory = person("Jory Hollingsworth", "JH");
const cosimo = person("Cosimo Corrigan", "CC");
const kerensa = person("Kerensa Whitlock", "KW");
const pascoe = person("Pascoe Birchall", "PB");
const marisol = person("Marisol Ashgrove", "MA");
const perrin = person("Perrin Upcott", "PU");

const productionProjectExamples: readonly ProjectRow[] = [
  project(
    "sprint-0810",
    "PRO-53",
    "8/10-14",
    59,
    "MEDIUM",
    kaito,
    "8/14/26",
    "Aug 3, 2026"
  ),
  project(
    "sprint-0817",
    "PRO-56",
    "8/17-21",
    25,
    "MEDIUM",
    kaito,
    "8/21/26",
    "4 days ago"
  ),
  project(
    "sprint-0824",
    "PRO-59",
    "8/24-28",
    0,
    "MEDIUM",
    kaito,
    null,
    "21 hours ago",
    0
  ),
  project(
    "anouk-workspace",
    null,
    "Anouk Workspace",
    0,
    "MEDIUM",
    ottilie,
    null,
    "Mar 12, 2026"
  ),
  project(
    "ottilie-august",
    "PRO-52",
    "Ottilie August Strategic Projects",
    11,
    "MEDIUM",
    ottilie,
    null,
    "Jul 29, 2026"
  ),
  project(
    "andrews-backlog",
    null,
    "Ottilie's Backlog",
    9,
    "LOW",
    ottilie,
    null,
    "Mar 12, 2026"
  ),
  project(
    "bigs-backlog",
    "PRO-33",
    "Bigs Backlog",
    5,
    "MEDIUM",
    kaito,
    null,
    "Jun 8, 2026"
  ),
  project(
    "daniels-workspace",
    null,
    "Daveth's Workspace",
    9,
    "MEDIUM",
    daveth,
    null,
    "Mar 12, 2026"
  ),
  project(
    "hosted-must-have",
    null,
    "Hosted Version + Free Trial - Must Have",
    33,
    "LOW",
    kaito,
    "4/15/26",
    "Mar 12, 2026"
  ),
  project(
    "hosted-nice-to-have",
    null,
    "Hosted Version + Free Trial - Nice To Have",
    13,
    "MEDIUM",
    kaito,
    null,
    "Mar 12, 2026"
  ),
  project(
    "hosted-public-launch",
    null,
    "Hosted Version + Free Trial - Public Launch",
    50,
    "MEDIUM",
    kaito,
    null,
    "Mar 12, 2026"
  ),
  project(
    "idea-backlog-processed",
    null,
    "Idea Backlog (Processed)",
    15,
    "LOW",
    kaito,
    null,
    "May 11, 2026"
  ),
  project(
    "ideas-triage",
    "PRO-16",
    "Ideas Triage",
    13,
    "MEDIUM",
    kaito,
    null,
    "Apr 13, 2026"
  ),
  project(
    "internal-bugs-triage",
    "PRO-57",
    "Internal Bugs Triage",
    27,
    "HIGH",
    kaito,
    null,
    "3 days ago"
  ),
  project(
    "jacks-workspace",
    "PRO-49",
    "Jory's Workspace",
    0,
    "LOW",
    jory,
    null,
    "Jul 22, 2026",
    0
  ),
  project(
    "jims-interesting-items",
    "PRO-55",
    "Jim's Interesting Items",
    3,
    "MEDIUM",
    cosimo,
    null,
    "Aug 6, 2026"
  ),
  project(
    "jims-junk-drawer",
    "PRO-43",
    "Jim's Junk Drawer",
    32,
    "MEDIUM",
    cosimo,
    null,
    "Aug 6, 2026"
  ),
  project(
    "kaitis-workspace",
    "PRO-17",
    "Kaito's Workspace",
    47,
    "MEDIUM",
    kaito,
    null,
    "Apr 13, 2026"
  ),
  project(
    "kerensa-workspace",
    null,
    "Kerensa's Workspace",
    62,
    "MEDIUM",
    kerensa,
    null,
    "Mar 12, 2026"
  ),
  project(
    "marketing-site-bugs",
    "PRO-22",
    "Marketing Site - Initial Launch Bugs",
    50,
    "HIGH",
    pascoe,
    "4/28/26",
    "Apr 28, 2026"
  ),
  project(
    "mikes-workspace",
    null,
    "Marisol's Workspace",
    58,
    "LOW",
    marisol,
    null,
    "Mar 12, 2026"
  ),
  project(
    "night-crew",
    "PRO-40",
    "Night Crew",
    70,
    "MEDIUM",
    pascoe,
    null,
    "Jun 30, 2026"
  ),
  project(
    "pascoe-triage",
    "PRO-37",
    "Pascoe Triage",
    13,
    "MEDIUM",
    pascoe,
    null,
    "Jun 24, 2026"
  ),
  project(
    "peters-workspace",
    "PRO-14",
    "Perrin's Workspace",
    52,
    "LOW",
    perrin,
    null,
    "Apr 8, 2026"
  ),
  project(
    "prototypes",
    "PRO-47",
    "Prototypes",
    83,
    "MEDIUM",
    pascoe,
    null,
    "Jul 16, 2026"
  ),
  project(
    "qa-visual-logic",
    "PRO-51",
    "QA - Visual Logic Agent Findings",
    75,
    "MEDIUM",
    kaito,
    null,
    "Jul 27, 2026"
  ),
  project(
    "smalls-backlog",
    "PRO-34",
    "Smalls Backlog",
    40,
    "MEDIUM",
    kaito,
    null,
    "Jun 8, 2026"
  ),
];

const visibleTeamProjectIds = new Set([
  "sprint-0810",
  "sprint-0817",
  "ottilie-august",
]);

export const webMasterProjects: readonly ProjectRow[] =
  productionProjectExamples.filter((projectRow) =>
    visibleTeamProjectIds.has(projectRow.id)
  );

export function findProject(projectId: string): ProjectRow | undefined {
  return webMasterProjects.find((projectRow) => projectRow.id === projectId);
}

export function projectHref(project: ProjectRow): string {
  return `${WEB_MASTER_BASE_PATH}/projects/${encodeURIComponent(project.id)}`;
}

function person(name: string, initials: string): Owner {
  return { initials, name };
}

/**
 * Turn an authored label into the instant the surface sorts and filters by.
 * The prototype's labels are the oracle; this derives the machine value from
 * them rather than keeping a second, drifting list of timestamps.
 */
function updatedAtMsFor(label: string): number {
  const hours = label.match(HOURS_AGO_PATTERN);
  if (hours) {
    return WEB_MASTER_PROJECTS_NOW_MS - Number(hours[1]) * HOUR_MS;
  }
  const days = label.match(DAYS_AGO_PATTERN);
  if (days) {
    return WEB_MASTER_PROJECTS_NOW_MS - Number(days[1]) * DAY_MS;
  }
  return Date.parse(label);
}

function project(
  id: string,
  code: string | null,
  name: string,
  completionPercentage: number,
  priority: ProjectRow["priority"],
  owner: Owner,
  dueDate: string | null,
  updated: string,
  childTaskCount = 12
): ProjectRow {
  return {
    childTaskCount,
    code,
    completionPercentage,
    dueDateLabel: dueDate,
    dueDateMs: dueDate ? Date.parse(dueDate) : null,
    id,
    name,
    owner,
    priority,
    updatedAtMs: updatedAtMsFor(updated),
    updatedLabel: updated,
  };
}
