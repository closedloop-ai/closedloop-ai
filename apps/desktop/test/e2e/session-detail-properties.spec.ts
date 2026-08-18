/**
 * ISS-4899 (fix ISS-4793): the session-detail Properties pane's pill contract, on
 * the ELECTRON adapter.
 *
 * `apps/desktop/test/e2e/` carried NO session-DETAIL spec at all before this one,
 * so every desktop assertion about that screen came from mounted Vitest tests
 * (`apps/desktop/src/renderer/components/sessions/__tests__/session-detail-view.test.tsx`)
 * driving a hand-built props object. Those prove the SHELL passes what it means to
 * pass; they cannot prove the LOCAL READ actually produces a session whose pills
 * render, nor that the rendered anchor points where the seeded row says it does.
 * This drives the real Electron renderer over the real local SQLite read.
 *
 * The desktop contract ISS-4793 settled, and what this pins:
 *
 * 1. PR pills DO resolve. `PullRequestPill` renders
 *    `<a class="sd3-result-pr" href="https://github.com/<repo>/pull/<n>"
 *    target="_blank" rel="noreferrer">` when the session's repository identity
 *    resolves — which on this corpus it does only through the ISS-4431 THIRD tier
 *    (no live cwd, no stored `sessions.repo_full_name`, so the repo is recovered
 *    from the linked branch artifact's `repo_full_name`). That whole chain is
 *    local-read-only and has no web analogue, so it can only be proven here.
 *    The anchor is focusable, which is the half of ISS-4793 that a `<span>`
 *    styled to look identical would silently fail.
 *
 * 2. A linked-artifact pill never emits an IN-APP href. The renderer hosts no
 *    document detail routes and its nav guard DROPS an unmapped href, so a
 *    synthetic `/issues/<slug>` would look clickable and do nothing. ISS-4898
 *    gave the pill an ABSOLUTE web-app URL instead (an external anchor the
 *    Electron window-open handler hands to the OS browser), and ISS-5366 made it
 *    withhold BOTH reachability claims until the org slug and web-app origin
 *    resolve. What stays forbidden on this surface is the root-relative form.
 *
 * 3. ISS-5617: a seeded `closedloop_artifact` link RENDERS a pill here. This
 *    seed writes one (`linkClosedloopArtifactSlug`), and that is the whole point:
 *    the chain it exercises — local SQLite `session_artifact_links` → the detail
 *    read's `projectLocalLinkedArtifacts` fold → the runtime-status IPC → preload
 *    → `SessionLinkedArtifactsRow` — exists nowhere else in the desktop test
 *    suite. The node test (`test/session-detail-linked-artifacts.test.ts`) stops
 *    at the projection, and the mounted-renderer test
 *    (`src/renderer/components/sessions/__tests__/session-detail-view.test.tsx`)
 *    INJECTS the detail response, so each proves one end while assuming the
 *    other. Either boundary could regress independently and both stay green.
 *
 * This spec previously seeded no document link and asserted the row was ABSENT,
 * which is an assertion that cannot fail: with nothing seeded it passes just as
 * well against a build that projects `linkedArtifacts` and one that drops them on
 * the floor. Seeding the link is what turns the pair of assertions below into a
 * real regression test (codex + wongk review).
 *
 * WHAT THE PILL'S DESTINATION IS ON THIS SURFACE, verified rather than assumed:
 * NOTHING, and specifically never an href. `SessionDetailView` passes
 * `buildArtifactHref` only once BOTH an org slug (from `GET /desktop/identity`)
 * and a configured web-app origin resolve; this harness launches signed out, so
 * `useDesktopIdentity` settles to `{identity: null, isResolved: true}` and the
 * row renders its inert `<span class="sd3-result-pr">` branch. So the pill is
 * asserted to be a SPAN and the row to contain no anchor at all — which is
 * exactly the ISS-4793 contract (a root-relative `/issues/<slug>` would look
 * clickable and be silently dropped by the renderer's nav guard), now pinned
 * against a session that actually HAS a linked artifact to mis-link.
 *
 * The pane's complete anchor-href set is still asserted to be the seeded GitHub
 * PR URL. That assertion was previously vacuous for artifact pills too — there
 * were none — and is now load-bearing: a desktop build that started handing
 * linked-artifact pills any href, in-app or absolute, adds an entry here.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { gotoHash, launchDesktopApp } from "./helpers/desktop-app";
import {
  seedMergedUnenrichedSinglePrBranch,
  waitForBranchesSchema,
} from "./helpers/seed-branches-db";

// A merged single-PR branch: the seed writes the `kind='pull_request'` artifact
// + `created` link the SESSION's `prs` are derived from (see the
// `linkPullRequestArtifact` note at the seed call below) AND the `kind='branch'`
// artifact whose `repo_full_name` is the only place this session's repository
// identity exists (ISS-4431 tier three).
const SEED = {
  branchName: "iss-4899-session-detail-properties",
  mergedAt: "2026-05-21T12:00:00.000Z",
  prNumber: 4899,
  repoFullName: "acme/web",
  sessionId: "iss-4899-session-detail-properties-session",
} as const;

// What `getPullRequestHref` (session-pull-request-pill.tsx) composes from the
// resolved repo path + PR number — byte-identical to the `pr_url` the seed writes.
const PR_URL = `https://github.com/${SEED.repoFullName}/pull/${SEED.prNumber}`;

// ISS-5617: the slug on the seeded `closedloop_artifact`. An `ISS-` prefix so
// `parseTypedArtifactSlug` types it as a DOCUMENT (a `PRO-`/`WRK-`/`SES-` prefix
// is dropped by `projectLocalLinkedArtifacts` by design and would seed a link
// that correctly renders nothing). This exact string is what the pill labels
// itself with, since the local store carries no artifact title.
const LINKED_ARTIFACT_SLUG = "ISS-5617";

// The session-detail `<h1>` (`agent-session-detail-view.tsx`) renders
// `name ?? externalSessionId`; this seed writes no name, so the title is the id.
// It is the only PER-SESSION barrier on this screen, so it is what "the detail
// mounted" is waited on.
const SESSION_TITLE_SELECTOR = ".sd3-head h1";
// The Properties pane is a `<div role="button">` disclosure (`.prd-props-header`
// with a `.prd-props-title` span) that is COLLAPSED by default — it must be
// clicked open before any `.prd-prop` row exists to assert on.
const PROPERTIES_SECTION_SELECTOR = "section.prd-props-section";
const PROPERTIES_BUTTON_NAME = "Properties";
// Row labels (`span.prd-prop-label`) inside the expanded pane.
const PULL_REQUESTS_ROW_LABEL = "Pull requests";
const LINKED_ARTIFACTS_ROW_LABEL = "Linked artifacts";
// The shared pill class. On desktop only the ANCHOR branch may ever carry it.
const PILL_CLASS = "sd3-result-pr";
const MOUNT_TIMEOUT_MS = 30_000;

test.describe("Session detail Properties pane (ISS-4899)", () => {
  test("the PR pill is a focusable GitHub link and no artifact pill emits a desktop href", async () => {
    test.setTimeout(180_000);

    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-session-props-claude-")
    );
    // Isolate CODEX_HOME: unset, the boot Codex collector reads the real
    // ~/.codex/sessions and would ingest a developer's rollouts alongside the seed.
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-session-props-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "desktop-session-props-udd-")
    );

    try {
      // Launch 1 — create + migrate the SQLite schema, then close so the seed
      // writes with the app DOWN (a running app does not observe another
      // process's writes to its own store).
      const first = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });
      try {
        await waitForBranchesSchema(userDataDir);
      } finally {
        await first.cleanup();
      }

      // `linkPullRequestArtifact` is not optional decoration: a session's `prs`
      // are derived from a `kind='pull_request'` ARTIFACT link, never from the
      // `pull_requests` table (which only supplies merged/closed lifecycle
      // facts) — without it the row renders "None" and there is no pill at all.
      await seedMergedUnenrichedSinglePrBranch(userDataDir, SEED, {
        // ISS-5617: the document link whose pill the assertions below drive
        // through the real Electron chain (SQLite → detail read → IPC → preload
        // → renderer). Without it those assertions are vacuous.
        linkClosedloopArtifactSlug: LINKED_ARTIFACT_SLUG,
        linkPullRequestArtifact: true,
      });

      // Launch 2 — the real local detail read projects the seeded corpus.
      const { page, pageErrors, cleanup } = await launchDesktopApp({
        env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
        keepUserDataDir: true,
        userDataDir,
      });

      try {
        await gotoHash(page, `/sessions/${SEED.sessionId}`);
        await expect(page.locator(SESSION_TITLE_SELECTOR)).toHaveText(
          SEED.sessionId,
          { timeout: MOUNT_TIMEOUT_MS }
        );

        // Open the pane. `visible=true` scopes past any keep-alive-hidden view.
        const propertiesSection = page
          .locator(PROPERTIES_SECTION_SELECTOR)
          .locator("visible=true")
          .first();
        await expect(propertiesSection).toBeVisible({
          timeout: MOUNT_TIMEOUT_MS,
        });
        await page
          .getByRole("button", { name: PROPERTIES_BUTTON_NAME })
          .locator("visible=true")
          .first()
          .click();
        // `data-open` is the section's own disclosure state, so this waits for the
        // expanded rows rather than racing the click.
        await expect(propertiesSection).toHaveAttribute("data-open", "true");

        // ── the PR pill resolves, and it is a real link ──
        const pullRequestsRow = propertiesSection.locator(
          `div.prd-prop:has(span.prd-prop-label:text-is("${PULL_REQUESTS_ROW_LABEL}"))`
        );
        await expect(pullRequestsRow).toHaveCount(1);
        const prPill = pullRequestsRow.locator(`a.${PILL_CLASS}`);
        await expect(prPill).toHaveCount(1);
        await expect(prPill).toHaveAttribute("href", PR_URL);
        // Electron routes a click on this anchor to `shell.openExternal` and
        // returns `{action:"deny"}`, so there is no in-page navigation to assert;
        // the href/target/rel triple IS the contract (same reasoning as
        // branches-pr-link.spec.ts).
        await expect(prPill).toHaveAttribute("target", "_blank");
        await expect(prPill).toHaveAttribute("rel", "noreferrer");

        // Focusable — the half of ISS-4793 a lookalike `<span>` fails silently.
        await prPill.focus();
        await expect(prPill).toBeFocused();

        // ── ISS-5617: the seeded document link reaches the screen ──
        // This is the assertion the PR exists for, and it is red at EITHER
        // boundary: drop `linkedArtifacts` from the main-process detail payload
        // and the row never appears; drop it in the renderer and the row never
        // appears. Only the full chain over the real local SQLite read makes it
        // green.
        const linkedArtifactsRow = propertiesSection.locator(
          `div.prd-prop:has(span.prd-prop-label:text-is("${LINKED_ARTIFACTS_ROW_LABEL}"))`
        );
        await expect(linkedArtifactsRow).toHaveCount(1);

        // The pill labels off the seeded SLUG (the local store has no title), so
        // this asserts the value that actually crossed the boundary rather than
        // just the count of pills around it.
        const artifactPill = linkedArtifactsRow.locator(`.${PILL_CLASS}`);
        await expect(artifactPill).toHaveCount(1);
        await expect(artifactPill).toHaveText(LINKED_ARTIFACT_SLUG);

        // ── the pill's destination: none, and never an href ──
        // Signed out, `SessionDetailView` withholds `buildArtifactHref` (no org
        // slug), so the row renders its inert branch. `:not(.sd3-result-pr-pending)`
        // waits past the ISS-5366 "checking link…" window rather than racing it,
        // so this pins the SETTLED shape.
        await expect(
          linkedArtifactsRow.locator(
            `span.${PILL_CLASS}:not(.sd3-result-pr-pending)`
          )
        ).toHaveCount(1);
        // No anchor anywhere in the row — this is the ISS-4793 contract, now
        // asserted against a session that HAS a linked artifact to mis-link.
        await expect(linkedArtifactsRow.locator("a")).toHaveCount(0);

        // The durable half: the pane's COMPLETE anchor set is the PR pill. With
        // a document link now seeded, a desktop build that started handing
        // linked-artifact pills an href — root-relative OR absolute — adds an
        // entry here and fails.
        const pillHrefs = await propertiesSection
          .locator(`a.${PILL_CLASS}`)
          .evaluateAll((pills) =>
            pills.map((pill) => pill.getAttribute("href") ?? "")
          );
        expect(pillHrefs).toEqual([PR_URL]);

        await page.screenshot({
          fullPage: true,
          path: test.info().outputPath("session-detail-properties.png"),
        });

        expect(pageErrors).toEqual([]);
      } finally {
        await cleanup();
      }
    } finally {
      fs.rmSync(userDataDir, { force: true, recursive: true });
      fs.rmSync(claudeHome, { force: true, recursive: true });
      fs.rmSync(codexHome, { force: true, recursive: true });
    }
  });
});
