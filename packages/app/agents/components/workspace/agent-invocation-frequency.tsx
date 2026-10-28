"use client";

import { CategoryBarChart } from "@repo/design-system/components/ui/category-bar-chart";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useAgentComponentsDataSource } from "../../data-source/provider";
import { agentComponentKeys } from "../../hooks/use-agent-components";

/** Daily component invocation counts, independent of per-model token coverage. */
export function AgentInvocationFrequency({ slug }: { slug: string }) {
  const source = useAgentComponentsDataSource();
  const frequency = source.frequency;
  const query = useQuery({
    queryKey: [
      ...agentComponentKeys.detail(source.scope, slug),
      "frequency",
      frequencyWindowDays,
    ],
    queryFn: () => {
      if (!frequency) {
        throw new Error("Frequency read unavailable");
      }
      return frequency(slug, frequencyWindowDays);
    },
    enabled: frequency !== undefined,
    throwOnError: false,
    retry: false,
  });
  return (
    <section aria-label="Usage over time" className="flex flex-col gap-3">
      <div>
        <h2 className="font-semibold text-base">Usage over time</h2>
        <p className="mt-1 text-muted-foreground text-sm">
          Runtime use of this component is review evidence, not component
          authorship.
        </p>
      </div>
      <FrequencyBody
        available={frequency !== undefined}
        error={query.isError}
        pending={query.isPending}
        points={query.data?.points}
      />
    </section>
  );
}

function FrequencyBody({
  available,
  error,
  pending,
  points,
}: {
  available: boolean;
  error: boolean;
  pending: boolean;
  points?: readonly { day: string; invocations: number }[];
}) {
  if (!available || error) {
    return (
      <p className="text-muted-foreground text-sm">
        Usage for this component isn't available here
      </p>
    );
  }
  if (pending) {
    return (
      <Skeleton
        aria-label="Loading component details…"
        className="h-40 w-full"
        role="status"
      />
    );
  }
  return (
    <div
      aria-label="Invocations in the last 30 days"
      className="h-40"
      role="img"
    >
      <CategoryBarChart
        colorByKey={Object.fromEntries(
          (points ?? []).map((point) => [point.day, "var(--primary)"])
        )}
        data={(points ?? []).map((point) => ({
          key: point.day,
          label: point.day,
          value: point.invocations,
        }))}
        emptyMessage="No usage recorded in the last 30 days."
        valueFormatter={formatInvocations}
      />
    </div>
  );
}

function formatInvocations(value: number): string {
  return `${value.toLocaleString()} invocations`;
}

const frequencyWindowDays = 30;
