import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  getPackedTimelineMarkerStyle,
  type TimelineMarkerInput,
} from "../../lib/timeline-marker-packing";
import { TimelineMarkerSemantic } from "../../lib/timeline-marker-semantics";
import {
  TimelineMarkerRail,
  TimelineMarkerTrigger,
} from "../timeline-marker-rail";

describe("TimelineMarkerRail", () => {
  it("renders bucketed markers through shared column and marker slots", async () => {
    const onBlue = vi.fn();
    render(
      <TimelineMarkerRail
        className="rail"
        columns={[
          {
            id: "bucket-1",
            markers: [{ id: "blue", label: "Human steering" }],
          },
        ]}
        layout="bucketed"
        renderColumn={(column, children) => (
          <div data-column={column.id} key={column.id}>
            {children}
          </div>
        )}
        renderMarker={(marker) => (
          <button key={marker.id} onClick={onBlue} type="button">
            {marker.label}
          </button>
        )}
      />
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Human steering" })
    );
    expect(onBlue).toHaveBeenCalledTimes(1);
  });

  it("renders packed markers and keyboard-reachable overflow clusters", async () => {
    const onClusterJump = vi.fn();
    render(
      <TimelineMarkerRail
        className="packed"
        items={[
          marker("a"),
          marker("b"),
          marker("c", TimelineMarkerSemantic.Delivery),
          marker("d", TimelineMarkerSemantic.FailureLimit),
        ]}
        layout="packed"
        renderCluster={(cluster) => (
          <button
            aria-label={`${cluster.items.length} more events`}
            key={cluster.id}
            onClick={onClusterJump}
            style={getPackedTimelineMarkerStyle(cluster)}
            type="button"
          />
        )}
        renderMarker={(packed) => (
          <button
            aria-label={packed.item.label}
            key={packed.id}
            style={getPackedTimelineMarkerStyle(packed)}
            type="button"
          />
        )}
      />
    );

    await userEvent.tab();
    expect(screen.getByRole("button", { name: "2 more events" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onClusterJump).toHaveBeenCalledTimes(1);
  });

  it("provides shared button aria and keyboard activation scaffolding", async () => {
    const onActivate = vi.fn();
    render(
      <TimelineMarkerTrigger
        ariaDisabled
        ariaLabel="Jump to dense marker"
        onClick={onActivate}
      />
    );

    const marker = screen.getByRole("button", {
      name: "Jump to dense marker",
    });
    expect(marker).toHaveAttribute("aria-disabled", "true");
    await userEvent.tab();
    expect(marker).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onActivate).toHaveBeenCalledTimes(1);
  });
});

function marker(
  id: string,
  semantic: TimelineMarkerSemantic = TimelineMarkerSemantic.HumanSteering
): TimelineMarkerInput<{ id: string }> {
  return {
    id,
    label: id,
    leftPct: 50,
    payload: { id },
    row: 0,
    semantic,
    sourceOrder: 0,
    stableOrderKey: id,
    timeMs: Date.parse("2026-06-10T10:00:00.000Z"),
  };
}
