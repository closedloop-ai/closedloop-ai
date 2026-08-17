/**
 * ISS-5500: cross-adapter E2E for the Definition panel's absence REASON at the
 * DESKTOP host. The web twin is `e2e/agent-detail-definition-absence.spec.ts`.
 *
 * The Definition panel is rendered by the SHARED
 * `packages/app/agents/components/workspace/agent-detail.tsx`, which the Electron
 * renderer mounts through `src/renderer/components/agents/agent-detail-view.tsx`,
 * so `packages/app/AGENTS.md` ("E2E Coverage for UI Surfaces") owes this adapter
 * its own regression for a UI bug fix (#4632 review, codex P1).
 *
 * WHY THIS ADAPTER IS NOT A RESTATEMENT OF THE WEB TWIN
 * ----------------------------------------------------
 * Unlike the ISS-5029 truncation caption — whose shown-state only the CLOUD read
 * can produce, so its desktop sibling can only assert an absence — every input
 * this spec needs is reachable from the desktop's OWN local read.
 * `agent_components.resolved_state` is a real local column, synced from the
 * cloud and also set locally by the definition-content collector, and
 * `getAgentComponentDetailLocal` passes it straight through. So both halves of
 * the regression are drivable here against the real IPC path.
 *
 * More than that, this adapter carries a hazard the web one does not.
 * `shared-agent-components-api.ts` emits `prompt: content ?? description` for
 * prompt-kinds, so on desktop the panel's body can come from the frontmatter
 * DESCRIPTION of a component whose definition was never captured. That fallback
 * is exactly why `bodyCaptured` is now read from the selected revision's
 * `content` rather than from `prompt`, and this is the only harness where that
 * distinction exists at all — the seeded row NULLs both columns so the empty
 * state renders on the real read rather than on an injected payload.
 *
 * The regression is a DIFFERENCE, so no single case expresses it: the two
 * flag-ON cases seed rows differing ONLY in `resolved_state` and assert the panel
 * says two different things. Before the fix both rendered the identical legacy
 * sentence, so both would fail.
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
import {
  gotoHash,
  launchDesktopApp,
  seedDesktopFeatureFlags,
} from "./helpers/desktop-app";
import {
  type BodylessAgentComponentSeed,
  seedBodylessAgentComponent,
  waitForAgentComponentsSchema,
} from "./helpers/seed-agent-components-db";

/**
 * The desktop Labs key gating this pass. Spelled as a LITERAL rather than
 * imported from `../../src/shared/feature-flags`: that module's extension-less
 * `@repo/api/src/types/...` specifiers do not resolve under Playwright's ESM
 * loader, and a spec-level import failure aborts the WHOLE desktop-e2e suite at
 * load time (see the same note in `agents-source-provenance.spec.ts` and
 * `agents-loc-per-dollar-display.spec.ts`). The copy is pinned by the ISS-5500
 * case in `apps/desktop/test/feature-flags-shared-ui.test.ts`, which asserts this
 * exact string against `AGENTS_DEFINITION_EMPTY_STATE_FLAG_KEY`, so a rename
 * fails there rather than silently leaving this spec seeding a key nothing reads.
 */
const DEFINITION_EMPTY_STATE_FLAG_KEY = "agents-definition-empty-state-honesty";

const DESKTOP_VIEWPORT = { height: 900, width: 1380 };

const MOUNT_TIMEOUT_MS = 30_000;

// `subagent` is a PROMPT_KIND and an observed kind, so it is one of the kinds
// whose detail page renders the Definition panel at all
// (`hasVersionHistoryAffordance` in `packages/app/agents/lib/component-meta.tsx`).
const COMPONENT_KEY = "iss-5500-absent-definition";

/** The seeded row, varying only by `resolvedState` between cases. */
function bodylessSeed(resolvedState: string): BodylessAgentComponentSeed {
  return {
    harness: "claude",
    id: "iss-5500-agent-component",
    key: COMPONENT_KEY,
    kind: AgentComponentKind.Subagent,
    name: "ISS-5500 Absent Definition",
    resolvedState,
    source: "acme/app",
  };
}

const COMPONENT_SLUG = encodeComponentSlug(
  AgentComponentKind.Subagent,
  COMPONENT_KEY
);

const DEFINITION_HEADING = "Definition";

// The exact shipped copy. Pinned as literals so a copy change has to be
// deliberate — this panel's wording IS the deliverable of the ticket.
const NEVER_RECORDED_TITLE = "No definition recorded";
const UNAVAILABLE_TITLE = "Definition unavailable";
// The pre-ISS-5500 line, kept verbatim as the flag-OFF contract.
const LEGACY_TITLE = "No definition captured";
const LEGACY_BODY = "We haven't captured this component's definition yet.";

test.describe("Agent detail definition absence reason, Labs gate ON (ISS-5500)", () => {
  test("says nothing was ever recorded for an unresolved identity", async () => {
    test.setTimeout(180_000);

    await withSeededDesktopProfile(
      {
        flagOn: true,
        prefix: "iss-5500-unresolved",
        resolvedState: "unresolved",
      },
      async (page) => {
        await page.setViewportSize(DESKTOP_VIEWPORT);

        await waitForLocalComponentDetail(page, COMPONENT_SLUG);
        await gotoHash(page, `/agents/${COMPONENT_SLUG}`);

        // Positive control: the Definition panel mounted through the renderer's
        // real local IPC source. Without it an absence assertion is vacuous.
        await expect(
          page.getByRole("heading", { exact: true, name: DEFINITION_HEADING })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        await expect(
          page.getByText(NEVER_RECORDED_TITLE, { exact: true })
        ).toBeVisible();

        // The other half of the regression: the failure story must not be told
        // about a component that has none, and neither must the single line that
        // used to serve both.
        await expect(
          page.getByText(UNAVAILABLE_TITLE, { exact: true })
        ).toHaveCount(0);
        await expect(page.getByText(LEGACY_BODY, { exact: true })).toHaveCount(
          0
        );
      }
    );
  });

  test("says the definition could not be loaded for an inaccessible identity", async () => {
    test.setTimeout(180_000);

    // Same seeded row as above except `resolved_state`. `inaccessible` means the
    // org holds a definition it could not read, so claiming nothing was ever
    // recorded would be a lie. Before the fix this rendered byte-identically to
    // the case above.
    await withSeededDesktopProfile(
      {
        flagOn: true,
        prefix: "iss-5500-inaccessible",
        resolvedState: "inaccessible",
      },
      async (page) => {
        await page.setViewportSize(DESKTOP_VIEWPORT);

        await waitForLocalComponentDetail(page, COMPONENT_SLUG);
        await gotoHash(page, `/agents/${COMPONENT_SLUG}`);

        await expect(
          page.getByRole("heading", { exact: true, name: DEFINITION_HEADING })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        await expect(
          page.getByText(UNAVAILABLE_TITLE, { exact: true })
        ).toBeVisible();

        await expect(
          page.getByText(NEVER_RECORDED_TITLE, { exact: true })
        ).toHaveCount(0);
        await expect(page.getByText(LEGACY_BODY, { exact: true })).toHaveCount(
          0
        );
      }
    );
  });
});

test.describe("Agent detail definition absence reason, Labs gate OFF (ISS-5500 dark-launch no-op)", () => {
  test("keeps the single legacy line", async () => {
    test.setTimeout(180_000);

    // ISS-4779 closed-by-default. The Labs toggle registers default OFF, so this
    // is what the packaged app renders today for every reason a body is absent.
    await withSeededDesktopProfile(
      {
        flagOn: false,
        prefix: "iss-5500-flag-off",
        resolvedState: "unresolved",
      },
      async (page) => {
        await page.setViewportSize(DESKTOP_VIEWPORT);

        await waitForLocalComponentDetail(page, COMPONENT_SLUG);
        await gotoHash(page, `/agents/${COMPONENT_SLUG}`);

        await expect(
          page.getByRole("heading", { exact: true, name: DEFINITION_HEADING })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        await expect(
          page.getByText(LEGACY_TITLE, { exact: true })
        ).toBeVisible();
        await expect(
          page.getByText(LEGACY_BODY, { exact: true })
        ).toBeVisible();

        await expect(
          page.getByText(NEVER_RECORDED_TITLE, { exact: true })
        ).toHaveCount(0);
      }
    );
  });
});

/**
 * Launch the built app twice against ONE temp profile — once to create and
 * migrate the SQLite schema (closed before seeding, so the write has no
 * cross-process WAL contention), then again so the real local component IPC
 * source reads the seeded inventory at boot. The Labs flag is seeded on BOTH
 * launches because `seedE2eDesktopSettings` rewrites the settings file each time.
 *
 * CLAUDE_HOME / CODEX_HOME are empty temp dirs so the boot collectors ingest
 * nothing and the only inventory row is the seeded one (mirrors
 * `agents-source-provenance.spec.ts`).
 */
async function withSeededDesktopProfile(
  {
    flagOn,
    prefix,
    resolvedState,
  }: { flagOn: boolean; prefix: string; resolvedState: string },
  run: (page: Page) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  const seedGate = (dir: string) => {
    if (flagOn) {
      seedDesktopFeatureFlags(dir, {
        [DEFINITION_EMPTY_STATE_FLAG_KEY]: true,
      });
    }
  };

  try {
    const first = await launchDesktopApp({
      beforeLaunch: seedGate,
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForAgentComponentsSchema(userDataDir);
    } finally {
      await first.cleanup();
    }

    await seedBodylessAgentComponent(userDataDir, bodylessSeed(resolvedState));

    const { page, cleanup } = await launchDesktopApp({
      beforeLaunch: seedGate,
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
 * and swaps in the real ones once the local db host is up. The disabled `detail`
 * responder fails closed as `null`, which `createLocalAgentComponentsDataSource`
 * raises as a 404 `ApiError` — deliberately excluded from the shared query
 * client's retry — so a detail query landing inside that boot window caches
 * "Component not found" and never refetches. Polling the SAME production IPC
 * channel the view reads through establishes the precondition without stubbing
 * anything (see the fuller note in `agent-detail-versions-truncated.spec.ts`).
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
