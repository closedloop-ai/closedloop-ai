#!/usr/bin/env node
/**
 * Measure Agent Dashboard SQLite storage without creating missing DB files.
 *
 * The first-party Agent Dashboard DB lives at
 * `<userData>/agent-dashboard.pgdata`. Missing directories are reported as
 * absent and are never opened.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";

const APP_NAME = "Closedloop";

const userDataPath = parseUserDataArg(process.argv) ?? defaultUserDataPath();
const target = {
  mode: "sqlite",
  path: path.join(userDataPath, "agent-dashboard.pgdata"),
};

console.log(
  JSON.stringify(
    { userDataPath, measurements: [measureExistingDirectory(target)] },
    null,
    2
  )
);

function parseUserDataArg(argv) {
  const index = argv.indexOf("--user-data");
  if (index < 0) {
    return null;
  }
  const value = argv[index + 1];
  if (!value) {
    throw new Error("--user-data requires a path value");
  }
  return path.resolve(value);
}

function defaultUserDataPath() {
  switch (platform()) {
    case "darwin":
      return path.join(homedir(), "Library", "Application Support", APP_NAME);
    case "win32":
      return path.join(
        process.env.APPDATA || path.join(homedir(), "AppData", "Roaming"),
        APP_NAME
      );
    default:
      return path.join(homedir(), ".config", APP_NAME);
  }
}

function measureExistingDirectory(target) {
  if (!existsSync(target.path)) {
    return {
      mode: target.mode,
      path: target.path,
      exists: false,
      bytes: 0,
      files: 0,
      directories: 0,
    };
  }

  const measured = measurePath(target.path);
  return {
    mode: target.mode,
    path: target.path,
    exists: true,
    ...measured,
  };
}

function measurePath(targetPath) {
  const stat = statSync(targetPath);
  if (!stat.isDirectory()) {
    return { bytes: stat.size, files: 1, directories: 0 };
  }

  let bytes = 0;
  let files = 0;
  let directories = 1;
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    const child = path.join(targetPath, entry.name);
    const measured = measurePath(child);
    bytes += measured.bytes;
    files += measured.files;
    directories += measured.directories;
  }
  return { bytes, files, directories };
}
