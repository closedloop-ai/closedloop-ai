/**
 * ISS-11596 guard: no Desktop main-process or gateway code calls a synchronous
 * binary resolver except the callers that run off the main thread or never run
 * in production (Daveth Oakhurst, 2026-10-06: ticket decision 3 and PLN-2165
 * Q-003 option b).
 *
 * `getResolvedGitPath`, `getResolvedClaudePath`, `getShellPathSync` and
 * `resolveBinaryFromLoginShellSync` all reach `getShellPathSync`, which on a
 * cold PATH cache runs the login shell with `execFileSync` for up to 10 s and
 * freezes every window (the ISS-6132 class). The `no-desktop-main-sync-exec`
 * gate cannot see these callers, because the blocking child lives in
 * `shell-path.ts`, whose one counted call is allowlisted as the documented
 * synchronous twin. Main-thread code awaits the async twins instead:
 * `getResolvedGitPathAsync`, `getResolvedClaudePathAsync`, `getShellPath`,
 * `resolveBinaryFromLoginShell`.
 *
 * The walk is AST-based (`no-raw-text-source-scan`, shared with the ISS-12120
 * Keychain guard in `helpers/main-thread-symbol-guard.ts`) and binds imports the way
 * `scripts/lint/rules/no-desktop-main-sync-exec.ts` does: a named import,
 * aliased or not, a member call on a namespace import, and, inside a defining
 * module, a call of the local declaration. Known blind spots, as in that gate:
 * a resolver passed around as a value and called elsewhere, and a future
 * production caller of `isHarnessInstalled`, `pickSingleInstallCommand` or
 * `resolveAutoCommand` that omits `childEnv` and so reaches the allowed
 * `defaultResolvedChildEnv` default.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { describe, test } from "vitest";
import {
  collectSymbolUses,
  type GuardedModules,
  SymbolUseKind,
  scanSourceFiles,
} from "./helpers/main-thread-symbol-guard.js";

const desktopDir = path.dirname(
  fileURLToPath(new URL("../package.json", import.meta.url))
);
const SRC_DIR = path.join(desktopDir, "src");
const SCANNED_ROOTS = [
  path.join(SRC_DIR, "main"),
  path.join(SRC_DIR, "server"),
] as const;

const SyncResolver = {
  GitPath: "getResolvedGitPath",
  ClaudePath: "getResolvedClaudePath",
  ShellPathSync: "getShellPathSync",
  LoginShellSync: "resolveBinaryFromLoginShellSync",
} as const;
type SyncResolver = (typeof SyncResolver)[keyof typeof SyncResolver];

/** Module basename that exports each resolver. */
const RESOLVER_MODULES: GuardedModules = {
  "binary-path-overrides.js": [SyncResolver.GitPath, SyncResolver.ClaudePath],
  "shell-path.js": [SyncResolver.ShellPathSync, SyncResolver.LoginShellSync],
};

/** The modules that declare resolvers, keyed by their path under `src`. */
const DEFINING_MODULES: Readonly<Record<string, readonly SyncResolver[]>> = {
  "server/operations/binary-path-overrides.ts": [
    SyncResolver.GitPath,
    SyncResolver.ClaudePath,
  ],
  "server/shell-path.ts": [
    SyncResolver.ShellPathSync,
    SyncResolver.LoginShellSync,
  ],
};

type AllowedCall = {
  file: string;
  enclosing: string;
  resolver: SyncResolver;
  reason: string;
};

/**
 * Every synchronous resolver call that may remain. Keyed by file, enclosing
 * function and resolver, so a new call in an allowed file still fails.
 */
const ALLOWED_CALLS: readonly AllowedCall[] = [
  {
    file: "server/operations/git-helpers.ts",
    enclosing: "resolveRepoFullName",
    resolver: SyncResolver.GitPath,
    reason:
      "db-host utilityProcess: its one caller is the session import (ISS-11414 retained call)",
  },
  {
    file: "main/packs/install-child-env.ts",
    enclosing: "defaultResolvedChildEnv",
    resolver: SyncResolver.ShellPathSync,
    reason:
      "a default parameter value only; every production caller passes childEnv",
  },
  {
    file: "main/packs/pack-scanner.ts",
    enclosing: "detectBinaryTool",
    resolver: SyncResolver.LoginShellSync,
    reason: "pack-scan utilityProcess and its db-host fallback",
  },
  {
    file: "main/packs/pack-scanner.ts",
    enclosing: "detectClaudeCodeRouter",
    resolver: SyncResolver.LoginShellSync,
    reason: "pack-scan utilityProcess and its db-host fallback",
  },
  {
    file: "main/database/db-host/db-store-host.ts",
    enclosing: "resolveCachedBinaryPath",
    resolver: SyncResolver.LoginShellSync,
    reason: "db-host store worker",
  },
  {
    file: "server/operations/binary-path-overrides.ts",
    enclosing: "getResolvedGitPath",
    resolver: SyncResolver.LoginShellSync,
    reason: "the synchronous git resolver's own definition",
  },
  {
    file: "server/operations/binary-path-overrides.ts",
    enclosing: "getResolvedClaudePath",
    resolver: SyncResolver.LoginShellSync,
    reason: "the synchronous claude resolver's own definition",
  },
  {
    file: "server/shell-path.ts",
    enclosing: "resolveBinaryFromLoginShellSync",
    resolver: SyncResolver.ShellPathSync,
    reason: "the synchronous binary resolver's own definition",
  },
];

type FoundCall = {
  file: string;
  enclosing: string;
  resolver: SyncResolver;
  line: number;
};

/** Collect resolver calls in one parsed file; `relativeFile` is its path under `src`. */
function collectResolverCalls(
  source: ts.SourceFile,
  relativeFile: string
): FoundCall[] {
  return collectSymbolUses(source, relativeFile, {
    modules: RESOLVER_MODULES,
    definedHere: DEFINING_MODULES[relativeFile],
    kind: SymbolUseKind.Calls,
  }).map(({ symbol, ...use }) => ({
    ...use,
    resolver: symbol as SyncResolver,
  }));
}

function callKey(call: {
  file: string;
  enclosing: string;
  resolver: SyncResolver;
}): string {
  return `${call.file} ${call.enclosing} ${call.resolver}`;
}

function scanSourceTree(): FoundCall[] {
  return scanSourceFiles(SRC_DIR, SCANNED_ROOTS).flatMap(
    ({ relativeFile, source }) => collectResolverCalls(source, relativeFile)
  );
}

const ASYNC_TWIN: Readonly<Record<SyncResolver, string>> = {
  [SyncResolver.GitPath]: "await getResolvedGitPathAsync()",
  [SyncResolver.ClaudePath]: "await getResolvedClaudePathAsync()",
  [SyncResolver.ShellPathSync]: "await getShellPath()",
  [SyncResolver.LoginShellSync]:
    "await getResolvedGitPathAsync() or await resolveBinaryFromLoginShell()",
};

describe("ISS-11596 guard: no synchronous binary resolution on the main thread", () => {
  test("the collector reports direct, renamed and namespace calls of every resolver", () => {
    const fixture = ts.createSourceFile(
      "fixture.ts",
      [
        'import { getResolvedGitPath, getResolvedClaudePath as claudeSync } from "../server/operations/binary-path-overrides.js";',
        'import * as overrides from "./binary-path-overrides.js";',
        'import { getShellPathSync as pathSync, resolveBinaryFromLoginShellSync } from "../shell-path.js";',
        'import * as shellPath from "../shell-path.js";',
        "export async function route(): Promise<void> {",
        "  getResolvedGitPath();",
        "  claudeSync();",
        "  overrides.getResolvedClaudePath();",
        "  pathSync();",
        '  const resolve = () => resolveBinaryFromLoginShellSync("git");',
        "  shellPath.getShellPathSync();",
        "}",
      ].join("\n"),
      ts.ScriptTarget.Latest,
      false
    );

    const calls = collectResolverCalls(fixture, "main/fixture.ts");

    assert.deepEqual(
      calls.map(({ enclosing, resolver }) => `${enclosing} ${resolver}`),
      [
        `route ${SyncResolver.GitPath}`,
        `route ${SyncResolver.ClaudePath}`,
        `route ${SyncResolver.ClaudePath}`,
        `route ${SyncResolver.ShellPathSync}`,
        `resolve ${SyncResolver.LoginShellSync}`,
        `route ${SyncResolver.ShellPathSync}`,
      ]
    );
  });

  test("src/main and src/server call a synchronous resolver only where the allow table says", () => {
    const found = scanSourceTree();
    const allowedKeys = new Set(ALLOWED_CALLS.map(callKey));
    const violations = found
      .filter((call) => !allowedKeys.has(callKey(call)))
      .map(
        (call) =>
          `${call.file}:${call.line} ${call.enclosing} calls ${call.resolver}; use ${ASYNC_TWIN[call.resolver]}`
      );
    const foundKeys = new Set(found.map(callKey));
    const stale = ALLOWED_CALLS.filter(
      (entry) => !foundKeys.has(callKey(entry))
    ).map(
      (entry) =>
        `stale allow-table entry, no such call any more: ${callKey(entry)}`
    );

    assert.deepEqual(
      [...violations, ...stale],
      [],
      "A synchronous binary resolver runs a login shell with execFileSync on a cold PATH cache and freezes the Electron main thread (ISS-6132, ISS-11596)."
    );
  });
});
