import type {
  AgentEvent,
  IterationEvent,
  PerfEvent,
  PerfSummary,
  PipelineStepEvent,
} from "@repo/api/src/types/performance";

const MAX_LINE_BYTES = 65_536; // 64KB
const MAX_EVENTS = 10_000;
const MAX_DISTINCT_AGENTS = 50;
const MAX_DISTINCT_STEPS = 50;
const MAX_STRING_FIELD_LENGTH = 255;

function capString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.slice(0, MAX_STRING_FIELD_LENGTH);
}

export function isPerfEvent(value: unknown): value is PerfEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  const eventType = obj.event;
  if (eventType === "iteration") {
    return (
      typeof obj.run_id === "string" &&
      typeof obj.iteration === "number" &&
      typeof obj.duration_s === "number"
    );
  }
  if (eventType === "pipeline_step") {
    return (
      typeof obj.run_id === "string" &&
      typeof obj.step_name === "string" &&
      typeof obj.duration_s === "number"
    );
  }
  if (eventType === "agent") {
    return (
      typeof obj.run_id === "string" &&
      typeof obj.agent_name === "string" &&
      typeof obj.duration_s === "number"
    );
  }
  return false;
}

export function parsePerfEvents(buffer: Buffer): PerfEvent[] {
  const events: PerfEvent[] = [];
  const text = buffer.toString("utf8");
  const lines = text.split("\n");

  for (const line of lines) {
    if (events.length >= MAX_EVENTS) {
      break;
    }
    if (!line.trim()) {
      continue;
    }
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isPerfEvent(parsed)) {
      continue;
    }
    events.push(parsed);
  }

  return events;
}

type AgentStats = {
  agentType: string;
  totalDurationS: number;
  callCount: number;
};
type StepStats = {
  callCount: number;
  skipCount: number;
  totalDurationS: number;
};

function processAgentEvent(
  e: AgentEvent,
  agentMap: Map<string, AgentStats>
): void {
  const agentName = capString(e.agent_name);
  if (agentMap.size >= MAX_DISTINCT_AGENTS && !agentMap.has(agentName)) {
    return;
  }
  const agentType = capString(e.agent_type);
  const existing = agentMap.get(agentName);
  if (existing) {
    existing.totalDurationS += e.duration_s;
    existing.callCount++;
  } else {
    agentMap.set(agentName, {
      agentType,
      totalDurationS: e.duration_s,
      callCount: 1,
    });
  }
}

function processStepEvent(
  e: PipelineStepEvent,
  stepMap: Map<string, StepStats>
): void {
  const stepName = capString(e.step_name);
  if (stepMap.size >= MAX_DISTINCT_STEPS && !stepMap.has(stepName)) {
    return;
  }
  const existing = stepMap.get(stepName);
  if (existing) {
    if (e.skipped) {
      existing.skipCount++;
    } else {
      existing.callCount++;
    }
    existing.totalDurationS += e.duration_s;
  } else {
    stepMap.set(stepName, {
      callCount: e.skipped ? 0 : 1,
      skipCount: e.skipped ? 1 : 0,
      totalDurationS: e.duration_s,
    });
  }
}

export function computePerfSummary(events: PerfEvent[]): PerfSummary {
  let totalIterations = 0;
  let totalDurationS = 0;

  const agentMap = new Map<string, AgentStats>();
  const stepMap = new Map<string, StepStats>();

  for (const event of events) {
    if (event.event === "iteration") {
      const e = event as IterationEvent;
      totalIterations++;
      totalDurationS += e.duration_s;
    } else if (event.event === "agent") {
      processAgentEvent(event as AgentEvent, agentMap);
    } else if (event.event === "pipeline_step") {
      processStepEvent(event as PipelineStepEvent, stepMap);
    }
  }

  const agentBreakdown = Array.from(agentMap.entries()).map(
    ([agentName, stats]) => ({
      agentName,
      agentType: stats.agentType,
      totalDurationS: stats.totalDurationS,
      callCount: stats.callCount,
    })
  );

  const pipelineStepBreakdown = Array.from(stepMap.entries()).map(
    ([stepName, stats]) => ({
      stepName,
      callCount: stats.callCount,
      skipCount: stats.skipCount,
      totalDurationS: stats.totalDurationS,
    })
  );

  return {
    totalIterations,
    totalDurationS,
    agentBreakdown,
    pipelineStepBreakdown,
  };
}

export function parsePerfSummary(buffer: Buffer): PerfSummary {
  const events = parsePerfEvents(buffer);
  return computePerfSummary(events);
}
