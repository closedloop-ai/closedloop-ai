import {
  SettingsDomainId,
  SettingsDomainStatus,
} from "@repo/api/src/types/settings-domain";
import { SettingsPanelIntent } from "@repo/api/src/types/settings-panel";
import type { Meta, StoryObj } from "@storybook/react";
import { organizationKeys } from "../../../organizations/hooks/use-organizations";
import { userKeys } from "../../../users/hooks/use-users";
import { settingsViewModelKeys } from "../hooks/use-settings-view-model";
import { organizationGeneralPanel } from "../panels/organization-general/organization-general-panel";

/**
 * ISS-8365. The panel body as the shell mounts it, over the REAL hooks — the
 * story only seeds the query cache the harness already provides, so what renders
 * is the shipped derivation rather than a hand-authored picture of it.
 *
 * Lives in `components/` because Storybook's globs reach two directory levels
 * under `packages/app` and no deeper (`apps/storybook/.storybook/main.ts`), so a
 * story co-located beside the panel would never be collected at all.
 */
const ORGANIZATION_ID = "org_01HQ8Z";

const ORGANIZATION = {
  active: true,
  clerkId: "org_clerk_01HQ8Z",
  createdAt: new Date("2026-01-14T09:00:00.000Z"),
  id: ORGANIZATION_ID,
  name: "Northwind Labs",
  settings: {},
  slug: "northwind-labs",
  updatedAt: new Date("2026-08-30T17:20:00.000Z"),
};

const CURRENT_USER = {
  email: "ada@northwind.example",
  id: "user_01HQ8Z",
  organizationId: ORGANIZATION_ID,
};

function viewModel(grants: {
  admin: boolean;
  edit: boolean;
  owner: boolean;
  read: boolean;
}) {
  return {
    domains: {
      [SettingsDomainId.Organization]: {
        grants,
        status: SettingsDomainStatus.Ready,
      },
    },
    status: "ready",
  };
}

function seededCache(grants: Parameters<typeof viewModel>[0]) {
  return [
    [userKeys.currentUser(), CURRENT_USER],
    [organizationKeys.detail(ORGANIZATION_ID), ORGANIZATION],
    [settingsViewModelKeys.viewModel(), viewModel(grants)],
  ] as const;
}

const ADMIN = { admin: true, edit: true, owner: false, read: true };
const MEMBER = { admin: false, edit: true, owner: false, read: true };

const { Panel } = organizationGeneralPanel;

const meta: Meta<typeof Panel> = {
  args: { intent: SettingsPanelIntent.View },
  component: Panel,
  tags: ["deprecated", "autodocs"],
  parameters: {
    appCore: {
      queryData: seededCache(ADMIN),
    },
    layout: "padded",
  },
  title: "Composites v1.0/Settings/Organization General Panel",
};

export default meta;

type Story = StoryObj<typeof Panel>;

/** An org admin: both identity fields are editable. */
export const AdminReady: Story = {};

/**
 * A member. The name stays editable — `SETTINGS_DOMAIN_ACCESS_POLICY` grants
 * every role `edit` on the Organization domain — while the URL, whose write is
 * admin-gated at the route, is read-only rather than a button that 403s.
 */
export const MemberCannotEditUrl: Story = {
  parameters: {
    appCore: {
      queryData: seededCache(MEMBER),
    },
  },
};

/**
 * The capability read failed. Distinct from a denial on purpose: the panel says
 * it could not find out, instead of showing a confident read-only form.
 */
export const CapabilityReadFailed: Story = {
  parameters: {
    appCore: {
      queryData: [
        [userKeys.currentUser(), CURRENT_USER],
        [organizationKeys.detail(ORGANIZATION_ID), ORGANIZATION],
        [
          settingsViewModelKeys.viewModel(),
          {
            domains: {
              [SettingsDomainId.Organization]: {
                grants: {
                  admin: false,
                  edit: false,
                  owner: false,
                  read: false,
                },
                reason: "upstream_unavailable",
                status: SettingsDomainStatus.Error,
              },
            },
            status: "partial",
          },
        ],
      ],
    },
  },
};
