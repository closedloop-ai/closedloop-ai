/**
 * @file statusline-capture-install-core.ts
 * @description Electron-free core of the statusline-capture install/compose UX
 * (FEA-3492 / PRD-539). Owns the pure `statusLine` settings-object transforms so
 * they can be exercised under `tsx --test` without an Electron runtime — path
 * resolution, `app.getPath()`, `electron-store`, the userData script copy, and
 * the config-file write live in the outer `statusline-capture-install.ts` shell.
 *
 * Compose contract: setting our `statusLine` behind an explicit opt-in must
 * NEVER clobber a pre-existing user statusLine — the prior entry is preserved
 * (wrapped) so the shell can re-invoke it, and opt-out restores the prior config
 * exactly.
 */

/** A Claude Code `statusLine` settings entry (`{ type, command, ... }`). */
export type StatusLineEntry = {
  type?: string;
  command?: string;
  [key: string]: unknown;
};

/** Filename token identifying an entry this installer owns. */
export const STATUSLINE_SCRIPT_FILENAME = "statusline-capture.js";

/**
 * True when `entry`'s command references our capture script — a filename-boundary
 * check so only our own entries match (mirrors agent-monitor's `isClaudeEntry`).
 */
export function isOurStatusLineEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const command = (entry as StatusLineEntry).command;
  if (typeof command !== "string") {
    return false;
  }
  const f = STATUSLINE_SCRIPT_FILENAME;
  return (
    command.includes(`/${f}"`) ||
    command.includes(`/${f} `) ||
    command.endsWith(`/${f}`) ||
    command.includes(`\\${f}"`) ||
    command.includes(`\\${f} `) ||
    command.endsWith(`\\${f}`)
  );
}

/** Extract the shell command string of a statusLine entry, or null. */
export function statusLineCommandOf(entry: unknown): string | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const command = (entry as StatusLineEntry).command;
  return typeof command === "string" && command.length > 0 ? command : null;
}

/** The canonical entry this installer writes. */
export function buildOurStatusLineEntry(ourCommand: string): StatusLineEntry {
  return { type: "command", command: ourCommand };
}

export type PlanInstallInput = {
  /** The current Claude settings object (parsed from settings.json). */
  settings: Record<string, unknown>;
  /** The previously-persisted prior statusLine (from the store), if any. */
  storedBackup: StatusLineEntry | null;
  /** The baked shell command that invokes our capture script. */
  ourCommand: string;
};

export type PlanInstallResult = {
  /** The settings object to write back (with `statusLine` set to ours). */
  nextSettings: Record<string, unknown>;
  /** The prior statusLine the shell should persist as the restore backup. */
  backupToStore: StatusLineEntry | null;
  /** The user's prior command to compose (re-invoke), or null for none. */
  wrappedCommand: string | null;
};

/**
 * Plan an idempotent opt-in install. When our entry is already present this is a
 * repair: the stored backup is preserved and the wrapped command is taken from
 * it (never from our own entry, which would recurse). Otherwise the current
 * statusLine (possibly absent) becomes the backup + wrapped command — so while
 * opted in, a statusLine the user sets out-of-band is adopted as the new wrapped
 * command and restore point (self-heal semantics, matching the agent-monitor
 * hook installer), not clobbered outright.
 */
export function planInstall(input: PlanInstallInput): PlanInstallResult {
  const current = input.settings.statusLine;
  const alreadyOurs = isOurStatusLineEntry(current);

  const backupToStore = alreadyOurs
    ? input.storedBackup
    : ((current as StatusLineEntry | undefined) ?? null);
  const wrappedCommand = statusLineCommandOf(backupToStore);

  return {
    nextSettings: {
      ...input.settings,
      statusLine: buildOurStatusLineEntry(input.ourCommand),
    },
    backupToStore,
    wrappedCommand,
  };
}

export type PlanUninstallInput = {
  settings: Record<string, unknown>;
  /** The prior statusLine to restore exactly, or null if there was none. */
  storedBackup: StatusLineEntry | null;
};

export type PlanUninstallResult = {
  nextSettings: Record<string, unknown>;
  /** True when our entry was found and removed/restored. */
  removed: boolean;
};

/**
 * Plan opt-out/removal. Only touches `statusLine` when the current entry is
 * ours (a user who replaced it after install keeps their choice), restoring the
 * backup exactly or deleting the key when there was no prior config.
 */
export function planUninstall(input: PlanUninstallInput): PlanUninstallResult {
  const current = input.settings.statusLine;
  if (!isOurStatusLineEntry(current)) {
    return { nextSettings: input.settings, removed: false };
  }

  if (input.storedBackup === null) {
    // Restore "no statusLine" by omitting the key entirely (not writing an
    // `undefined` value, which would linger in the object).
    const { statusLine: _removed, ...rest } = input.settings;
    return { nextSettings: rest, removed: true };
  }
  return {
    nextSettings: { ...input.settings, statusLine: input.storedBackup },
    removed: true,
  };
}
