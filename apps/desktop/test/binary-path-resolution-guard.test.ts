import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(testDir, "..");
const productionRoots = [
  path.join(desktopRoot, "src"),
  path.join(desktopRoot, "scripts"),
];
const srcRoot = path.join(desktopRoot, "src");
const legacyResolverName = ["resolveBinaryFrom", "InheritedPath"].join("");
const productionSourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

type ScannedFile = {
  absolutePath: string;
  relativePath: string;
  text: string;
};

type BinaryDiscoveryRule = {
  label: string;
  pattern: RegExp;
};

type BinaryDiscoveryViolation = {
  label: string;
  line: number;
  relativePath: string;
};

const directBinaryDiscoveryRules: BinaryDiscoveryRule[] = [
  {
    label: "execFile bare which",
    pattern: /\bexecFile\s*\(\s*["']which["']/g,
  },
  {
    label: "execFileSync bare which",
    pattern: /\bexecFileSync\s*\(\s*["']which["']/g,
  },
  {
    label: "execFile absolute which",
    pattern: /\bexecFile\s*\(\s*["']\/usr\/bin\/which["']/g,
  },
  {
    label: "execFileSync absolute which",
    pattern: /\bexecFileSync\s*\(\s*["']\/usr\/bin\/which["']/g,
  },
  {
    label: "spawn bare which",
    pattern: /\bspawn\s*\(\s*["']which["']/g,
  },
  {
    label: "spawnSync bare which",
    pattern: /\bspawnSync\s*\(\s*["']which["']/g,
  },
  {
    label: "spawn absolute which",
    pattern: /\bspawn\s*\(\s*["']\/usr\/bin\/which["']/g,
  },
  {
    label: "spawnSync absolute which",
    pattern: /\bspawnSync\s*\(\s*["']\/usr\/bin\/which["']/g,
  },
  {
    label: "exec string which",
    pattern: /\bexec\s*\(\s*["']which\b[^"']*["']/g,
  },
  {
    label: "execSync string which",
    pattern: /\bexecSync\s*\(\s*["']which\b[^"']*["']/g,
  },
  {
    label: "exec string absolute which",
    pattern: /\bexec\s*\(\s*["']\/usr\/bin\/which\b[^"']*["']/g,
  },
  {
    label: "execSync string absolute which",
    pattern: /\bexecSync\s*\(\s*["']\/usr\/bin\/which\b[^"']*["']/g,
  },
  {
    label: "execFile bash login-shell which",
    pattern:
      /\bexecFile\s*\(\s*["'](?:bash|sh)["']\s*,\s*\[[\s\S]*?["']-lc["'][\s\S]*?["'](?:\/usr\/bin\/)?which\b[^"']*["'][\s\S]*?\]/g,
  },
  {
    label: "execFileSync bash login-shell which",
    pattern:
      /\bexecFileSync\s*\(\s*["'](?:bash|sh)["']\s*,\s*\[[\s\S]*?["']-lc["'][\s\S]*?["'](?:\/usr\/bin\/)?which\b[^"']*["'][\s\S]*?\]/g,
  },
  {
    label: "spawn bash login-shell which",
    pattern:
      /\bspawn\s*\(\s*["'](?:bash|sh)["']\s*,\s*\[[\s\S]*?["']-lc["'][\s\S]*?["'](?:\/usr\/bin\/)?which\b[^"']*["'][\s\S]*?\]/g,
  },
  {
    label: "spawnSync bash login-shell which",
    pattern:
      /\bspawnSync\s*\(\s*["'](?:bash|sh)["']\s*,\s*\[[\s\S]*?["']-lc["'][\s\S]*?["'](?:\/usr\/bin\/)?which\b[^"']*["'][\s\S]*?\]/g,
  },
  {
    label: "execFile shell true command which",
    pattern:
      /\bexecFile\s*\(\s*["'](?:\/usr\/bin\/)?which\b[^"']*["']\s*,\s*(?:\[[\s\S]*?\]\s*,\s*)?\{[\s\S]*?\bshell\s*:\s*true\b[\s\S]*?\}/g,
  },
  {
    label: "execFileSync shell true command which",
    pattern:
      /\bexecFileSync\s*\(\s*["'](?:\/usr\/bin\/)?which\b[^"']*["']\s*,\s*(?:\[[\s\S]*?\]\s*,\s*)?\{[\s\S]*?\bshell\s*:\s*true\b[\s\S]*?\}/g,
  },
  {
    label: "spawn shell true command which",
    pattern:
      /\bspawn\s*\(\s*["'](?:\/usr\/bin\/)?which\b[^"']*["']\s*,\s*(?:\[[\s\S]*?\]\s*,\s*)?\{[\s\S]*?\bshell\s*:\s*true\b[\s\S]*?\}/g,
  },
  {
    label: "spawnSync shell true command which",
    pattern:
      /\bspawnSync\s*\(\s*["'](?:\/usr\/bin\/)?which\b[^"']*["']\s*,\s*(?:\[[\s\S]*?\]\s*,\s*)?\{[\s\S]*?\bshell\s*:\s*true\b[\s\S]*?\}/g,
  },
];

const failureFixtures: Array<{ label: string; text: string }> = [
  {
    label: "execFile bare which",
    text: 'execFile("which", ["codex"]);',
  },
  {
    label: "execFileSync bare which",
    text: 'execFileSync("which", ["codex"]);',
  },
  {
    label: "execFile absolute which",
    text: 'execFile("/usr/bin/which", ["codex"]);',
  },
  {
    label: "execFileSync absolute which",
    text: 'execFileSync("/usr/bin/which", ["codex"]);',
  },
  {
    label: "spawn bare which",
    text: 'spawn("which", ["codex"]);',
  },
  {
    label: "spawnSync bare which",
    text: 'spawnSync("which", ["codex"]);',
  },
  {
    label: "spawn absolute which",
    text: 'spawn("/usr/bin/which", ["codex"]);',
  },
  {
    label: "spawnSync absolute which",
    text: 'spawnSync("/usr/bin/which", ["codex"]);',
  },
  {
    label: "exec string which",
    text: 'exec("which codex");',
  },
  {
    label: "execSync string which",
    text: 'execSync("which codex");',
  },
  {
    label: "exec string absolute which",
    text: 'exec("/usr/bin/which codex");',
  },
  {
    label: "execSync string absolute which",
    text: 'execSync("/usr/bin/which codex");',
  },
  {
    label: "execFile bash login-shell which",
    text: 'execFile("bash", ["-lc", "which codex"]);',
  },
  {
    label: "execFileSync bash login-shell which",
    text: 'execFileSync("bash", ["-lc", "/usr/bin/which codex"]);',
  },
  {
    label: "spawn bash login-shell which",
    text: 'spawn("bash", ["-lc", "which codex"]);',
  },
  {
    label: "spawnSync bash login-shell which",
    text: 'spawnSync("sh", ["-lc", "/usr/bin/which codex"]);',
  },
  {
    label: "execFile shell true command which",
    text: 'execFile("which codex", { shell: true });',
  },
  {
    label: "execFile shell true command which",
    text: 'execFile("/usr/bin/which codex", { shell: true });',
  },
  {
    label: "execFile shell true command which",
    text: 'execFile("which codex", [], { shell: true });',
  },
  {
    label: "execFile shell true command which",
    text: 'execFile("/usr/bin/which codex", [], { shell: true });',
  },
  {
    label: "execFileSync shell true command which",
    text: 'execFileSync("which codex", { shell: true });',
  },
  {
    label: "execFileSync shell true command which",
    text: 'execFileSync("/usr/bin/which codex", { shell: true });',
  },
  {
    label: "execFileSync shell true command which",
    text: 'execFileSync("which codex", [], { shell: true });',
  },
  {
    label: "execFileSync shell true command which",
    text: 'execFileSync("/usr/bin/which codex", [], { shell: true });',
  },
  {
    label: "spawn shell true command which",
    text: 'spawn("which codex", { shell: true });',
  },
  {
    label: "spawn shell true command which",
    text: 'spawn("/usr/bin/which codex", { shell: true });',
  },
  {
    label: "spawn shell true command which",
    text: 'spawn("which codex", [], { shell: true });',
  },
  {
    label: "spawn shell true command which",
    text: 'spawn("/usr/bin/which codex", [], { shell: true });',
  },
  {
    label: "spawnSync shell true command which",
    text: 'spawnSync("which codex", { shell: true });',
  },
  {
    label: "spawnSync shell true command which",
    text: 'spawnSync("/usr/bin/which codex", { shell: true });',
  },
  {
    label: "spawnSync shell true command which",
    text: 'spawnSync("which codex", [], { shell: true });',
  },
  {
    label: "spawnSync shell true command which",
    text: 'spawnSync("/usr/bin/which codex", [], { shell: true });',
  },
];

const requiredShellTrueCommandFixtures = [
  ...["execFile", "execFileSync", "spawn", "spawnSync"].flatMap(
    (functionName) =>
      ["which codex", "/usr/bin/which codex"].flatMap((command) => [
        {
          label: `${functionName} shell true command which`,
          text: `${functionName}("${command}", { shell: true });`,
        },
        {
          label: `${functionName} shell true command which`,
          text: `${functionName}("${command}", [], { shell: true });`,
        },
      ])
  ),
];

function collectProductionSourceFiles(dir: string): ScannedFile[] {
  const files: ScannedFile[] = [];
  for (const entry of readdirSync(dir)) {
    const absolutePath = path.join(dir, entry);
    const stat = statSync(absolutePath);
    if (stat.isDirectory()) {
      files.push(...collectProductionSourceFiles(absolutePath));
      continue;
    }
    if (!productionSourceExtensions.has(path.extname(entry))) {
      continue;
    }
    files.push({
      absolutePath,
      relativePath: path.relative(desktopRoot, absolutePath),
      text: readFileSync(absolutePath, "utf8"),
    });
  }
  return files;
}

function collectDesktopProductionFiles(): ScannedFile[] {
  return productionRoots.flatMap((root) => collectProductionSourceFiles(root));
}

function readScannedFile(relativePath: string): ScannedFile {
  const absolutePath = path.join(desktopRoot, relativePath);
  return {
    absolutePath,
    relativePath,
    text: readFileSync(absolutePath, "utf8"),
  };
}

function lineNumber(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function collectRegexViolations(
  files: ScannedFile[],
  label: string,
  pattern: RegExp
): BinaryDiscoveryViolation[] {
  const violations: BinaryDiscoveryViolation[] = [];
  for (const file of files) {
    for (const match of file.text.matchAll(pattern)) {
      violations.push({
        label,
        line: lineNumber(file.text, match.index ?? 0),
        relativePath: file.relativePath,
      });
    }
  }
  return violations;
}

function findDirectBinaryDiscoveryViolations(
  files: ScannedFile[]
): BinaryDiscoveryViolation[] {
  return directBinaryDiscoveryRules.flatMap(({ label, pattern }) =>
    collectRegexViolations(files, label, pattern)
  );
}

function formatViolations(violations: BinaryDiscoveryViolation[]): string {
  return violations
    .map(({ label, line, relativePath }) => `${relativePath}:${line} ${label}`)
    .join("\n");
}

describe("binary path resolution source guards", () => {
  test("desktop production source and scripts are scanned", () => {
    const relativePaths = collectDesktopProductionFiles().map(
      ({ relativePath }) => relativePath
    );

    assert.ok(
      relativePaths.includes("scripts/stage-packaging-app.mjs"),
      "Desktop script files must stay inside the direct binary-discovery scan"
    );
    assert.ok(
      relativePaths.includes(
        "src/renderer/components/features/CoreFeaturesView.tsx"
      ),
      "Desktop TSX source files must stay inside the direct binary-discovery scan"
    );
  });

  test("desktop production source and scripts do not use direct host discovery commands", () => {
    const sourceFiles = collectDesktopProductionFiles();
    const violations = findDirectBinaryDiscoveryViolations(sourceFiles);

    assert.deepEqual(
      violations,
      [],
      `Use resolveBinaryFromLoginShell or resolveBinaryFromLoginShellSync instead:\n${formatViolations(violations)}`
    );
  });

  test("approved resolver and unrelated which text fixtures pass", () => {
    const fixture: ScannedFile = {
      absolutePath: "/fixture/approved.ts",
      relativePath: "fixture/approved.ts",
      text: `
        import { execFileSync, spawn } from "node:child_process";
        import { resolveBinaryFromLoginShellSync } from "../src/server/shell-path.js";

        const resolved = resolveBinaryFromLoginShellSync("codex");
        if (resolved.source === "path") {
          execFileSync(resolved.path, ["--version"]);
        }
        const codexBin = resolved.path;
        spawn(codexBin, ["--version"]);
        const note = "Choose which command is already resolved.";
        // The word which in prose is not host binary discovery.
      `,
    };

    assert.deepEqual(findDirectBinaryDiscoveryViolations([fixture]), []);
  });

  test("banned direct host discovery fixtures fail with stable labels", () => {
    const fixtureLabels = new Set(failureFixtures.map(({ label }) => label));
    const missingFixtureLabels = directBinaryDiscoveryRules
      .map(({ label }) => label)
      .filter((label) => !fixtureLabels.has(label));

    assert.deepEqual(
      missingFixtureLabels,
      [],
      "Every direct binary-discovery rule must have at least one failure fixture"
    );

    const missingShellTrueFixtures = requiredShellTrueCommandFixtures.filter(
      (requiredFixture) =>
        !failureFixtures.some(
          (fixture) =>
            fixture.label === requiredFixture.label &&
            fixture.text === requiredFixture.text
        )
    );

    assert.deepEqual(
      missingShellTrueFixtures,
      [],
      "Every shell:true static command family must cover bare and absolute which commands in both option positions"
    );

    for (const fixture of failureFixtures) {
      const violations = findDirectBinaryDiscoveryViolations([
        {
          absolutePath: `/fixture/${fixture.label}.ts`,
          relativePath: `fixture/${fixture.label}.ts`,
          text: fixture.text,
        },
      ]);

      assert.deepEqual(
        violations.map(({ label }) => label),
        [fixture.label],
        `${fixture.label} should be rejected`
      );
    }
  });

  test("desktop source only declares approved getResolvedXxxPath wrappers", () => {
    const allowed = new Set([
      "getResolvedClaudePath",
      "getResolvedGitPath",
      "getResolvedGhPath",
    ]);
    const sourceFiles = collectProductionSourceFiles(srcRoot);
    const declarations: string[] = [];

    for (const file of sourceFiles) {
      for (const match of file.text.matchAll(
        /\b(?:export\s+)?function\s+(getResolved[A-Z][A-Za-z0-9]*Path)\s*\(/g
      )) {
        const helperName = match[1];
        if (!allowed.has(helperName)) {
          declarations.push(
            `${file.relativePath}:${lineNumber(file.text, match.index ?? 0)} ${helperName}`
          );
        }
      }
    }

    assert.deepEqual(
      declarations,
      [],
      `Unapproved resolver wrappers found:\n${declarations.join("\n")}`
    );
  });

  test("legacy inherited PATH resolver references stay deleted", () => {
    const legacyPattern = new RegExp(`\\b${legacyResolverName}\\b`, "g");
    const files = [
      ...collectDesktopProductionFiles(),
      readScannedFile("test/resolve-binary.test.ts"),
      readScannedFile("test/symphony-loop-binary-resolution.test.ts"),
    ];
    const violations = collectRegexViolations(
      files,
      "references deleted inherited PATH resolver",
      legacyPattern
    );

    assert.deepEqual(
      violations,
      [],
      `Legacy resolver references found:\n${formatViolations(violations)}`
    );
  });
});
