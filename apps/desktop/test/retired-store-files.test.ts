import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import {
  deleteRetiredHomeFiles,
  deleteRetiredStoreFiles,
  RETIRED_STORE_FILE_NAMES,
} from "../src/main/lifecycle/retired-store-files.js";
import { createTempDirManager } from "./helpers/temp-dir.js";
import {
  callSitesOf,
  callsInside,
  parseAppModule,
} from "./support/app-module-ast.js";

const { makeTempDir } = createTempDirManager("retired-store-files-");

function writeStore(dir: string, name: string): string {
  const filePath = path.join(dir, `${name}.json`);
  fs.writeFileSync(filePath, "{}");
  return filePath;
}

describe("deleteRetiredStoreFiles (ISS-12435)", () => {
  test("deletes both loop store files and leaves every other store in place", () => {
    const dir = makeTempDir();
    const retired = RETIRED_STORE_FILE_NAMES.map((name) =>
      writeStore(dir, name)
    );
    const kept = writeStore(dir, "desktop-sign-out-cleanup");
    const logs: string[] = [];

    deleteRetiredStoreFiles(dir, (message) => logs.push(message));

    for (const filePath of retired) {
      assert.equal(fs.existsSync(filePath), false, filePath);
    }
    assert.equal(fs.existsSync(kept), true);
    assert.deepEqual(logs, []);
  });

  test("an install that never had the files is a silent no-op", () => {
    const dir = makeTempDir();
    const logs: string[] = [];

    deleteRetiredStoreFiles(dir, (message) => logs.push(message));

    assert.deepEqual(fs.readdirSync(dir), []);
    assert.deepEqual(logs, []);
  });

  test("a failed delete is logged and the next file is still attempted", () => {
    const attempted: string[] = [];
    const logs: string[] = [];

    deleteRetiredStoreFiles(
      "/user-data",
      (message) => logs.push(message),
      (filePath) => {
        attempted.push(path.basename(filePath));
        if (attempted.length === 1) {
          throw new Error("EBUSY");
        }
      }
    );

    assert.deepEqual(
      attempted,
      RETIRED_STORE_FILE_NAMES.map((name) => `${name}.json`)
    );
    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? "", EBUSY_PATTERN);
  });
});

describe("deleteRetiredHomeFiles (ISS-12784)", () => {
  function writeHomeFile(home: string, name: string): string {
    const dir = path.join(home, ".closedloop");
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, "{}");
    return filePath;
  }

  test("deletes authorized_keys.json and keeps its sibling and the directory", () => {
    const home = makeTempDir();
    const retired = writeHomeFile(home, "authorized_keys.json");
    const sibling = writeHomeFile(home, "settings.json");
    const logs: string[] = [];

    deleteRetiredHomeFiles(home, (message) => logs.push(message));

    assert.equal(fs.existsSync(retired), false);
    assert.equal(fs.existsSync(sibling), true);
    assert.equal(fs.existsSync(path.join(home, ".closedloop")), true);
    assert.deepEqual(logs, []);
  });

  test("a home without the file is a silent no-op", () => {
    const home = makeTempDir();
    const logs: string[] = [];

    deleteRetiredHomeFiles(home, (message) => logs.push(message));

    assert.deepEqual(fs.readdirSync(home), []);
    assert.deepEqual(logs, []);
  });

  test("a failed delete is logged rather than thrown", () => {
    const logs: string[] = [];

    deleteRetiredHomeFiles(
      "/home-dir",
      (message) => logs.push(message),
      () => {
        throw new Error("EBUSY");
      }
    );

    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? "", EBUSY_PATTERN);
  });
});

describe("app boot wiring (ISS-12435)", () => {
  // app.ts statically imports electron, so the boot call is pinned on the AST
  // (support/app-module-ast.ts explains why).
  test("DesktopApplication.boot deletes the retired store files from userData", () => {
    const sourceFile = parseAppModule();

    assert.ok(callsInside("boot").includes("deleteRetiredStoreFiles"));
    const sites = callSitesOf("deleteRetiredStoreFiles", sourceFile);
    assert.equal(sites.length, 1);
    assert.equal(
      sites[0]?.arguments[0]?.getText(sourceFile),
      'app.getPath("userData")'
    );
  });

  test("DesktopApplication.boot deletes the retired home files from home (ISS-12784)", () => {
    const sourceFile = parseAppModule();

    assert.ok(callsInside("boot").includes("deleteRetiredHomeFiles"));
    const sites = callSitesOf("deleteRetiredHomeFiles", sourceFile);
    assert.equal(sites.length, 1);
    assert.equal(
      sites[0]?.arguments[0]?.getText(sourceFile),
      'app.getPath("home")'
    );
  });
});

const EBUSY_PATTERN = /EBUSY/;
