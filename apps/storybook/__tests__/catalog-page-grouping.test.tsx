/**
 * Drives `stories/catalog.stories.tsx` over a crafted catalog, so the page's
 * grouping and status branches run against entries the generated catalog
 * does not currently carry: an entry with no subgroup, an internal helper, a
 * catalog-only entry, and groups/subgroups that tie on rank.
 */
import type { StorybookCatalogEntry } from "@repo/design-system/storybook/component-catalog";
import { composeStory } from "@storybook/react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const LEVEL = "Primitives";

const ENTRIES: StorybookCatalogEntry[] = [
  {
    id: "solo",
    label: "Solo Entry",
    sourcePath: "packages/x/solo.tsx",
    level: LEVEL,
    pathSegments: [],
    storyId: "solo",
    storyTitle: "Primitives/Solo Entry",
  },
  {
    id: "zeta-helper",
    label: "Zeta Helper",
    sourcePath: "packages/x/zeta.tsx",
    level: LEVEL,
    pathSegments: ["Zeta Group"],
    storyId: "zeta-helper",
    storyTitle: "Primitives/Zeta Group/Zeta Helper",
    internal: true,
  },
  {
    id: "alpha-only",
    label: "Alpha Only",
    sourcePath: "packages/x/alpha-only.tsx",
    level: LEVEL,
    pathSegments: ["Alpha Group"],
    storyTitle: "Primitives/Alpha Group/Alpha Only",
    storyStatus: "catalog-only",
  },
  {
    id: "alpha-b",
    label: "Alpha B",
    sourcePath: "packages/x/alpha-b.tsx",
    level: LEVEL,
    pathSegments: ["Alpha Group", "Sub B"],
    storyId: "alpha-b",
    storyTitle: "Primitives/Alpha Group/Sub B/Alpha B",
  },
  {
    id: "alpha-a",
    label: "Alpha A",
    sourcePath: "packages/x/alpha-a.tsx",
    level: LEVEL,
    pathSegments: ["Alpha Group", "Sub A"],
    storyId: "alpha-a",
    storyTitle: "Primitives/Alpha Group/Sub A/Alpha A",
  },
];

vi.mock("@repo/design-system/storybook/component-catalog", async (orig) => {
  const actual =
    await orig<
      typeof import("@repo/design-system/storybook/component-catalog")
    >();
  return { ...actual, storybookComponentCatalog: ENTRIES };
});

const catalogModule = await import("../stories/catalog.stories");
const CatalogIndex = composeStory(
  catalogModule.CatalogIndex,
  catalogModule.default
);

function headingIndex(name: string): number {
  const names = screen.getAllByRole("heading").map((h) => h.textContent);
  const index = names.indexOf(name);
  if (index === -1) {
    throw new Error(`no heading ${name}`);
  }
  return index;
}

function statValue(label: string): string | null {
  return screen.getByText(label).previousElementSibling?.textContent ?? null;
}

function statusOf(label: string): string | null {
  const article = screen
    .getByRole("heading", { name: label })
    .closest("article");
  if (!article) {
    throw new Error(`no article for ${label}`);
  }
  return within(article).getByText((_, el) => el?.tagName === "SPAN")
    .textContent;
}

describe("catalog page over a crafted catalog", () => {
  it("counts story-backed, catalog-only and internal entries separately", () => {
    render(<CatalogIndex />);
    expect(statValue("Story-backed entries")).toBe("3");
    expect(statValue("Catalog-only entries")).toBe("1");
    expect(statValue("Internal helpers")).toBe("1");
    expect(statValue("Total catalog entries")).toBe("5");
  });

  it("labels each entry's status by internal flag, then catalog-only, else story-backed", () => {
    render(<CatalogIndex />);
    expect(statusOf("Zeta Helper")).toBe("Internal helper");
    expect(statusOf("Alpha Only")).toBe("Catalog only");
    expect(statusOf("Solo Entry")).toBe("Story-backed");
  });

  it("renders no group heading for an entry with no path segments, ahead of named groups", () => {
    render(<CatalogIndex />);
    const groupHeadings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(groupHeadings).toEqual(["Alpha Group", "Zeta Group"]);
    expect(headingIndex("Solo Entry")).toBeLessThan(
      headingIndex("Alpha Group")
    );
  });

  it("orders unranked subgroups alphabetically after the empty subgroup", () => {
    render(<CatalogIndex />);
    const subgroups = screen
      .getAllByRole("heading", { level: 4 })
      .map((h) => h.textContent);
    expect(subgroups).toEqual(["Sub A", "Sub B"]);
    expect(headingIndex("Alpha Only")).toBeLessThan(headingIndex("Sub A"));
  });
});
