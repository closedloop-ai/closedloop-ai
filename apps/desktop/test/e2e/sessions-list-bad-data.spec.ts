/** Native-only pageData regression: non-finite values survive Electron IPC, not JSON. */
import { expect, test } from "@playwright/test";
import type { DesktopApi } from "../../src/renderer/types/desktop-api";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
} from "./helpers/seeded-sessions-list";
import { withSeededSessionsV2List } from "./helpers/seeded-sessions-v2-list";
import { enableSessionsPageDataNonFiniteRow } from "./helpers/sessions-page-data-gate";

test("non-finite pageData crosses native IPC without inventing a measured cost", async () => {
  test.setTimeout(180_000);
  const name = "Native non-finite pageData";
  const dirs = makeSeededSessionsDirs("desktop-sessions-non-finite");
  try {
    await withSeededSessionsV2List(
      dirs,
      {
        featureFlags: { "grid-table-v2": true },
        readyRowName: name,
        sessions: [
          {
            sessionId: "native-non-finite",
            name,
            status: "inactive",
            estimatedCost: 12.5,
          },
        ],
        sessionsPageDataGate: true,
      },
      async (page, panel, app) => {
        const row = panel.locator('[role="row"][data-grid-row]').filter({
          has: page.getByRole("link", { name, exact: true }),
        });
        const cost = row.locator('[data-column-id="cost"]');
        await expect(cost).toHaveText("$12.50");
        await enableSessionsPageDataNonFiniteRow(app, name);
        // Inspect on the renderer side of the real bridge. A JSON substitute
        // would turn both values into null and must not satisfy this test.
        const transported = await page.evaluate(async (rowName) => {
          const api = Reflect.get(
            window.desktopApi,
            "agentSessionsApi"
          ) as DesktopApi["agentSessionsApi"];
          const response = await api.pageData();
          const item = response.list.items.find(
            (entry) => entry.name === rowName
          );
          return {
            nanCost: Number.isNaN(item?.estimatedCost),
            infiniteOutput: item?.outputTokens === Number.POSITIVE_INFINITY,
          };
        }, name);
        expect(transported).toEqual({ nanCost: true, infiniteOutput: true });
        await expect(cost).toHaveText("—", { timeout: 30_000 });
      }
    );
  } finally {
    cleanupSeededSessionsDirs(dirs);
  }
});
