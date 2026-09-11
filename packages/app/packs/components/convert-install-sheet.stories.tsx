import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import type { ConvertInstallOutcome } from "@repo/api/src/types/convert-install";
import { ConvertInstallState } from "@repo/api/src/types/convert-install";
import { ConversionSupport } from "@repo/api/src/types/harness-conversion";
import { HarnessName } from "@repo/crewd/model";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import {
  ConvertInstallSheet,
  type ConvertInstallTarget,
} from "./convert-install-sheet";

const HARNESS_LABEL: Record<HarnessName, string> = {
  [HarnessName.Claude]: "Claude",
  [HarnessName.Codex]: "Codex",
  [HarnessName.Opencode]: "OpenCode",
};
const harnessLabel = (harness: HarnessName): string => HARNESS_LABEL[harness];

const cleanTarget: ConvertInstallTarget = {
  packId: "pack-clean",
  name: "Docs helper",
  kind: AgentComponentKind.Skill,
  currentHarness: HarnessName.Codex,
  targetHarness: HarnessName.Claude,
  sourceHarness: HarnessName.Codex,
};

const partialTarget: ConvertInstallTarget = {
  packId: "pack-partial",
  name: "Reviewer agent",
  kind: AgentComponentKind.Subagent,
  currentHarness: HarnessName.Claude,
  targetHarness: HarnessName.Codex,
  sourceHarness: HarnessName.Claude,
};

const unsupportedTarget: ConvertInstallTarget = {
  packId: "pack-unsupported",
  name: "Pre-commit hook",
  kind: AgentComponentKind.Hook,
  currentHarness: HarnessName.Claude,
  targetHarness: HarnessName.Codex,
  sourceHarness: HarnessName.Claude,
};

const installedOutcome: ConvertInstallOutcome = {
  state: ConvertInstallState.Installed,
  identity: {
    id: "id",
    name: "Docs helper",
    kind: AgentComponentKind.Skill,
    sourceHarness: HarnessName.Codex,
    currentHarness: HarnessName.Codex,
    targetHarness: HarnessName.Claude,
  },
  capability: { support: ConversionSupport.Supported, droppedFields: [] },
  droppedFields: [],
};

const resolveInstalled = (): Promise<ConvertInstallOutcome> =>
  Promise.resolve(installedOutcome);

/**
 * A side panel that walks you through installing one skill, agent, or hook
 * onto a different AI harness, such as moving a Codex skill so it works in
 * Claude, converting its format along the way. It shows where the component
 * came from and whether the conversion is clean, will drop some fields, or
 * can't happen at all, and it will not let you confirm until you have seen
 * which one applies. Reach for it whenever an item needs a format conversion
 * before it can install, since a plain install action would either fail
 * outright or silently drop information. While the conversion and install is
 * running, the sheet locks its own close button and the Escape key, so you
 * can't dismiss it mid run and lose track of whether it finished.
 */
const meta = {
  title: "Composites/Packs/Convert Install Sheet",
  component: ConvertInstallSheet,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  args: {
    harnessLabel,
    onConvertInstall: fn(resolveInstalled),
    onOpenChange: fn(),
    target: cleanTarget,
    targetOffline: false,
  },
  argTypes: {
    // A resolver the surface injects, not a value to edit.
    harnessLabel: { control: false },
    onConvertInstall: { control: false, table: { category: "Events" } },
    onOpenChange: { control: false, table: { category: "Events" } },
    target: { control: "object" },
    targetOffline: { control: "boolean" },
  },
} satisfies Meta<typeof ConvertInstallSheet>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Clean: Story = {};

export const Partial: Story = {
  args: { target: partialTarget },
};

export const Unsupported: Story = {
  args: { target: unsupportedTarget },
};

export const OfflineTarget: Story = {
  args: { target: cleanTarget, targetOffline: true },
};
