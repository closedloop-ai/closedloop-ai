import {
  SettingsPanelHost,
  SettingsPanelId,
  SettingsPanelResolutionStatus,
} from "@repo/api/src/types/settings-panel";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import type { SettingsPanelResolution } from "../lib/settings-panel-resolution";
import { SettingsPanelStatusView } from "./settings-panel-status-view";

const RECOVERY = { href: "/settings?panel=profile", label: "Profile" };

/**
 * A resolution in one status. Every field the view reads is set explicitly, so a
 * story pins the SHAPE the shell hands this component rather than a convenient
 * subset of it.
 */
function resolution(
  status: SettingsPanelResolutionStatus,
  overrides: Partial<SettingsPanelResolution> = {}
): SettingsPanelResolution {
  return {
    status,
    requestedPanel: SettingsPanelId.Members,
    requestedPanelId: SettingsPanelId.Members,
    evaluatedPanelId: SettingsPanelId.Members,
    panelId: null,
    fallbackPanelId: SettingsPanelId.Profile,
    ...overrides,
  };
}

const meta = {
  title: "Composites v1.0/Settings/Settings Panel Status View",
  component: SettingsPanelStatusView,
  tags: ["deprecated", "autodocs"],
  args: {
    host: SettingsPanelHost.Web,
    recovery: RECOVERY,
    resolution: resolution(SettingsPanelResolutionStatus.Forbidden),
  },
} satisfies Meta<typeof SettingsPanelStatusView>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The capability read is still in flight. A skeleton, never an empty frame and
 * never a denial — "we have not asked yet" and "the answer was no" are the two
 * facts this whole component exists to keep apart.
 */
export const Pending: Story = {
  args: { resolution: resolution(SettingsPanelResolutionStatus.Pending) },
};

/** The link named something that is not a panel id at all. */
export const Unknown: Story = {
  args: {
    resolution: resolution(SettingsPanelResolutionStatus.Unknown, {
      requestedPanel: "integrations",
      requestedPanelId: null,
      evaluatedPanelId: null,
    }),
  },
};

/**
 * The echoed value is capped. A deep link can carry an arbitrarily long panel
 * value, and the title is width-capped — this is the story that shows the
 * truncation holding instead of the sentence running off the card.
 */
export const UnknownWithOverlongValue: Story = {
  args: {
    resolution: resolution(SettingsPanelResolutionStatus.Unknown, {
      requestedPanel:
        "organization-billing-and-invoicing-preferences-legacy-tab-2019",
      requestedPanelId: null,
      evaluatedPanelId: null,
    }),
  },
};

/** A real panel, but not one this host builds. Distinct from a denial. */
export const Unavailable: Story = {
  args: {
    host: SettingsPanelHost.Web,
    resolution: resolution(SettingsPanelResolutionStatus.Unavailable, {
      requestedPanel: SettingsPanelId.DesktopApp,
      requestedPanelId: SettingsPanelId.DesktopApp,
      evaluatedPanelId: SettingsPanelId.DesktopApp,
    }),
  },
};

/** An authoritative no. The remedy is a person, so the copy names one. */
export const Forbidden: Story = {};

/**
 * The permission check itself failed. Tone must not read as a refusal, and the
 * action is a real retry of the read rather than a recovery link.
 */
export const CapabilityError: Story = {
  args: {
    onRetryCapabilities: fn(),
    resolution: resolution(SettingsPanelResolutionStatus.CapabilityError),
  },
};

/**
 * The same failure with no retry available — the surface that mounted Settings
 * supplied no refetch. The screen degrades to the recovery link rather than
 * offering a button that would do nothing.
 */
export const CapabilityErrorWithoutRetry: Story = {
  args: {
    resolution: resolution(SettingsPanelResolutionStatus.CapabilityError),
  },
};

/**
 * Nothing this actor can open, so there is no recovery target to offer. The
 * screen must still say what happened rather than collapsing to a bare frame.
 */
export const ForbiddenWithNoRecovery: Story = {
  args: {
    recovery: null,
    resolution: resolution(SettingsPanelResolutionStatus.Forbidden, {
      fallbackPanelId: null,
    }),
  },
};

/**
 * The narrow column. Settings' panel area collapses to a single column below
 * `md`, and these titles are the longest strings the component composes.
 */
export const NarrowColumn: Story = {
  args: {
    resolution: resolution(SettingsPanelResolutionStatus.Unavailable, {
      requestedPanel: SettingsPanelId.DesktopApp,
      requestedPanelId: SettingsPanelId.DesktopApp,
      evaluatedPanelId: SettingsPanelId.DesktopApp,
    }),
  },
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
