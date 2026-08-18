import type { WorkflowEffectivenessItem } from "@repo/app/agents/lib/session-types";
import { SectionHeader } from "@repo/app/insights/components/overview/section-header";
import { Graph } from "@repo/design-system/components/ui/primitives/graph";

type AgentCollaborationNetworkProps = {
  data: WorkflowEffectivenessItem[];
  edges: Array<{ source: string; target: string; weight: number }>;
};

export function AgentCollaborationNetwork({
  data,
  edges,
}: AgentCollaborationNetworkProps) {
  // Match the sibling overview chart cards (model-usage / autonomy-trend): a
  // `flex h-full flex-col` header + `min-h-0 flex-1` body so the graph compresses
  // to the enclosing DashboardCard height instead of spilling past it (FEA-3622).
  // No nested Section card here — the DashboardCard already provides the chrome.
  //
  // ISS-5280 (review): the description says what the reader is looking at, not
  // how the graph is built — the previous copy ("Directed workflow handoffs
  // between agent types, with weighted edges and relative node volume")
  // described the data structure. The plain-language wording stands, but the
  // "ships to everyone" premise no longer does: ISS-5061 re-gated this row
  // closed-by-default on both surfaces, so only opted-in users see it.
  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        description="Which agent types hand work to which, and how often."
        title="Agent Collaboration Network"
      />
      <div className="min-h-0 flex-1">
        <Graph
          ariaLabel="Agent collaboration graph"
          edgeLegendLabel="A runs before B"
          emptyMessage="No agent collaboration data for this period yet."
          getLinkDescription={(link, source, target) =>
            `${source.label ?? source.id} runs before ${target.label ?? target.id} ${link.weight} times.`
          }
          getLinkRows={(link, source, target) => [
            { label: "Sequential pairs", value: `${link.weight}x` },
            {
              label: `Share of ${source.label ?? source.id}`,
              value:
                source.value > 0
                  ? `${((link.weight / source.value) * 100).toFixed(1)}%`
                  : "—",
            },
            {
              label: `Share of ${target.label ?? target.id}`,
              value:
                target.value > 0
                  ? `${((link.weight / target.value) * 100).toFixed(1)}%`
                  : "—",
            },
          ]}
          getNodeDescription={(node) =>
            `${node.label ?? node.id} appears in ${node.value} runs across the observed workflow graph.`
          }
          getNodeRows={(node) => {
            const item = data.find((entry) => entry.subagentType === node.id);
            return [
              { label: "Runs", value: node.value.toLocaleString() },
              {
                label: "Sessions",
                value: (item?.sessions ?? 0).toLocaleString(),
              },
              {
                label: "Success rate",
                value: item ? `${item.successRate.toFixed(0)}%` : "—",
              },
            ];
          }}
          legendLabel="Legend"
          links={edges.map((edge) => ({
            ...edge,
            label: `${edge.weight}x`,
          }))}
          nodes={data.map((item) => ({
            id: item.subagentType,
            label: item.subagentType,
            value: item.total,
          }))}
        />
      </div>
    </div>
  );
}
