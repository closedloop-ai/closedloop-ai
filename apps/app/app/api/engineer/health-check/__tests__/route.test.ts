import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

// --- Mock module boundaries BEFORE importing route module ---

vi.mock("@/lib/engineer/repos", () => ({
  REQUIRED_SYMPHONY_PLUGINS: [
    "code@closedloop-ai",
    "self-learning@closedloop-ai",
    "judges@closedloop-ai",
    "code-review@closedloop-ai",
    "platform@closedloop-ai",
    "code-simplifier@claude-plugins-official",
  ],
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

// Import route and mocked repos AFTER mocks are registered
const { GET } = await import("../route");
const { checkRequiredPlugins } = await import("@/lib/engineer/repos");

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

beforeEach(() => {
  // Stub fetch globally so tests that trigger checkPluginVersions()
  // (whenever allInstalled is true) never make real network requests.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("unstubbed fetch")))
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
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

// ---------------------------------------------------------------------------
// Plugin version checks
// ---------------------------------------------------------------------------

const ALL_UP_TO_DATE_INSTALLED: Record<string, string> = {
  "code@closedloop-ai": "99.0.0",
  "self-learning@closedloop-ai": "99.0.0",
  "judges@closedloop-ai": "99.0.0",
  "code-review@closedloop-ai": "99.0.0",
  "platform@closedloop-ai": "99.0.0",
  "code-simplifier@claude-plugins-official": "99.0.0",
};

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GET /api/engineer/health-check -- plugin version checks", () => {
  beforeEach(() => {
    // Override the file-level fetch rejection with a controllable mock
    vi.stubGlobal("fetch", vi.fn());
  });

  test("all 5 up-to-date: plugin-versions row present with passed: true, required: false", async () => {
    vi.mocked(checkRequiredPlugins).mockReturnValueOnce({
      allInstalled: true,
      missing: [],
      installed: ALL_UP_TO_DATE_INSTALLED,
      reason: "ok",
    });

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(() =>
      Promise.resolve(makeJsonResponse({ version: "99.0.0" }))
    );

    const binDir = createBaseBinDir(tmpRoot);
    fakeBinDir = binDir;

    const response = await GET();
    const body = await response.json();

    const row = body.checks.find(
      (c: { id: string }) => c.id === "plugin-versions"
    );
    expect(row).toBeDefined();
    expect(row.passed).toBe(true);
    expect(row.required).toBe(false);
  });

  test("one outdated: passed: false, error contains plugin key, remediation contains install command", async () => {
    vi.mocked(checkRequiredPlugins).mockReturnValueOnce({
      allInstalled: true,
      missing: [],
      installed: {
        ...ALL_UP_TO_DATE_INSTALLED,
        "code@closedloop-ai": "1.0.0",
      },
      reason: "ok",
    });

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(() =>
      Promise.resolve(makeJsonResponse({ version: "99.0.0" }))
    );

    const binDir = createBaseBinDir(tmpRoot);
    fakeBinDir = binDir;

    const response = await GET();
    const body = await response.json();

    const row = body.checks.find(
      (c: { id: string }) => c.id === "plugin-versions"
    );
    expect(row).toBeDefined();
    expect(row.passed).toBe(false);
    expect(row.error).toContain("code@closedloop-ai");
    expect(row.remediation).toContain(
      "claude plugin install code@closedloop-ai"
    );
  });

  test("all fetches fail: no plugin-versions row", async () => {
    vi.mocked(checkRequiredPlugins).mockReturnValueOnce({
      allInstalled: true,
      missing: [],
      installed: ALL_UP_TO_DATE_INSTALLED,
      reason: "ok",
    });

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValue(new Error("timeout"));

    const binDir = createBaseBinDir(tmpRoot);
    fakeBinDir = binDir;

    const response = await GET();
    const body = await response.json();

    const row = body.checks.find(
      (c: { id: string }) => c.id === "plugin-versions"
    );
    expect(row).toBeUndefined();
  });

  test("partial success: 3 of 5 return 404, 2 return valid JSON matching installed; passed: false, error contains unverified fraction", async () => {
    vi.mocked(checkRequiredPlugins).mockReturnValueOnce({
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
    });

    const fetchMock = vi.mocked(fetch);
    // First 2 fetches (code, self-learning) return versions matching installed
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ version: "1.5.8" }));
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ version: "1.0.0" }));
    // Next 3 fetches (judges, code-review, platform) return 404
    fetchMock.mockResolvedValueOnce(makeJsonResponse({}, 404));
    fetchMock.mockResolvedValueOnce(makeJsonResponse({}, 404));
    fetchMock.mockResolvedValueOnce(makeJsonResponse({}, 404));

    const binDir = createBaseBinDir(tmpRoot);
    fakeBinDir = binDir;

    const response = await GET();
    const body = await response.json();

    const row = body.checks.find(
      (c: { id: string }) => c.id === "plugin-versions"
    );
    expect(row).toBeDefined();
    expect(row.passed).toBe(false);
    expect(row.error).toContain("3/5");
  });

  test("non-semver installed version: passed: false (unverified partial), no crash", async () => {
    vi.mocked(checkRequiredPlugins).mockReturnValueOnce({
      allInstalled: true,
      missing: [],
      installed: {
        ...ALL_UP_TO_DATE_INSTALLED,
        "code@closedloop-ai": "installed",
      },
      reason: "ok",
    });

    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(() =>
      Promise.resolve(makeJsonResponse({ version: "99.0.0" }))
    );

    const binDir = createBaseBinDir(tmpRoot);
    fakeBinDir = binDir;

    const response = await GET();
    const body = await response.json();

    const row = body.checks.find(
      (c: { id: string }) => c.id === "plugin-versions"
    );
    expect(row).toBeDefined();
    expect(row.passed).toBe(false);
  });

  test("gating - allInstalled false: no plugin-versions row", async () => {
    vi.mocked(checkRequiredPlugins).mockReturnValueOnce({
      allInstalled: false,
      missing: ["code@closedloop-ai"],
      installed: {},
      reason: "plugins_missing",
    });

    // fetch is stubbed in beforeEach but should not be called when allInstalled is false
    const binDir = createBaseBinDir(tmpRoot);
    fakeBinDir = binDir;

    const response = await GET();
    const body = await response.json();

    const row = body.checks.find(
      (c: { id: string }) => c.id === "plugin-versions"
    );
    expect(row).toBeUndefined();
  });
});
