import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { createSessionTableRowFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { SessionGroupBy } from "@repo/app/agents/lib/session-grouping";
import { render, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionGroups } from "../use-session-groups";

const FLAGS = vi.hoisted(() => new Map<string, boolean>());

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: (key: string) => FLAGS.get(key) ?? false,
}));

describe("legacy Sessions grid universal status groups", () => {
  beforeEach(() => FLAGS.clear());

  it("renders canonical labels with state-specific champion marks", () => {
    FLAGS.set(UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY, true);
    const rows = [
      createSessionTableRowFixture({
        id: "active-session",
        rawStatus: SESSION_STATUS.ACTIVE,
        status: SESSION_STATUS.ACTIVE,
      }),
      createSessionTableRowFixture({
        id: "failed-session",
        rawStatus: SESSION_STATUS.ERROR,
        status: SESSION_STATUS.ERROR,
      }),
    ];

    const { result } = renderHook(() =>
      useSessionGroups(rows, SessionGroupBy.Status)
    );
    const { container } = render(
      <div>
        {result.current?.map((group) => (
          <span key={group.key}>{group.icon}</span>
        ))}
      </div>
    );
    const icons = container.querySelectorAll('[data-slot="status-icon"]');

    expect(result.current?.map((group) => group.label)).toEqual([
      "Running",
      "Failed",
    ]);
    expect(icons).toHaveLength(2);
    expect(icons[0]?.innerHTML).not.toBe(icons[1]?.innerHTML);
  });

  /**
   * ISS-10364 (operator ruling, Cosimo Corrigan, 2026-09-23/24: retired
   * `waiting`, legacy rows fold to Active) — #8618 review thread on
   * `artifact-status-mapping.ts`: a stored legacy `"waiting"` keeps the active
   * row's answer through `LEGACY_WAITING_WIRE_STATUS`, so it bands as Running.
   * Per the same ruling ("Don't distinguish"), a genuinely unrecognized raw
   * status bands as Running too, in the same band.
   */
  it("ISS-10364: bands a legacy Waiting status and an unrecognized status together as Running", () => {
    FLAGS.set(UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY, true);
    const rows = [
      createSessionTableRowFixture({
        id: "recognized-waiting",
        rawStatus: "waiting",
        status: SESSION_STATUS.ACTIVE,
      }),
      createSessionTableRowFixture({
        id: "future-status",
        rawStatus: "paused_by_future_producer",
        status: SESSION_STATUS.ACTIVE,
      }),
    ];

    const { result } = renderHook(() =>
      useSessionGroups(rows, SessionGroupBy.Status)
    );

    expect(result.current?.map((group) => group.label)).toEqual(["Running"]);
    expect(
      result.current?.map((group) => group.items.map((row) => row.id))
    ).toEqual([["recognized-waiting", "future-status"]]);
  });
});
