import { packInstallRun, packs } from "@repo/app/agents/lib/session-mock-data";
import type { PackInstallRun } from "@repo/app/agents/lib/session-types";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { PackInstallDialog } from "./pack-install-dialog";

function PackInstallDialogCanvas() {
  const [run, setRun] = useState<PackInstallRun>(packInstallRun);

  return (
    <PackInstallDialog
      onClose={() => undefined}
      onCopyCommand={() => undefined}
      onOpenChange={() => undefined}
      onRunCommand={() =>
        setRun((current) => ({
          ...current,
          state: "running",
          lines: [...(current.lines ?? []), "Starting install command..."],
        }))
      }
      onSelectProject={(project) =>
        setRun((current) => ({
          ...current,
          selectedProject: project,
        }))
      }
      open
      pack={packs[0]}
      run={run}
    />
  );
}

const meta = {
  title: "App Core/Packs/Pack Install Dialog",
  component: PackInstallDialogCanvas,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof PackInstallDialogCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
