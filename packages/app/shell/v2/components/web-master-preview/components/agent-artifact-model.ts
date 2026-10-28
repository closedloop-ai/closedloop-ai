/**
 * Agentic-component fixture data for the Web Master prototype.
 *
 * Split from `agent-artifact-specialization.tsx` so the record set and its
 * lookups stay readable apart from the interactive canvas that renders them.
 */

import {
  ArtifactKind,
  ArtifactStatus,
  type GenericArtifact,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";

export const AgentComponentType = {
  Agent: "Agent",
  Command: "Command",
  Skill: "Skill",
  Workflow: "Workflow",
  Mcp: "MCP tool",
  Hook: "Hook",
  Config: "Memory & config",
  Plugin: "Plugin",
  Tool: "Tool",
  Orchestration: "Orchestration",
} as const;

export type AgentComponentType =
  (typeof AgentComponentType)[keyof typeof AgentComponentType];

export const OBSERVED_COMPONENT_TYPES = new Set<AgentComponentType>([
  AgentComponentType.Mcp,
  AgentComponentType.Tool,
  AgentComponentType.Orchestration,
]);

export type AgentComponentRecord = {
  artifact: GenericArtifact;
  componentType: AgentComponentType;
  source: string;
  harness: string;
  invocations: number;
  usageSessions: number;
  locPerDollar: number | null;
  mergedPrs: number | null;
  linesShipped: number | null;
  totalCost: number | null;
  versionCount: number;
  format: string;
  model: string;
  allowedTools: readonly string[];
  definition: string;
  usageExamples: readonly string[];
  resolution: "Resolved" | "Unresolved";
};

export const NAME_PARTS_PATTERN = /\s+/;

const records: readonly AgentComponentRecord[] = [
  makeAgent({
    id: "subagent-design-critic",
    slug: "AGT-DC01",
    title: "design-critic",
    summary:
      "Gives design direction in the team’s design voice for prototype reviews and live production VQA.",
    componentType: AgentComponentType.Agent,
    source: ".claude/agents/design-critic.md",
    harness: "Multiple harnesses",
    invocations: 34,
    usageSessions: 21,
    locPerDollar: 3.81,
    mergedPrs: 12,
    linesShipped: null,
    totalCost: null,
    versionCount: 7,
    format: "md",
    model: "opus",
    allowedTools: ["Repository read", "Browser VQA", "FEAT filing"],
    definition:
      'name: "design-critic"\ndescription: "Gives design direction in the team’s design voice. Two modes: prototype review and live production VQA. Requires the design soul."\nmodel: opus\ncolor: purple',
    usageExamples: [
      "prototype-ready-for-review",
      "VQA production website against prototypes exhaustively",
      "Full logical VQA of platform pages",
      "Confirm feature works as expected",
    ],
    resolution: "Resolved",
    collaborators: [
      "Marisol Ashgrove",
      "Tamsin Bramley",
      "Kerensa Whitlock",
      "Perrin Upcott",
      "Kaito Castellane",
      "Cosimo Corrigan",
    ],
  }),
  makeAgent({
    id: "agent-comment-issue",
    slug: "AGT-204",
    title: "_add_comment_to_issue",
    summary: "Adds a comment to an issue with traceable artifact context.",
    componentType: AgentComponentType.Tool,
    source: "_add_comment_to_issue",
    harness: "Codex",
    invocations: 2184,
    usageSessions: 684,
    locPerDollar: 18.6,
    mergedPrs: 46,
    linesShipped: 5210,
    totalCost: 117.41,
    versionCount: 7,
    format: "md",
    model: "gpt-5.5",
    allowedTools: ["issues.read", "comments.write"],
    definition:
      "Add a concise, evidence-backed comment to the selected issue. Preserve references to the originating artifact and never mutate unrelated fields.",
    usageExamples: [
      "Triage review feedback",
      "Apply requested issue updates",
      "Validate comment provenance",
    ],
    resolution: "Unresolved",
    collaborators: ["Daveth Oakhurst", "Ottilie Eastwick", "Jordan Lee"],
  }),
  makeAgent({
    id: "agent-design-reviewer",
    slug: "AGT-317",
    title: "design-systems-reviewer",
    summary:
      "Reviews implementation work for shared-component and interaction consistency.",
    componentType: AgentComponentType.Agent,
    source: ".codex/agents/design-systems-reviewer.md",
    harness: "Codex",
    invocations: 1487,
    usageSessions: 392,
    locPerDollar: 16.2,
    mergedPrs: 102,
    linesShipped: 8204,
    totalCost: 91.79,
    versionCount: 12,
    format: "md",
    model: "gpt-5.6",
    allowedTools: ["repository.read", "browser.vqa"],
    definition:
      "Review artifact implementations for visual consistency, correct ownership boundaries, responsive behavior, and reuse of the shared design system.",
    usageExamples: [
      "Review navigation consistency",
      "Audit shared component reuse",
      "Validate responsive behavior",
    ],
    resolution: "Resolved",
    collaborators: ["Ottilie Eastwick", "Pascoe Birchall"],
  }),
  makeAgent({
    id: "agent-release-skill",
    slug: "AGT-441",
    title: "release-readiness",
    summary: "Checks build, test, deployment, and change-management readiness.",
    componentType: AgentComponentType.Skill,
    source: ".codex/skills/release-readiness/SKILL.md",
    harness: "Claude",
    invocations: 906,
    usageSessions: 241,
    locPerDollar: 13.9,
    mergedPrs: 71,
    linesShipped: 3902,
    totalCost: 64.21,
    versionCount: 5,
    format: "md",
    model: "claude-opus-4-8",
    allowedTools: ["github.read", "ci.read", "deployments.read"],
    definition:
      "Evaluate whether the selected change is ready to ship. Report blocking failures separately from advisory risks and include links to primary evidence.",
    usageExamples: [
      "Confirm release checks",
      "Review deployment readiness",
      "Summarize blocking failures",
    ],
    resolution: "Resolved",
    collaborators: ["Pascoe Birchall", "Sam Chen"],
  }),
  makeAgent({
    id: "agent-github-mcp",
    slug: "AGT-512",
    title: "github",
    summary:
      "Provides structured repository, pull request, and issue operations.",
    componentType: AgentComponentType.Mcp,
    source: "plugin://github",
    harness: "Codex",
    invocations: 4521,
    usageSessions: 1216,
    locPerDollar: null,
    mergedPrs: 834,
    linesShipped: null,
    totalCost: null,
    versionCount: 3,
    format: "json",
    model: "Provider managed",
    allowedTools: ["pull_requests", "issues", "repositories"],
    definition:
      "Expose bounded GitHub operations through structured tools with repository-scoped authorization and explicit write intent.",
    usageExamples: [
      "Inspect pull request feedback",
      "Publish a prototype branch",
      "Review repository history",
    ],
    resolution: "Resolved",
    collaborators: ["Daveth Oakhurst", "Kerensa Whitlock"],
  }),
  makeAgent({
    id: "command-design-review",
    slug: "CMD-118",
    title: "/design-review",
    summary:
      "Starts the repository-grounded design review workflow for a prototype or live surface.",
    componentType: AgentComponentType.Command,
    source: ".claude/commands/design-review.md",
    harness: "Claude",
    invocations: 318,
    usageSessions: 127,
    locPerDollar: 9.8,
    mergedPrs: 44,
    linesShipped: 2910,
    totalCost: 42.61,
    versionCount: 8,
    format: "md",
    model: "Harness selected",
    allowedTools: ["design-critic", "Browser VQA", "repository.read"],
    definition:
      "Accept a prototype route or live URL, gather the applicable design context, invoke the design critic, and return prioritized evidence-backed recommendations.",
    usageExamples: [
      "Review generic artifact shells",
      "Audit responsive navigation",
      "Compare production and prototype behavior",
    ],
    resolution: "Resolved",
    collaborators: ["Ottilie Eastwick", "Kaito Castellane"],
  }),
  makeAgent({
    id: "plugin-gstack",
    slug: "PLG-031",
    title: "gstack",
    summary:
      "Packages reusable browser, review, and engineering workflows for installation across repositories.",
    componentType: AgentComponentType.Plugin,
    source: ".claude/plugins/gstack/plugin.json",
    harness: "Multiple harnesses",
    invocations: 762,
    usageSessions: 246,
    locPerDollar: 11.4,
    mergedPrs: 61,
    linesShipped: 6482,
    totalCost: 89.14,
    versionCount: 15,
    format: "json",
    model: "Plugin managed",
    allowedTools: ["commands", "skills", "hooks"],
    definition:
      'name: "gstack"\ncomponents: [commands, skills, hooks]\ndescription: "Reusable engineering and VQA workflows."',
    usageExamples: [
      "Install repository review workflows",
      "Run browser-backed VQA",
      "Share repeatable engineering commands",
    ],
    resolution: "Resolved",
    collaborators: ["Kerensa Whitlock", "Tamsin Bramley"],
  }),
  makeAgent({
    id: "hook-post-tool-use",
    slug: "HOK-204",
    title: "posttooluse:edit",
    summary:
      "Runs post-tool bookkeeping and validation after an agent edits repository content.",
    componentType: AgentComponentType.Hook,
    source: ".claude/settings.json",
    harness: "Claude",
    invocations: 2085,
    usageSessions: 142,
    locPerDollar: null,
    mergedPrs: null,
    linesShipped: null,
    totalCost: null,
    versionCount: 4,
    format: "json",
    model: "Event triggered",
    allowedTools: ["Edit", "post-tool-use-hook.sh"],
    definition:
      'event: "PostToolUse"\nmatcher: "Edit"\ncommand: "$' +
      '{CLAUDE_PLUGIN_ROOT}/hooks/post-tool-use-hook.sh"',
    usageExamples: [
      "Track token attribution",
      "Validate changed files",
      "Capture post-edit evidence",
    ],
    resolution: "Resolved",
    collaborators: ["Tamsin Bramley", "Cosimo Corrigan"],
  }),
  makeAgent({
    id: "orchestration-task-create",
    slug: "ORC-134",
    title: "taskcreate",
    summary:
      "Observed harness operation that creates a coordinated task for an agent workflow.",
    componentType: AgentComponentType.Orchestration,
    source: "runtime://taskcreate",
    harness: "Claude",
    invocations: 1164,
    usageSessions: 134,
    locPerDollar: null,
    mergedPrs: null,
    linesShipped: null,
    totalCost: null,
    versionCount: 1,
    format: "observed",
    model: "Harness managed",
    allowedTools: ["taskcreate", "taskupdate", "wait_agent"],
    definition:
      "Observed runtime interface. Orchestration components are supplied by the harness and measured from invocation evidence rather than authored or promoted.",
    usageExamples: [
      "Create a coordinated work item",
      "Dispatch a bounded subtask",
      "Track orchestration progress",
    ],
    resolution: "Resolved",
    collaborators: ["Cosimo Corrigan", "Marisol Ashgrove", "Kerensa Whitlock"],
  }),
  makeAgent({
    id: "workflow-prototype-review",
    slug: "WFL-087",
    title: "prototype-review",
    summary:
      "Sequences evidence gathering, critique, implementation, and VQA into one review workflow.",
    componentType: AgentComponentType.Workflow,
    source: ".codex/workflows/prototype-review.yml",
    harness: "Codex",
    invocations: 184,
    usageSessions: 79,
    locPerDollar: 8.7,
    mergedPrs: 19,
    linesShipped: 1540,
    totalCost: 31.82,
    versionCount: 6,
    format: "yaml",
    model: "Workflow selected",
    allowedTools: ["design-critic", "browser", "tests"],
    definition:
      "steps:\n  - inspect_reference\n  - review_prototype\n  - implement_approved_changes\n  - verify_interactions",
    usageExamples: [
      "Review artifact list interactions",
      "Apply approved design cleanup",
      "Run final VQA matrix",
    ],
    resolution: "Resolved",
    collaborators: ["Ottilie Eastwick", "Pascoe Birchall"],
  }),
  makeAgent({
    id: "config-repository-memory",
    slug: "CFG-014",
    title: "CLAUDE.md",
    summary:
      "Repository memory and configuration that governs how agents work in this codebase.",
    componentType: AgentComponentType.Config,
    source: "CLAUDE.md",
    harness: "Multiple harnesses",
    invocations: 4210,
    usageSessions: 1317,
    locPerDollar: null,
    mergedPrs: 150,
    linesShipped: null,
    totalCost: null,
    versionCount: 22,
    format: "md",
    model: "Inherited",
    allowedTools: ["repository instructions", "coding standards"],
    definition:
      "Repository-scoped memory and configuration. Defines required commands, ownership boundaries, review expectations, and safe implementation practices.",
    usageExamples: [
      "Load repository instructions",
      "Apply code ownership rules",
      "Run required validation",
    ],
    resolution: "Resolved",
    collaborators: ["Marisol Ashgrove", "Kerensa Whitlock", "Kaito Castellane"],
  }),
];

function makeAgent(
  input: Omit<AgentComponentRecord, "artifact"> & {
    id: string;
    slug: string;
    title: string;
    summary: string;
    collaborators: readonly string[];
  }
): AgentComponentRecord {
  const isObserved = OBSERVED_COMPONENT_TYPES.has(input.componentType);

  return {
    ...input,
    artifact: {
      activityCount: Math.max(4, Math.round(input.invocations / 100)),
      aiSpend: Math.round(input.invocations * 0.031 * 100) / 100,
      collaborators: input.collaborators,
      commentCount: input.versionCount + 2,
      createdAgoDays: input.versionCount * 4,
      currentVersion: isObserved ? "—" : String(input.versionCount),
      id: input.id,
      kind: ArtifactKind.Agent,
      outcomeScore: input.resolution === "Resolved" ? 91 : 74,
      owner: input.collaborators[0] ?? "Unassigned",
      ownerInitials: initials(input.collaborators[0] ?? "—"),
      project:
        input.title === "design-critic" ? "Design system" : "Agent platform",
      relationshipCount: input.usageSessions + 3,
      repository: "closedloop-ai",
      slug: input.slug,
      status:
        input.resolution === "Resolved"
          ? ArtifactStatus.Active
          : ArtifactStatus.InReview,
      summary: input.summary,
      tags: [input.componentType, input.harness],
      timeToReadyMinutes: 12 + input.versionCount * 3,
      title: input.title,
      updated: input.title === "design-critic" ? "just now" : "2d ago",
      updatedAgoMinutes: input.title === "design-critic" ? 2 : 2 * 24 * 60,
    },
  };
}

function initials(name: string): string {
  return name
    .split(NAME_PARTS_PATTERN)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export const agentArtifacts = records.map((record) => record.artifact);

const byId = new Map(records.map((record) => [record.artifact.id, record]));

export function recordFor(artifact: GenericArtifact): AgentComponentRecord {
  const existing = byId.get(artifact.id);
  if (existing) {
    return existing;
  }
  const template = records[0]!;
  const componentTypeValue = artifact.creationValues?.["component-type"];
  const componentType = Object.values(AgentComponentType).includes(
    componentTypeValue as AgentComponentType
  )
    ? (componentTypeValue as AgentComponentType)
    : AgentComponentType.Agent;
  return {
    ...template,
    allowedTools: [],
    artifact,
    componentType,
    definition:
      typeof artifact.creationValues?.definition === "string"
        ? artifact.creationValues.definition
        : "",
    harness:
      typeof artifact.creationValues?.harness === "string"
        ? artifact.creationValues.harness
        : "Codex",
    invocations: 0,
    source:
      typeof artifact.creationValues?.source === "string"
        ? artifact.creationValues.source
        : "Not connected",
    usageSessions: 0,
    versionCount: 1,
  };
}
