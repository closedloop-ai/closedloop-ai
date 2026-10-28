// gardener-support: test and story data, not shipped
import { describe, expect, it } from "vitest";

/**
 * ISS-9544 — the both-host half of PRD-711's per-defect requirement, executed
 * rather than re-derived.
 *
 * A `@repo/app` surface is mounted by two shells that share nothing but the
 * component and the flag key: since ISS-8753 both shells resolve the signed-in
 * account's assignment for the SAME PostHog key, so what differs is the module
 * graph and the provider stack each one resolves that key through — not the
 * gate. An adopter must not register or mock a desktop Labs entry beside it;
 * `packages/app/AGENTS.md` records that where a Labs row still exists for a
 * shared key it is residue that no longer gates the surface, and mocking it
 * would make "both-host" coverage exercise configuration production never
 * reads. Every defect this pack has produced landed in
 * that gap — a shared hook edited with no `packages/app` test that mounts its
 * desktop consumer, a helper matching a selector only one shell emits, a lane
 * that read `git grep` under `apps/desktop/src` as "desktop does not render
 * this" while the render path went `BranchesView` → `BranchesListSurfaceV2` →
 * `ApprovedBranchesTable`.
 *
 * The sibling static guard (`surface-capability-parity.ts`, ISS-9218) reads
 * DECLARATIONS off disk: which optional props each host's JSX passes. It cannot
 * see what a shell actually renders. This runs the other half — one fixture
 * set, one set of expectations, executed against each shell's real mount inside
 * that shell's own suite, so a divergence reddens in the shell that diverged.
 *
 * Adopting it on a new defect is a CASE, not a rig: the per-shell mount already
 * exists in each suite, and a fix adds a fixture plus the state both shells owe
 * the reader.
 *
 * A divergence is CHECKED, not believed — the same reason the capability ledger
 * verifies `inertWithout` against its companion rather than grading a sentence.
 * A host named as diverging must actually FAIL the shared expectation; the day
 * it starts satisfying it, the stale entry reddens instead of quietly excusing
 * the shell forever.
 */

/** The two shells that mount `@repo/app`'s shared surfaces. */
export const WEB_HOST = "web";
export const DESKTOP_HOST = "desktop";
export type BothHostName = typeof WEB_HOST | typeof DESKTOP_HOST;

export type BothHostCase<TFixture> = {
  /** Names the STATE, not the shell — both hosts run the same case. */
  readonly name: string;
  /** The identical input both shells are mounted over. */
  readonly fixture: TFixture;
  /**
   * Runs after the host has mounted `fixture` and answers why this host's DOM
   * does not show the state, or nothing when it does.
   *
   * Handed the SAME fixture that was mounted, so a reader cannot assert over a
   * different one. Reading a module constant instead would pass today, when
   * every case shares one fixture, and go quietly wrong on the first case that
   * does not — which is precisely how a defect fix "adds one fixture".
   *
   * A returned SENTENCE rather than a thrown assertion: the divergence branch
   * below reads the absence as evidence, and an unrelated throw — a provider
   * this shell stopped supplying — must reach the runner as an error rather
   * than be laundered into "this shell is excused".
   */
  readonly renderProblem: (fixture: TFixture) => Promise<string | undefined>;
  /**
   * Hosts that genuinely cannot render this state, each with what that shell
   * lacks. Verified against the mounted DOM, never taken on trust.
   */
  readonly divergence?: Readonly<Partial<Record<BothHostName, string>>>;
};

export type BothHostRenderContract<TFixture> = {
  /** Named verbatim in every failure, so a red run says which surface. */
  readonly surface: string;
  readonly cases: readonly BothHostCase<TFixture>[];
};

/**
 * Everything wrong with the contract itself, from `host`'s side — the checks
 * that stop a contract this host cannot fail.
 */
export function contractShapeProblems<TFixture>({
  contract,
  host,
}: {
  contract: BothHostRenderContract<TFixture>;
  host: BothHostName;
}): string[] {
  const { cases, surface } = contract;
  if (cases.length === 0) {
    return [
      `${surface}: the both-host contract carries no case, so mounting ${host} asserts nothing about it.`,
    ];
  }
  const problems: string[] = [];
  if (cases.every((entry) => entry.divergence?.[host] !== undefined)) {
    problems.push(
      `${surface}: every case names ${host} as diverging, so this host is only ever asserted to FAIL and nothing pins what it does render. Keep at least one state both shells owe the reader.`
    );
  }
  for (const entry of cases) {
    const reason = entry.divergence?.[host];
    if (reason !== undefined && reason.trim().length === 0) {
      problems.push(
        `${surface}: case "${entry.name}" names ${host} as diverging with no reason. State what this shell lacks.`
      );
    }
  }
  return problems;
}

/** What is wrong with ONE case on ONE host after mounting it, or nothing. */
export async function caseOutcomeProblem<TFixture>({
  contract,
  host,
  mount,
  testCase,
}: {
  contract: BothHostRenderContract<TFixture>;
  host: BothHostName;
  mount: (fixture: TFixture) => Promise<void> | void;
  testCase: BothHostCase<TFixture>;
}): Promise<string | undefined> {
  await mount(testCase.fixture);
  const failure = await testCase.renderProblem(testCase.fixture);
  const reason = testCase.divergence?.[host];
  if (reason === undefined) {
    return failure === undefined
      ? undefined
      : `${contract.surface}: ${host} does not render "${testCase.name}" from the shared fixture, and no divergence entry says it cannot — ${failure}`;
  }
  if (failure !== undefined) {
    return undefined;
  }
  return `${contract.surface}: case "${testCase.name}" claims ${host} diverges ("${reason}"), but ${host} renders it. Drop the divergence entry — a claim nothing checks is how two shells drift apart behind a green suite.`;
}

/**
 * The element(s) `query` finds, or nothing when the DOM genuinely has none.
 *
 * Only ABSENCE is swallowed. A blanket `catch` would turn every other failure —
 * "Found multiple elements", a torn-down jsdom, a provider that stopped being
 * supplied — into the same absence sentence, and `caseOutcomeProblem` reads any
 * sentence as proof that a declared divergence is real. That is the laundering
 * the runner refuses one level up, so a reader must not reintroduce it.
 */
export async function foundOrAbsent<T>(
  query: () => Promise<T>
): Promise<T | undefined> {
  try {
    return await query();
  } catch (error) {
    if (error instanceof Error && ABSENT_FROM_DOM.test(error.message)) {
      return undefined;
    }
    throw error;
  }
}

/** Testing Library's not-found wording. "Found multiple" is NOT this. */
const ABSENT_FROM_DOM = /^Unable to find/;

/**
 * Run `contract` against one shell's own mount, from inside that shell's suite.
 *
 * Each shell keeps its adapter half — its providers, its gate mocks, its module
 * graph — and supplies only `mount`. Everything the reader is owed lives in the
 * contract, once.
 */
export function runBothHostContract<TFixture>({
  contract,
  host,
  mount,
}: {
  contract: BothHostRenderContract<TFixture>;
  host: BothHostName;
  mount: (fixture: TFixture) => Promise<void> | void;
}): void {
  describe(`${contract.surface} both-host contract on ${host}`, () => {
    it("is a contract this host can fail", () => {
      expect(contractShapeProblems({ contract, host })).toStrictEqual([]);
    });

    it.each(contract.cases.map((entry) => [entry.name, entry] as const))(
      "%s",
      async (_name, testCase) => {
        expect(
          await caseOutcomeProblem({ contract, host, mount, testCase })
        ).toBeUndefined();
      }
    );
  });
}
