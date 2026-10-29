/**
 * The mount harness the `AgentsGroupedList` suites share.
 *
 * Extracted by ISS-6888, when the period-over-period delta cases moved into
 * their own file (`agents-grouped-list.date-window.test.tsx`) to keep the main
 * suite off the 1,000-line ceiling. Both files mount the same component through
 * the same providers against the same default inventory, so the wrapper and the
 * simple source belong in one module rather than being copied — two copies drift
 * into mounting the component under subtly different provider stacks, and then
 * "it passes over there" stops meaning anything.
 *
 * Deliberately NOT named `*.test.tsx`: a fixture module must not be collected as
 * a suite of its own.
 *
 * The richer two-window source lives in `agent-component-fixtures`
 * (`periodOverPeriodDataSource`) and is shared more widely still; this is only
 * the one-population case plus the provider stack.
 */

import type {
  AgentComponent,
  AgentComponentListResponse,
  AgentComponentQueryFilters,
} from "@repo/api/src/types/agent-component";
import { FIXTURE_COMPONENTS } from "@repo/app/agents/components/workspace/agent-component-fixtures";
import type { ReactNode } from "react";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import type { AgentComponentsDataSource } from "../../../data-source/agent-components-data-source";
import { AgentComponentsDataSourceProvider } from "../../../data-source/provider";

/**
 * A source serving ONE population for every read.
 *
 * `honorsDateWindow` defaults to `false` — the conservative choice for a source
 * that answers every window with the same rows, since that is exactly what the
 * declaration is supposed to describe. A case that needs the window-relative
 * reads passes `true` and means it.
 */
export function testDataSource(
  items: AgentComponent[] = FIXTURE_COMPONENTS,
  onList?: (filters: AgentComponentQueryFilters) => void,
  scope = "test",
  honorsDateWindow = false
): AgentComponentsDataSource {
  return {
    scope,
    honorsDateWindow,
    list: (filters) => {
      onList?.(filters);
      return Promise.resolve({
        items,
        total: items.length,
      } satisfies AgentComponentListResponse);
    },
    detail: () => Promise.reject(new Error("detail unused in list tests")),
  };
}

export function Wrapper({
  children,
  dataSource,
  enabledFlags,
}: {
  children: ReactNode;
  dataSource: AgentComponentsDataSource;
  enabledFlags?: readonly string[];
}) {
  return (
    <AppCoreStoryProviders enabledFlags={enabledFlags}>
      <AgentComponentsDataSourceProvider dataSource={dataSource}>
        {children}
      </AgentComponentsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}
