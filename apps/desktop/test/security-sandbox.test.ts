import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  assertPathAllowed,
  DirectoryNotAllowedError,
  isPathAllowed,
} from "../src/server/security.js";
import {
  buildAllowedDirectories,
  normalizeScopePath,
} from "../src/shared/sandbox-policy.js";

const tempDirs: string[] = [];

async function makeTempDir(suffix: string): Promise<string> {
  const dir = await fsp.mkdtemp(
    path.join(os.tmpdir(), `sandbox-test-${suffix}-`)
  );
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// --- Basic allow/deny ---

describe("isPathAllowed basics", () => {
  test("allows exact match of allowed directory", async () => {
    const dir = await makeTempDir("exact");
    assert.equal(isPathAllowed(dir, [dir]), true);
  });

  test("allows child path inside allowed directory", async () => {
    const dir = await makeTempDir("child");
    const child = path.join(dir, "subdir", "file.txt");
    assert.equal(isPathAllowed(child, [dir]), true);
  });

  test("rejects path outside allowed directory", async () => {
    const allowed = await makeTempDir("allowed");
    const outside = await makeTempDir("outside");
    assert.equal(isPathAllowed(outside, [allowed]), false);
  });

  test("rejects all paths when allowedDirectories is empty", async () => {
    const dir = await makeTempDir("empty-list");
    assert.equal(isPathAllowed(dir, []), false);
  });
});

// --- Path traversal attacks ---

describe("path traversal", () => {
  test("rejects ../ escape from allowed directory", async () => {
    const dir = await makeTempDir("traversal");
    const attack = path.join(dir, "..", "etc", "passwd");
    assert.equal(isPathAllowed(attack, [dir]), false);
  });

  test("rejects ../../ multi-level escape", async () => {
    const dir = await makeTempDir("multi-traversal");
    const child = path.join(dir, "a", "b");
    await fsp.mkdir(child, { recursive: true });
    const attack = path.join(child, "..", "..", "..", "etc", "passwd");
    assert.equal(isPathAllowed(attack, [dir]), false);
  });

  test("rejects traversal that lands in sibling directory", async () => {
    const parent = await makeTempDir("sibling-parent");
    const allowed = path.join(parent, "allowed");
    const sibling = path.join(parent, "sibling");
    await fsp.mkdir(allowed, { recursive: true });
    await fsp.mkdir(sibling, { recursive: true });
    const attack = path.join(allowed, "..", "sibling", "secret.txt");
    assert.equal(isPathAllowed(attack, [allowed]), false);
  });

  test("rejects prefix-collision attack (allowed-evil vs allowed)", async () => {
    const parent = await makeTempDir("prefix");
    const allowed = path.join(parent, "safe");
    const evil = path.join(parent, "safe-evil");
    await fsp.mkdir(allowed, { recursive: true });
    await fsp.mkdir(evil, { recursive: true });
    assert.equal(isPathAllowed(evil, [allowed]), false);
    assert.equal(isPathAllowed(path.join(evil, "payload"), [allowed]), false);
  });
});

// --- Symlink attacks ---

describe("symlink traversal", () => {
  test("rejects symlink pointing outside sandbox", async () => {
    const sandbox = await makeTempDir("sym-sandbox");
    const outside = await makeTempDir("sym-outside");
    const link = path.join(sandbox, "escape-link");
    fs.symlinkSync(outside, link);
    assert.equal(isPathAllowed(link, [sandbox]), false);
  });

  test("rejects symlink to sensitive path", async () => {
    const sandbox = await makeTempDir("sym-sensitive");
    const link = path.join(sandbox, "etc-link");
    fs.symlinkSync("/etc", link);
    assert.equal(isPathAllowed(link, [sandbox]), false);
  });

  test("allows symlink that stays inside sandbox", async () => {
    const sandbox = await makeTempDir("sym-internal");
    const realDir = path.join(sandbox, "real");
    await fsp.mkdir(realDir);
    const link = path.join(sandbox, "internal-link");
    fs.symlinkSync(realDir, link);
    assert.equal(isPathAllowed(link, [sandbox]), true);
  });
});

// --- Sensitive deny list ---

describe("sensitive path deny list", () => {
  test("blocks ~/.ssh even if parent is allowed", () => {
    const sshPath = path.join(os.homedir(), ".ssh");
    assert.equal(isPathAllowed(sshPath, [os.homedir()]), false);
  });

  test("blocks ~/.ssh/id_rsa (child of sensitive path)", () => {
    const keyPath = path.join(os.homedir(), ".ssh", "id_rsa");
    assert.equal(isPathAllowed(keyPath, [os.homedir()]), false);
  });

  test("blocks ~/.gnupg", () => {
    const gnupg = path.join(os.homedir(), ".gnupg");
    assert.equal(isPathAllowed(gnupg, [os.homedir()]), false);
  });

  test("blocks ~/.aws", () => {
    const aws = path.join(os.homedir(), ".aws");
    assert.equal(isPathAllowed(aws, [os.homedir()]), false);
  });

  test("blocks ~/.aws/credentials (child)", () => {
    const creds = path.join(os.homedir(), ".aws", "credentials");
    assert.equal(isPathAllowed(creds, [os.homedir()]), false);
  });

  test("blocks /etc", () => {
    assert.equal(isPathAllowed("/etc", ["/"]), false);
  });

  test("blocks /etc/passwd (child of /etc)", () => {
    assert.equal(isPathAllowed("/etc/passwd", ["/"]), false);
  });

  test("blocks /bin", () => {
    assert.equal(isPathAllowed("/bin", ["/"]), false);
  });

  test("blocks /sbin", () => {
    assert.equal(isPathAllowed("/sbin", ["/"]), false);
  });
});

// --- assertPathAllowed ---

describe("assertPathAllowed", () => {
  test("throws DirectoryNotAllowedError for blocked path", async () => {
    const allowed = await makeTempDir("assert-ok");
    const outside = await makeTempDir("assert-blocked");
    assert.throws(
      () => assertPathAllowed(outside, [allowed]),
      (err: unknown) => {
        assert.ok(err instanceof DirectoryNotAllowedError);
        assert.equal(err.targetPath, outside);
        return true;
      }
    );
  });

  test("does not throw for allowed path", async () => {
    const dir = await makeTempDir("assert-pass");
    assert.doesNotThrow(() => assertPathAllowed(dir, [dir]));
  });
});

// --- Home path expansion ---

describe("tilde expansion in paths", () => {
  test("~ resolves to homedir and is checked against sandbox", async () => {
    const sandbox = await makeTempDir("tilde");
    assert.equal(isPathAllowed("~", [sandbox]), false);
    assert.equal(isPathAllowed("~", [os.homedir()]), true);
  });

  test("~/subdir resolves correctly", async () => {
    const sandbox = os.homedir();
    assert.equal(isPathAllowed("~/Documents", [sandbox]), true);
  });
});

// --- buildAllowedDirectories ---

describe("buildAllowedDirectories", () => {
  test("returns single-entry array for valid sandbox", () => {
    const result = buildAllowedDirectories("/tmp/sandbox");
    assert.equal(result.length, 1);
    assert.equal(result[0], "/tmp/sandbox");
  });

  test("returns empty array for null", () => {
    assert.deepEqual(buildAllowedDirectories(null), []);
  });

  test("returns empty array for undefined", () => {
    assert.deepEqual(buildAllowedDirectories(undefined), []);
  });

  test("returns empty array for empty string", () => {
    assert.deepEqual(buildAllowedDirectories(""), []);
  });

  test("returns empty array for whitespace-only string", () => {
    assert.deepEqual(buildAllowedDirectories("   "), []);
  });

  test("expands ~ in sandbox path", () => {
    const result = buildAllowedDirectories("~/projects");
    assert.equal(result.length, 1);
    assert.equal(result[0], path.join(os.homedir(), "projects"));
  });
});

// --- normalizeScopePath ---

describe("normalizeScopePath", () => {
  test("trims whitespace", () => {
    assert.equal(normalizeScopePath("  /tmp/test  "), "/tmp/test");
  });

  test("returns null for falsy inputs", () => {
    assert.equal(normalizeScopePath(null), null);
    assert.equal(normalizeScopePath(undefined), null);
    assert.equal(normalizeScopePath(""), null);
  });

  test("expands tilde", () => {
    assert.equal(normalizeScopePath("~/foo"), path.join(os.homedir(), "foo"));
  });
});

// --- Edge cases ---

describe("edge cases", () => {
  test("empty string target path is rejected when no sandbox set", () => {
    assert.equal(isPathAllowed("", []), false);
  });

  test("root path / requires explicit allowlisting", async () => {
    const sandbox = await makeTempDir("root");
    assert.equal(isPathAllowed("/", [sandbox]), false);
  });

  test("non-existent child of allowed dir is still allowed", async () => {
    const sandbox = await makeTempDir("nonexist");
    const ghost = path.join(sandbox, "does", "not", "exist", "yet.txt");
    assert.equal(isPathAllowed(ghost, [sandbox]), true);
  });

  test("case-sensitive: .SSH is not blocked if filesystem is case-sensitive", () => {
    const upperSSH = path.join(os.homedir(), ".SSH");
    const result = isPathAllowed(upperSSH, [os.homedir()]);
    // The implementation uses .toLowerCase() so .SSH should still be blocked
    assert.equal(result, false);
  });
});
