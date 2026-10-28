import { useLocalStorageState } from "@repo/app/shared/hooks/use-local-storage-state";
import { booleanOrFallback } from "@repo/app/shared/lib/local-storage-validators";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import { COMMENTS_RAIL_COLLAPSED_KEY } from "../session-detail-workspace";
import { withProviders } from "./agent-session-detail-view.test-helpers";

// Call through, so every other assertion in the suite still exercises the real hook.
// The spy exists only to observe the ARGUMENTS the view hands it.
vi.mock(
  "@repo/app/shared/hooks/use-local-storage-state",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@repo/app/shared/hooks/use-local-storage-state")
      >();
    return {
      ...actual,
      useLocalStorageState: vi.fn(actual.useLocalStorageState),
    };
  }
);

/**
 * ISS-8533 wiring for the comments-rail collapse preference.
 *
 * What this pins, precisely: the view passes a coercer for that key, and it is the
 * shared `booleanOrFallback` against a `false` fallback. That is the mutation worth
 * killing here — deleting the third argument restores the unvalidated `as T` and no
 * behavioural assertion in this component's other suites would notice.
 *
 * What it does NOT pin, because the rail's collapsed state has no stable accessible
 * observable to assert against: the rendered rail. The coercer's own behaviour is
 * covered in `shared/lib/__tests__/local-storage-validators.test.ts`.
 */
describe("AgentSessionDetailView comments-rail collapse coercion (ISS-8533)", () => {
  it("validates the persisted collapse preference against a false default", () => {
    render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={createAgentSessionDetailFixture()}
        />
      )
    );

    const railCall = vi
      .mocked(useLocalStorageState)
      .mock.calls.find(([key]) => key === COMMENTS_RAIL_COLLAPSED_KEY);

    expect(railCall).toBeDefined();
    expect(railCall?.[1]).toBe(false);
    expect(railCall?.[2]).toBe(booleanOrFallback);
  });
});
