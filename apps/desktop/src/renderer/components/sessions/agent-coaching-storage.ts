import type { AgentCoachingFeedbackEvent } from "./agent-coaching-types";

const FEEDBACK_STORAGE_KEY = "desktop-agent-coaching-feedback:v1";
const MAX_FEEDBACK_EVENTS = 200;

export function loadAgentCoachingFeedback(
  storage: Storage = window.localStorage
): AgentCoachingFeedbackEvent[] {
  try {
    const raw = storage.getItem(FEEDBACK_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isFeedbackEvent).slice(-MAX_FEEDBACK_EVENTS);
  } catch {
    return [];
  }
}

export function appendAgentCoachingFeedback(
  event: AgentCoachingFeedbackEvent,
  storage: Storage = window.localStorage
): AgentCoachingFeedbackEvent[] {
  const next = [...loadAgentCoachingFeedback(storage), event].slice(
    -MAX_FEEDBACK_EVENTS
  );
  storage.setItem(FEEDBACK_STORAGE_KEY, JSON.stringify(next));
  return next;
}

function isFeedbackEvent(value: unknown): value is AgentCoachingFeedbackEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.tipId === "string" &&
    typeof record.category === "string" &&
    typeof record.action === "string" &&
    typeof record.createdAt === "string"
  );
}
