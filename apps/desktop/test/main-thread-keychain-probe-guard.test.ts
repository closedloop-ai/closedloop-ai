/**
 * ISS-12120 guard: no Desktop main-thread code reaches the synchronous Keychain
 * credential probe.
 *
 * `hasKeychainCredentialCached` runs `execFileSync("/usr/bin/security", …)` for
 * up to 800 ms on a cold memo, and `detectBillingMode`, `resolveBillingMode` and
 * `resolveBillingModeForRow` reach it. On the Electron main thread that freezes
 * every window, IPC reply and timer (the ISS-6132 class). Main-thread callers
 * use the non-blocking twins in {@link NON_BLOCKING_TWIN} instead. The
 * `no-desktop-main-sync-exec` gate cannot see these callers, because the
 * blocking child lives in `anthropic-keychain.ts`, whose one counted call is
 * allowlisted for the db-host store worker.
 *
 * Unlike the binary-resolver guard this one counts value references as well as
 * calls: the telemetry bug it pins passed the detector as a default value
 * (`options.detectBillingMode ?? detectBillingMode`) and called it elsewhere.
 *
 * It does not trust its own labels. Every site it allows as a store-worker site
 * must be outside the main process's runtime import closure, computed from
 * `src/main/index.ts` with literal dynamic `import()` followed, and the closure
 * must contain known main-thread modules, so a walk that collapses fails.
 *
 * Known blind spot, tracked by ISS-12431: the walk binds by import and
 * identifier, so a synchronous link passed through an untyped hop (an `any`
 * cast, a computed property, a re-export barrel) and called elsewhere escapes
 * it, as it escapes the ISS-11596 guard and the source gate.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import { describe, test } from "vitest";
import {
  collectSymbolUses,
  type GuardedModules,
  mainImportClosure,
  type SymbolUse,
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
const MAIN_ENTRY = path.join(SRC_DIR, "main/index.ts");

const Probe = {
  Cached: "hasKeychainCredentialCached",
  Detect: "detectBillingMode",
  Resolve: "resolveBillingMode",
  ResolveRow: "resolveBillingModeForRow",
} as const;
type Probe = (typeof Probe)[keyof typeof Probe];

/** What a main-thread caller uses instead of each synchronous link. */
const NON_BLOCKING_TWIN: Readonly<Record<Probe, string>> = {
  [Probe.Cached]: "hasKeychainCredentialNonBlocking",
  [Probe.Detect]: "detectBillingModeNonBlocking",
  [Probe.Resolve]: "resolveBillingModeNonBlocking",
  [Probe.ResolveRow]:
    "resolveBillingModesNonBlocking (rows) or resolveBillingModeNonBlocking",
};

const GUARDED_MODULES: GuardedModules = {
  "anthropic-keychain.js": [Probe.Cached],
  "billing-mode-detector.js": [Probe.Detect, Probe.Resolve],
  "agent-session-token-cost-resolution.js": [Probe.ResolveRow],
};

/** The modules that declare the synchronous chain, keyed by path under `src`. */
const DEFINING_MODULES: Readonly<Record<string, readonly Probe[]>> = {
  "main/cost/anthropic-keychain.ts": [Probe.Cached],
  "main/cost/billing-mode-detector.ts": [Probe.Detect, Probe.Resolve],
  "main/agent-sync/agent-session-token-cost-resolution.ts": [Probe.ResolveRow],
};

const SiteKind = {
  /** Runs in the db-host store worker; must be outside main's closure. */
  StoreWorker: "store-worker",
  /** A link of the synchronous chain inside its own defining module. */
  Chain: "chain",
} as const;
type SiteKind = (typeof SiteKind)[keyof typeof SiteKind];

type AllowedSite = {
  file: string;
  enclosing: string;
  symbol: Probe;
  kind: SiteKind;
  reason: string;
};

/** Every use of the synchronous chain that may remain, by file, function and symbol. */
const ALLOWED_SITES: readonly AllowedSite[] = [
  {
    file: "main/cost/billing-mode-detector.ts",
    enclosing: "realDeps",
    symbol: Probe.Cached,
    kind: SiteKind.Chain,
    reason: "the synchronous detector's Keychain dependency",
  },
  {
    file: "main/cost/billing-mode-detector.ts",
    enclosing: "resolveBillingMode",
    symbol: Probe.Detect,
    kind: SiteKind.Chain,
    reason: "the synchronous resolver's own definition",
  },
  {
    file: "main/agent-sync/agent-session-token-cost-resolution.ts",
    enclosing: "resolveBillingModeForRow",
    symbol: Probe.Resolve,
    kind: SiteKind.Chain,
    reason: "the synchronous row resolver's own definition",
  },
  {
    file: "main/database/db-host/db-store-host.ts",
    enclosing: "open",
    symbol: Probe.Detect,
    kind: SiteKind.StoreWorker,
    reason:
      "wires ingest detection, which runs inside the write-queue transaction (ISS-11414 retained call)",
  },
  {
    file: "main/database/billing-mode-heal.ts",
    enclosing: "healUnknownBillingModes",
    symbol: Probe.Detect,
    kind: SiteKind.StoreWorker,
    reason: "boot maintenance in the store worker",
  },
  {
    file: "main/database/sync-source.ts",
    enclosing: "assembleSyncedSessions",
    symbol: Probe.ResolveRow,
    kind: SiteKind.StoreWorker,
    reason: "cloud sync payload assembly in the store worker",
  },
  {
    file: "main/database/sync-source.ts",
    enclosing: "loadSqliteMeteredUsageRows",
    symbol: Probe.Resolve,
    kind: SiteKind.StoreWorker,
    reason: "cost reconciliation rows, read in the store worker",
  },
  {
    file: "main/database/sync-source-session-rows.ts",
    enclosing: "buildMinimalSyncSession",
    symbol: Probe.ResolveRow,
    kind: SiteKind.StoreWorker,
    reason: "cloud sync payload assembly in the store worker",
  },
];

/** Main-thread modules the closure must reach, so an empty walk cannot pass. */
const KNOWN_MAIN_THREAD_MODULES = [
  "main/telemetry/gen-ai-request-telemetry.ts",
  "main/session/shared-agent-sessions-usage-summary.ts",
  "main/database/branch-usage-reads.ts",
  "main/cost/anthropic-keychain.ts",
] as const;

function siteKey(site: {
  file: string;
  enclosing: string;
  symbol: string;
}): string {
  return `${site.file} ${site.enclosing} ${site.symbol}`;
}

function collectUses(source: ts.SourceFile, relativeFile: string) {
  return collectSymbolUses(source, relativeFile, {
    modules: GUARDED_MODULES,
    definedHere: DEFINING_MODULES[relativeFile],
    kind: SymbolUseKind.References,
  });
}

/**
 * The guard's verdict for a scan: every use outside the allow table, every
 * allow-table entry with no use left, and every store-worker site the main
 * process loads.
 */
function guardViolations(
  uses: readonly SymbolUse[],
  allowed: readonly AllowedSite[],
  mainClosure: ReadonlySet<string>
): string[] {
  const allowedKeys = new Set(allowed.map(siteKey));
  const usedKeys = new Set(uses.map(siteKey));
  return [
    ...uses
      .filter((use) => !allowedKeys.has(siteKey(use)))
      .map(
        (use) =>
          `${use.file}:${use.line} ${use.enclosing} uses ${use.symbol}; use ${NON_BLOCKING_TWIN[use.symbol as Probe]}`
      ),
    ...allowed
      .filter((site) => !usedKeys.has(siteKey(site)))
      .map((site) => `stale allow-table entry: ${siteKey(site)}`),
    ...allowed
      .filter(
        (site) =>
          site.kind === SiteKind.StoreWorker && mainClosure.has(site.file)
      )
      .map(
        (site) =>
          `${site.file} is allowed as a store-worker site but the main process loads it`
      ),
  ];
}

function relativeClosure(): Set<string> {
  return new Set(
    [...mainImportClosure(MAIN_ENTRY)].map((file) =>
      path.relative(SRC_DIR, file).split(path.sep).join("/")
    )
  );
}

function parse(lines: readonly string[]): ts.SourceFile {
  return ts.createSourceFile(
    "fixture.ts",
    lines.join("\n"),
    ts.ScriptTarget.Latest,
    false
  );
}

describe("ISS-12120 guard: no synchronous Keychain probe on the main thread", () => {
  test("the collector reports calls and passed values, aliased or through a namespace", () => {
    const fixture = parse([
      'import { detectBillingMode, resolveBillingMode as resolve } from "../cost/billing-mode-detector.js";',
      'import * as rows from "../agent-sync/agent-session-token-cost-resolution.js";',
      'import type { hasKeychainCredentialCached } from "../cost/anthropic-keychain.js";',
      "type Mode = ReturnType<typeof detectBillingMode>;",
      "const options = { detectBillingMode: undefined as Mode | undefined };",
      "export function create(): unknown {",
      "  const detect = options.detectBillingMode ?? detectBillingMode;",
      '  resolve({ billingMode: null, harness: "claude" });',
      "  rows.resolveBillingModeForRow({});",
      "  return { detectBillingMode, detect };",
      "}",
    ]);

    const uses = collectUses(fixture, "main/fixture.ts");

    assert.deepEqual(
      uses.map(({ enclosing, symbol }) => `${enclosing} ${symbol}`),
      [
        `create ${Probe.Detect}`,
        `create ${Probe.Resolve}`,
        `create ${Probe.ResolveRow}`,
        `create ${Probe.Detect}`,
      ]
    );
  });

  test("the verdict fails an unlisted use, a stale entry and a store-worker site main loads", () => {
    const [storeSite, staleSite] = [ALLOWED_SITES[3], ALLOWED_SITES[4]];
    assert.ok(storeSite && staleSite);
    const uses: SymbolUse[] = [
      { ...storeSite, line: 1 },
      {
        file: "main/telemetry/gen-ai-request-telemetry.ts",
        enclosing: "createGenAiRequestTelemetry",
        symbol: Probe.Detect,
        line: 97,
      },
    ];

    const violations = guardViolations(
      uses,
      [storeSite, staleSite],
      new Set([storeSite.file])
    );

    assert.deepEqual(violations, [
      `main/telemetry/gen-ai-request-telemetry.ts:97 createGenAiRequestTelemetry uses ${Probe.Detect}; use detectBillingModeNonBlocking`,
      `stale allow-table entry: ${siteKey(staleSite)}`,
      `${storeSite.file} is allowed as a store-worker site but the main process loads it`,
    ]);
  });

  test("the main-process closure follows dynamic import() and reaches the known main-thread modules", () => {
    const closure = relativeClosure();

    const missing = KNOWN_MAIN_THREAD_MODULES.filter(
      (file) => !closure.has(file)
    );

    assert.deepEqual(missing, [], "the closure walk lost main-thread modules");
  });

  test("src/main and src/server reach the synchronous probe only where the allow table says", () => {
    const files = scanSourceFiles(SRC_DIR, SCANNED_ROOTS);
    assert.ok(files.length > 0, "the source scan found no files");
    const uses = files.flatMap(({ relativeFile, source }) =>
      collectUses(source, relativeFile)
    );

    assert.deepEqual(
      guardViolations(uses, ALLOWED_SITES, relativeClosure()),
      [],
      "A synchronous Keychain probe runs /usr/bin/security with execFileSync for up to 800 ms and freezes the Electron main thread (ISS-6132, ISS-12120)."
    );
  });
});
