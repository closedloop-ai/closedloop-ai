import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
  isTccProtectedPath,
  TCC_PROTECTED_HOME_SUBDIRS,
} from "../src/shared/sandbox-policy.js";

// ISS-11914: the subtree guard session discovery and attribution consult before
// reading a file or spawning `git` under a transcript's recorded cwd.

const home = os.homedir();

const PROTECTED_ROOTS = [
  ...TCC_PROTECTED_HOME_SUBDIRS.map((name) => path.join(home, name)),
  path.join(home, "Library", "Mobile Documents"),
  path.join(home, "Library", "CloudStorage"),
  path.join(home, "Library", "Containers"),
  path.join(home, "Library", "Group Containers"),
  path.join(home, "Library", "Application Support", "AddressBook"),
  path.join(home, "Library", "Calendars"),
  path.join(home, "Library", "Group Containers", "group.com.apple.reminders"),
  "/Volumes",
];

describe("isTccProtectedPath", () => {
  test("flags each protected location and every path under it", () => {
    for (const root of PROTECTED_ROOTS) {
      assert.equal(isTccProtectedPath(root), true, root);
      assert.equal(isTccProtectedPath(path.join(root, "proj")), true, root);
      assert.equal(
        isTccProtectedPath(path.join(root, "a", "b", ".git", "config")),
        true,
        root
      );
    }
  });

  test("names the ruling's concrete examples", () => {
    for (const target of [
      path.join(home, "Documents", "proj"),
      path.join(home, "Desktop", "scratch"),
      path.join(home, "Downloads", "repo"),
      path.join(
        home,
        "Library",
        "Mobile Documents",
        "com~apple~CloudDocs",
        "x"
      ),
      path.join(home, "Library", "CloudStorage", "Dropbox", "work", "app"),
      path.join(home, "Library", "Containers", "com.example.app", "Data"),
      path.join(home, "Library", "Group Containers", "group.example", "x"),
      "/Volumes/External/code/app",
    ]) {
      assert.equal(isTccProtectedPath(target), true, target);
    }
  });

  test("compares case-insensitively", () => {
    assert.equal(
      isTccProtectedPath(path.join(home, "documents", "proj")),
      true
    );
    assert.equal(
      isTccProtectedPath(path.join(home, "LIBRARY", "cloudstorage", "Dropbox")),
      true
    );
    assert.equal(isTccProtectedPath("/volumes/External/app"), true);
  });

  test("expands a home-relative path", () => {
    assert.equal(isTccProtectedPath("~/Documents/proj"), true);
    assert.equal(isTccProtectedPath("~/code/proj"), false);
  });

  test("flags a .photoslibrary bundle and its contents anywhere", () => {
    assert.equal(isTccProtectedPath("/srv/x/My.photoslibrary"), true);
    assert.equal(
      isTccProtectedPath("/srv/x/My.PhotosLibrary/originals/a.heic"),
      true
    );
  });

  test("does not flag neighbours that only share a prefix or a name", () => {
    for (const target of [
      path.join(home, "DocumentsX"),
      path.join(home, "Documents-backup", "proj"),
      path.join(home, "code", "Documents"),
      path.join(home, "code", "Library", "CloudStorage", "x"),
      path.join(home, "Library", "CloudStorageX"),
      path.join(home, "Library", "Application Support", "Code"),
      path.join(home, "Library", "Application Support", "AddressBookX"),
      path.join(home, "Library", "CalendarsX"),
      path.join(home, ".claude", "projects"),
      path.join(home, "code", "app"),
      "/VolumesX/app",
      "/private/tmp/Volumes/app",
    ]) {
      assert.equal(isTccProtectedPath(target), false, target);
    }
  });

  test("does not flag the home directory or its Library folder itself", () => {
    assert.equal(isTccProtectedPath(home), false);
    assert.equal(isTccProtectedPath(path.join(home, "Library")), false);
  });

  test("handles null/undefined/blank", () => {
    assert.equal(isTccProtectedPath(null), false);
    assert.equal(isTccProtectedPath(undefined), false);
    assert.equal(isTccProtectedPath(""), false);
  });
});

describe("isTccProtectedPath follows symlinks", () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "iss11914-links-"))
    );
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    fs.mkdirSync(path.join(fakeHome, "Documents", "proj", "src"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(fakeHome, "code", "real"), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  test("flags a path that reaches a protected folder through a symlink", () => {
    const link = path.join(fakeHome, "code", "link");
    fs.symlinkSync(path.join(fakeHome, "Documents", "proj"), link);
    const chained = path.join(fakeHome, "code", "chained");
    fs.symlinkSync(link, chained);

    assert.equal(isTccProtectedPath(link), true);
    assert.equal(isTccProtectedPath(path.join(link, "src")), true);
    assert.equal(isTccProtectedPath(path.join(chained, "src", "x")), true);
  });

  test("follows a relative symlink and a symlinked parent", () => {
    const parentLink = path.join(fakeHome, "work");
    fs.symlinkSync("Documents", parentLink);

    assert.equal(isTccProtectedPath(path.join(parentLink, "proj")), true);
  });

  test("does not flag a symlink to an unprotected folder", () => {
    const link = path.join(fakeHome, "code", "link");
    fs.symlinkSync(path.join(fakeHome, "code", "real"), link);

    assert.equal(isTccProtectedPath(path.join(link, "src")), false);
  });

  test("ends on a dangling symlink or a loop", () => {
    const dangling = path.join(fakeHome, "code", "dangling");
    fs.symlinkSync(path.join(fakeHome, "code", "missing"), dangling);
    const loopA = path.join(fakeHome, "code", "a");
    const loopB = path.join(fakeHome, "code", "b");
    fs.symlinkSync(loopB, loopA);
    fs.symlinkSync(loopA, loopB);

    assert.equal(isTccProtectedPath(path.join(dangling, "x")), false);
    assert.equal(isTccProtectedPath(path.join(loopA, "x")), false);
  });

  test("resolves with lstat and readlink only, and touches nothing inside the protected folder", () => {
    const link = path.join(fakeHome, "code", "link");
    fs.symlinkSync(path.join(fakeHome, "Documents", "proj"), link);
    const lstat = vi.spyOn(fs, "lstatSync");
    const readlink = vi.spyOn(fs, "readlinkSync");
    const stat = vi.spyOn(fs, "statSync");
    const readdir = vi.spyOn(fs, "readdirSync");
    const readFile = vi.spyOn(fs, "readFileSync");

    assert.equal(isTccProtectedPath(path.join(link, "src")), true);

    const documents = path.join(fakeHome, "Documents");
    const touched = [...lstat.mock.calls, ...readlink.mock.calls].map(
      ([target]) => String(target)
    );
    assert.ok(touched.length > 0);
    assert.deepEqual(
      touched.filter(
        (target) =>
          target === documents || target.startsWith(`${documents}${path.sep}`)
      ),
      []
    );
    assert.deepEqual(
      readlink.mock.calls.map(([target]) => String(target)),
      [link]
    );
    assert.equal(stat.mock.calls.length, 0);
    assert.equal(readdir.mock.calls.length, 0);
    assert.equal(readFile.mock.calls.length, 0);
  });
});
