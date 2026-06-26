import { LoopArtifactFile } from "@closedloop-ai/loops-api/artifacts";
import { ResultBundle } from "@closedloop-ai/loops-api/bundles";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { LoopHarness } from "@closedloop-ai/loops-api/desktop-request";
import type { BinaryName } from "../shell-path.js";

type CommandPackHarnessBinaryName = Extract<
  BinaryName,
  "claude" | "codex" | "cursor" | "opencode"
>;

export const ClosedloopCommandPackId = {
  Web: "closedloop-web-command-pack",
} as const;
export type ClosedloopCommandPackId =
  (typeof ClosedloopCommandPackId)[keyof typeof ClosedloopCommandPackId];

export const CommandPackLaunchMode = {
  NativePrompt: "native-prompt",
  PluginRunLoop: "plugin-run-loop",
  ClaudeSlashCommand: "claude-slash-command",
  BundledScript: "bundled-script",
} as const;
export type CommandPackLaunchMode =
  (typeof CommandPackLaunchMode)[keyof typeof CommandPackLaunchMode];

export const CommandPackAdapterStatus = {
  Supported: "supported",
  Planned: "planned",
} as const;
export type CommandPackAdapterStatus =
  (typeof CommandPackAdapterStatus)[keyof typeof CommandPackAdapterStatus];

export type CommandPackHarnessAdapter = {
  harness: LoopHarness;
  binaryName: CommandPackHarnessBinaryName;
  configDirName: string;
  status: CommandPackAdapterStatus;
  launchModes: readonly CommandPackLaunchMode[];
  notes?: string;
};

export type CommandPackCommandHarness = {
  adapter: CommandPackHarnessAdapter;
  launchMode: CommandPackLaunchMode;
};

export type CommandPackCommandSpec = {
  command: LoopCommand;
  desktopDefaultHarness: LoopHarness;
  webPreferredHarness: LoopHarness;
  harnesses: Partial<Record<LoopHarness, CommandPackCommandHarness>>;
  requiredOutputs: readonly string[];
  optionalOutputs: readonly string[];
};

export type CommandPack = {
  id: ClosedloopCommandPackId;
  displayName: string;
  version: number;
  adapters: readonly CommandPackHarnessAdapter[];
  commands: readonly CommandPackCommandSpec[];
};

export type RuntimeSelection =
  | {
      ok: true;
      pack: CommandPack;
      command: CommandPackCommandSpec;
      harness: CommandPackCommandHarness;
      requestedHarness: LoopHarness | undefined;
    }
  | {
      ok: false;
      pack: CommandPack;
      command: CommandPackCommandSpec | undefined;
      requestedHarness: LoopHarness | undefined;
      reason: string;
    };

const CLAUDE_ADAPTER: CommandPackHarnessAdapter = {
  harness: LoopHarness.Claude,
  binaryName: "claude",
  configDirName: ".claude",
  status: CommandPackAdapterStatus.Supported,
  launchModes: [
    CommandPackLaunchMode.NativePrompt,
    CommandPackLaunchMode.PluginRunLoop,
    CommandPackLaunchMode.ClaudeSlashCommand,
    CommandPackLaunchMode.BundledScript,
  ],
};

const CODEX_ADAPTER: CommandPackHarnessAdapter = {
  harness: LoopHarness.Codex,
  binaryName: "codex",
  configDirName: ".codex",
  status: CommandPackAdapterStatus.Supported,
  launchModes: [CommandPackLaunchMode.NativePrompt],
};

const CURSOR_ADAPTER: CommandPackHarnessAdapter = {
  harness: LoopHarness.Cursor,
  binaryName: "cursor",
  configDirName: ".cursor",
  status: CommandPackAdapterStatus.Planned,
  launchModes: [],
  notes:
    "Factory placeholder; add a launcher once Cursor exposes a stable noninteractive command API.",
};

const OPENCODE_ADAPTER: CommandPackHarnessAdapter = {
  harness: LoopHarness.OpenCode,
  binaryName: "opencode",
  configDirName: ".opencode",
  status: CommandPackAdapterStatus.Planned,
  launchModes: [],
  notes:
    "Factory placeholder; add a launcher once OpenCode command execution semantics are finalized.",
};

const SUPPORTED_ADAPTERS = [CLAUDE_ADAPTER, CODEX_ADAPTER] as const;
const ALL_ADAPTERS = [
  CLAUDE_ADAPTER,
  CODEX_ADAPTER,
  CURSOR_ADAPTER,
  OPENCODE_ADAPTER,
] as const;

const NATIVE_PROMPT_COMMANDS = [
  LoopCommand.Plan,
  LoopCommand.Execute,
  LoopCommand.RequestChanges,
  LoopCommand.Decompose,
  LoopCommand.EvaluatePrd,
  LoopCommand.EvaluatePlan,
  LoopCommand.EvaluateCode,
  LoopCommand.EvaluateFeature,
  LoopCommand.GeneratePrd,
  LoopCommand.RequestPrdChanges,
] as const;

const CLAUDE_PREFERRED_COMMANDS = new Set<LoopCommand>([
  LoopCommand.Plan,
  LoopCommand.Execute,
  LoopCommand.RequestChanges,
]);

function outputsFor(command: LoopCommand): {
  requiredOutputs: readonly string[];
  optionalOutputs: readonly string[];
} {
  const bundle = ResultBundle[command];
  return {
    requiredOutputs: bundle?.required ?? [],
    optionalOutputs: bundle?.optional ?? [],
  };
}

function harness(
  adapter: CommandPackHarnessAdapter,
  launchMode: CommandPackLaunchMode
): CommandPackCommandHarness {
  return { adapter, launchMode };
}

function commandSpec(
  command: LoopCommand,
  webPreferredHarness: LoopHarness,
  harnesses: Partial<Record<LoopHarness, CommandPackCommandHarness>>
): CommandPackCommandSpec {
  return {
    command,
    desktopDefaultHarness: LoopHarness.Claude,
    webPreferredHarness,
    harnesses,
    ...outputsFor(command),
  };
}

function buildClosedloopWebPack(): CommandPack {
  const nativePromptHarnesses = Object.fromEntries(
    SUPPORTED_ADAPTERS.map((adapter) => [
      adapter.harness,
      harness(adapter, CommandPackLaunchMode.NativePrompt),
    ])
  ) as Partial<Record<LoopHarness, CommandPackCommandHarness>>;

  return {
    id: ClosedloopCommandPackId.Web,
    displayName: "Closedloop Web Command Pack",
    version: 1,
    adapters: ALL_ADAPTERS,
    commands: [
      ...NATIVE_PROMPT_COMMANDS.map((command) =>
        commandSpec(
          command,
          CLAUDE_PREFERRED_COMMANDS.has(command)
            ? LoopHarness.Claude
            : LoopHarness.Codex,
          nativePromptHarnesses
        )
      ),
      commandSpec(LoopCommand.Bootstrap, LoopHarness.Claude, {
        [LoopHarness.Claude]: harness(
          CLAUDE_ADAPTER,
          CommandPackLaunchMode.BundledScript
        ),
      }),
    ],
  };
}

export class ClosedloopWebCommandPackFactory {
  create(): CommandPack {
    return buildClosedloopWebPack();
  }

  selectRuntime(
    command: LoopCommand,
    requestedHarness?: LoopHarness
  ): RuntimeSelection {
    const pack = this.create();
    const commandSpecForRequest = pack.commands.find(
      (entry) => entry.command === command
    );
    if (!commandSpecForRequest) {
      return {
        ok: false,
        pack,
        command: undefined,
        requestedHarness,
        reason: `${command} is not in ${pack.displayName}`,
      };
    }

    const harnessName =
      requestedHarness ?? commandSpecForRequest.desktopDefaultHarness;
    const selectedHarness = commandSpecForRequest.harnesses[harnessName];
    if (!selectedHarness) {
      const supported = Object.keys(commandSpecForRequest.harnesses).join(", ");
      return {
        ok: false,
        pack,
        command: commandSpecForRequest,
        requestedHarness,
        reason: `${command} does not support harness '${harnessName}' in ${pack.displayName}. Supported: ${supported}`,
      };
    }
    if (selectedHarness.adapter.status !== CommandPackAdapterStatus.Supported) {
      return {
        ok: false,
        pack,
        command: commandSpecForRequest,
        requestedHarness,
        reason: `${selectedHarness.adapter.harness} adapter is ${selectedHarness.adapter.status}`,
      };
    }

    return {
      ok: true,
      pack,
      command: commandSpecForRequest,
      harness: selectedHarness,
      requestedHarness,
    };
  }
}

export function createClosedloopWebCommandPackFactory(): ClosedloopWebCommandPackFactory {
  return new ClosedloopWebCommandPackFactory();
}

export function getCommandPackRequiredOutput(
  command: LoopCommand
): readonly string[] {
  return ResultBundle[command]?.required ?? [];
}

export function requiredOutputDescription(command: LoopCommand): string {
  const required = getCommandPackRequiredOutput(command);
  if (required.length === 0) {
    return "No required output artifact.";
  }
  return `Required output: ${required.join(", ")}.`;
}

export function outputInstructionForCommand(command: LoopCommand): string {
  switch (command) {
    case LoopCommand.Plan:
      return `Write the plan JSON to ${LoopArtifactFile.Plan}. Also write human-readable plan markdown to ${LoopArtifactFile.PlanMarkdown} when practical.`;
    case LoopCommand.Execute:
      return `Write execution metadata as JSON to ${LoopArtifactFile.ExecutionResult}.`;
    case LoopCommand.RequestChanges:
      return `Write the amended plan JSON to ${LoopArtifactFile.Plan}. Also write human-readable plan markdown to ${LoopArtifactFile.PlanMarkdown} when practical.`;
    case LoopCommand.Decompose:
      return `Write a JSON feature decomposition to ${LoopArtifactFile.Features}.`;
    case LoopCommand.EvaluatePrd:
      return `Write PRD judge results as JSON to ${LoopArtifactFile.PrdJudges}.`;
    case LoopCommand.EvaluatePlan:
      return `Write implementation-plan judge results as JSON to ${LoopArtifactFile.PlanJudges}.`;
    case LoopCommand.EvaluateCode:
      return `Write code judge results as JSON to ${LoopArtifactFile.CodeJudges}.`;
    case LoopCommand.EvaluateFeature:
      return `Write feature judge results as JSON to ${LoopArtifactFile.FeatureJudges}.`;
    case LoopCommand.GeneratePrd:
    case LoopCommand.RequestPrdChanges:
      return `Write the final PRD markdown to ${LoopArtifactFile.Prd}.`;
    default:
      return requiredOutputDescription(command);
  }
}
