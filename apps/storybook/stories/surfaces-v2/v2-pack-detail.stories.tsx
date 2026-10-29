import {
  LABS_NAV_SECTION_FEATURE_FLAG_KEY,
  PACK_UNDISTRIBUTE_FEATURE_FLAG_KEY,
  PACKS_DETAIL_ROUTE_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import { packCatalogFixture, packsApiRoutes } from "./fixtures/packs-fixtures";
import { PackDetailPage } from "./fixtures/packs-page";
import { expectActiveNavItem } from "./live-route";

// ISS-11361 Target sidebar, entry 17 of 62: Pack Detail (Record detail).
// The tree `apps/app/.../packs/[id]/page.tsx` returns (breadcrumb and
// `PacksRouteBody`) at `/packs/pk_review`, in the app frame. The route is gated
// on the packs detail-route flag and the body on `labs-nav-section`; both are
// on here. Each story is one state the live page reaches from its reads.

const LIVE_FLAGS = [
  LABS_NAV_SECTION_FEATURE_FLAG_KEY,
  PACKS_DETAIL_ROUTE_FEATURE_FLAG_KEY,
];

const REVIEW_PACK = packCatalogFixture[0];
const DESIGN_PACK = packCatalogFixture[1];

const meta = {
  title: "Surfaces/Labs/Packs/Pack Detail",
  tags: ["preview"],
  render: () => <PackDetailPage packId={REVIEW_PACK?.id ?? ""} />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    appCore: { apiRoutes: packsApiRoutes, enabledFlags: LIVE_FLAGS },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

/** The signed-in admin on a pack the org distributes. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The page heading and the pack's own title both carry the pack name.
    const headings = await canvas.findAllByRole("heading", {
      name: REVIEW_PACK?.name,
    });
    await expect(headings.length).toBeGreaterThan(0);
    await expectActiveNavItem(canvas, "Packs");
  },
};

/** The route's id names no pack in the catalog. */
export const NotFound: Story = {
  render: () => <PackDetailPage packId="pk_missing" />,
};

/** The admin's Distribution tab, with withdrawing a distribution offered. */
export const WebAdminWithdrawable: Story = {
  parameters: {
    appCore: {
      apiRoutes: packsApiRoutes,
      enabledFlags: [...LIVE_FLAGS, PACK_UNDISTRIBUTE_FEATURE_FLAG_KEY],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tabs = await canvas.findAllByRole("tab");
    const distribution = tabs.at(-1);
    if (distribution) {
      await userEvent.click(distribution);
    }
  },
};

/** A member (not an admin) on a pack offered to the org. */
export const WebMemberInstall: Story = {
  render: () => <PackDetailPage admin={false} packId={DESIGN_PACK?.id ?? ""} />,
};
