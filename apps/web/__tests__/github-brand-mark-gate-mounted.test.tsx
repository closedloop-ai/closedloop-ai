// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: undefined as boolean | undefined,
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: (flag: string) =>
    mocks.enabled === undefined
      ? undefined
      : { key: flag, enabled: mocks.enabled },
}));

const { GitHubLogo } = await import("@/components/github-logo");

beforeEach(() => {
  mocks.enabled = undefined;
});

/**
 * The sibling suite renders through `react-dom/server`, where `useEffect` never
 * runs — so it can only ever observe this component's closed branch. Nothing
 * there fails if the marketing site's half of FEA-3570 is deleted outright.
 * This file mounts for real, which is the only way the open branch is reachable.
 *
 * Its own file because `apps/web` renders every other suite under the `node`
 * environment on purpose; the pragma above is scoped here rather than flipped
 * for the app.
 */
describe("the marketing site's GitHub mark, once mounted", () => {
  test("swaps to the filled Invertocat and keeps the caller's size", () => {
    mocks.enabled = true;

    const { container } = render(<GitHubLogo className="size-4" />);
    const svg = container.querySelector("svg");

    expect(svg?.getAttribute("fill")).toBe("currentColor");
    expect(svg?.querySelectorAll("path")).toHaveLength(1);
    expect(svg?.getAttribute("class")).toContain("size-4");
  });

  test("stays on the outline glyph while the flag is closed", () => {
    mocks.enabled = false;

    const { container } = render(<GitHubLogo className="size-4" />);
    const svg = container.querySelector("svg");

    expect(svg?.getAttribute("fill")).toBe("none");
    expect(svg?.querySelectorAll("path")).toHaveLength(2);
  });
});
