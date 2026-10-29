/**
 * ISS-6641: the Agents type-tab permalink (`?kind=`) round-trips through the
 * REAL router at the DESKTOP host. The web twin is
 * `e2e/agents-kind-permalink.spec.ts`.
 *
 * `AgentsGroupedList` reads its active type tab from `?kind=` through
 * `useTabParam` → the `packages/navigation` port, and
 * `agents-grouped-list.permalink.test.tsx` covers that in jsdom over
 * `createMemoryNavigation`. A memory adapter is neither shipping router. Web
 * resolves the param through Next.js `useSearchParams`; the desktop renderer
 * resolves it out of `location.hash` through `createDesktopNavigation`
 * (`src/renderer/navigation/desktop-adapter.tsx`), which parses the hash with
 * `hashToHrefEntries`, validates the PATH ONLY via `matchRoute(parsePath(href))`
 * — the query never participates in route matching — and republishes it as the
 * search-params snapshot the shared hook reads. None of that exists on web, and
 * the desktop half is where the permalink is also expected to SURVIVE A RELOAD
 * off the persisted hash rather than off a server-rendered URL.
 *
 * Every case asserts the CATALOG ROWS, not only the strip state or the hash. A
 * permalink test that stops at `aria-checked` or at a query string is the
 * unfalsifiable shape ISS-6640 was filed for: both are satisfied by a screen
 * whose list never narrowed. The seeded inventory is mixed for the same reason —
 * against a single-kind corpus, "shows only commands" is true of a screen that
 * does no filtering at all.
 *
 * One launch, one seeded profile, four sequential phases. The phases share a
 * profile deliberately: each one's starting state is the previous one's proven
 * end state, so the deep-link → reload → clear → fallback sequence is exercised
 * as a continuous session rather than four independent cold boots that could
 * each pass without the transitions between them ever happening.
 *
 * Phase 4 runs BOTH inputs ISS-6641 names for the fallback — a valid kind the
 * strip does not surface, and a value that is not a kind at all — and re-scopes
 * to `?kind=command` before each. That re-scoping is not boilerplate:
 * `gotoHash` returns the moment `location.hash` is assigned, so a fallback
 * driven from the All tab asserts nothing the previous render already satisfied.
 * See `expectUnselectableKindWidensToAll`.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { AgentComponentKind } from "@repo/api/src/types/agent-component.ts";
import {
  gotoHash,
  launchDesktopApp,
  waitForLocalAgentComponentList,
} from "./helpers/desktop-app";
import {
  type AgentComponentProvenanceSeed,
  seedAgentComponents,
} from "./helpers/seed-agent-components-db";
import { waitForBranchesSchema } from "./helpers/seed-branches-db";

/** Wide enough that every strip segment is a real, clickable segment. */
const DESKTOP_VIEWPORT = { height: 900, width: 1380 };

const MOUNT_TIMEOUT_MS = 30_000;

// Anchored so `getByRole` cannot substring-match a longer accessible name.
const RE_ALL_TAB = /^All$/;
const RE_COMMANDS_TAB = /^Commands$/;

/**
 * One seeded row per kind, with names that are not substrings of one another nor
 * of any strip label. The Command row is what `?kind=command` must KEEP; the
 * Tool and Skill rows are what it must DROP — and, on the All tab, what proves
 * the drop was a real narrowing rather than a catalog that never held them.
 */
const COMMAND_COMPONENT_NAME = "acme/iss-6641-ship-it";
const TOOL_COMPONENT_NAME = "acme/iss-6641-grep-runner";
const SKILL_COMPONENT_NAME = "acme/iss-6641-release-notes";

const SEEDED_COMPONENTS: AgentComponentProvenanceSeed[] = [
  {
    componentKind: AgentComponentKind.Command,
    externalId: COMMAND_COMPONENT_NAME,
    id: "iss-6641-command",
  },
  {
    componentKind: AgentComponentKind.Tool,
    externalId: TOOL_COMPONENT_NAME,
    id: "iss-6641-tool",
  },
  {
    componentKind: AgentComponentKind.Skill,
    externalId: SKILL_COMPONENT_NAME,
    id: "iss-6641-skill",
  },
];

/**
 * `emptyStateMessage(ALL_TYPES, AgentsTimeRange.All, false, false)`. Asserted
 * absent wherever this spec claims a fallback lands on All, so a fallback that
 * silently emptied the catalog could not pass as one that widened it.
 */
const EMPTY_COPY = "No components yet.";

/**
 * The two `?kind=` values that must NOT select a tab, matching the web twin's
 * `UNSELECTABLE_KIND_PARAMS`. `orchestration` is a real `AgentComponentKind`
 * that `SCOPED_OUT_KINDS` deliberately keeps off the strip; `not-a-kind` is
 * simply unknown. ISS-6641 requires BOTH at this host, and they are not the same
 * branch: a fallback keyed on "is this a rendered tab" handles both, while one
 * keyed on "does this parse as a kind" handles only the scoped-out value and can
 * still blank or wedge on garbage — which is what a hand-edited or truncated
 * permalink delivers. Each must widen the catalog rather than narrow it to
 * nothing.
 */
const UNSELECTABLE_KIND_PARAMS = [
  AgentComponentKind.Orchestration,
  "not-a-kind",
] as const;

test.describe("Agents ?kind= permalink at the desktop host (ISS-6641)", () => {
  test("resolves out of the hash, scopes the catalog, survives a reload, clears on All, and widens back to All for an unselectable kind", async () => {
    test.setTimeout(180_000);

    await withSeededDesktopProfile("iss-6641-permalink", async (page) => {
      await page.setViewportSize(DESKTOP_VIEWPORT);
      // Must precede the first navigation: the disabled boot responder's empty
      // list is cached by the query client forever, so navigating early pins a
      // permanently empty workspace and every row assertion below would fail
      // for that reason rather than for the contract (ISS-5364).
      await waitForLocalAgentComponentList(page, MOUNT_TIMEOUT_MS);

      // ── Phase 1: the deep link resolves and scopes the catalog ────────────
      await gotoHash(page, `/agents?kind=${AgentComponentKind.Command}`);

      // The strip mounted AND adopted the hash. Awaited first so nothing below
      // can pass vacuously against a workspace that never rendered.
      await expect(
        page.getByRole("radio", { name: RE_COMMANDS_TAB })
      ).toHaveAttribute("aria-checked", "true", { timeout: MOUNT_TIMEOUT_MS });

      // …and the CATALOG is scoped to it. This is the half a strip-state or
      // hash-only assertion leaves unprotected. The Command row is asserted
      // present BEFORE the absences, so a catalog that has not finished loading
      // cannot satisfy "the Tool row is gone".
      await expect(catalogRow(page, COMMAND_COMPONENT_NAME)).toHaveCount(1);
      await expect(catalogRow(page, TOOL_COMPONENT_NAME)).toHaveCount(0);
      await expect(catalogRow(page, SKILL_COMPONENT_NAME)).toHaveCount(0);

      // ── Phase 2: it survives a reload off the persisted hash ──────────────
      // The desktop-specific half. There is no server round-trip to restore the
      // tab here: `createDesktopNavigation` re-seeds the store from
      // `location.hash` on boot, so a reload that lost the query would drop the
      // user back onto All with the whole inventory.
      await page.reload();
      await waitForLocalAgentComponentList(page, MOUNT_TIMEOUT_MS);

      await expect(
        page.getByRole("radio", { name: RE_COMMANDS_TAB })
      ).toHaveAttribute("aria-checked", "true", { timeout: MOUNT_TIMEOUT_MS });
      await expect(catalogRow(page, COMMAND_COMPONENT_NAME)).toHaveCount(1);
      await expect(catalogRow(page, TOOL_COMPONENT_NAME)).toHaveCount(0);
      await expect(catalogRow(page, SKILL_COMPONENT_NAME)).toHaveCount(0);

      // ── Phase 3: selecting All widens the catalog and clears the param ────
      await page.getByRole("radio", { name: RE_ALL_TAB }).click();

      // The Tool and Skill rows did not exist in the DOM a moment ago, so this
      // cannot be satisfied by the pre-click render — it is the awaited proof
      // the new render landed, which the hash assertion below then reads
      // against.
      await expect(catalogRow(page, TOOL_COMPONENT_NAME)).toHaveCount(1);
      await expect(catalogRow(page, SKILL_COMPONENT_NAME)).toHaveCount(1);
      await expect(catalogRow(page, COMMAND_COMPONENT_NAME)).toHaveCount(1);

      // The default tab is OMITTED from the persisted location, keeping the
      // shareable hash canonical. Polled rather than read once: `useTabParam`
      // writes through `useNavigation().replace`, which reaches
      // `location.hash` asynchronously, so a single synchronous read can catch
      // the pre-write hash and pass for the wrong reason.
      await expect.poll(() => kindParamFromHash(page)).toBeNull();

      // ── Phase 4: an unselectable ?kind= widens back to All, not to empty ──
      // Both inputs ISS-6641 names, each driven from a provably filtered state.
      for (const kindParam of UNSELECTABLE_KIND_PARAMS) {
        await expectUnselectableKindWidensToAll(page, kindParam);
      }
    });
  });
});

/**
 * The `kind` query param currently persisted in `location.hash`, or null.
 *
 * Read from the hash rather than from `page.url()`: the renderer is loaded from
 * a `file://` document whose URL carries no app route at all, so the hash IS the
 * desktop location.
 */
async function kindParamFromHash(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const raw = globalThis.location.hash;
    const hash = raw.startsWith("#") ? raw.slice(1) : raw;
    const queryStart = hash.indexOf("?");
    if (queryStart === -1) {
      return null;
    }
    return new URLSearchParams(hash.slice(queryStart + 1)).get("kind");
  });
}

/**
 * The catalog grid row that owns `componentName` — scoped to the row so a name
 * rendered somewhere other than the catalog could not stand in for a row.
 */
function catalogRow(page: Page, componentName: string): Locator {
  return page.getByRole("row").filter({ hasText: componentName });
}

/**
 * Launch the built app twice against ONE temp profile — once to create and
 * migrate the SQLite schema (closed before seeding, so the write has no
 * cross-process WAL contention), then again so the real Agents IPC source reads
 * the seeded inventory at boot. Mirrors `agents-source-provenance.spec.ts`.
 *
 * CLAUDE_HOME / CODEX_HOME are empty temp dirs so the boot collectors ingest
 * nothing and the only inventory rows are the seeded ones — which is what lets
 * the "only the Command row" assertions mean what they say.
 */
async function withSeededDesktopProfile(
  prefix: string,
  run: (page: Page) => Promise<void>
): Promise<void> {
  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), `${prefix}-claude-`)
  );
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-codex-`));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-udd-`));
  const env = { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome };

  try {
    const first = await launchDesktopApp({
      env,
      keepUserDataDir: true,
      userDataDir,
    });
    try {
      await waitForBranchesSchema(userDataDir);
    } finally {
      await first.cleanup();
    }

    await seedAgentComponents(userDataDir, SEEDED_COMPONENTS);

    const { page, cleanup } = await launchDesktopApp({
      env,
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
 * Drive `?kind=<value>` for a value the strip cannot select, and assert the
 * fallback WIDENS the catalog back to the whole inventory under a checked All
 * tab — rather than narrowing to a kind nothing matches and leaving the user on
 * an empty list.
 *
 * The scoping step at the top is the load-bearing part, not setup. `gotoHash`
 * resolves as soon as `location.hash` is assigned, so arriving here from a state
 * where All is ALREADY checked and all three rows are ALREADY rendered — which
 * is exactly where Phase 3 leaves the page — makes every assertion below
 * satisfiable by the PREVIOUS render, before the desktop navigation adapter has
 * processed the new value at all. The whole phase would then stay green with
 * invalid-permalink handling removed outright. From `?kind=command` the All tab
 * is unchecked and the Tool and Skill rows are absent from the DOM, so each
 * assertion can only be met by a render that consumed the new hash — which is
 * also why no explicit wait is needed: Playwright's auto-retry does the awaiting,
 * against a condition the prior state provably could not satisfy.
 */
async function expectUnselectableKindWidensToAll(
  page: Page,
  kindParam: string
): Promise<void> {
  await gotoHash(page, `/agents?kind=${AgentComponentKind.Command}`);

  // The provably-filtered starting state, asserted rather than assumed.
  await expect(
    page.getByRole("radio", { name: RE_COMMANDS_TAB })
  ).toHaveAttribute("aria-checked", "true", { timeout: MOUNT_TIMEOUT_MS });
  await expect(catalogRow(page, COMMAND_COMPONENT_NAME)).toHaveCount(1);
  await expect(catalogRow(page, TOOL_COMPONENT_NAME)).toHaveCount(0);
  await expect(catalogRow(page, SKILL_COMPONENT_NAME)).toHaveCount(0);

  await gotoHash(page, `/agents?kind=${kindParam}`);

  await expect(page.getByRole("radio", { name: RE_ALL_TAB })).toHaveAttribute(
    "aria-checked",
    "true",
    { timeout: MOUNT_TIMEOUT_MS }
  );
  // …and All means the WHOLE inventory. Without these three, a fallback that
  // narrowed to a kind nothing matches would render an empty catalog under a
  // checked All tab and still pass. The Tool and Skill rows did not exist a
  // moment ago, so they are the ones that prove the widening happened.
  await expect(catalogRow(page, COMMAND_COMPONENT_NAME)).toHaveCount(1);
  await expect(catalogRow(page, TOOL_COMPONENT_NAME)).toHaveCount(1);
  await expect(catalogRow(page, SKILL_COMPONENT_NAME)).toHaveCount(1);
  await expect(page.getByText(EMPTY_COPY)).toHaveCount(0);
}
