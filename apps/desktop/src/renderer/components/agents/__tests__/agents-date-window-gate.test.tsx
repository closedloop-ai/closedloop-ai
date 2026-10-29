/**
 * @description ISS-6888 — both arms of the desktop date-window rollout gate.
 *
 * The flag-ON arm is the one that matters here. An earlier revision of this
 * change placed the gate inside `DesktopAppCoreProvider`, which sits ABOVE the
 * real `DesktopFeatureFlagProvider` and therefore resolves every flag through
 * the static all-off adapter: the gate read `false` forever and the capability
 * was unreachable in production no matter what the PostHog key said. A
 * closed-default test alone passed that build, because closed was all it could
 * ever be. Asserting the OPEN arm is what makes these tests able to fail.
 */

import type { AgentComponentsDataSource } from "@repo/app/agents/data-source/agent-components-data-source";
import {
  AgentComponentsDataSourceProvider,
  useAgentComponentsDataSource,
} from "@repo/app/agents/data-source/provider";
import { AGENTS_LOCAL_DATE_WINDOW_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { DesktopAgentsDateWindowGate } from "../agents-date-window-gate";

/**
 * A stand-in for the desktop LOCAL source: it declares the capability, exactly
 * as `createLocalAgentComponentsDataSource` does since FEA-3196 taught the local
 * reader to apply the bounds.
 */
function localSource(): AgentComponentsDataSource {
  return {
    scope: "agent-components:local",
    honorsDateWindow: true,
    list: () => Promise.resolve({ items: [], total: 0, hasMore: false }),
    detail: () => Promise.reject(new Error("detail unused")),
    subscribe: () => () => undefined,
  };
}

function renderGate(
  source: AgentComponentsDataSource,
  enabledFlags: readonly string[]
) {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AppCoreStoryProviders enabledFlags={enabledFlags}>
        <AgentComponentsDataSourceProvider dataSource={source}>
          <DesktopAgentsDateWindowGate>{children}</DesktopAgentsDateWindowGate>
        </AgentComponentsDataSourceProvider>
      </AppCoreStoryProviders>
    );
  }
  return renderHook(() => useAgentComponentsDataSource(), { wrapper: Wrapper });
}

describe("DesktopAgentsDateWindowGate", () => {
  it("WITHHOLDS the capability from the shared list while the flag is off", () => {
    const source = localSource();

    const gated = renderGate(source, []);

    expect(gated.result.current.honorsDateWindow).toBe(false);
    // The rest of the port rides through, so a flag-off desktop keeps its live
    // refresh and its reads — only the declaration is withheld.
    expect(gated.result.current.scope).toBe(source.scope);
    expect(gated.result.current.list).toBe(source.list);
    expect(gated.result.current.subscribe).toBe(source.subscribe);
  });

  it("PASSES the capability through once the flag is on", () => {
    // The arm the misplaced gate could never reach. Same source, same tree, one
    // input different — so this cannot pass on the fixture alone, and a gate
    // wired above the real flag provider fails it.
    const source = localSource();

    const opened = renderGate(source, [
      AGENTS_LOCAL_DATE_WINDOW_FEATURE_FLAG_KEY,
    ]);

    expect(opened.result.current.honorsDateWindow).toBe(true);
    // The SAME object, not a rebuilt copy: a fresh identity per render would
    // change the React Query cache key on every paint.
    expect(opened.result.current).toBe(source);
  });

  it("reads the flag key the shared web surface reads, not a desktop alias", () => {
    // ISS-8753 made the desktop renderer resolve the signed-in user's PostHog
    // assignment, so ONE key gates both surfaces and there is no Labs alias to
    // drift from. A gate keyed on some other string would leave desktop dark
    // while web was lit; enabling an unrelated key must not open this one.
    const gated = renderGate(localSource(), ["some-other-flag"]);

    expect(gated.result.current.honorsDateWindow).toBe(false);
  });
});
