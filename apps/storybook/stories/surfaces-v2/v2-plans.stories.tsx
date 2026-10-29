import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { PlansView } from "../../../desktop/src/renderer/components/features/CoreFeaturesView";
import { invalidateCache } from "../../../desktop/src/renderer/hooks/useQueryCache";
import { pageTitleForNav } from "../../../desktop/src/renderer/navigation/nav-config";
import { NavId } from "../../../desktop/src/renderer/navigation/route-table";
import {
  plansFixture,
  planVersionsFixture,
} from "./test/desktop-only-fixtures";
import { DesktopPage, expectActiveDesktopNavItem } from "./test/desktop-page";

// ISS-11361 Target sidebar: Plans (Desktop only).
// The desktop app's Plans page (`CoreFeaturesView`'s `PlansView`, rendered by
// `App.tsx` for `#/plans`) in the desktop shell's own frame: the plans the
// local agent DB extracted from sessions, read through
// `desktopApi.db.getPlansList` / `getPlanVersions`. The view caches those
// reads module-wide, so each story starts from an empty cache.

type PlansAnswer = () => Promise<unknown>;

const PLAN_CACHE_KEYS = [
  "db:plans-list",
  ...plansFixture.map((plan) => `db:plan-versions:${plan.id}`),
  "db:plan-versions:null",
];

function clearPlansCache() {
  for (const key of PLAN_CACHE_KEYS) {
    invalidateCache(key);
  }
}

function PlansPage({ plans }: { plans: PlansAnswer }) {
  useState(clearPlansCache);
  return (
    <DesktopPage
      bridge={{
        db: {
          getPlansList: plans,
          getPlanVersions: (planId: string) =>
            Promise.resolve(
              planVersionsFixture.filter((version) => version.planId === planId)
            ),
          confirmPlan: () => Promise.resolve(),
          rejectPlan: () => Promise.resolve(),
          openPlan: () => Promise.resolve(),
        },
      }}
      navId={NavId.Plans}
    >
      <PlansView />
    </DesktopPage>
  );
}

const meta = {
  title: "Surfaces/Desktop Only/Plans",
  tags: ["stable"],
  render: (_args, { parameters }) => (
    <PlansPage
      plans={
        (parameters.plans as PlansAnswer | undefined) ??
        (() => Promise.resolve(plansFixture))
      }
    />
  ),
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", {
        level: 1,
        name: pageTitleForNav(NavId.Plans),
      })
    ).toBeVisible();
    await expectActiveDesktopNavItem(
      canvasElement,
      pageTitleForNav(NavId.Plans)
    );
  },
};

/** The plans read is still in flight. */
export const Loading: Story = {
  parameters: {
    plans: () =>
      new Promise<never>(() => {
        // Never settles.
      }),
  },
};

/** The local DB has no plans yet. */
export const Empty: Story = {
  parameters: { plans: () => Promise.resolve([]) },
};

/** The plans read failed. */
export const Unavailable: Story = {
  parameters: {
    plans: () => Promise.reject(new Error("agent DB unavailable")),
  },
};

/** A plan opened from the list, with its content and versions. */
export const PlanSelected: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = plansFixture[0]?.title ?? "";
    const [row] = await canvas.findAllByText(title);
    if (row) {
      await userEvent.click(row);
    }
  },
};
