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

/**
 * A modal that walks through installing a pack from the command line: it
 * shows the exact command to run, lets you pick a project first if the pack
 * is project scoped, and prints the command's output as it runs. Depending
 * on the pack, the primary button either runs the command directly or copies
 * it to your clipboard for you to run yourself. Use it when installing a
 * pack means actually executing a command rather than a simple in app
 * action, such as when a project needs to be chosen first. Once the command
 * finishes, the dialog can show follow up instructions and a second command
 * to copy, if the pack needs another step after install.
 */
const meta = {
  title: "Composites/Packs/Pack Install Dialog",
  component: PackInstallDialogCanvas,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof PackInstallDialogCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
