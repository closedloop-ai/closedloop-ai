/**
 * FEA-1718 back-link unit coverage: the pure `resolveLoopSessionBacklink`
 * decision, and the SHAPE of the claim — release-then-claim, both statements in
 * ONE transaction, nothing caught inside it.
 *
 * The SQL SEMANTICS (earliest-`sessionStartedAt` wins, superseded-loop release,
 * org scoping, the guard that stops a bogus target loop from releasing a real
 * link) are pinned against a REAL Postgres in
 * `apps/api/__tests__/integration/loop-session-artifact-backlink.test.ts`. A
 * mocked `$executeRaw` cannot evaluate a predicate, so asserting semantics here
 * would only re-assert the string this file already contains.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  linkLoopSessionArtifact,
  resolveLoopSessionBacklink,
} from "./loop-session-backlink";

const txMock = vi.fn();

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), {
    tx: (...args: unknown[]) => txMock(...args),
  }),
}));

const ORGANIZATION_ID = "019f0000-0000-7000-8000-0000000000a1";
const LOOP_ID = "019f0000-0000-7000-8000-0000000000b2";
const SESSION_ARTIFACT_ID = "019f0000-0000-7000-8000-0000000000c3";

type CapturedStatement = { sql: string; values: unknown[] };

let statements: CapturedStatement[];

/**
 * Runs the real transaction callback against a fake client that records each
 * `$executeRaw`, so the ORDER and the parameters of the two statements are
 * observable without a database.
 */
function installTx(claimRowCount: number): void {
  txMock.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({
      $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        statements.push({ sql: strings.join("?"), values });
        return Promise.resolve(statements.length === 1 ? 0 : claimRowCount);
      },
    })
  );
}

function buildBacklink() {
  return {
    loopId: LOOP_ID,
    organizationId: ORGANIZATION_ID,
    sessionArtifactId: SESSION_ARTIFACT_ID,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  statements = [];
  installTx(1);
});

describe("resolveLoopSessionBacklink", () => {
  it("describes the claim when the committed row names a loop", () => {
    expect(
      resolveLoopSessionBacklink({
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: SESSION_ARTIFACT_ID,
        sourceLoopId: LOOP_ID,
      })
    ).toEqual(buildBacklink());
  });

  it("returns nothing for a session with no source loop", () => {
    expect(
      resolveLoopSessionBacklink({
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: SESSION_ARTIFACT_ID,
        sourceLoopId: null,
      })
    ).toBeNull();
  });

  it("drops a source loop id a version-skewed desktop sent as free text", () => {
    // `Loop.id` is a uuid column; handing Postgres "loop-1" raises 22P02 instead
    // of simply not matching, so the value is rejected before it gets there.
    expect(
      resolveLoopSessionBacklink({
        organizationId: ORGANIZATION_ID,
        sessionArtifactId: SESSION_ARTIFACT_ID,
        sourceLoopId: "loop-1",
      })
    ).toBeNull();
  });
});

describe("linkLoopSessionArtifact", () => {
  it("releases superseded loops before claiming, in one transaction", async () => {
    const claimed = await linkLoopSessionArtifact(buildBacklink());

    expect(claimed).toBe(true);
    // ONE transaction: a release that committed without its claim would drop a
    // link and put nothing back.
    expect(txMock).toHaveBeenCalledTimes(1);
    expect(statements).toHaveLength(2);
    // Order is load-bearing — the unique index is on session_artifact_id
    // globally, so the stale holder must let go before the new claim can land.
    expect(statements[0].sql).toContain('SET "session_artifact_id" = NULL');
    expect(statements[1].sql).toContain(
      'SET "session_artifact_id" = mine."artifact_id"'
    );
  });

  it("scopes both statements to the caller's organization", async () => {
    await linkLoopSessionArtifact(buildBacklink());

    // `sourceLoopId` is caller-supplied, so an unscoped statement would let one
    // tenant's sync mutate another tenant's loop.
    for (const statement of statements) {
      expect(statement.values).toContain(ORGANIZATION_ID);
      expect(statement.values).toContain(LOOP_ID);
      expect(statement.values).toContain(SESSION_ARTIFACT_ID);
    }
  });

  it("reports no claim when the earliest-wins comparison rejects this session", async () => {
    installTx(0);

    expect(await linkLoopSessionArtifact(buildBacklink())).toBe(false);
  });

  it("propagates a failure rather than reporting a claim it did not make", async () => {
    // The batch caller owns the best-effort downgrade (and the metric); this
    // function must not silently report success on a rolled-back transaction.
    txMock.mockRejectedValue(new Error("connection reset"));

    await expect(linkLoopSessionArtifact(buildBacklink())).rejects.toThrow(
      "connection reset"
    );
  });
});
