import type {
  WorkflowData,
  WorkflowEffectivenessItem,
} from "@repo/app/agents/lib/session-types";
import { AgentCollaborationNetwork } from "./agent-collaboration-network";

export function AgentPipelineGraph({
  data,
  edges,
}: {
  data: WorkflowEffectivenessItem[];
  edges: WorkflowData["cooccurrence"];
}) {
  return <AgentCollaborationNetwork data={data} edges={edges} />;
}
