import { CatalogItemSource } from "@repo/api/src/types/distribution";
import { LABS_NAV_SECTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { packCatalogFixture, packsApiRoutes } from "./fixtures/packs-fixtures";
import { PacksListPage } from "./fixtures/packs-page";

// ISS-11361 Target sidebar, entry 16 of 62: Packs List (Artifact list).
// The tree `apps/app/.../packs/page.tsx` returns (Header and `PacksRouteBody`)
// at `/packs`, in the app frame. The body is gated on `labs-nav-section`, on
// here as in the live app. Each story is one state the live page reaches from
// its catalog and distribution reads.

const LIVE_FLAGS = [LABS_NAV_SECTION_FEATURE_FLAG_KEY];

function withRoutes(overrides: FixtureRoute[]) {
  return {
    appCore: {
      apiRoutes: [...overrides, ...packsApiRoutes],
      enabledFlags: LIVE_FLAGS,
    },
  };
}

const meta = {
  title: "Surfaces/Labs/Packs/Packs List",
  tags: ["preview"],
  render: () => <PacksListPage />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: { apiRoutes: packsApiRoutes, enabledFlags: LIVE_FLAGS },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** The signed-in admin: what the org distributes, the catalog, permissions. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { level: 1 })
    ).toBeInTheDocument();
    await expect(
      (await canvas.findAllByText(packCatalogFixture[0]?.name ?? "")).length
    ).toBeGreaterThan(0);
    await expect(
      await canvas.findByRole("link", { name: "Packs" })
    ).toHaveAttribute("data-active", "true");
  },
};

/** The catalog read is still in flight. */
export const Loading: Story = {
  parameters: withRoutes([
    {
      method: "GET",
      path: "/catalog",
      respond: () => new Promise(() => undefined),
    },
  ]),
};

/** An org with no packs authored or distributed. */
export const Empty: Story = {
  parameters: withRoutes([
    { method: "GET", path: "/catalog", respond: () => [] },
    { method: "GET", path: "/distributions", respond: () => [] },
  ]),
};

/** The catalog read failed. */
export const LoadFailed: Story = {
  parameters: withRoutes([
    { method: "GET", path: "/catalog", respond: () => null, status: 500 },
  ]),
};

/** A member (not an admin): their packs and what they can install. */
export const Member: Story = {
  render: () => <PacksListPage admin={false} />,
};

/** Two packs with the same name from different sources. */
export const CollidingNames: Story = {
  parameters: withRoutes([
    {
      method: "GET",
      path: "/catalog",
      respond: () => [
        ...packCatalogFixture,
        {
          ...packCatalogFixture[0],
          id: "pk_review_curated",
          organizationId: null,
          source: CatalogItemSource.Curated,
          version: "3.0.0",
        },
      ],
    },
  ]),
};
