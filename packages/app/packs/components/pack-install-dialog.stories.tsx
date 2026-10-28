import { packInstallRun, packs } from "@repo/app/agents/lib/session-mock-data";
import type { PackInstallRun } from "@repo/app/agents/lib/session-types";
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { PackInstallDialog } from "./pack-install-dialog";

/**
 * The first thing a user actually sees: the command is built, but nothing has
 * run yet. No exit code, no output lines, no post-install follow-up — those
 * only exist once `run.state` moves past `preview`.
 */
const previewInstallRun: PackInstallRun = {
  action: "install",
  harness: "claude",
  command: "./setup --host claude",
  commandIsAutoDetect: false,
  projectScoped: true,
  state: "preview",
  projectOptions: [
    "/workspace/closedloop-ai",
    "/workspace/closedloop-electron",
  ],
};

function PackInstallDialogCanvas({
  initialRun = packInstallRun,
}: {
  initialRun?: PackInstallRun;
}) {
  const [run, setRun] = useState<PackInstallRun>(initialRun);

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
  title: "Composites v1.0/Packs/Pack Install Dialog",
  component: PackInstallDialogCanvas,
  tags: ["deprecated", "autodocs"],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof PackInstallDialogCanvas>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/**
 * `run.state === "preview"`, before the user has run or copied anything: a
 * command to review and, since this pack is project-scoped, a project still to
 * pick. No run output and no post-install follow-up yet.
 */
export const Preview: Story = {
  args: { initialRun: previewInstallRun },
};
