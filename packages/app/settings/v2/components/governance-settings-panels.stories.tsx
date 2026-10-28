import {
  SettingsActorRole,
  SettingsActorRoleStatus,
} from "@repo/api/src/types/settings-actor-role";
import { projectSettingsViewModel } from "@repo/api/src/types/settings-view-model";
import type { Meta, StoryObj } from "@storybook/react";
import { agentComponentComplianceKeys } from "../../../agents/hooks/use-agent-component-compliance";
import { customFieldKeys } from "../../../custom-fields/hooks/use-custom-fields";
import { tagKeys } from "../../../tags/hooks/use-tags";
import { userKeys } from "../../../users/hooks/use-users";
import { settingsViewModelKeys } from "../hooks/use-settings-view-model";
import { CompliancePanel } from "../panels/compliance/compliance-panel";
import { CustomFieldsPanel } from "../panels/custom-fields/custom-fields-panel";
import { TagsPanel } from "../panels/tags/tags-panel";
import {
  buildComplianceGapFixture,
  buildCustomFieldFixture,
  buildTagFixture,
} from "../test-fixtures/governance-panel-fixtures";

/**
 * ISS-8367. The three governance panel bodies as the shell mounts them, over
 * the REAL hooks — each story only seeds the query cache the harness already
 * provides, so what renders is the shipped derivation rather than a
 * hand-authored picture of it.
 *
 * Lives in `components/` because Storybook's globs reach two directory levels
 * under `packages/app` and no deeper (`apps/storybook/.storybook/main.ts`), so
 * a story co-located beside a panel would never be collected at all.
 */
// `createdById: null` on purpose: a resolved author renders a `UserLink`, which
// needs a navigation provider these panel stories do not mount.
const FIELD = buildCustomFieldFixture({ createdById: null });
const TAG = buildTagFixture();
const COMPLIANCE_GAP = buildComplianceGapFixture();

function viewModelFor(role: SettingsActorRole) {
  return projectSettingsViewModel({
    resolution: { role, status: SettingsActorRoleStatus.Resolved },
    staleSessionRole: false,
  });
}

function cacheFor(role: SettingsActorRole) {
  return [
    [settingsViewModelKeys.viewModel(), viewModelFor(role)],
    [customFieldKeys.list({}), [FIELD]],
    [userKeys.organizationUsers(), []],
    [tagKeys.list({}), [TAG]],
    [
      agentComponentComplianceKeys.list(),
      { items: [COMPLIANCE_GAP], total: 1 },
    ],
  ] as const;
}

const meta: Meta<typeof CustomFieldsPanel> = {
  component: CustomFieldsPanel,
  tags: ["deprecated", "autodocs"],
  parameters: {
    appCore: { queryData: cacheFor(SettingsActorRole.Admin) },
    layout: "padded",
  },
  title: "Composites v1.0/Settings/Governance Settings Panels",
};

export default meta;

type Story = StoryObj<typeof CustomFieldsPanel>;

/** An org admin: the fields are listed and every write control is offered. */
export const CustomFieldsAdmin: Story = {};

/**
 * A member. The list stays — `GET /custom-fields` is open to any member, and
 * `SETTINGS_DOMAIN_ACCESS_POLICY` says so — while the create and row-action
 * controls, whose routes call `isOrgAdmin`, are not offered at all rather than
 * offered and answered 403.
 */
export const CustomFieldsMember: Story = {
  parameters: {
    appCore: { queryData: cacheFor(SettingsActorRole.Member) },
  },
};

/** Tags: every role may create, rename, recolor and delete. */
export const Tags: Story = {
  render: () => <TagsPanel />,
};

/**
 * Compliance for an admin. Read-only by policy (`edit` is empty for every
 * role), so the panel offers no control at all.
 */
export const ComplianceAdmin: Story = {
  render: () => <CompliancePanel />,
};

/**
 * A gap-free organization. Distinct from a failed read on purpose: this one
 * states that everything is installed and in use, which is a measurement.
 */
export const ComplianceNoGaps: Story = {
  parameters: {
    appCore: {
      queryData: [
        [
          settingsViewModelKeys.viewModel(),
          viewModelFor(SettingsActorRole.Admin),
        ],
        [agentComponentComplianceKeys.list(), { items: [], total: 0 }],
      ],
    },
  },
  render: () => <CompliancePanel />,
};
