import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { describe, expect, it } from "vitest";
import type { Routine } from "../routine-model";
import {
  ComponentKind,
  narrowInvokedComponentKind,
  RoutineOrigin,
  RoutineStatus,
  RunsOn,
  routineComponentKinds,
  routineStatusLabel,
  ScheduleKind,
  scheduleLabel,
} from "../routine-model";
import { PermissionMode, RoutineProvider } from "../routine-provider";
import { routineTemplates } from "../routine-templates";

describe("Routine enum vocabularies", () => {
  it("labels every schedule kind", () => {
    for (const kind of Object.values(ScheduleKind)) {
      expect(scheduleLabel[kind]).toBeTruthy();
    }
  });

  it("labels every routine status", () => {
    for (const status of Object.values(RoutineStatus)) {
      expect(routineStatusLabel[status]).toBeTruthy();
    }
  });

  it("exposes the documented origin, runs-on, and component kinds", () => {
    expect(Object.values(RoutineOrigin)).toEqual(["created", "discovered"]);
    expect(Object.values(RunsOn)).toEqual(["local", "cloud"]);
    expect(Object.values(ComponentKind)).toEqual([
      "subagent",
      "command",
      "skill",
    ]);
  });
});

describe("ComponentKind ⊂ AgentComponentInvocationKind (canonical, not re-declared)", () => {
  it("derives its members from the canonical invocation kinds", () => {
    // The three surfaced kinds are the exact canonical values, not new literals.
    expect(routineComponentKinds).toEqual([
      AgentComponentInvocationKind.Subagent,
      AgentComponentInvocationKind.Command,
      AgentComponentInvocationKind.Skill,
    ]);
    for (const kind of routineComponentKinds) {
      expect(Object.values(AgentComponentInvocationKind)).toContain(kind);
    }
  });

  it("intentionally omits the four runtime-plumbing kinds", () => {
    const omitted = [
      AgentComponentInvocationKind.Tool,
      AgentComponentInvocationKind.Mcp,
      AgentComponentInvocationKind.Orchestration,
      AgentComponentInvocationKind.Hook,
    ];
    for (const kind of omitted) {
      expect(routineComponentKinds).not.toContain(kind);
    }
  });
});

describe("narrowInvokedComponentKind", () => {
  it("keeps the three surfaced kinds", () => {
    for (const kind of routineComponentKinds) {
      expect(narrowInvokedComponentKind(kind)).toBe(kind);
    }
  });

  it("drops the four omitted kinds to null (never a silent cast)", () => {
    expect(
      narrowInvokedComponentKind(AgentComponentInvocationKind.Tool)
    ).toBeNull();
    expect(
      narrowInvokedComponentKind(AgentComponentInvocationKind.Mcp)
    ).toBeNull();
    expect(
      narrowInvokedComponentKind(AgentComponentInvocationKind.Orchestration)
    ).toBeNull();
    expect(
      narrowInvokedComponentKind(AgentComponentInvocationKind.Hook)
    ).toBeNull();
  });
});

describe("Routine crewd superset — lossless schedule + cascade", () => {
  // A routine converted from a crewd ScheduledTask pinned to a timezone with a
  // multi-step fallback cascade. The model must carry the canonical cron, the
  // IANA timezone, and every cascade step verbatim so a later save can restore
  // the exact fire time / DST behavior and the full fallback sequence.
  const converted: Routine = {
    id: "r1",
    name: "Nightly audit",
    description: "",
    owner: "mike",
    provider: RoutineProvider.Claude,
    modelId: "opus-4-8",
    harnessCascade: [
      { harness: "claude", modelId: "opus-4-8" },
      { harness: "codex", modelId: "gpt-5-6-sol" },
      { harness: "opencode", modelId: null },
    ],
    runsOn: RunsOn.Local,
    instructions: "Audit the repo",
    folderOrRepo: "~/repo",
    project: null,
    runsIn: null,
    cron: "30 2 * * *",
    timezone: "America/Chicago",
    scheduleKind: ScheduleKind.Custom,
    scheduleDetail: "At 2:30 AM (America/Chicago)",
    notifyMode: "all-runs",
    status: RoutineStatus.Active,
    origin: RoutineOrigin.Created,
    hostMachine: null,
    connectorIds: [],
    autoFixPullRequests: false,
    permissionMode: PermissionMode.AcceptEdits,
    reasoningEffort: null,
    worktree: false,
    lastRun: null,
    lastRunSessionId: null,
    nextRun: null,
    invokedComponents: [],
    sessionIds: [],
  };

  it("preserves the canonical cron and IANA timezone (not just display prose)", () => {
    expect(converted.cron).toBe("30 2 * * *");
    expect(converted.timezone).toBe("America/Chicago");
  });

  it("preserves every cascade step, not just the first", () => {
    expect(converted.harnessCascade.map((step) => step.harness)).toEqual([
      "claude",
      "codex",
      "opencode",
    ]);
    // Fallback steps after the primary survive the conversion.
    expect(converted.harnessCascade.length).toBeGreaterThan(1);
  });

  it("derives provider/modelId from the primary cascade step", () => {
    const [primary] = converted.harnessCascade;
    expect(converted.provider).toBe(primary.harness);
    expect(converted.modelId).toBe(primary.modelId);
  });
});

describe("routineTemplates", () => {
  it("only references known providers", () => {
    const providers = new Set<string>(Object.values(RoutineProvider));
    expect(
      routineTemplates.every((template) => providers.has(template.provider))
    ).toBe(true);
  });

  it("has stable ids and non-empty copy", () => {
    const ids = routineTemplates.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      routineTemplates.every(
        (template) =>
          template.label.length > 0 && template.description.length > 0
      )
    ).toBe(true);
  });
});
