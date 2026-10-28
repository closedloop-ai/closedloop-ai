#!/usr/bin/env tsx
/**
 * ISS-9846 (PRD-707 R1) — the STANDING COUNTERFACTUAL HARNESS for the
 * desktop→cloud contract replay layer.
 *
 * A replay suite that cannot fail is worse than none, and the only way to know
 * whether this one would have caught the incidents it names is to put each
 * incident back and watch it red. This harness does exactly that: for each entry
 * below it reintroduces the defect as a one-line source mutation, runs the
 * replay suite, requires a NON-ZERO exit, and restores the file — whatever the
 * outcome.
 *
 * Deliberately a script and not a test. It edits production source in the
 * working tree, so a CI lane that ran it would be racing every other lane in the
 * same checkout; and one run costs a whole integration-suite execution per
 * entry. Run it under the ticket that changes this layer, and paste the table it
 * prints into the PR.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app \
 *     pnpm --filter api exec tsx scripts/contract-replay-counterfactual.ts
 *
 * Name one or more incidents to run a subset:
 *
 *   … scripts/contract-replay-counterfactual.ts ISS-8271 ISS-8780
 *
 * A silent no-op mutation is the failure mode this harness exists to avoid, so
 * an anchor that does not appear EXACTLY once in its file aborts the run rather
 * than reporting "the layer does not guard this".
 *
 * ISS-8049 has no entry. It is a CloudRelay transport failure that never reaches
 * a route handler, so no source mutation on this side can reproduce it; PRD-707
 * D2 (ISS-9166) owns it. That is the documented gap, and the harness prints it
 * rather than quietly covering four of five.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `fileURLToPath(import.meta.url)`, not `import.meta.dirname`: tsx transforms
// this file to CJS, where the latter is undefined and every path below silently
// resolves against nothing.
const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = resolve(API_ROOT, "../..");
const REPLAY_SUITE =
  "__tests__/integration/iss9846-desktop-contract-replay.integration.test.ts";

/**
 * The advisory-lock statement as it appears in the source, for one Prisma raw
 * method. Built rather than written as a plain string because the source it must
 * match verbatim contains a template interpolation, which a string literal
 * carrying `${…}` cannot hold without tripping `noTemplateCurlyInString`; here
 * the escape says plainly that the placeholder is source text, not a bug.
 */
function advisoryLockStatement(rawMethod: "$executeRaw" | "$queryRaw"): string {
  return `    await tx.${rawMethod}\`SELECT pg_advisory_xact_lock(hashtext(\${lockKey}))\`;`;
}

type Counterfactual = {
  /** The incident this mutation reintroduces. */
  incident: string;
  /**
   * What this mutation is expected to do TODAY.
   *
   * `red` is the normal case: the defect is reproducible and the layer must
   * catch it. `not-reproducible` records a mutation that no longer reproduces
   * its incident because the environment moved under it — the entry stays so a
   * regression is noticed, and `reason` says what the evidence was. Recorded as
   * a field rather than dropped, because an incident silently missing from this
   * table reads as one nobody thought about.
   */
  expect: "red" | "not-reproducible";
  /** Why an entry is `not-reproducible`; empty for a `red` entry. */
  reason?: string;
  /** Repo-root-relative file the mutation edits. */
  file: string;
  /** Exact text to replace; must occur exactly once. */
  find: string;
  /** The defect, put back. */
  replace: string;
  /** What the mutation does to production behaviour. */
  why: string;
};

export const COUNTERFACTUALS: readonly Counterfactual[] = [
  {
    incident: "ISS-8271",
    expect: "red",
    file: "apps/api/lib/desktop-agent-sessions-schema.ts",
    find: "  dataRevision: z.number().int().nullish(),",
    replace: "  dataRevision: z.number().int().min(1).nullish(),",
    why: "Restores the wire-schema floor that rejected the desktop's local sentinel revisions (-1 import-pending, 0 maintenance-stale). The parse is batch-wide, so one sentinel row 400s the whole delivery.",
  },
  {
    incident: "ISS-8051",
    expect: "red",
    file: "apps/api/lib/desktop-agent-sessions-schema.ts",
    find: "  tokenEvents: z.array(syncedAgentSessionTokenEventSchema).optional(),",
    replace:
      "  tokenEvents: z.array(syncedAgentSessionTokenEventSchema).max(10_000).optional(),",
    why: "Restores the 10,000-element cardinality cap. A `.max()` on a Zod array rejects rather than truncates, so a session one event over loses its events, agents, metadata and tiling on every retry.",
  },
  {
    incident: "ISS-8069 / ISS-8125",
    expect: "red",
    file: "apps/api/app/agent-sessions/service/component-usage.ts",
    find: "    const componentKey = projectIndexKey(usage.componentKey);",
    replace:
      "    const componentKey = { projected: false, value: usage.componentKey };",
    why: "Sends the raw component-usage key to the write. `idx_acsu_session_kind_key_branch` is a plain btree over `component_key`, so an over-budget high-entropy value raises `index row size N exceeds btree version 4 maximum 2704` and the component fan-out — which is not one transaction — commits some rows and abandons the rest, forever, on a batch the desktop keeps retrying.",
  },
  {
    incident: "ISS-8780 / #6576",
    expect: "red",
    file: "apps/api/app/agent-sessions/service/artifact-links/internal-branch-target.ts",
    find: advisoryLockStatement("$executeRaw"),
    replace: advisoryLockStatement("$queryRaw"),
    why: "Takes the branch-identity advisory lock as a row-returning query. `pg_advisory_xact_lock()` returns void, which Prisma cannot deserialize, so the call throws on every execution and the whole ingest slice fails.",
  },
  {
    incident: "ISS-8267",
    // MEASURED 2026-09-09 against Prisma 7.10 on Postgres 16.13, and it is a
    // statement about PRISMA, not about Postgres: the engine still raises 42P10
    // for a bare-column arbiter over a partial unique (`ON CONFLICT (a)` against
    // `CREATE UNIQUE INDEX … WHERE act IS NOT NULL`) and still accepts the
    // predicate-qualified form, so the hazard is intact. What changed is that
    // Prisma 7.10 no longer emits the bare arbiter — the mutation below, even
    // written to name the partial unique's column DIRECTLY (`where: {
    // agentSessionId }`), completes without error. So this entry cannot red the
    // layer today. It stays because a Prisma regression would make it red again,
    // and because ISS-8267 missing from this table would read as an incident
    // nobody considered. The live guards are the
    // `no-partial-unique-upsert` source gate plus
    // `__tests__/integration/partial-unique-upsert-arbiter-realdb.test.ts`,
    // pinned to a Prisma range by
    // `scripts/lint/partial-unique-upsert-prisma-version-contract.test.ts`.
    expect: "not-reproducible",
    reason:
      "Prisma 7.10 no longer emits a bare-column ON CONFLICT arbiter for a partial unique, so reintroducing the native upsert — including one keyed directly on `agentSessionId` — completes without 42P10. Postgres itself still rejects that arbiter (positive control run 2026-09-09), so the defect class is alive and only Prisma's SQL generation moved.",
    file: "apps/api/app/agent-sessions/service/component-invocations.ts",
    find: `  const existing = await tx.agentComponentInvocationGeneration.findUnique({
    where: generationIdentityWhere(agentSessionId, part),
    select: { id: true },
  });`,
    replace: `  const existing = await tx.agentComponentInvocationGeneration.upsert({
    where: generationIdentityWhere(agentSessionId, part),
    create: {
      agentSessionId,
      externalGenerationId: part.externalGenerationId,
      sourceUpdatedAt: new Date(part.sourceUpdatedAt),
      dataRevision: part.dataRevision,
      sourceSequence: part.sourceSequence,
      expectedPartCount: part.partCount,
    },
    update: {},
    select: { id: true },
  });`,
    why: "Restores the Prisma native upsert on a model carrying the partial unique `idx_acig_one_active_per_session`. Prisma arbitrates on the partial index's column instead of the identity in `where`, and Postgres answers 42P10 at SQL generation time, on every call.",
  },
];

/** The one gap, printed rather than omitted. */
const DOCUMENTED_GAP = {
  incident: "ISS-8049",
  reason:
    "A CloudRelay transport failure. The payload never reaches a Next.js route handler, so no source mutation on the API side can reproduce it and no fixture replayed through POST can catch it. PRD-707 D2 (ISS-9166) and its relay stretch item own this one.",
};

type Outcome = {
  incident: string;
  expect: Counterfactual["expect"];
  redded: boolean;
  detail: string;
};

export function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/**
 * Room for the whole vitest run's output.
 *
 * Node's default `maxBuffer` is 1 MiB and OVERFLOWING IT KILLS THE CHILD with
 * ENOBUFS, which `execFileSync` raises exactly like a non-zero exit. This
 * harness scores a throw as "the layer caught the defect", so a verbose run
 * would be recorded as a RED it never earned — the one failure mode a
 * counterfactual harness must not have. Matches `scripts/exec-turbo.ts`.
 */
const REPLAY_SUITE_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

/**
 * Run the replay suite; true when it PASSED.
 *
 * Throws on ENOBUFS rather than reporting it as a failure: an output overflow
 * says nothing about whether the mutation was caught, and silently scoring it
 * as a catch is how this harness would start lying.
 */
function replaySuitePasses(): { passed: boolean; tail: string } {
  try {
    const stdout = execFileSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.config.integration.mts",
        "--no-file-parallelism",
        REPLAY_SUITE,
      ],
      {
        cwd: API_ROOT,
        encoding: "utf8",
        maxBuffer: REPLAY_SUITE_MAX_BUFFER_BYTES,
        stdio: "pipe",
      }
    );
    return { passed: true, tail: lastLines(stdout) };
  } catch (error) {
    const output = error as {
      code?: string;
      stdout?: string;
      stderr?: string;
    };
    // Node's own code for the buffer overflow above.
    if (output.code === "ENOBUFS") {
      throw new Error(
        `the replay suite produced more than ${REPLAY_SUITE_MAX_BUFFER_BYTES} bytes and was killed; this is NOT evidence the layer caught anything. Raise REPLAY_SUITE_MAX_BUFFER_BYTES and re-run.`
      );
    }
    return {
      passed: false,
      tail: lastLines(`${output.stdout ?? ""}${output.stderr ?? ""}`),
    };
  }
}

function lastLines(text: string, count = 12): string {
  return text.trim().split("\n").slice(-count).join("\n");
}

/**
 * Restore `path` to `original`, and keep doing it if the process is killed.
 *
 * `finally` covers a throw; it does NOT cover SIGINT or SIGTERM, and this
 * harness edits PRODUCTION SOURCE in the working tree. An operator who hits
 * Ctrl-C mid-run would otherwise be left with a silently mutated schema or
 * service file, which is the worst outcome this script can have — worse than
 * any wrong verdict, because nothing announces it.
 */
function withSignalRestore(path: string, original: string): () => void {
  const restore = (): void => {
    writeFileSync(path, original, "utf8");
  };
  const onSignal = (signal: NodeJS.Signals) => () => {
    restore();
    process.stderr.write(
      `\n[contract-replay-counterfactual] ${signal}: restored ${path}\n`
    );
    process.exit(130);
  };
  const handlers: [NodeJS.Signals, () => void][] = [
    ["SIGINT", onSignal("SIGINT")],
    ["SIGTERM", onSignal("SIGTERM")],
  ];
  for (const [signal, handler] of handlers) {
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
}

function runOne(counterfactual: Counterfactual): Outcome {
  const path = resolve(REPO_ROOT, counterfactual.file);
  const original = readFileSync(path, "utf8");
  const found = occurrences(original, counterfactual.find);
  if (found !== 1) {
    // A mutation that lands nowhere produces a confident, false "the layer does
    // not guard this", so this is fatal rather than a skipped row.
    throw new Error(
      `${counterfactual.incident}: anchor occurs ${found} time(s) in ${counterfactual.file}, expected exactly 1. The source moved; update the anchor before trusting any result from this harness.`
    );
  }

  process.stdout.write(`\n=== ${counterfactual.incident} ===\n`);
  const releaseSignalRestore = withSignalRestore(path, original);
  try {
    writeFileSync(
      path,
      original.replace(counterfactual.find, counterfactual.replace),
      "utf8"
    );
    const { passed, tail } = replaySuitePasses();
    return {
      incident: counterfactual.incident,
      expect: counterfactual.expect,
      redded: !passed,
      detail: tail,
    };
  } finally {
    // Restored from the exact bytes read above, never from git — a `git
    // checkout` here would discard unrelated uncommitted work in the tree.
    writeFileSync(path, original, "utf8");
    releaseSignalRestore();
  }
}

function main(): void {
  const requested = new Set(process.argv.slice(2));
  const selected =
    requested.size === 0
      ? COUNTERFACTUALS
      : COUNTERFACTUALS.filter((entry) =>
          [...requested].some((name) => entry.incident.includes(name))
        );
  if (selected.length === 0) {
    throw new Error(
      `no counterfactual matches ${JSON.stringify([...requested])}; known: ${COUNTERFACTUALS.map((entry) => entry.incident).join(", ")}`
    );
  }

  // Establish the baseline first. A suite that is already red makes every
  // "redded" verdict below meaningless.
  process.stdout.write("=== baseline (unmutated) ===\n");
  const baseline = replaySuitePasses();
  if (!baseline.passed) {
    throw new Error(
      `the replay suite is already failing, so no counterfactual result would mean anything:\n${baseline.tail}`
    );
  }

  const outcomes = selected.map(runOne);

  process.stdout.write("\n=== counterfactual results ===\n");
  for (const outcome of outcomes) {
    if (outcome.expect === "not-reproducible") {
      process.stdout.write(
        `${outcome.redded ? "RED (unexpectedly reproducible again)" : "GREEN (expected — documented non-reproducer)"} ${outcome.incident}\n`
      );
      continue;
    }
    process.stdout.write(
      `${outcome.redded ? "RED   " : "GREEN "} ${outcome.incident}\n`
    );
    if (!outcome.redded) {
      process.stdout.write(
        `  the layer did NOT catch this:\n${outcome.detail}\n`
      );
    }
  }
  process.stdout.write(
    `\nDOCUMENTED GAP ${DOCUMENTED_GAP.incident}: ${DOCUMENTED_GAP.reason}\n`
  );

  // Only a `red`-expected entry that stayed green is a failure. A
  // `not-reproducible` entry that suddenly reds is reported above and is good
  // news, not a broken harness.
  const missed = outcomes.filter(
    (outcome) => outcome.expect === "red" && !outcome.redded
  );
  if (missed.length > 0) {
    process.exitCode = 1;
  }
}

// Guarded so the anchor test can import `COUNTERFACTUALS` without this script
// mutating production source and running the whole integration suite on import.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
