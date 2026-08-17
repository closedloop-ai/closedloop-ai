/**
 * ISS-5029: cross-adapter E2E for the partial-revision-history marker at the
 * DESKTOP host. The web twin is `e2e/agent-detail-versions-truncated.spec.ts`.
 *
 * The component Definition panel is rendered by the SHARED
 * `packages/app/agents/components/workspace/agent-detail.tsx`, which the Electron
 * renderer mounts through `src/renderer/components/agents/agent-detail-view.tsx`,
 * so `packages/app/AGENTS.md` ("E2E Coverage for UI Surfaces") owes this adapter
 * its own regression. ISS-5366 retired the `component-versions-truncated` gate
 * to its enabled state, so no Labs flag is seeded here: the marker is
 * unconditional on this surface too, and that is what makes the assertion below
 * load-bearing rather than a restatement of a closed gate.
 *
 * WHAT THIS ADAPTER CAN REACH, AND WHAT IT DELIBERATELY DOES NOT
 * -------------------------------------------------------------
 * The caption's shown-state needs a detail payload carrying
 * `versionsTruncated: true`. That claim is produced only by the CLOUD detail
 * read (`apps/api/app/agent-components/service/detail-version-history.ts`),
 * whose bounded `take` is the read that actually hits a cap. The desktop's own
 * local read — `getAgentComponentDetailLocal` in
 * `src/main/dashboard/shared-agent-components-api.ts` — is UNCAPPED and never
 * emits the field at all (`versionsTruncated` does not appear anywhere under
 * `apps/desktop/src`), and every desktop E2E profile runs Local mode: the seed
 * pins `cloudConnectionEnabled: false` (`test/e2e/helpers/desktop-app.ts`) and
 * `resolveDesktopAppCoreMode` (`src/renderer/shared-agent-sessions/
 * desktop-app-core-mode.ts`) only selects Cloud for an authenticated + online
 * renderer, which E2E has no Clerk to become.
 *
 * So the shown-state assertion lives on the WEB twin, which reaches it honestly
 * by mocking `GET /agent-components/{slug}`. Faking it here — monkey-patching
 * the contextBridge IPC to inject a field the desktop never sends — would test
 * the stub, not the adapter.
 *
 * What this adapter asserts instead is the claim that IS load-bearing here and
 * that no other test covers: now that the caption is unconditional, the
 * desktop's own complete, uncapped history must still never describe itself as
 * partial. That is a live assertion, not a vacuous one — it fails the moment
 * `truncated` is recomputed locally from `versions.length` against a cap instead
 * of being read from the server's explicit claim, which is exactly what the
 * production comment on `PromptPanel` forbids, and retiring the gate is exactly
 * the moment that mistake would start shipping to everyone. The case first
 * asserts the Definition body is on screen, so a panel that failed to mount
 * cannot make the absence assertion pass for the wrong reason.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { AgentComponentKind } from "@repo/api/src/types/agent-component.ts";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics.ts";
import { gotoHash, launchDesktopApp } from "./helpers/desktop-app";
import {
  type AgentComponentSeed,
  seedAgentComponent,
  waitForAgentComponentsSchema,
} from "./helpers/seed-agent-components-db";

const DESKTOP_VIEWPORT = { height: 900, width: 1380 };

const MOUNT_TIMEOUT_MS = 30_000;

// `subagent` is a PROMPT_KIND and an observed kind, so it is one of the kinds
// whose detail page renders the Definition panel at all
// (`hasVersionHistoryAffordance` in `packages/app/agents/lib/component-meta.tsx`).
const COMPONENT_KEY = "iss-5029-partial-history";

const SEEDED_COMPONENT: AgentComponentSeed = {
  id: "iss-5029-agent-component",
  kind: AgentComponentKind.Subagent,
  key: COMPONENT_KEY,
  name: "ISS-5029 Partial History",
  content: "ISS-5029 seeded definition body.",
  harness: "claude",
  source: "acme/app",
};

const COMPONENT_SLUG = encodeComponentSlug(
  SEEDED_COMPONENT.kind,
  SEEDED_COMPONENT.key
);

const DEFINITION_HEADING = "Definition";

// Deliberately BROADER than the shipped copy so a reworded caption still fails
// these absence assertions rather than slipping through. The exact string —
// typographic apostrophe included — is pinned by the web twin's shown-state
// case and by the jsdom matrix in `packages/app`.
const TRUNCATION_CAPTION_PATTERN = /revision history is partial/i;

test.describe("Agent detail partial-revision-history marker (ISS-5029)", () => {
  test("the desktop's own uncapped local history never describes itself as partial", async () => {
    test.setTimeout(180_000);

    await withSeededDesktopProfile(
      { prefix: "iss-5029-unconditional" },
      async (page) => {
        await page.setViewportSize(DESKTOP_VIEWPORT);

        await waitForLocalComponentDetail(page, COMPONENT_SLUG);
        await gotoHash(page, `/agents/${COMPONENT_SLUG}`);

        // Positive control: the Definition panel mounted through the renderer's
        // real local IPC source and rendered the seeded body.
        await expect(
          page.getByRole("heading", { name: DEFINITION_HEADING })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
        await expect(page.getByText(SEEDED_COMPONENT.content)).toBeVisible();

        // The caption is unconditional now, and the local read sends no
        // truncation claim — so the panel must stay silent rather than invent
        // one. This is the assertion the retirement makes load-bearing.
        await expect(page.getByText(TRUNCATION_CAPTION_PATTERN)).toHaveCount(0);
      }
    );
  });
});

/**
 * Launch the built app twice against ONE temp profile — once to create and
 * migrate the SQLite schema (closed before seeding, so the write has no
 * cross-process WAL contention), then again so the real local component IPC
 * source reads the seeded inventory at boot. ISS-5366: no Labs flag is seeded —
 * the caption this spec drives no longer has a gate.
 *
 * CLAUDE_HOME / CODEX_HOME are empty temp dirs so the boot collectors ingest
 * nothing and the only component is the seeded one (mirrors
 * `agents-loc-per-dollar-display.spec.ts`).
 */
async function withSeededDesktopProfile(
  { prefix }: { prefix: string },
  run: (page: Page) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  try {
    const first = await launchDesktopApp({
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForAgentComponentsSchema(userDataDir);
    } finally {
      await first.cleanup();
    }

    await seedAgentComponent(userDataDir, SEEDED_COMPONENT);

    const { page, cleanup } = await launchDesktopApp({
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await run(page);
    } finally {
      await cleanup();
    }
  } finally {
    fs.rmSync(userDataDir, { force: true, recursive: true });
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
}

/**
 * Block until the launched renderer's OWN local component IPC resolves the
 * seeded slug, BEFORE the detail route is ever mounted.
 *
 * The main process installs the DISABLED agent-dashboard DB responders at boot
 * and swaps in the real ones once the local db host is up
 * (`agent-dashboard-ipc-contract.ts`). The disabled `detail` responder fails
 * closed as `null`, which `createLocalAgentComponentsDataSource` raises as a
 * 404 `ApiError` — and `ApiError` is deliberately excluded from the shared query
 * client's retry, so a detail query that lands inside that boot window caches
 * "Component not found" and never refetches on its own. Deep-linking to
 * `#/agents/:slug` immediately after launch therefore raced the runtime and left
 * the not-found card on screen for the whole test, with no Definition panel to
 * assert against. (Re-navigating away and back re-resolves it, which is what
 * makes this a mount-time race rather than a seeding failure.)
 *
 * The gate polls the SAME production IPC channel the view itself reads through
 * — nothing is stubbed, injected, or monkey-patched — so it only establishes the
 * precondition the spec always assumed: navigate once the app can actually see
 * the seeded row. Every assertion below it is unchanged.
 */
async function waitForLocalComponentDetail(
  page: Page,
  slug: string
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async (target) => {
          const detailFn = (
            globalThis as unknown as {
              desktopApi?: {
                db?: {
                  getAgentComponentDetail?: (
                    slug: string
                  ) => Promise<unknown | null>;
                };
              };
            }
          ).desktopApi?.db?.getAgentComponentDetail;
          if (!detailFn) {
            return false;
          }
          try {
            return (await detailFn(target)) != null;
          } catch {
            // The local runtime is still coming up; keep polling.
            return false;
          }
        }, slug),
      { timeout: MOUNT_TIMEOUT_MS }
    )
    .toBe(true);
}
