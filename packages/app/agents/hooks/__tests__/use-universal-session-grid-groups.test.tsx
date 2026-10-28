import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { createSessionTableRowFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { buildGroups } from "@repo/app/agents/components/sessions/sessions-list-surface-rows";
import {
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { render, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  presentUniversalSessionGridGroups,
  useUniversalSessionGridGroups,
} from "../use-universal-session-grid-groups";

const FLAGS = vi.hoisted(() => new Map<string, boolean>());

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: (key: string) => FLAGS.get(key) ?? false,
}));

describe("production Sessions v2 universal status groups", () => {
  beforeEach(() => FLAGS.clear());

  /**
   * ISS-10364 (operator ruling, 2026-09-23/24: "Don't distinguish between
   * active and stale"): a legacy `"stale"` displayed value folds to Active, so
   * it bands as Running rather than the generic Unknown root.
   */
  it("ISS-10364: a legacy stale displayed value bands as Running", () => {
    FLAGS.set(UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY, true);
    const state = grouping("status");
    const groups = buildGroups(
      [
        createSessionTableRowFixture({
          rawStatus: SESSION_STATUS.ACTIVE,
          status: "stale",
        }),
      ],
      state
    );

    const { result } = renderHook(() =>
      useUniversalSessionGridGroups(groups, state)
    );

    expect(result.current?.[0]?.label).toBe("Running");
  });

  it("uses the same canonical transformation for secondary status bands", () => {
    FLAGS.set(UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY, true);
    const state = grouping("owner", "status");
    const groups = buildGroups(
      [
        createSessionTableRowFixture({
          rawStatus: SESSION_STATUS.ERROR,
          status: SESSION_STATUS.ERROR,
        }),
      ],
      state
    );

    const { result } = renderHook(() =>
      useUniversalSessionGridGroups(groups, state)
    );

    expect(result.current?.[0]?.subgroups?.[0]?.label).toBe("Failed");
  });

  it("renders state-specific champion marks for primary status bands", () => {
    FLAGS.set(UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY, true);
    const state = grouping("status");
    const groups = buildGroups(
      [
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
      ],
      state
    );

    const { result } = renderHook(() =>
      useUniversalSessionGridGroups(groups, state)
    );
    const { container } = render(
      <div>
        {result.current?.map((group) => (
          <span key={group.key}>{group.icon}</span>
        ))}
      </div>
    );
    const icons = container.querySelectorAll('[data-slot="status-icon"]');

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
    const state = grouping("status");
    const groups = buildGroups(
      [
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
      ],
      state
    );

    const { result } = renderHook(() =>
      useUniversalSessionGridGroups(groups, state)
    );

    expect(result.current?.map((group) => group.label)).toEqual(["Running"]);
    expect(
      result.current?.map((group) => group.items.map((row) => row.id))
    ).toEqual([["recognized-waiting", "future-status"]]);
  });

  it("ISS-10364: bands a legacy Waiting secondary status and an unrecognized one together as Running", () => {
    FLAGS.set(UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY, true);
    const state = grouping("owner", "status");
    const groups = buildGroups(
      [
        createSessionTableRowFixture({
          id: "recognized-waiting",
          rawStatus: "waiting",
          status: SESSION_STATUS.ACTIVE,
          user: { id: "owner-1", name: "Daveth" },
        }),
        createSessionTableRowFixture({
          id: "future-status",
          rawStatus: "paused_by_future_producer",
          status: SESSION_STATUS.ACTIVE,
          user: { id: "owner-1", name: "Daveth" },
        }),
      ],
      state
    );

    const { result } = renderHook(() =>
      useUniversalSessionGridGroups(groups, state)
    );

    expect(result.current).toHaveLength(1);
    expect(result.current?.[0]?.subgroups?.map((group) => group.label)).toEqual(
      ["Running"]
    );
  });

  it("preserves a non-droppable secondary group while merging canonical bands", () => {
    const first = createSessionTableRowFixture({
      id: "first-active",
      rawStatus: SESSION_STATUS.ACTIVE,
      status: SESSION_STATUS.ACTIVE,
    });
    const second = createSessionTableRowFixture({
      id: "second-active",
      rawStatus: SESSION_STATUS.ACTIVE,
      status: SESSION_STATUS.ACTIVE,
    });
    const state = grouping("status", "owner");
    const groups = [
      {
        items: [first],
        key: "legacy-active-a",
        label: "Active A",
        subgroups: [
          {
            droppable: true,
            items: [first],
            key: "owner:shared",
            label: "Daveth",
            value: "owner-1",
          },
        ],
      },
      {
        items: [second],
        key: "legacy-active-b",
        label: "Active B",
        subgroups: [
          {
            droppable: false,
            items: [second],
            key: "owner:shared",
            label: "Daveth",
            value: "owner-1",
          },
        ],
      },
    ];

    const presented = presentUniversalSessionGridGroups(groups, state);

    expect(presented).toHaveLength(1);
    expect(presented?.[0]?.subgroups).toEqual([
      expect.objectContaining({
        droppable: false,
        items: [first, second],
        key: "owner:shared",
        value: "owner-1",
      }),
    ]);
  });
});

function grouping(
  primaryFieldId: string,
  secondaryFieldId: string | null = null
): TableGroupingState {
  return {
    primary: {
      fieldId: primaryFieldId,
      order: TableGroupOrder.Ascending,
      showEmptyGroups: false,
    },
    secondary: {
      fieldId: secondaryFieldId,
      order: TableGroupOrder.Ascending,
      showEmptyGroups: false,
    },
  };
}
