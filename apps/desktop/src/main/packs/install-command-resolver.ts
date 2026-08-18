/**
 * @file install-command-resolver.ts
 * @description Command SELECTION for catalog installs/uninstalls: turning a
 * catalog entry plus a requested harness into the concrete shell text a run
 * should execute, and saying why it cannot when it cannot.
 *
 * Covers the `single_install` superset path and (ISS-5027) the `HARNESS_AUTO`
 * sentinel for every other pack class. Split out of `install-orchestrator.ts`
 * (ISS-5138) — resolution is a pure, separately testable decision, while the
 * orchestrator owns spawning, auditing, and streaming.
 */

import type { CatalogEntry } from "../../shared/agent-db-contract.js";
import { StreamRunErrorCode } from "../../shared/install-run-contract.js";
import {
  defaultResolvedChildEnv,
  isHarnessInstalled,
} from "./install-child-env.js";

export type InstallAction = "install" | "uninstall";

/**
 * A `single_install` pick. `command` is what gets spawned — for a multi-harness
 * uninstall that is the joined aggregate — while `commands` stays the
 * INDIVIDUAL steps, because the project-scoped `copy_command` hand-off gives
 * them to the user to paste and the `if ! ( … ); then …` wrapper is not a
 * runnable paste.
 */
export type PickedInstallCommand = {
  command: string | null;
  commands: string[];
  registerHarnesses: string[];
};

/**
 * Outcome of resolving the `HARNESS_AUTO` sentinel to real command text.
 * A discriminated union so a caller cannot read `command` without first having
 * handled the unavailable case.
 */
export type AutoCommandResolution =
  | {
      /** The script to spawn: one command, or the joined multi-step form. */
      command: string;
      /**
       * The individual resolved commands, deduped, BEFORE joining. The
       * project-scoped `copy_command` guard surfaces these to the user to run
       * by hand — handing over the `if ! ( … ); then …` aggregate instead would
       * be an unusable paste.
       */
      commands: string[];
      registerHarnesses: string[];
      unavailable?: undefined;
    }
  | {
      command: null;
      commands?: undefined;
      registerHarnesses: string[];
      unavailable: { code: StreamRunErrorCode; message: string };
    };

/**
 * Join independent commands so each runs regardless of whether prior ones
 * fail, but the aggregate exit code reflects any failure.
 *
 * Used for multi-harness runs: an `auto` uninstall across every listed harness,
 * and (ISS-5027) an `auto` install of a non-`single_install` pack whose
 * harnesses need genuinely different commands, so a pack lands in BOTH
 * `~/.claude` and the Codex location rather than only whichever harness
 * happened to be picked.
 *
 * NEWLINE-separated, not `; `-separated. Each command is arbitrary vetted
 * catalog text, and a `#` comment anywhere in a `; `-joined single line
 * swallows the rest of the script — including the `); then …` that closes its
 * own `if`, which is a shell syntax error that runs NOTHING at all.
 *
 * Composition contract for a joined command: it must not background its own
 * work. `cmd &` returns 0 immediately, so a step that fails asynchronously is
 * reported as success. No seeded catalog command does this today.
 */
export function joinIndependentCommands(commands: string[]): string {
  const failureVar = "__closedloop_step_failed";
  return [
    `${failureVar}=0`,
    ...commands.map(
      (command) => `if ! (\n${command}\n); then ${failureVar}=1; fi`
    ),
    `exit $${failureVar}`,
  ].join("\n");
}

/**
 * For `single_install` packs (gstack), pick the command to run for install
 * or uninstall.
 *
 * INSTALL — pick the SUPERSET command. By convention the codex install
 * command is a superset of the claude install command. Running it once
 * installs for all detected CLIs.
 *
 * UNINSTALL — run all uninstall commands independently but aggregate
 * failures. Runs for ALL listed harnesses (not just CLIs on PATH) because
 * on-disk artifacts may outlive the CLI install.
 *
 * See {@link PickedInstallCommand} for what `command` vs `commands` mean.
 */
export function pickSingleInstallCommand(
  entry: CatalogEntry,
  action: InstallAction,
  childEnv: Record<string, string | undefined> = defaultResolvedChildEnv()
): PickedInstallCommand {
  const cmdMap =
    action === "uninstall" ? entry.uninstallCommands : entry.installCommands;
  const harnesses = Array.isArray(entry.harnesses) ? entry.harnesses : [];

  if (action === "uninstall") {
    return pickSingleInstallUninstall(harnesses, cmdMap);
  }

  // Install path — only consider harnesses whose CLI is actually present.
  const installed = harnesses.filter((h) => isHarnessInstalled(h, childEnv));
  if (installed.length === 0) {
    return noPickedCommand();
  }
  // Prefer codex command when codex is present (superset convention), then
  // fall back to any command for any installed harness.
  //
  // `isNonEmptyString`, not `Boolean` (ISS-5248). `stringRecordOrNull` now
  // builds `cmdMap` null-prototype, so in production an inherited key cannot
  // resolve here at all — this is the instance-level backstop for that class
  // fix, not the thing standing between us and the bug. It earns its keep
  // because this function is EXPORTED and callable with a hand-built entry
  // (the ISS-5248 tests do exactly that), so its correctness must not depend
  // on the caller having gone through the ingest boundary. Kept identical to
  // the filter `resolveAutoCommand` applies below — every command gate in this
  // module must agree on what counts as a configured command.
  for (const h of [...CODEX_FIRST, ...installed]) {
    const command = installed.includes(h) ? cmdMap?.[h] : undefined;
    if (isNonEmptyString(command)) {
      return { command, commands: [command], registerHarnesses: installed };
    }
  }
  return noPickedCommand();
}

/**
 * ISS-5027: resolve `HARNESS_AUTO` to concrete command text for ANY pack.
 *
 * This is the single resolution path for the sentinel. Before this, only
 * `single_install` packs interpreted it and everything else fell through to a
 * command-map lookup keyed by `"auto"` — a key that by construction never
 * exists — so the distribution installer and the renderer's Install action
 * could not start a non-`single_install` pack at all.
 *
 * - `single_install` packs keep their existing superset semantics via
 *   {@link pickSingleInstallCommand} (one command covers every installed CLI).
 * - Everything else installs onto EVERY listed harness whose CLI is actually on
 *   PATH. Commands are deduped by TEXT first — most catalog entries repeat one
 *   command across harnesses — and only genuinely different ones are joined with
 *   {@link joinIndependentCommands} so a partial failure is still reported. That
 *   is what puts a pack in both `~/.claude` and the Codex location for a user
 *   who has both CLIs, instead of one arbitrary harness.
 * - Uninstall runs for every listed harness that has a command, whether or not
 *   its CLI is still on PATH, because on-disk artifacts outlive a CLI removal.
 *
 * Never throws: an unresolvable pack comes back as `unavailable` with a
 * user-actionable message and the same closed error-code vocabulary
 * `streamRun` already emits, so the failure is legible rather than silent.
 */
export function resolveAutoCommand(
  entry: CatalogEntry,
  packId: string,
  action: InstallAction,
  childEnv: Record<string, string | undefined> = defaultResolvedChildEnv()
): AutoCommandResolution {
  if (entry.singleInstall) {
    const picked = pickSingleInstallCommand(entry, action, childEnv);
    if (picked.command) {
      return {
        command: picked.command,
        // The individual steps, NOT `[picked.command]`: a multi-harness
        // `single_install` uninstall already joined them, and re-wrapping the
        // aggregate here is exactly the unhandleable paste `commands` exists to
        // avoid.
        commands: picked.commands,
        registerHarnesses: picked.registerHarnesses,
      };
    }
    return unavailableResolution(singleInstallUnavailable(packId, action));
  }

  const cmdMap =
    action === "uninstall" ? entry.uninstallCommands : entry.installCommands;
  const listed = listedHarnesses(entry, cmdMap);
  // `isNonEmptyString`, not `Boolean`: a harness named for an inherited key
  // ("constructor", "toString") would resolve to a truthy FUNCTION here and
  // then be dropped later, leaving an empty command set that composes into a
  // script exiting 0 — a "successful" install that installed nothing. Since
  // ISS-5248 `cmdMap` is built null-prototype at ingest, so this is a backstop
  // for direct callers rather than the production defense. Both filters must
  // agree.
  const withCommand = listed.filter((h) => isNonEmptyString(cmdMap?.[h]));

  if (withCommand.length === 0) {
    return unavailableResolution({
      code: StreamRunErrorCode.NoCommand,
      message: `pack '${packId}' has no ${action} command for any of its listed harnesses${formatHarnessList(listed)}.`,
    });
  }

  // Uninstall covers every listed harness — on-disk artifacts can outlive the
  // CLI, so a missing CLI must not leave the pack's files behind.
  const targets =
    action === "uninstall"
      ? withCommand
      : withCommand.filter((h) => isHarnessInstalled(h, childEnv));

  if (targets.length === 0) {
    return unavailableResolution({
      code: StreamRunErrorCode.NoCli,
      message:
        `pack '${packId}' supports${formatHarnessList(withCommand)} but none of those CLIs are on PATH. ` +
        "Install one of them first, then try again.",
    });
  }

  // Dedupe by COMMAND TEXT, not by harness. Most multi-harness catalog entries
  // carry byte-identical commands per harness (`rtk` installs via one `brew`
  // line for both; `bmad-method` runs one `npx` scaffolder), and running an
  // install twice is at best wasteful and at worst fatal — a `git clone` into a
  // path the first pass created fails, flipping a working install to `failed`.
  // Only genuinely different per-harness commands (claude's `~/.claude/...` vs
  // codex's `~/.codex/...`) should compose into a multi-step run.
  const commands = [
    ...new Set(targets.map((h) => cmdMap?.[h]).filter(isNonEmptyString)),
  ];
  if (commands.length === 0) {
    // Unreachable while `withCommand` and this filter agree, but a script that
    // silently exits 0 would be reported to the user AND the cloud as a
    // successful install of nothing, so fail loudly rather than coerce.
    return unavailableResolution({
      code: StreamRunErrorCode.NoCommand,
      message: `pack '${packId}' resolved no usable ${action} command text${formatHarnessList(targets)}.`,
    });
  }
  return {
    command:
      commands.length === 1 ? commands[0] : joinIndependentCommands(commands),
    commands,
    registerHarnesses: targets,
  };
}

/** Superset convention: prefer codex's command, then claude's. */
const CODEX_FIRST = ["codex", "claude"];

/** A fresh "nothing to run" pick — never a shared object callers could alias. */
function noPickedCommand(): PickedInstallCommand {
  return { command: null, commands: [], registerHarnesses: [] };
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * The harnesses an entry claims. Falls back to the command map's own keys when
 * `harnesses` is empty, so a catalog row that carries commands but an empty
 * harness list still resolves instead of reporting "no command".
 */
function listedHarnesses(
  entry: CatalogEntry,
  cmdMap: Record<string, string> | null
): string[] {
  if (Array.isArray(entry.harnesses) && entry.harnesses.length > 0) {
    return entry.harnesses;
  }
  return Object.keys(cmdMap ?? {});
}

function formatHarnessList(harnesses: string[]): string {
  return harnesses.length > 0 ? ` (${harnesses.join(", ")})` : "";
}

/** The pre-existing `single_install` wording, kept verbatim for that path. */
function singleInstallUnavailable(
  packId: string,
  action: InstallAction
): { code: StreamRunErrorCode; message: string } {
  if (action === "uninstall") {
    return {
      code: StreamRunErrorCode.NoCommand,
      message: `pack '${packId}' is single_install but no uninstall commands are configured for any listed harness.`,
    };
  }
  return {
    code: StreamRunErrorCode.NoCli,
    message:
      `pack '${packId}' is single_install but no supported CLI is on PATH. ` +
      "Install Claude Code or Codex first, then try again.",
  };
}

function unavailableResolution(unavailable: {
  code: StreamRunErrorCode;
  message: string;
}): AutoCommandResolution {
  return { command: null, registerHarnesses: [], unavailable };
}

/**
 * Run ALL listed harnesses' uninstall commands independently, deduped by TEXT
 * as the non-`single_install` path does: a command repeated verbatim across
 * harnesses must be shown (and run) once, not once each.
 *
 * `isNonEmptyString`, not `Boolean(c)` (ISS-5248): this path does NOT gate on
 * `isHarnessInstalled` first — on-disk artifacts outlive the CLI — so a harness
 * named for an inherited key reaches the lookup directly. On a plain-object map
 * `Boolean` accepted the inherited `Object.prototype` function and the
 * `c is string` predicate then asserted it was command text, putting a FUNCTION
 * in `command`. `stringRecordOrNull` now builds that map null-prototype, so this
 * guard is the backstop for callers that hand-build an entry rather than the
 * production defense.
 */
function pickSingleInstallUninstall(
  harnesses: string[],
  cmdMap: Record<string, string> | null
): PickedInstallCommand {
  const cmds = harnesses.map((h) => cmdMap?.[h]).filter(isNonEmptyString);
  if (cmds.length === 0) {
    return noPickedCommand();
  }
  const unique = [...new Set(cmds)];
  return {
    command: unique.length === 1 ? unique[0] : joinIndependentCommands(unique),
    commands: unique,
    registerHarnesses: harnesses,
  };
}
