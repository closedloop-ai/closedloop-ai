import { DATA_SYNC_LEVELS } from "@repo/api/src/types/data-sync-level";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import { DeviceDataPolicy } from "./device-data-policy";
import {
  DEVICE_DATA_POLICY_PLACEHOLDER_COPY as COPY,
  FIXTURE_DEVICES,
  FIXTURE_LEVEL_ONLY_POLICY,
  FIXTURE_ORG_NAME,
  FIXTURE_REPORTED_POLICY,
} from "./device-data-policy-fixtures";

/**
 * ISS-12531 (PRD-806): a desktop device's data policy as web shows it,
 * read-only. Design-only: no API reports another device's policy to web yet,
 * so no production host renders it.
 *
 * The new labels are placeholders named after their copy slot (operator
 * ruling, Nerys, 2026-10-15, thread th_Dc0RuSiAdyCvLQpC_X2G4). "Current level"
 * and the level names are ISS-12523's shipped copy. Devices, organization and
 * directories are fictional.
 */
const meta = {
  title: "Composites/Shared/Data Sync/Device Data Policy",
  tags: ["experimental"],
  component: DeviceDataPolicy,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
  args: {
    copy: COPY,
    machineName: FIXTURE_DEVICES[0].machineName,
    orgName: FIXTURE_ORG_NAME,
    policy: FIXTURE_REPORTED_POLICY,
  },
  argTypes: {
    policy: {
      control: "object",
      description:
        "The policy the device reported, or null when it reported none.",
    },
    machineName: { control: "text" },
    orgName: { control: "text" },
    copy: {
      control: "object",
      description: "Every new string, supplied by the host.",
    },
  },
} satisfies Meta<typeof DeviceDataPolicy>;

export default meta;

type Story = StoryObj<typeof meta>;

const DARK = { globals: { theme: "dark" } } as const;

/** No edit control of any kind: web shows the policy, never changes it. */
async function expectNoEditControl(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  for (const role of ["button", "combobox", "radio", "checkbox", "textbox"]) {
    await expect(canvas.queryAllByRole(role)).toHaveLength(0);
  }
}

/** A device that reported its level, directory count and directory list. */
export const Reported: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(COPY.reported)).toBeVisible();
    await expect(canvas.getByText("Current level")).toBeVisible();
    await expect(
      canvas.getByText(COPY.directoryScope).parentElement
    ).toHaveTextContent("2");
    await expect(canvas.getByText(FIXTURE_ORG_NAME)).toBeVisible();
    await expectNoEditControl(canvasElement);
    // A click on an included row leaves it included.
    const code = canvas.getAllByRole("treeitem", { name: "~/code" })[0];
    await userEvent.click(code);
    await expect(code).toHaveAttribute("aria-checked", "true");
    await expect(code).toHaveAttribute("data-readonly");
  },
};

export const ReportedDark: Story = { ...Reported, ...DARK };

/** The level alone: no directory count or list was reported. */
export const LevelOnly: Story = {
  args: { policy: FIXTURE_LEVEL_ONLY_POLICY },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Current level")).toBeVisible();
    await expect(
      canvas.queryByText(COPY.directoryScope)
    ).not.toBeInTheDocument();
    await expect(canvas.queryByRole("tree")).not.toBeInTheDocument();
  },
};

/** AC-002: the device has reported no policy. */
export const Unreported: Story = {
  args: { policy: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(COPY.unreported)).toBeVisible();
    await expect(
      canvas.getByText(FIXTURE_DEVICES[0].machineName)
    ).toBeVisible();
    await expect(canvas.queryByText("Current level")).not.toBeInTheDocument();
    await expectNoEditControl(canvasElement);
  },
};

export const UnreportedDark: Story = { ...Unreported, ...DARK };

/** Every level a device can report, one under the other. */
export const AllLevels: Story = {
  render: (args) => (
    <div className="flex flex-col gap-6">
      {DATA_SYNC_LEVELS.map((level) => (
        <DeviceDataPolicy
          {...args}
          key={level}
          policy={{ ...FIXTURE_LEVEL_ONLY_POLICY, level }}
        />
      ))}
    </div>
  ),
};

/** Several devices as a Connected Devices list would show them. */
export const SeveralDevices: Story = {
  render: (args) => (
    <ul className="flex flex-col gap-2">
      {FIXTURE_DEVICES.map((device) => (
        <li className="rounded-lg border p-3" key={device.id}>
          <DeviceDataPolicy
            {...args}
            machineName={device.machineName}
            policy={device.policy}
          />
        </li>
      ))}
    </ul>
  ),
};
