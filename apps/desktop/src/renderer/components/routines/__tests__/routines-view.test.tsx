import type { RoutinesDataSource } from "@repo/app/routines/components/routines-view";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoutinesView } from "../routines-view";

// The desktop wrapper mounts the shared `@repo/app/routines` view. Mock it to a
// marker so this suite exercises the wrapper's flag gate + chrome, not the
// shared slice internals (covered by packages/app/routines tests).
vi.mock("@repo/app/routines/components/routines-view", () => ({
  RoutinesView: () => <div data-testid="shared-routines-view" />,
}));

// PageShell pulls native chrome; render its children inline so the marker is
// queryable without the full renderer shell.
vi.mock("../../layout/page-shell", () => ({
  PageShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const mockFlag = vi.hoisted(() => ({ enabled: false }));
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => mockFlag.enabled,
}));

const stubDataSource: RoutinesDataSource = {
  list: () => Promise.resolve([]),
  runs: () => Promise.resolve([]),
  create: () => Promise.resolve(undefined as never),
  update: () => Promise.resolve(undefined as never),
  delete: () => Promise.resolve(true),
  toggle: () => Promise.resolve(null),
  runNow: () => Promise.resolve(true),
  previewSchedule: () =>
    Promise.resolve({ valid: true, error: null, nextRuns: [] }),
  onChanged: () => () => undefined,
};

describe("desktop RoutinesView flag gate (PRD-566 / FEA-4348)", () => {
  afterEach(() => {
    mockFlag.enabled = false;
    vi.clearAllMocks();
  });

  it("renders nothing when the routines flag is OFF (mount gated)", () => {
    mockFlag.enabled = false;
    const { container, queryByTestId } = render(
      <RoutinesView dataSource={stubDataSource} />
    );

    expect(queryByTestId("shared-routines-view")).toBeNull();
    // The wrapper returns null when off, so nothing renders into the container.
    expect(container.firstChild).toBeNull();
  });

  it("mounts the shared Routines view when the flag is ON", () => {
    // Flip the flag so the OFF assertion above cannot be satisfied by the
    // default — a green here proves the gate opens, not that it is stuck closed.
    mockFlag.enabled = true;
    const { queryByTestId } = render(
      <RoutinesView dataSource={stubDataSource} />
    );

    expect(queryByTestId("shared-routines-view")).not.toBeNull();
  });
});
