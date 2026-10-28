/**
 * ISS-8463 / #6241 review — the operator report may not label the eligible
 * population as the KPI step a capped run actually takes.
 *
 * WHAT THIS PINS. `applyStampBackfill` clears the globally oldest `LIMIT` rows.
 * Before this fix the per-(org, repo) step was printed from the ELIGIBLE count,
 * so a run capped below the population announced a delivery-coverage delta for
 * every eligible group — including groups the cap never reached, whose realized
 * delta was zero. An operator following the script's own instruction to announce
 * the step would have reported numbers that never happened.
 *
 * Every case below asserts the printed step against the SELECTED count and
 * asserts that the eligible count is never presented as the step, so restoring
 * the old headline fails here rather than in production.
 */
import { describe, expect, it } from "vitest";
import type {
  ClearedStubRow,
  UnresolvableStubGroup,
  UnresolvableStubPopulation,
} from "../backfill-unresolvable-pr-stubs-queries";
import {
  reportPopulation,
  reportRealizedStep,
  reportRevert,
} from "../backfill-unresolvable-pr-stubs-report";
import {
  createScriptOutput,
  type ScriptOutput,
  type ScriptWritable,
} from "../script-progress-output";

const ORG = "org-1";
const REPO_BIG = "acme/widgets";
const REPO_SMALL = "acme/gadgets";

const TRUNCATED_LINE = /^TRUNCATED:/;
const STEP_LINE = /^ {2}org=/;

function group(
  repositoryFullName: string,
  eligible: number,
  selected: number,
  backlog = 0
): UnresolvableStubGroup {
  return {
    organizationId: ORG,
    repositoryFullName,
    eligibleCount: BigInt(eligible),
    selectedCount: BigInt(selected),
    desktopStubBacklog: BigInt(backlog || eligible),
  };
}

function population(
  groups: UnresolvableStubGroup[]
): UnresolvableStubPopulation {
  let eligibleTotal = 0;
  let selectedTotal = 0;
  for (const entry of groups) {
    eligibleTotal += Number(entry.eligibleCount);
    selectedTotal += Number(entry.selectedCount);
  }
  return {
    groups,
    eligibleTotal,
    selectedTotal,
    truncated: selectedTotal < eligibleTotal,
  };
}

/** Run the reporter and hand back the lines it printed. */
async function capture(
  run: (output: ScriptOutput) => Promise<void>
): Promise<string[]> {
  const lines: string[] = [];
  await run(
    createScriptOutput({
      stdout: captureStream(lines),
      stderr: captureStream(lines),
    })
  );
  return lines;
}

/** The per-group KPI step lines, in print order. */
function stepLines(lines: string[]): string[] {
  return lines.filter((line) => STEP_LINE.test(line));
}

describe("reportPopulation — eligible > LIMIT (the truncated run)", () => {
  const capped = population([
    group(REPO_BIG, 8, 5),
    // Eligible, announced, and NOT reached by the cap. Its realized step is 0.
    group(REPO_SMALL, 4, 0),
  ]);

  it("states the step at the rows this run clears, not the eligible count", async () => {
    const lines = await capture((output) =>
      reportPopulation(capped, 5, output)
    );

    expect(stepLines(lines)).toEqual([
      `  org=${ORG} repo=${REPO_BIG} -5 of 8 eligible (desktop stub backlog 8)`,
      `  org=${ORG} repo=${REPO_SMALL} -0 of 4 eligible (desktop stub backlog 4)`,
    ]);
  });

  it("never prints the eligible count as a bare step for a group the cap missed", async () => {
    const lines = await capture((output) =>
      reportPopulation(capped, 5, output)
    );

    // The old headline. `-4` for a group whose realized delta is zero is the
    // exact number an operator would have announced and been wrong about.
    expect(stepLines(lines)).not.toContain(
      `  org=${ORG} repo=${REPO_SMALL} -4 of 4 eligible (desktop stub backlog 4)`
    );
    expect(
      stepLines(lines).some((line) => line.includes(`${REPO_BIG} -8`))
    ).toBe(false);
  });

  it("declares the outcome partial and names the remainder", async () => {
    const lines = await capture((output) =>
      reportPopulation(capped, 5, output)
    );

    const truncated = lines.filter((line) => TRUNCATED_LINE.test(line));
    expect(truncated).toHaveLength(1);
    expect(truncated[0]).toContain("7 eligible row(s) are NOT cleared");
    expect(lines).toContain("Cleared by this run: 5 of 12 eligible (LIMIT 5)");
  });
});

describe("reportPopulation — eligible == LIMIT (the exact-fit run)", () => {
  const exact = population([group(REPO_BIG, 5, 5)]);

  it("states the whole population as the step and declares nothing partial", async () => {
    const lines = await capture((output) => reportPopulation(exact, 5, output));

    expect(stepLines(lines)).toEqual([
      `  org=${ORG} repo=${REPO_BIG} -5 of 5 eligible (desktop stub backlog 5)`,
    ]);
    // A LIMIT equal to the population truncates nothing; announcing a partial
    // outcome here would be its own wrong number in the other direction.
    expect(lines.some((line) => TRUNCATED_LINE.test(line))).toBe(false);
    expect(lines).toContain("Cleared by this run: 5 of 5 eligible (LIMIT 5)");
  });
});

describe("reportPopulation — eligible < LIMIT (the cap that never binds)", () => {
  const under = population([group(REPO_BIG, 2, 2), group(REPO_SMALL, 1, 1)]);

  it("clears everything eligible and declares nothing partial", async () => {
    const lines = await capture((output) => reportPopulation(under, 5, output));

    expect(stepLines(lines)).toEqual([
      `  org=${ORG} repo=${REPO_BIG} -2 of 2 eligible (desktop stub backlog 2)`,
      `  org=${ORG} repo=${REPO_SMALL} -1 of 1 eligible (desktop stub backlog 1)`,
    ]);
    expect(lines.some((line) => TRUNCATED_LINE.test(line))).toBe(false);
    expect(lines).toContain("Cleared by this run: 3 of 3 eligible (LIMIT 5)");
  });

  it("reports an uncapped run the same way, with no LIMIT to name", async () => {
    const lines = await capture((output) =>
      reportPopulation(under, null, output)
    );

    expect(lines).toContain(
      "Cleared by this run: 3 of 3 eligible (LIMIT none)"
    );
    expect(lines.some((line) => TRUNCATED_LINE.test(line))).toBe(false);
  });
});

describe("reportRealizedStep", () => {
  const cleared: ClearedStubRow[] = [
    { id: "a", organizationId: ORG, repositoryFullName: REPO_BIG },
    { id: "b", organizationId: ORG, repositoryFullName: REPO_BIG },
    { id: "c", organizationId: ORG, repositoryFullName: null },
  ];

  it("regroups the rows the apply actually cleared", async () => {
    const lines = await capture((output) =>
      reportRealizedStep(cleared, 3, output)
    );

    expect(stepLines(lines)).toEqual([
      `  org=${ORG} repo=${REPO_BIG} -2`,
      `  org=${ORG} repo=(none) -1`,
    ]);
    expect(lines.some((line) => line.includes("NOTE:"))).toBe(false);
  });

  it("says so when the run cleared fewer rows than it projected", async () => {
    // The reconciler repaired two rows between the summary and the apply. The
    // projection is now wrong and the realized grouping is what gets announced.
    const lines = await capture((output) =>
      reportRealizedStep(cleared, 5, output)
    );

    const note = lines.filter((line) => line.includes("NOTE:"));
    expect(note).toHaveLength(1);
    expect(note[0]).toContain("projected 5 row(s) and cleared 3");
  });

  it("does not print an empty grouping as a step that happened", async () => {
    const lines = await capture((output) => reportRealizedStep([], 4, output));

    expect(stepLines(lines)).toEqual([]);
    expect(lines).toContain("  (none — no row was cleared by this run)");
    expect(lines.some((line) => line.includes("projected 4 row(s)"))).toBe(
      true
    );
  });
});

describe("flushed reporter output", () => {
  it("waits for population write callbacks before printing subsequent lines", async () => {
    const lines: string[] = [];
    const stream = deferredCaptureStream(lines);
    const output = createScriptOutput({ stdout: stream, stderr: stream });
    const run = trackSettlement(
      reportPopulation(population([group(REPO_BIG, 2, 1)]), 1, output)
    );

    await Promise.resolve();

    expect(lines).toStrictEqual([
      "Eligible unresolvable factless desktop PR stubs: 2",
    ]);
    expect(run.settled).toBe(false);

    stream.resolveNextWrite();
    await Promise.resolve();

    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("Cleared by this run: 1 of 2 eligible (LIMIT 1)");
    expect(run.settled).toBe(false);

    await resolveRemainingWrites(stream);
    await run.promise;
  });

  it("waits for realized-step write callbacks before completing", async () => {
    const lines: string[] = [];
    const stream = deferredCaptureStream(lines);
    const output = createScriptOutput({ stdout: stream, stderr: stream });
    const run = trackSettlement(
      reportRealizedStep(
        [{ id: "a", organizationId: ORG, repositoryFullName: REPO_BIG }],
        1,
        output
      )
    );

    await Promise.resolve();

    expect(lines).toStrictEqual([
      "\nRealized delivery-coverage numerator step (rows actually cleared), per (org, repo):",
    ]);
    expect(run.settled).toBe(false);

    await resolveRemainingWrites(stream);
    await run.promise;
  });

  it("waits for revert write callbacks before completing", async () => {
    const lines: string[] = [];
    const stream = deferredCaptureStream(lines);
    const output = createScriptOutput({ stdout: stream, stderr: stream });
    const run = trackSettlement(
      reportRevert("run-1", { closedCount: 2, restoredCount: 1 }, output)
    );

    await Promise.resolve();

    expect(lines).toStrictEqual([
      "Reverted run run-1: 1 row(s) restored, 2 capture(s) closed.",
    ]);
    expect(run.settled).toBe(false);

    await resolveRemainingWrites(stream);
    await run.promise;
  });
});

function captureStream(lines: string[]): ScriptWritable {
  return {
    write(chunk, callback) {
      lines.push(chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk);
      callback();
      return true;
    },
  };
}

function deferredCaptureStream(lines: string[]): ScriptWritable & {
  pendingWriteCount: () => number;
  resolveNextWrite: () => void;
} {
  const callbacks: Array<() => void> = [];
  return {
    pendingWriteCount: () => callbacks.length,
    resolveNextWrite() {
      const callback = callbacks.shift();
      if (!callback) {
        throw new Error("expected a pending write callback");
      }
      callback();
    },
    write(chunk, callback) {
      lines.push(chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk);
      callbacks.push(callback);
      return false;
    },
  };
}

function trackSettlement(promise: Promise<void>) {
  const tracked = {
    settled: false,
    promise: promise.finally(() => {
      tracked.settled = true;
    }),
  };
  return tracked;
}

async function resolveRemainingWrites(stream: {
  pendingWriteCount: () => number;
  resolveNextWrite: () => void;
}) {
  for (let guard = 0; guard < 20; guard += 1) {
    if (stream.pendingWriteCount() === 0) {
      await Promise.resolve();
      if (stream.pendingWriteCount() === 0) {
        return;
      }
    }
    stream.resolveNextWrite();
    await Promise.resolve();
  }
  throw new Error("reporter did not drain deferred writes");
}
