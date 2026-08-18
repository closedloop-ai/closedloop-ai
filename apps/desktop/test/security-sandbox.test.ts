import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  SANDBOX_REQUIRED_MESSAGE,
  SANDBOX_RISKY_ROOT_MESSAGE,
} from "../src/shared/sandbox-messages.js";
import {
  buildAllowedDirectories,
  isBroadScopeRoot,
  isRiskyAllowedDirectory,
  normalizeScopePath,
  validateSandboxBaseDirectory,
} from "../src/shared/sandbox-policy.js";

const tempDirs: string[] = [];

async function makeTempDir(suffix: string): Promise<string> {
  const dir = await fsp.mkdtemp(
    path.join(os.tmpdir(), `sandbox-test-${suffix}-`)
  );
  tempDirs.push(dir);
  return dir;
}

/**
 * ISS-4577: some persist-time assertions need a base dir whose canonical
 * realpath is a legitimate (non-risky) sandbox root. `os.tmpdir()` on macOS
 * realpaths under `/private/var/folders/...`, which `isRiskyAllowedDirectory`
 * (correctly) rejects as a system prefix — so a project under it can never be
 * persisted, masking the canonicalization behavior under test. A dot-dir
 * directly under the user's home realpaths to itself and is deep enough to clear
 * the `/Users/<name>` risky-root check.
 */
async function makeHomeTempDir(suffix: string): Promise<string> {
  const dir = await fsp.mkdtemp(
    path.join(os.homedir(), `.cl-sandbox-test-${suffix}-`)
  );
  tempDirs.push(dir);
  return dir;
}

/**
 * ISS-6128: a fixture whose LEXICAL path is not itself a risky root. Cases that
 * assert `canonicalizeScopePath`'s realpath work must not be satisfied by the
 * lexical path alone, or they stay green with that canonicalization removed:
 * `os.tmpdir()` on macOS is `/var/folders/...`, which `isRiskyAllowedDirectory`
 * rejects on the `/var` prefix, masking the behavior under test. `/tmp` is
 * outside every prefix that guard checks on both macOS and Linux, and — unlike
 * `makeHomeTempDir` — nothing it strands on an abrupt SIGTERM lands in the
 * operator's real home directory.
 */
async function makeNonSystemTempDir(suffix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join("/tmp", `sandbox-test-${suffix}-`));
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

// --- FEA-4005: symlinked scope root escaping to a risky root ---

describe("FEA-4005 symlinked sandbox scope root", () => {
  test("isRiskyAllowedDirectory flags a scope root symlinked to /", async () => {
    // A symlink whose lexical name is benign but that points at `/`. Without
    // canonicalization the lexical risky-root check passes and the enforcement
    // path then admits the whole filesystem.
    const dir = await makeTempDir("risky-symlink");
    const link = path.join(dir, "profile-scope");
    fs.symlinkSync("/", link);
    assert.equal(isRiskyAllowedDirectory(link), true);
  });

  test("isPathAllowed fails closed when the allowed root canonicalizes to /", async () => {
    const dir = await makeTempDir("scope-root-escape");
    const link = path.join(dir, "scope");
    fs.symlinkSync("/", link);
    // A file well outside the intended scope would be admitted if the symlinked
    // `/` root were honored; it must be rejected.
    assert.equal(isPathAllowed("/usr/local/share", [link]), false);
  });

  test("isPathAllowed still allows a symlinked root pointing at a safe project dir", async () => {
    const parent = await makeTempDir("safe-symlink-parent");
    const realProject = path.join(parent, "my-project");
    await fsp.mkdir(realProject, { recursive: true });
    const link = path.join(parent, "project-link");
    fs.symlinkSync(realProject, link);
    const child = path.join(realProject, "src", "index.ts");
    assert.equal(isPathAllowed(child, [link]), true);
  });
});

// --- ISS-4577: persist the canonical (real) sandbox dir, not the symlink ---

describe("ISS-4577 validateSandboxBaseDirectory canonicalizes at save", () => {
  test("persists the symlink target (real dir), not the lexical alias", async () => {
    // A benign-looking symlink pointing at a safe project. The authoritative
    // save must store the REAL directory so a later retarget of the link cannot
    // silently move the enforced sandbox.
    const parent = await makeHomeTempDir("iss4577-safe");
    const realProject = path.join(parent, "my-project");
    await fsp.mkdir(realProject, { recursive: true });
    const link = path.join(parent, "scope-link");
    fs.symlinkSync(realProject, link);

    const persisted = validateSandboxBaseDirectory(link);
    // The persisted value is the canonical target, not the mutable link path,
    // so retargeting `link` afterward cannot widen the saved scope.
    assert.equal(persisted, fs.realpathSync.native(realProject));
    assert.notEqual(persisted, link);
  });

  test("rejects a symlink that resolves to a risky root at save time", async () => {
    const dir = await makeTempDir("iss4577-risky");
    const link = path.join(dir, "scope-link");
    fs.symlinkSync("/", link);
    assert.throws(() => validateSandboxBaseDirectory(link));
  });

  test("survives a post-save retarget: the enforced scope stays the saved real dir", async () => {
    // Simulate the retarget attack: save while the link points at a safe
    // project, then repoint the link at the home directory. Because we persisted
    // the canonical real dir, enforcement never sees the widened target.
    const parent = await makeHomeTempDir("iss4577-retarget");
    const realProject = path.join(parent, "my-project");
    await fsp.mkdir(realProject, { recursive: true });
    const link = path.join(parent, "scope-link");
    fs.symlinkSync(realProject, link);

    const persisted = validateSandboxBaseDirectory(link);

    // Retarget the link at home (a broad, would-be-risky root).
    fs.unlinkSync(link);
    fs.symlinkSync(os.homedir(), link);

    // A home file is NOT admitted, because the saved scope is the pinned real
    // project dir — not whatever the link now points at.
    const homeFile = path.join(os.homedir(), "some-unrelated-file.txt");
    assert.equal(isPathAllowed(homeFile, [persisted]), false);
    // The intended project child is still allowed.
    const child = path.join(realProject, "src", "index.ts");
    assert.equal(isPathAllowed(child, [persisted]), true);
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
    // A non-protected subdir under home resolves and is allowed.
    assert.equal(isPathAllowed("~/Source", [sandbox]), true);
  });

  test("FEA-3641: ~/Documents (TCC-protected) is denied even under home sandbox", () => {
    // Previously this resolved to allowed; the protected-folder deny now blocks
    // it so browsing/searching never stats TCC-protected user folders.
    assert.equal(isPathAllowed("~/Documents", [os.homedir()]), false);
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

// --- isRiskyAllowedDirectory: blank input ---

describe("isRiskyAllowedDirectory blank input", () => {
  test("answers false for blank input instead of resolving it to cwd", () => {
    // `normalizeScopePath` refuses a blank value, so there is no canonical path
    // to judge and the answer is "not risky" — safe only because a blank sandbox
    // never becomes an allowed directory: `buildAllowedDirectories` returns []
    // (deny everything) and `validateSandboxBaseDirectory` throws
    // SANDBOX_REQUIRED_MESSAGE before this guard is consulted. Answering `true`
    // here would instead mislabel "no sandbox chosen yet" as "risky root".
    for (const blank of [null, undefined, "", "   "]) {
      assert.equal(
        isRiskyAllowedDirectory(blank),
        false,
        `blank input ${JSON.stringify(blank)} is absent, not risky`
      );
    }
  });
});

// --- FEA-4005: isBroadScopeRoot, the enforcement-time guard ---

describe("isBroadScopeRoot", () => {
  // Mirrors the module-private EXACT_SYSTEM_ROOTS in `sandbox-policy.ts` (not
  // exported, so it cannot be imported). Each entry must be rejected EXACTLY —
  // a deep child of one must not be, which the asymmetry test below pins.
  const exactSystemRoots = [
    "/etc",
    "/private",
    "/usr",
    "/bin",
    "/sbin",
    "/var",
    "/System",
  ];

  test("answers false for blank input", () => {
    // `security.ts#isPathAllowed` calls this on every allowed root it walks; a
    // blank root must fall through to the normal comparison (which will reject
    // it) rather than being skipped as "broad".
    for (const blank of [null, undefined, ""]) {
      assert.equal(isBroadScopeRoot(blank), false, JSON.stringify(blank));
    }
  });

  test("answers false when trailing-slash stripping leaves nothing", () => {
    // `//` is not the literal `/` fast path, so it goes through the strip and
    // normalizes to the empty string. An emptied path is not the filesystem
    // root and must not be treated as one.
    assert.equal(isBroadScopeRoot("//"), false);
    assert.equal(isBroadScopeRoot("///"), false);
  });

  test("rejects the filesystem root and each exact system root", () => {
    assert.equal(isBroadScopeRoot("/"), true);
    for (const root of exactSystemRoots) {
      assert.equal(isBroadScopeRoot(root), true, root);
      assert.equal(
        isBroadScopeRoot(`${root}/`),
        true,
        `${root} with a trailing slash is the same root`
      );
    }
  });

  test("is deliberately NARROWER than isRiskyAllowedDirectory", () => {
    // The asymmetry `validateSandboxBaseDirectory` and
    // `security.ts#isPathAllowed` both rely on. The persist-time policy rejects
    // anything UNDER a system prefix; the enforcement-time guard rejects only
    // the roots that admit a whole tree. A legitimate temp-based project
    // canonicalizes to `/private/var/folders/...` on macOS, so denying deep
    // children here would deny the project itself.
    const canonicalTempProject = "/private/var/folders/zz/T/my-project";
    assert.equal(
      isRiskyAllowedDirectory(canonicalTempProject),
      true,
      "persist-time policy rejects a system-prefixed scope root"
    );
    assert.equal(
      isBroadScopeRoot(canonicalTempProject),
      false,
      "enforcement must NOT deny a deep child of /private"
    );

    // Home and `/Users` are a persist-time policy call, not a catastrophic
    // enforcement root: an explicitly home-scoped allowlist stays enforceable.
    for (const homeScoped of [os.homedir(), "/Users", "/Users/someone"]) {
      assert.equal(
        isRiskyAllowedDirectory(homeScoped),
        true,
        `${homeScoped} is rejected at persist time`
      );
      assert.equal(
        isBroadScopeRoot(homeScoped),
        false,
        `${homeScoped} must not be denied at enforcement time`
      );
    }
  });
});

// --- validateSandboxBaseDirectory: the two rejections are distinguishable ---

describe("validateSandboxBaseDirectory rejection messages", () => {
  test("a blank path throws the REQUIRED message, never the risky-root one", () => {
    for (const blank of [null, undefined, "", "   "]) {
      assert.throws(
        () => validateSandboxBaseDirectory(blank),
        { message: SANDBOX_REQUIRED_MESSAGE },
        `blank input ${JSON.stringify(blank)} must report "required", not "risky"`
      );
    }
  });

  test("a risky root throws the RISKY_ROOT message, never the required one", () => {
    for (const risky of [os.homedir(), "/", "/etc", "/usr/local"]) {
      assert.throws(
        () => validateSandboxBaseDirectory(risky),
        { message: SANDBOX_RISKY_ROOT_MESSAGE },
        `${risky} must report "risky root", not "required"`
      );
    }
  });

  test("a symlink resolving to / reports the risky-root message specifically", async () => {
    // The FEA-4005 escape, pinned by MESSAGE: the lexical path is neither blank
    // nor risky, so a bare `throws` here cannot tell the canonicalized
    // risky-root rejection apart from the blank-path one.
    const dir = await makeTempDir("risky-message");
    const link = path.join(dir, "scope-link");
    fs.symlinkSync("/", link);
    assert.throws(() => validateSandboxBaseDirectory(link), {
      message: SANDBOX_RISKY_ROOT_MESSAGE,
    });
  });
});

describe("ISS-6128 fail-closed sandbox arms", () => {
  test("a broad-root entry does not disable the rest of the allowlist", async () => {
    // FEA-4005's rejection of an allowed root that canonicalizes to `/` is a
    // `continue`, not a `return false`. That the poisoned entry is itself
    // rejected is already pinned above, by "isPathAllowed fails closed when the
    // allowed root canonicalizes to /". What nothing pinned is that the walk
    // CARRIES ON: every existing case passes a single-entry allowlist, so
    // turning that `continue` into `return false` silently switched the sandbox
    // off for every other configured root without failing a test.
    const parent = await makeTempDir("iss6128-multi-root");
    const realProject = path.join(parent, "my-project");
    await fsp.mkdir(realProject, { recursive: true });
    const poisoned = path.join(parent, "scope-link");
    fs.symlinkSync("/", poisoned);

    assert.equal(
      isPathAllowed(path.join(realProject, "src", "index.ts"), [
        poisoned,
        realProject,
      ]),
      true
    );
  });

  test("rejects a not-yet-created scope whose symlinked parent lands in a system tree", async () => {
    // The chosen scope does not exist yet, so `realpathSync` on it throws and
    // the nearest-existing-ancestor walk in `canonicalizeScopePath` is what
    // resolves the symlink. Every existing canonicalization case uses a
    // directory that already exists and so never reaches that walk; without it
    // the lexical path is not a risky root, and a scope that really lives
    // inside `/etc` persists as an ordinary project folder.
    //
    // The link points at `/etc` rather than `/` so the lexical path stays
    // non-risky; see `makeNonSystemTempDir` for why the parent is neither
    // `os.tmpdir()` nor the real home directory.
    const parent = await makeNonSystemTempDir("iss6128-unborn-scope");
    const link = path.join(parent, "etc-link");
    fs.symlinkSync("/etc", link);
    // The walk is reached only because the scope itself cannot be realpath'd,
    // so that absence is a precondition of the assertion below, not a property
    // of the machine: a real `/etc/<child>` would satisfy the FIRST realpath
    // and keep this green with the walk deleted. `existsSync` resolves the link
    // exactly as `realpathSync` does, so it tests the same condition the
    // production code branches on.
    const scope = path.join(link, `iss6128-scope-${randomUUID()}`);
    assert.equal(fs.existsSync(scope), false);
    assert.throws(() => validateSandboxBaseDirectory(scope), {
      message: SANDBOX_RISKY_ROOT_MESSAGE,
    });
  });
});
