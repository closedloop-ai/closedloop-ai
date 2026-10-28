/**
 * Branch coverage for small Storybook modules the story sweep mounts once and
 * never varies: the manager sidebar label, the foundations token readers, the
 * story sort-order path walker, the v2 activity disclosure toggles and the
 * PriorityBadge key handler.
 */
import { composeStory } from "@storybook/react";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import { addons } from "storybook/manager-api";
import { userEvent } from "storybook/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import activityMeta, {
  CollapsedCard as collapsedCardStory,
  ExpandedDetailCard as expandedDetailStory,
} from "../stories/composites-v2/v2-activity-future.stories";
import { useResolvedTokens as useResolvedTokensV1 } from "../stories/foundations/token-table";
import {
  ColorSwatchGrid as ColorSwatchGridV2,
  useResolvedTokens as useResolvedTokensV2,
} from "../stories/foundations-v2/token-table";
import priorityBadgeMeta, {
  ForwardedSpanAttributes as forwardedSpanStory,
} from "../stories/priority-badge.stories";
import { storySortOrderPaths } from "../story-group-order";
import "../.storybook/manager";

vi.mock("storybook/manager-api", () => ({
  addons: { setConfig: vi.fn() },
}));

const TOKEN_NAME = "branch-test-token";
const MADE_CHANGES = /made 4 changes/;
const BADGE_TEST_ID = "priority-badge-forwarding";

type SidebarConfig = {
  sidebar: { renderLabel: (item: unknown) => import("react").ReactNode };
};

// Captured at import: manager.ts calls `addons.setConfig` once, at load.
const [managerCall] = vi.mocked(addons.setConfig).mock.calls;
const sidebarConfig = managerCall?.[0] as SidebarConfig | undefined;

function renderLabel(id: string, tags: string[] | undefined) {
  if (!sidebarConfig) {
    throw new Error("manager.ts did not call addons.setConfig");
  }
  return sidebarConfig.sidebar.renderLabel({ id, name: "Label", tags });
}

afterEach(() => {
  document.documentElement.style.removeProperty(`--${TOKEN_NAME}`);
});

describe("manager sidebar renderLabel", () => {
  it("returns the bare name when the item carries no lifecycle tag", () => {
    expect(renderLabel("composites-button", ["autodocs"])).toBe("Label");
    expect(renderLabel("composites-button", ["autodocs", "v2.0"])).toBe(
      "Label"
    );
    expect(renderLabel("composites-button", undefined)).toBe("Label");
  });

  it("returns the bare name for the Start Here root and anything under it", () => {
    expect(renderLabel("start-here", ["stable"])).toBe("Label");
    expect(renderLabel("start-here-welcome", ["stable"])).toBe("Label");
  });

  it.each([
    ["stable", "Stable"],
    ["preview", "Preview"],
    ["experimental", "Experimental"],
    ["deprecated", "Deprecated"],
  ])("badges a %s item outside Start Here as %s", (tag, label) => {
    render(renderLabel("composites-button", ["autodocs", tag]));
    expect(screen.getByText("Label")).toBeVisible();
    expect(screen.getByText(label)).toBeVisible();
  });

  it("does not treat a prefix-sharing id as Start Here", () => {
    render(renderLabel("start-heres", ["deprecated"]));
    expect(screen.getByText("Deprecated")).toBeVisible();
  });
});

describe.each([
  ["foundations", useResolvedTokensV1],
  ["foundations-v2", useResolvedTokensV2],
])("%s useResolvedTokens", (_label, useResolvedTokens) => {
  it("resolves to an empty map for an empty token list", () => {
    const { result } = renderHook(() => useResolvedTokens([]));
    expect(result.current).toEqual({});
  });

  it("reads each token's trimmed value off the document root", async () => {
    document.documentElement.style.setProperty(`--${TOKEN_NAME}`, " #123456 ");
    const { result } = renderHook(() => useResolvedTokens([TOKEN_NAME]));
    await waitFor(() => expect(result.current[TOKEN_NAME]).toBe("#123456"));
  });
});

describe("foundations-v2 ColorSwatchGrid", () => {
  it("prints the hex of a resolved token and 'not set' for an unresolved one", async () => {
    document.documentElement.style.setProperty(
      `--${TOKEN_NAME}`,
      "rgb(255, 0, 0)"
    );
    render(<ColorSwatchGridV2 tokens={[TOKEN_NAME, "branch-test-missing"]} />);
    expect(await screen.findByText("#ff0000")).toBeVisible();
    expect(screen.getByText("not set")).toBeVisible();
  });
});

describe("storySortOrderPaths", () => {
  it("ignores a nested group that has no preceding string to hang under", () => {
    expect(
      storySortOrderPaths([["Orphan", "Child"], "Root", ["Leaf"]])
    ).toEqual(new Set(["Root", "Root/Leaf"]));
  });
});

describe("v2 activity disclosures", () => {
  it("folds the collapsed run back up on a second press", async () => {
    await composeStory(
      { ...collapsedCardStory, play: undefined },
      activityMeta
    ).run();
    const toggle = screen.getByRole("button", { name: MADE_CHANGES });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("hides and restores the rename detail through the toggle", async () => {
    await composeStory(
      { ...expandedDetailStory, play: undefined },
      activityMeta
    ).run();
    expect(screen.getByText("Before")).toBeVisible();
    const toggle = screen.getByRole("button", { name: "Toggle detail" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(toggle);
    expect(screen.queryByText("Before")).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(toggle);
    expect(screen.getByText("Before")).toBeVisible();
  });
});

describe("PriorityBadge forwarded key handler", () => {
  it("ignores keys other than Enter and Space and activates on those two", async () => {
    const Story = composeStory(
      { ...forwardedSpanStory, play: undefined },
      priorityBadgeMeta
    );
    await Story.run();
    const onClick = Story.args.onClick;
    const badge = screen.getByTestId(BADGE_TEST_ID);
    badge.focus();

    await userEvent.keyboard("a");
    expect(onClick).not.toHaveBeenCalled();

    await userEvent.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
