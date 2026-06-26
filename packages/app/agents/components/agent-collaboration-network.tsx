import type { WorkflowEffectivenessItem } from "@repo/app/agents/lib/session-types";
import { Section } from "@repo/design-system/components/ui/layout/section";
import { Graph } from "@repo/design-system/components/ui/primitives/graph";

type AgentCollaborationNetworkProps = {
  data: WorkflowEffectivenessItem[];
  edges: Array<{ source: string; target: string; weight: number }>;
};

export function AgentCollaborationNetwork({
  data,
  edges,
}: AgentCollaborationNetworkProps) {
  return (
    <Section
      contentClassName="space-y-4"
      description="Directed workflow handoffs between agent types, with weighted edges and relative node volume."
      title="Agent collaboration network"
    >
      <Graph
        ariaLabel="Agent collaboration graph"
        edgeLegendLabel="A runs before B"
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
    </Section>
  );
}
