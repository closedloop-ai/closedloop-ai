import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import type { ConvertInstallOutcome } from "@repo/api/src/types/convert-install";
import { ConvertInstallState } from "@repo/api/src/types/convert-install";
import { ConversionSupport } from "@repo/api/src/types/harness-conversion";
import { HarnessName } from "@repo/crewd/model";
import type { Meta, StoryObj } from "@storybook/react";
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

const meta = {
  title: "App Core/Packs/Convert Install Sheet",
  component: ConvertInstallSheet,
  parameters: {
    layout: "fullscreen",
  },
  args: {
    harnessLabel,
    onConvertInstall: resolveInstalled,
    onOpenChange: () => undefined,
    target: cleanTarget,
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
