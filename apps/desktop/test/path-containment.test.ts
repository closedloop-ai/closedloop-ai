import assert from "node:assert/strict";
import path from "node:path";
import { test } from "vitest";
import { isUnderDir } from "../src/server/path-containment.js";

const ROOT = path.resolve(path.sep, "srv", "sandbox");

test("isUnderDir: the directory itself and its descendants are contained", () => {
  assert.equal(isUnderDir(ROOT, ROOT), true);
  assert.equal(isUnderDir(path.join(ROOT, "a.txt"), ROOT), true);
  assert.equal(isUnderDir(path.join(ROOT, "a", "b", "c.txt"), ROOT), true);
  assert.equal(
    isUnderDir(path.join(ROOT, "a.txt"), `${ROOT}${path.sep}`),
    true
  );
});

test("isUnderDir: a sibling sharing the directory name as a prefix is NOT contained", () => {
  assert.equal(isUnderDir(`${ROOT}-evil`, ROOT), false);
  assert.equal(isUnderDir(path.join(`${ROOT}-evil`, "a.txt"), ROOT), false);
});

test("isUnderDir: the parent and an unrelated absolute path are NOT contained", () => {
  assert.equal(isUnderDir(path.dirname(ROOT), ROOT), false);
  assert.equal(
    isUnderDir(path.resolve(ROOT, "..", "outside", "x"), ROOT),
    false
  );
  assert.equal(isUnderDir(path.resolve(path.sep, "etc", "hosts"), ROOT), false);
});
