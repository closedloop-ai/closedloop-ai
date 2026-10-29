/**
 * A temp repoRoot shaped enough for `applyDevUpdate`: the desktop manifest it
 * reads the built entry from, and a fake `pnpm` on PATH standing in for the
 * desktop build.
 *
 * {@link DESKTOP_ENTRY_MAIN} is transcribed from `apps/desktop/package.json` by
 * hand on purpose. A fixture that derived it from the same manifest the code
 * under test reads would agree with that code however it resolved the entry,
 * and could not fail.
 */
import fs from "node:fs/promises";
import path from "node:path";

export const DESKTOP_ENTRY_MAIN = "dist/main/index.js";

/**
 * Writes the desktop manifest under `repoRoot` and returns the absolute entry
 * path its `main` names.
 */
export async function writeDesktopManifest(
  repoRoot: string,
  main: string = DESKTOP_ENTRY_MAIN
): Promise<string> {
  const desktopDir = path.join(repoRoot, "apps", "desktop");
  await fs.mkdir(desktopDir, { recursive: true });
  await fs.writeFile(
    path.join(desktopDir, "package.json"),
    `${JSON.stringify({ name: "desktop", main }, null, 2)}\n`
  );
  return path.join(desktopDir, main);
}

export type FakePnpmOptions = {
  /** The entry the fake build writes; omit for a build that writes nothing. */
  entry?: string;
  /** Exit nonzero with this on stderr, standing in for a failed build step. */
  failWith?: string;
};

/**
 * Installs a fake `pnpm` first on PATH that appends its argv to the returned log
 * file, one `$*` line per invocation.
 */
export async function installFakePnpm(
  repoRoot: string,
  { entry, failWith }: FakePnpmOptions = {}
): Promise<string> {
  const binDir = path.join(repoRoot, "pnpm-bin");
  await fs.mkdir(binDir, { recursive: true });
  const logFile = path.join(repoRoot, "pnpm-argv.log");
  const writeEntry = entry
    ? `mkdir -p ${quote(path.dirname(entry))} && : > ${quote(entry)}\n`
    : "";
  const fail = failWith
    ? `printf '%s\\n' ${quote(failWith)} 1>&2\nexit 1\n`
    : "exit 0\n";
  await fs.writeFile(
    path.join(binDir, "pnpm"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(logFile)}\n${writeEntry}${fail}`,
    { mode: 0o755 }
  );
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  return logFile;
}

/** The `$*` lines the fake binary recorded, or `[]` when it never ran. */
export async function loggedCommands(logFile: string): Promise<string[]> {
  const contents = await fs.readFile(logFile, "utf8").catch(() => "");
  return contents.split("\n").filter((line) => line.length > 0);
}

function quote(value: string): string {
  return JSON.stringify(value);
}
