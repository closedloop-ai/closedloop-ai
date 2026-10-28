/**
 * ISS-12519 — the data-controls prototype keeps one fixture state across the
 * four flows: the shared session's excluded-directory marker follows the
 * flow 1 selection, and a flow 1 edit made while a policy save is pending is
 * not overwritten when that save lands.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataControlsPrototypeDemo } from "../data-controls-prototype-demo";
import {
  PLACEHOLDER_DATA_CONTROLS_COPY,
  PRD_796_FLOW_TITLES,
  SCENARIO_PANEL_COPY,
} from "../data-controls-prototype-fixtures";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const renderDemo = () =>
  render(
    <DataControlsPrototypeDemo
      copy={PLACEHOLDER_DATA_CONTROLS_COPY}
      flowTitles={PRD_796_FLOW_TITLES}
      panelCopy={SCENARIO_PANEL_COPY}
    />
  );

const choose = (name: string) =>
  fireEvent.click(screen.getByRole("radio", { name }));
const openFlow = (flow: keyof typeof PRD_796_FLOW_TITLES) =>
  choose(PRD_796_FLOW_TITLES[flow]);
const row = (name: string) => screen.getByRole("treeitem", { name });
const excludedMarker = () =>
  screen.queryByText(
    PLACEHOLDER_DATA_CONTROLS_COPY.shareExceptions.excludedDirectoryLabel
  );

describe("DataControlsPrototypeDemo", () => {
  it("marks the shared session once flow 1 excludes ~/scratch", () => {
    renderDemo();
    choose(`${SCENARIO_PANEL_COPY.presets.sessionShared.ariaLabel}: On`);

    openFlow("share");
    expect(excludedMarker()).not.toBeInTheDocument();

    openFlow("scope");
    fireEvent.click(row("~/scratch"));
    expect(row("~/scratch")).toHaveAttribute("aria-checked", "false");

    openFlow("share");
    expect(excludedMarker()).toBeInTheDocument();
  });

  it("keeps a flow 1 edit made while a policy save is pending", () => {
    vi.useFakeTimers();
    renderDemo();
    choose(SCENARIO_PANEL_COPY.user.returning);

    openFlow("policy");
    fireEvent.click(row("harbor-api"));
    fireEvent.click(
      screen.getByRole("button", {
        name: PLACEHOLDER_DATA_CONTROLS_COPY.scopeEditor.saveLabel,
      })
    );

    openFlow("scope");
    fireEvent.click(row("~/scratch"));
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(row("~/scratch")).toHaveAttribute("aria-checked", "false");
    expect(row("harbor-api")).toHaveAttribute("aria-checked", "true");
  });
});
