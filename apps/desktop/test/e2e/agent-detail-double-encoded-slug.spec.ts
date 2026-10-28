/**
 * ISS-6642: the desktop Electron-e2e regression for the double-encoded
 * agent-detail slug. The web twin is `e2e/agents-breadcrumb-encoding.spec.ts`.
 *
 * `apps/desktop/AGENTS.md` ("E2E Coverage for UI Surfaces") owes a renderer UI
 * BUG FIX a launched-app regression that "reproduces the bug through the
 * launched app and would fail without your fix". The route-table unit test
 * added alongside the fix proves the match function returns a repaired
 * `agentSlug`; it cannot prove the rest of the chain — that the repaired value
 * is what the detail fetch and the Topbar breadcrumb actually read — because it
 * never mounts the shell, the router, or the local IPC data source. That whole
 * chain is what this spec drives.
 *
 * THE BUG
 * -------
 * `matchPattern` decodes a captured path segment exactly ONCE. A hash whose
 * `:id` segment was encoded twice (a router hop that re-encoded an already
 * encoded segment) therefore reaches the route table still percent-encoded, and
 * with no literal `::` for the identity codec to split on. Before the fix the
 * raw `command%3A%3A%2F…` string became `agentSlug`: `useAgentComponentDetail`
 * missed, the body rendered "Component not found", and the Topbar breadcrumb —
 * which shows the RESOLVED component name — collapsed to its settled
 * placeholder. After the fix `normalizeAgentSlug` repairs the slug once at this
 * one route boundary, so the detail fetch, the header, and the crumb all read
 * the same identity.
 *
 * WHY THE ASSERTIONS BELOW CANNOT PASS AGAINST THE UNFIXED CODE
 * ------------------------------------------------------------
 * The spec first proves, through the SAME production IPC channel the view reads
 * from, that the seeded component resolves under its canonical slug and does
 * NOT resolve under the once-decoded/still-encoded one. That is the load-bearing
 * precondition: the data source performs no repair of its own, so the only way
 * the header and crumb below can name the component is if the route table
 * handed the repaired identity down. Reverting `normalizeAgentSlug` in
 * `src/renderer/navigation/route-table.ts` turns the detail body into
 * "Component not found" and empties the crumb's name slot.
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: `CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e -- agent-detail-double-encoded-slug.spec.ts`
 *     (an isolated CODEX_HOME/CLAUDE_HOME keeps the operator's real local
 *     history out of the boot collectors — see "Electron E2E: isolate
 *     CODEX_HOME" in `apps/desktop/AGENTS.md`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { AgentComponentKind } from "@repo/api/src/types/agent-component.ts";
import { encodeComponentSlug } from "@repo/api/src/types/agent-component-analytics.ts";
import { gotoHash, launchDesktopApp } from "./helpers/desktop-app";
import { initializeDesktopProfileSchema } from "./helpers/initialize-desktop-profile-schema";
import {
  type AgentComponentSeed,
  seedAgentComponent,
} from "./helpers/seed-agent-components-db";

const DESKTOP_VIEWPORT = { height: 900, width: 1380 };

const MOUNT_TIMEOUT_MS = 30_000;

// The shape ISS-6642 was reported against, and the same identity the web twin
// uses: a command whose key is itself slash-prefixed, so the encoded slug
// carries `%3A%3A` AND `%2F%2F` and a second encoding pass mangles both.
const SEEDED_COMPONENT: AgentComponentSeed = {
  id: "iss-6642-agent-component",
  kind: AgentComponentKind.Command,
  key: "//cl-ci-babysit",
  name: "ISS-6642 Babysit Command",
  content: "ISS-6642 seeded definition body.",
  harness: "claude",
  source: "acme/app",
};

const CANONICAL_SLUG = encodeComponentSlug(
  SEEDED_COMPONENT.kind,
  SEEDED_COMPONENT.key
);

/** What `matchPattern`'s single decode leaves behind for a double-encoded href. */
const ONCE_DECODED_SLUG = encodeURIComponent(CANONICAL_SLUG);

/** The hash a router hop emits when it encodes an already-encoded segment. */
const DOUBLE_ENCODED_HASH = `/agents/${encodeURIComponent(ONCE_DECODED_SLUG)}`;

const NOT_FOUND_TITLE = "Component not found";

test.describe("Agent detail double-encoded slug repair (ISS-6642)", () => {
  test("a double-encoded agent hash renders the intended detail view and breadcrumb", async () => {
    test.setTimeout(180_000);

    await withSeededDesktopProfile(
      { prefix: "iss-6642-double-encoded" },
      async (page) => {
        await page.setViewportSize(DESKTOP_VIEWPORT);

        // Precondition, read through the renderer's own production IPC: the
        // seeded component resolves under its canonical identity...
        await expect
          .poll(() => localComponentResolves(page, CANONICAL_SLUG), {
            timeout: MOUNT_TIMEOUT_MS,
          })
          .toBe(true);
        // ...and does NOT resolve under the still-encoded string a single
        // decode leaves behind. The data source repairs nothing, so every
        // assertion below can only pass if the route table repaired the slug.
        expect(await localComponentResolves(page, ONCE_DECODED_SLUG)).toBe(
          false
        );

        await gotoHash(page, DOUBLE_ENCODED_HASH);

        // The intended detail view: the loaded header's <h1> is the component
        // name. Exact so a longer heading containing this string cannot satisfy
        // it.
        await expect(
          page.getByRole("heading", {
            exact: true,
            name: SEEDED_COMPONENT.name,
          })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        // The breadcrumb: the Topbar trail's trailing segment is the RESOLVED
        // name, which is published only when the detail read settles with data.
        // Scoped to <header> so it cannot be satisfied by the in-body heading
        // asserted above, and exact so it cannot be satisfied by a longer label.
        await expect(
          page
            .locator("header")
            .getByText(SEEDED_COMPONENT.name, { exact: true })
        ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });

        // The pre-fix state, stated directly: the route resolved to a real
        // component, not to the not-found card.
        await expect(page.getByText(NOT_FOUND_TITLE)).toHaveCount(0);
      }
    );
  });
});

/**
 * Initialize the caller-owned schema through production migrations, close its
 * writer, then seed offline before the real local component IPC boots. This
 * prototype retains the subject launch and requires separate profile-equivalence proof.
 *
 * CLAUDE_HOME / CODEX_HOME are fresh empty temp dirs, removed in teardown, so
 * the boot collectors ingest nothing of the operator's real local history and
 * the only component in the profile is the seeded one (mirrors
 * `agent-detail-versions-truncated.spec.ts`).
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
    await initializeDesktopProfileSchema(userDataDir);

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
 * Whether the launched renderer's OWN local component IPC resolves `slug`.
 *
 * Nothing is stubbed or monkey-patched: this is the exact
 * `window.desktopApi.db.getAgentComponentDetail` channel
 * `useAgentComponentDetail` reads through, which the main process installs in a
 * disabled, fail-closed form at boot and swaps for the real responder once the
 * local db host is up (`agent-dashboard-ipc-contract.ts`). Polling it before the
 * detail route is mounted keeps the spec off that boot race — a detail query
 * that lands inside the window caches an `ApiError` the shared query client
 * deliberately does not retry.
 */
async function localComponentResolves(
  page: Page,
  slug: string
): Promise<boolean> {
  return await page.evaluate(async (target) => {
    const detailFn = (
      globalThis as unknown as {
        desktopApi?: {
          db?: {
            getAgentComponentDetail?: (slug: string) => Promise<unknown | null>;
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
      // The local runtime is still coming up, or the slug genuinely missed.
      return false;
    }
  }, slug);
}
