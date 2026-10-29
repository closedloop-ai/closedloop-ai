/**
 * ISS-6688 — convert-to-install through the REAL gateway IPC, in the launched
 * Electron app.
 *
 * `catalog-convert-install-ipc.ts` has no tests of any kind. The two suites that
 * exist stop short of the boundary on both sides: `convert-install-sheet.test.tsx`
 * renders the Sheet against a `vi.fn()` stub, and `convert-engine.test.ts` calls
 * `convertInstall` with a scripted runner, so `streamRun` is never invoked. This
 * spec drives the whole chain — preload → `desktop:db:catalog-convert-install` →
 * `convertInstall` → `streamRun` → a real spawned child — against a seeded
 * catalog row.
 *
 * SCOPE NOTE, DELIBERATE AND LOAD-BEARING. The ticket asks to "drive the
 * convert-install Sheet's confirm". That is not possible: `ConvertInstallSheet`
 * has NO production render site. Its only references in the repo are its own
 * definition, its Storybook story, the design-system component catalog, and its
 * unit test — and `window.desktopApi.db.catalogConvertInstall` has no renderer
 * caller either. The feature is fully built end to end (engine, IPC handler,
 * preload bridge, component) and simply not wired to any user-reachable
 * affordance, so there is no click that reaches it. The honest boundary this
 * spec can cross is the preload IPC, which is exactly where the untested code
 * lives. That gap is reported on the ticket rather than papered over by mounting
 * the Sheet artificially — and it is why this spec is a sibling file rather than
 * part of the DOM journey in `pack-install-ui-journey.spec.ts`.
 *
 * THE FALSE-GREEN THIS SPEC IS BUILT AGAINST. The handler manufactures a
 * CONTRACT-COMPLETE error outcome for a malformed request, with the same shape as
 * a real permanent failure — and it is not the only such synthetic outcome: the
 * disabled-runtime responder builds one from the same factory whenever the Agent
 * Dashboard runtime has not started serving yet. An assertion on `state` alone,
 * or on "the promise resolved with an outcome", passes on both. So the positive
 * test asserts the fields those synthetic outcomes CANNOT carry — the seeded
 * pack's real identity, a real capability, real dropped fields, and a numeric
 * `runId` that only exists once `recordPackInstallRunStart` has written a row —
 * and a companion test pins the synthetic outcome itself, so the two are proven
 * distinguishable rather than assumed to be.
 */

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { AgentComponentKind } from "@repo/api/src/types/agent-component.ts";
import type {
  ConvertInstallOutcome,
  ConvertInstallRequest,
} from "@repo/api/src/types/convert-install.ts";
import {
  ConvertFailureClass,
  ConvertInstallState,
} from "@repo/api/src/types/convert-install.ts";
import { ConversionSupport } from "@repo/api/src/types/harness-conversion.ts";
import { HarnessName } from "@repo/api/src/types/harness-name.ts";
import type { InstallRunRecord } from "../../src/shared/agent-db-contract";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import type { HarnessHomes } from "./helpers/pack-install-fixture";
import {
  createPackInstallFixture,
  fixtureArtifactsPresent,
  makeHarnessHomes,
  removeHarnessHomes,
  waitForCatalogEntryServing,
} from "./helpers/pack-install-fixture";
import { seedPackCatalogEntry } from "./helpers/seed-pack-catalog-db";

const JOURNEY_TIMEOUT_MS = 180_000;
const RUNTIME_READY_TIMEOUT_MS = 60_000;
const SPAWN_SETTLE_TIMEOUT_MS = 60_000;

/**
 * The one `Partial` cell for a subagent: `claude → codex` drops `model` and
 * `allowedTools`. Chosen because a Partial outcome carries the richest set of
 * fields the synthetic fallback cannot fake — a non-`unsupported` capability AND
 * a non-empty `droppedFields` on both the outcome and the capability.
 */
const EXPECTED_DROPPED_FIELDS = ["model", "allowedTools"];
const COMPONENT_NAME = "closedloop-e2e-subagent";

/**
 * The preload bridge this spec drives, typed against the SHARED contract rather
 * than a hand-written shape — so a renamed or removed `ConvertInstallOutcome`
 * field fails `tsc` here instead of silently weakening an assertion.
 */
type ConvertDesktopWindow = Window & {
  desktopApi?: {
    db?: {
      catalogConvertInstall?: (
        request: unknown
      ) => Promise<ConvertInstallOutcome>;
      getInstallRuns?: (packId?: string) => Promise<InstallRunRecord[]>;
    };
  };
};

test.describe("Pack convert-install through the real gateway IPC (ISS-6688)", () => {
  test("a valid convert-install reports a Partial outcome carrying the SEEDED pack's identity and a real run id", async () => {
    test.setTimeout(JOURNEY_TIMEOUT_MS);
    const homes = makeHarnessHomes();
    const fixture = createPackInstallFixture({
      claudeHome: homes.claudeHome,
      displayName: "ClosedLoop E2E Convert Pack",
      packId: "closedloop-e2e-convert-install",
      skillName: "closedloop-e2e-convert-skill",
    });
    const launched = await launchDesktopApp({
      env: harnessHomeEnv(homes),
      userDataPrefix: "desktop-pack-convert-install-e2e-",
    });

    try {
      const { page } = launched;
      // The convert path passes `targetHarness` straight through to `streamRun`,
      // where the EXPLICIT-harness branch is a plain command-map lookup with no
      // CLI-on-PATH probe. So the row needs a `codex` command, and the run really
      // spawns on a runner with no Codex CLI — the constraint that forced the
      // pre-existing auto-harness spec to use uninstall for its spawn.
      await seedPackCatalogEntry(launched.userDataDir, {
        displayName: fixture.displayName,
        harnesses: [HarnessName.Claude, HarnessName.Codex],
        installCommands: {
          [HarnessName.Claude]: fixture.installCommand,
          [HarnessName.Codex]: fixture.installCommand,
        },
        packId: fixture.packId,
        uninstallCommands: { [HarnessName.Codex]: fixture.uninstallCommand },
      });
      await gotoNav(page, "sessions");
      await waitForCatalogEntryServing(
        page,
        fixture.packId,
        RUNTIME_READY_TIMEOUT_MS
      );

      // Typed against the canonical request contract, so a renamed or removed
      // field fails `tsc` here rather than silently sending a stale payload that
      // the handler would reject as malformed — which is precisely the synthetic
      // outcome this test exists to distinguish itself from.
      const request: ConvertInstallRequest = {
        currentHarness: HarnessName.Claude,
        kind: AgentComponentKind.Subagent,
        name: COMPONENT_NAME,
        packId: fixture.packId,
        // DISTINCT from `currentHarness` on purpose: `convertInstall` computes
        // `request.sourceHarness ?? currentHarness`, so sending the same value
        // for both would let the engine drop FEA-4028 provenance entirely and
        // still satisfy the identity assertion below.
        sourceHarness: HarnessName.Opencode,
        targetHarness: HarnessName.Codex,
      };
      const outcome = await invokeConvertInstall(page, request);

      // The terminal state. `Partial` is unreachable for every synthetic
      // outcome — `makeConvertInstallErrorOutcome` always produces `error`.
      expect(outcome.state).toBe(ConvertInstallState.Partial);
      expect(outcome.failureClass).toBeUndefined();

      // Identity carries the SEEDED pack's real values. The synthetic fallback
      // fills `EMPTY_CONVERT_IDENTITY` — every field the empty string — so this
      // is the assertion the ticket's false-green cannot survive. Asserted as a
      // whole object so a future field cannot quietly go unchecked.
      expect(outcome.identity).toEqual({
        currentHarness: HarnessName.Claude,
        id: fixture.packId,
        kind: AgentComponentKind.Subagent,
        name: COMPONENT_NAME,
        sourceHarness: HarnessName.Opencode,
        targetHarness: HarnessName.Codex,
      });

      // A real capability + real dropped fields. The synthetic outcome is always
      // `{ support: "unsupported", droppedFields: [] }` with `droppedFields: []`.
      expect(outcome.capability.support).toBe(ConversionSupport.Partial);
      expect(outcome.capability.droppedFields).toEqual(EXPECTED_DROPPED_FIELDS);
      expect(outcome.droppedFields).toEqual(EXPECTED_DROPPED_FIELDS);

      // A numeric run id. Structurally impossible for any synthetic outcome to
      // carry, and it exists only because `recordPackInstallRunStart` wrote an
      // audit row for the seeded pack after every preflight gate passed.
      expect(typeof outcome.runId).toBe("number");
      expect(outcome.runId).toBeGreaterThan(0);

      // The run really spawned: the seeded command's own artifacts appear on
      // disk. Checked from the TEST process, so no app API can vouch for itself.
      await expect
        .poll(() => fixtureArtifactsPresent(fixture), {
          timeout: SPAWN_SETTLE_TIMEOUT_MS,
        })
        .toBe(true);
    } finally {
      await launched.cleanup();
      removeHarnessHomes(homes);
    }
  });

  test("a malformed convert-install request returns the synthetic permanent outcome, which carries NONE of a real run's identity", async () => {
    test.setTimeout(JOURNEY_TIMEOUT_MS);
    const homes = makeHarnessHomes();
    const fixture = createPackInstallFixture({
      claudeHome: homes.claudeHome,
      displayName: "ClosedLoop E2E Convert Reject Pack",
      packId: "closedloop-e2e-convert-reject",
      skillName: "closedloop-e2e-convert-skill",
    });
    const launched = await launchDesktopApp({
      env: harnessHomeEnv(homes),
      userDataPrefix: "desktop-pack-convert-reject-e2e-",
    });

    try {
      const { page } = launched;
      await seedPackCatalogEntry(launched.userDataDir, {
        displayName: fixture.displayName,
        harnesses: [HarnessName.Codex],
        installCommands: { [HarnessName.Codex]: fixture.installCommand },
        packId: fixture.packId,
        uninstallCommands: {},
      });
      await gotoNav(page, "sessions");
      // Gate on the runtime SERVING before sending the malformed request. The
      // disabled-runtime responder builds an outcome from the same factory, so
      // without this gate a passing assertion here could be describing a
      // not-yet-started runtime instead of the schema rejection under test.
      await waitForCatalogEntryServing(
        page,
        fixture.packId,
        RUNTIME_READY_TIMEOUT_MS
      );

      // `kind` is not an `AgentComponentKind`, so `safeParse` fails and the
      // handler never reaches the engine.
      const outcome = await invokeConvertInstall(page, {
        currentHarness: HarnessName.Claude,
        kind: "not-a-component-kind",
        name: COMPONENT_NAME,
        packId: fixture.packId,
        targetHarness: HarnessName.Codex,
      });

      expect(outcome.state).toBe(ConvertInstallState.Error);
      expect(outcome.failureClass).toBe(ConvertFailureClass.Permanent);

      // The point of this test: the synthetic outcome carries NONE of the real
      // values, even though the request named a genuinely seeded pack. This is
      // what proves the positive test's identity assertions actually
      // discriminate rather than being satisfied by whatever the handler returns.
      expect(outcome.identity.id).toBe("");
      expect(outcome.identity.name).toBe("");
      expect(outcome.identity.id).not.toBe(fixture.packId);
      expect(outcome.capability.support).toBe(ConversionSupport.Unsupported);
      expect(outcome.droppedFields).toEqual([]);
      expect(outcome.runId).toBeUndefined();

      // And nothing spawned — a rejected request must not reach `streamRun`.
      //
      // Asserted on the install-run ROW, not on the command's on-disk artifacts.
      // `streamRun` does not await `spawnAndStream`; it returns as soon as the
      // child is spawned, so the artifacts are still unwritten at the instant
      // this promise resolves and a synchronous `fixtureArtifactsPresent` check
      // would read `false` whether or not a child was spawned — a textbook
      // cannot-fail assertion. `recordPackInstallRunStart` runs BEFORE the spawn
      // and is awaited, so an empty run list is genuinely settled here and is
      // what a spawn would have to contradict.
      expect(await readInstallRunActions(page, fixture.packId)).toEqual([]);
    } finally {
      await launched.cleanup();
      removeHarnessHomes(homes);
    }
  });
});

/**
 * The launch env for a convert-install launch.
 *
 * Points the app at the isolated homes {@link makeHarnessHomes} created, which
 * is what keeps the boot collectors off the operator's real agent history.
 * `SKIP_CATALOG_DETECTORS` short-circuits the per-pack detector table, whose
 * probes shell out to a login shell and `npm ls -g`.
 */
function harnessHomeEnv(homes: HarnessHomes): Record<string, string> {
  return {
    ...homes.env,
    SKIP_CATALOG_DETECTORS: "1",
  };
}

/**
 * Call the real convert-install IPC from the launched renderer.
 *
 * The parameter stays deliberately wide: one caller sends a valid
 * {@link ConvertInstallRequest} (type-checked at its own call site) and the other
 * sends a DELIBERATELY malformed payload, which is the whole point of the
 * companion test and cannot be expressed by the request type.
 */
function invokeConvertInstall(
  page: Page,
  request: ConvertInstallRequest | Record<string, unknown>
): Promise<ConvertInstallOutcome> {
  return page.evaluate(async (payload) => {
    const call = (window as ConvertDesktopWindow).desktopApi?.db
      ?.catalogConvertInstall;
    if (!call) {
      throw new Error("desktopApi.db.catalogConvertInstall is unavailable");
    }
    return await call(payload);
  }, request);
}

/**
 * The recorded install-run actions for a pack.
 *
 * `recordPackInstallRunStart` is awaited before `streamRun` spawns anything, so
 * this list is authoritative the moment the IPC promise resolves — unlike the
 * spawned command's on-disk output, which is still being written.
 */
async function readInstallRunActions(
  page: Page,
  packId: string
): Promise<string[]> {
  return await page.evaluate(async (id) => {
    const db = (window as ConvertDesktopWindow).desktopApi?.db;
    if (!db?.getInstallRuns) {
      throw new Error("desktopApi.db.getInstallRuns is unavailable");
    }
    const runs = await db.getInstallRuns(id);
    return runs.map((run) => run.action);
  }, packId);
}
