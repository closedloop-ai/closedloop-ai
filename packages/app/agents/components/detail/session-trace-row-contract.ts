import type { AgentComponentInvocationAnchor } from "@repo/api/src/types/agent-component-invocation";
import type { TurnActor } from "@repo/api/src/types/agent-session";
import type { ReactNode } from "react";
import type { TraceTextAnchor } from "./trace-comments";

/** Renders optional actor identity alongside a trace row's timing metadata. */
export type GutterActorRenderer = (actor: TurnActor) => ReactNode;

/** Shared interaction and presentation inputs for message and reasoning rows. */
export type SessionTraceRowRendererProps<TGroup> = {
  active?: boolean;
  group: TGroup;
  highlightAnchor?: TraceTextAnchor | null;
  invocationAnchor?: AgentComponentInvocationAnchor | null;
  onJump?: (row: number) => void;
  renderGutterActor?: GutterActorRenderer;
  selectionEnabled: boolean;
};
