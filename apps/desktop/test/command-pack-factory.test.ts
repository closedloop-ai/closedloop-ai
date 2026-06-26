import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import { LoopHarness } from "@closedloop-ai/loops-api/desktop-request";
import {
  ClosedloopCommandPackId,
  CommandPackAdapterStatus,
  CommandPackLaunchMode,
  createClosedloopWebCommandPackFactory,
} from "../src/server/operations/command-pack-factory.js";

const MANIFEST_URL = new URL(
  "../resources/command-packs/closedloop-web-command-pack/manifest.json",
  import.meta.url
);
const PLAN_CURSOR_UNSUPPORTED_REASON_REGEX =
  /PLAN does not support harness 'cursor'/;

describe("Closedloop Web Command Pack factory", () => {
  test("preserves Claude as the Desktop default when no harness is requested", () => {
    const selection = createClosedloopWebCommandPackFactory().selectRuntime(
      LoopCommand.EvaluatePrd
    );

    assert.equal(selection.ok, true);
    if (!selection.ok) {
      return;
    }
    assert.equal(selection.pack.id, ClosedloopCommandPackId.Web);
    assert.equal(selection.harness.adapter.harness, LoopHarness.Claude);
    assert.equal(
      selection.harness.launchMode,
      CommandPackLaunchMode.NativePrompt
    );
    assert.equal(selection.command.webPreferredHarness, LoopHarness.Codex);
  });

  test("selects Codex native-prompt when the web command requests Codex", () => {
    const selection = createClosedloopWebCommandPackFactory().selectRuntime(
      LoopCommand.GeneratePrd,
      LoopHarness.Codex
    );

    assert.equal(selection.ok, true);
    if (!selection.ok) {
      return;
    }
    assert.equal(selection.harness.adapter.binaryName, "codex");
    assert.equal(
      selection.harness.launchMode,
      CommandPackLaunchMode.NativePrompt
    );
    assert.deepEqual(selection.command.requiredOutputs, ["prd.md"]);
  });

  test("supports native prompts for loop commands without plugins", () => {
    const commands = [
      LoopCommand.Plan,
      LoopCommand.Execute,
      LoopCommand.RequestChanges,
    ] as const;

    for (const command of commands) {
      for (const requestedHarness of [LoopHarness.Claude, LoopHarness.Codex]) {
        const selection = createClosedloopWebCommandPackFactory().selectRuntime(
          command,
          requestedHarness
        );

        assert.equal(selection.ok, true);
        if (!selection.ok) {
          continue;
        }
        assert.equal(selection.harness.adapter.harness, requestedHarness);
        assert.equal(
          selection.harness.launchMode,
          CommandPackLaunchMode.NativePrompt
        );
      }
    }
  });

  test("rejects unsupported harness and command combinations before spawn", () => {
    const selection = createClosedloopWebCommandPackFactory().selectRuntime(
      LoopCommand.Plan,
      LoopHarness.Cursor
    );

    assert.equal(selection.ok, false);
    if (selection.ok) {
      return;
    }
    assert.match(selection.reason, PLAN_CURSOR_UNSUPPORTED_REASON_REGEX);
  });

  test("declares planned adapters for future harness launchers", () => {
    const pack = createClosedloopWebCommandPackFactory().create();
    const adapters = new Map(
      pack.adapters.map((adapter) => [adapter.harness, adapter])
    );

    assert.equal(
      adapters.get(LoopHarness.Cursor)?.status,
      CommandPackAdapterStatus.Planned
    );
    assert.equal(
      adapters.get(LoopHarness.OpenCode)?.status,
      CommandPackAdapterStatus.Planned
    );
  });

  test("bundled manifest stays aligned with factory command coverage", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_URL, "utf-8")) as {
      id: string;
      commands: Array<{
        command: LoopCommand;
        harnesses: Partial<Record<LoopHarness, { launch_mode: string }>>;
      }>;
    };
    const factoryCommands = createClosedloopWebCommandPackFactory()
      .create()
      .commands.map((entry) => entry.command)
      .sort();
    const manifestCommands = manifest.commands
      .map((entry) => entry.command)
      .sort();

    assert.equal(manifest.id, ClosedloopCommandPackId.Web);
    assert.deepEqual(manifestCommands, factoryCommands);

    const nativeLoopCommands = [
      LoopCommand.Plan,
      LoopCommand.Execute,
      LoopCommand.RequestChanges,
    ];
    for (const command of nativeLoopCommands) {
      const manifestCommand = manifest.commands.find(
        (entry) => entry.command === command
      );
      assert.equal(
        manifestCommand?.harnesses[LoopHarness.Claude]?.launch_mode,
        CommandPackLaunchMode.NativePrompt
      );
      assert.equal(
        manifestCommand?.harnesses[LoopHarness.Codex]?.launch_mode,
        CommandPackLaunchMode.NativePrompt
      );
    }
  });
});
