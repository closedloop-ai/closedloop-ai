/**
 * ISS-7661 — launched-app regression for the desktop half of the Sessions
 * read-failure contract (ISS-7519 / ISS-7528).
 *
 * query-core's error reducer never clears `data`, so a refetch that fails after a
 * read has already SUCCEEDED reports `isError === true` while the succeeded
 * result is still on screen. The desktop Sessions surface must keep rendering
 * that held result — here the neutral "No sessions yet" empty of a profile that
 * genuinely has none — and must never dress a failed BACKGROUND read as the hard
 * "Couldn't load sessions" outage card.
 *
 * The renderer suite (`sessions-view-read-failure-states.test.tsx`) already pins
 * that derivation against a real TanStack observer, but it mounts `SessionsView`
 * against MOCKED data sources. What it cannot prove — and what
 * `apps/desktop/test/AGENTS.md` asks a UI bug fix to carry — is that the real
 * chain `ipcMain handler -> preload bridge -> local data source -> react-query ->
 * mounted view` renders it that way in the launched app. That is this spec.
 *
 * Everything here is the real thing except one input: a local SQLite read that
 * fails on demand, AFTER a successful one. There is no HTTP on this path, so
 * `page.route` intercepts nothing; `helpers/sessions-list-failure-gate.ts`
 * substitutes it at the IPC response boundary the renderer actually consumes. The
 * injected failure is deliberately NON-transient — a db-host lifecycle error
 * routes to the quiet "Getting your sessions ready" surface and auto-retries,
 * which is a different contract with its own coverage.
 *
 * SCOPE, stated rather than implied: once armed, EVERY read fails. A single
 * failure would let the surface recover before the negative assertions ran, which
 * would make them pass for the wrong reason; holding it failed for the whole
 * assertion window makes "the outage card never appears" a claim about a STATE.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import { expect, test } from "@playwright/test";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";
import {
  armSessionsListFailure,
  readSessionsListFailureGateStats,
} from "./helpers/sessions-list-failure-gate";

/**
 * Copy pinned as hand-written literals, deliberately not imported from the
 * component that emits it: importing would let a copy change silently rewrite
 * this spec's expectation about WHICH state rendered. Same choice as the
 * renderer suite this complements.
 *
 * Local mode IS the connected agent, so `useDesktopHasConnectedAgent` forces the
 * signal true and a genuinely-empty profile renders the NEUTRAL copy, never the
 * connect-a-target onboarding CTA.
 */
const NEUTRAL_EMPTY_TITLE = "No sessions yet";
const OUTAGE_TITLE = "Couldn't load sessions";
const SYNCING_TITLE = "Getting your sessions ready";

const MOUNT_TIMEOUT_MS = 120_000;

/**
 * `MAX_TRANSIENT_QUERY_RETRIES` (`@repo/app/shared/query/query-client`) + the
 * original attempt. Pinned as a LITERAL rather than imported, for the same reason
 * `sessions-page-data-gate.ts` pins it: an extension-less `@repo/*` subpath does
 * not resolve under Playwright's ESM loader, and importing one from a spec aborts
 * the WHOLE desktop-e2e suite at load time.
 *
 * Waiting for this many failures is what proves the read has SETTLED errored
 * rather than still being mid-retry — the settled state is the one whose render
 * ISS-7519 changed. Drift fails loudly rather than silently: a cap that grew
 * would simply take one more poll cycle to reach, and a cap that shrank leaves
 * the poll waiting on failures the retry chain no longer produces.
 */
const SETTLED_FAILURE_COUNT = 3;

test.describe("Sessions refetch failure over held data (ISS-7661)", () => {
  test("keeps the held empty state and never renders the outage card", async () => {
    test.setTimeout(300_000);

    const app = await launchDesktopApp({ sessionsListFailureGate: true });
    try {
      await gotoNav(app.page, "sessions");

      // The SUCCEEDED read the failure below has to happen OVER. Without this the
      // spec would be asserting the plain first-load error path, which is a
      // different (and differently-rendered) contract.
      await expect(app.page.getByText(NEUTRAL_EMPTY_TITLE).first()).toBeVisible(
        {
          timeout: MOUNT_TIMEOUT_MS,
        }
      );

      // Non-vacuity, read from the gate rather than inferred from the render: the
      // real IPC read really did answer at least once before anything failed, so
      // there IS held data for the failure to land over.
      const armed = await armSessionsListFailure(app.app);
      expect(armed.succeeded).toBeGreaterThan(0);

      // The desktop pageData key polls on its own interval, so the failures
      // arrive without any user action. Waiting for the retry chain to run out is
      // what makes the assertions below describe a SETTLED error.
      await expect
        .poll(
          async () => (await readSessionsListFailureGateStats(app.app)).failed,
          { timeout: MOUNT_TIMEOUT_MS }
        )
        .toBeGreaterThanOrEqual(SETTLED_FAILURE_COUNT);

      // The contract: the held result stays, and a failed background read is
      // never dressed as an outage — nor as the quiet transient holding state,
      // which this failure is deliberately not.
      await expect(
        app.page.getByText(NEUTRAL_EMPTY_TITLE).first()
      ).toBeVisible();
      await expect(app.page.getByText(OUTAGE_TITLE)).toHaveCount(0);
      await expect(app.page.getByText(SYNCING_TITLE)).toHaveCount(0);

      expect(app.pageErrors).toEqual([]);
    } finally {
      await app.cleanup();
    }
  });
});
