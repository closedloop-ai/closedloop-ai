import { WEB_SHELL_ROUTE_HREFS } from "@repo/app/shared/lib/primary-nav-destinations";
import {
  type ShellNavigationRouteId,
  ShellNavigationSurface,
} from "@repo/app/shared/lib/shell-navigation-contract";
import {
  buildShellNavigationSectionInputs,
  type ShellNavigationHostResolution,
  shellNavigationDestinationIds,
} from "@repo/app/shell/v2/lib/shell-navigation-sections";
import { describe, expect, test } from "vitest";
import { webDestinationIcon } from "../web-shell-destination-icons";

/**
 * ISS-9734 — every row the web shell can offer resolves to an icon.
 *
 * The exhaustive `Record` in the module under test pins that every
 * `ShellNavigationItemId` has a DECISION. It does not pin that a canonical
 * decision RESOLVES: drop a `shellRouteId` from `PRIMARY_NAV_DESTINATIONS` and
 * `canonicalIcon` returns null, `tsc` stays green, and the row ships with a hole
 * where every sibling has an icon. This suite is that second half.
 */

/**
 * The web host with every gate open, so the offered set is every row this shell
 * can EVER render rather than the subset one flag position allows. `offered`
 * reads the canonical href map — the same rule `useWebShellNavigation` applies —
 * rather than a list of ids repeated here, which would go stale in exactly the
 * direction this suite exists to catch.
 */
const EVERY_GATE_OPEN_WEB_HOST: ShellNavigationHostResolution = {
  isGateOpen: () => true,
  offersControl: () => true,
  resolveRoute: (routeId: ShellNavigationRouteId) => ({
    href: WEB_SHELL_ROUTE_HREFS[routeId],
    offered: WEB_SHELL_ROUTE_HREFS[routeId] !== null,
  }),
  surface: ShellNavigationSurface.Web,
};

const OFFERED_WEB_DESTINATION_IDS = shellNavigationDestinationIds(
  buildShellNavigationSectionInputs(EVERY_GATE_OPEN_WEB_HOST)
);

describe("web shell destination icons", () => {
  test("the offered set is non-empty, so the per-id cases cannot pass vacuously", () => {
    expect(OFFERED_WEB_DESTINATION_IDS.length).toBeGreaterThan(0);
  });

  test.each(OFFERED_WEB_DESTINATION_IDS)(
    "%s resolves to an icon",
    (destinationId) => {
      expect(webDestinationIcon(destinationId)).not.toBeNull();
    }
  );
});
