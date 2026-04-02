import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";

// --- Mock module boundaries BEFORE importing route module ---

vi.mock("@/lib/engineer/repos", () => ({
  checkRequiredPlugins: vi.fn(() => ({
    allInstalled: true,
    missing: [],
    installed: {
      "code@closedloop-ai": "1.5.8",
      "self-learning@closedloop-ai": "1.0.0",
      "judges@closedloop-ai": "1.0.0",
      "code-review@closedloop-ai": "1.0.0",
      "platform@closedloop-ai": "1.0.0",
      "code-simplifier@claude-plugins-official": "1.0.0",
    },
    reason: "ok",
  })),
  getSymphonyScriptPath: vi.fn(() => "/fake/path/run-loop.sh"),
  loadReposConfig: vi.fn(() => ({
    repos: [],
    settings: {
      worktreeParentDir: "/tmp/worktrees",
      worktreeParentDirConfirmed: true,
    },
  })),
}));

// shell-path is mocked so getShellPath() returns our controlled temp bin dir
// The mock factory captures a reference that we can update per-test.
let fakeBinDir = "";

vi.mock("@/lib/engineer/shell-path", () => ({
  getShellPath: vi.fn(() => Promise.resolve(fakeBinDir)),
  clearShellPathCache: vi.fn(),
}));

// Import route AFTER mocks are registered
const { GET } = await import("../route");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeFakeBinary(dir: string, name: string, script: string): void {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
}

/** Create a temp bin dir with git, claude, gh fake binaries that all pass. */
function createBaseBinDir(tmpRoot: string): string {
  const dir = join(tmpRoot, `bin-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });

  writeFakeBinary(dir, "git", 'echo "git version 2.40.0"; exit 0');
  writeFakeBinary(dir, "claude", 'echo "1.2.3"; exit 0');
  // gh must handle both `--version` and `auth status`
  writeFakeBinary(
    dir,
    "gh",
    `case "$1" in
  --version) echo "gh version 2.40.0 (2024-01-01)"; exit 0 ;;
  auth) exit 0 ;;
  *) exit 0 ;;
esac`
  );
  return dir;
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "health-check-test-"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/engineer/health-check — python3 checks", () => {
  test("python3 supported (3.11.0): passed=true, required=true, allRequiredPassed=true", async () => {
    const binDir = createBaseBinDir(tmpRoot);
    writeFakeBinary(binDir, "python3", 'echo "Python 3.11.0"; exit 0');
    fakeBinDir = binDir;

    const response = await GET();
    const body = await response.json();

    const py = body.checks.find((c: { id: string }) => c.id === "python3");
    expect(py).toBeDefined();
    expect(py.passed).toBe(true);
    expect(py.required).toBe(true);
    expect(py.remediation).toBeUndefined();
    expect(body.allRequiredPassed).toBe(true);
  });

  test("python3 not found: passed=false, required=true, remediation mentions 3.10, allRequiredPassed=false", async () => {
    const binDir = createBaseBinDir(tmpRoot);
    // No python3 binary in this bin dir
    fakeBinDir = binDir;

    const response = await GET();
    const body = await response.json();

    const py = body.checks.find((c: { id: string }) => c.id === "python3");
    expect(py).toBeDefined();
    expect(py.passed).toBe(false);
    expect(py.required).toBe(true);
    expect(py.remediation).toContain("Install Python 3.10 or later");
    expect(body.allRequiredPassed).toBe(false);
  });

  test("python3 below floor (3.9.7): passed=false, required=true, error mentions below minimum, allRequiredPassed=false", async () => {
    const binDir = createBaseBinDir(tmpRoot);
    writeFakeBinary(binDir, "python3", 'echo "Python 3.9.7"; exit 0');
    fakeBinDir = binDir;

    const response = await GET();
    const body = await response.json();

    const py = body.checks.find((c: { id: string }) => c.id === "python3");
    expect(py).toBeDefined();
    expect(py.passed).toBe(false);
    expect(py.required).toBe(true);
    expect(py.error).toContain("below the required minimum");
    expect(py.version).toBe("3.9.7");
    expect(py.remediation).toContain("Install Python 3.10 or later");
    expect(body.allRequiredPassed).toBe(false);
  });

  test("python3 suffixed below-floor (3.9rc1): passed=false, required=true, remediation mentions 3.10, allRequiredPassed=false", async () => {
    const binDir = createBaseBinDir(tmpRoot);
    writeFakeBinary(binDir, "python3", 'echo "Python 3.9rc1"; exit 0');
    fakeBinDir = binDir;

    const response = await GET();
    const body = await response.json();

    const py = body.checks.find((c: { id: string }) => c.id === "python3");
    expect(py).toBeDefined();
    expect(py.passed).toBe(false);
    expect(py.required).toBe(true);
    // Must hit the version-comparison branch, not the "Unable to determine" branch
    expect(py.error).toContain("below the required minimum");
    expect(py.remediation).toContain("Install Python 3.10 or later");
    expect(body.allRequiredPassed).toBe(false);
  });

  test("python3 with extra version suffix (3.10.1.post1): passed=true, regex extracts major.minor correctly", async () => {
    const binDir = createBaseBinDir(tmpRoot);
    writeFakeBinary(binDir, "python3", 'echo "Python 3.10.1.post1"; exit 0');
    fakeBinDir = binDir;

    const response = await GET();
    const body = await response.json();

    const py = body.checks.find((c: { id: string }) => c.id === "python3");
    expect(py).toBeDefined();
    expect(py.passed).toBe(true);
    expect(py.required).toBe(true);
    expect(py.error).toBeUndefined();
    expect(body.allRequiredPassed).toBe(true);
  });

  test("python3 unparseable version: passed=false, required=true, error mentions Unable to determine, allRequiredPassed=false", async () => {
    const binDir = createBaseBinDir(tmpRoot);
    writeFakeBinary(binDir, "python3", 'echo "custom-build"; exit 0');
    fakeBinDir = binDir;

    const response = await GET();
    const body = await response.json();

    const py = body.checks.find((c: { id: string }) => c.id === "python3");
    expect(py).toBeDefined();
    expect(py.passed).toBe(false);
    expect(py.required).toBe(true);
    expect(py.error).toContain("Unable to determine Python version");
    expect(body.allRequiredPassed).toBe(false);
  });
});
