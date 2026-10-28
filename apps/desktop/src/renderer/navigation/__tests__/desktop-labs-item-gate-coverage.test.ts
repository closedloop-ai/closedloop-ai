/**
 * ISS-9731 — the shared navigation contract is the registry of per-item Labs
 * gates, and the shell resolves EVERY member of it.
 *
 * This is the case the old `resolveLabsItemGate` could not fail. It answered
 * two surfaces by name and returned `true` for everything else, so Help — which
 * declares a `desktopLabsItem` gate in the contract — resolved open at the route
 * while its view self-guarded to `null`, and the page rendered a breadcrumb
 * over a blank body. A fifth surface added to the contract
 * would have done the same thing silently.
 *
 * The contract side is read from `SHELL_NAVIGATION_ITEMS` and the resolver side
 * is driven through the real `resolveLabsItemGate`, so adding a declared gate
 * the shell does not resolve fails HERE rather than in production.
 */
import {
  SHELL_NAVIGATION_ITEMS,
  ShellNavigationGateKind,
  ShellNavigationSurface,
} from "@repo/app/shared/lib/shell-navigation-contract";
import { describe, expect, it } from "vitest";
import { DESKTOP_SHELL_ROUTE_NAV_IDS, type NavId } from "../route-table";
import { resolveLabsItemGate } from "../use-nav-gates";

/** Every (nav id, gate key) the contract declares for the desktop surface. */
function declaredDesktopItemGates(): { pageId: NavId; key: string }[] {
  const declared: { pageId: NavId; key: string }[] = [];
  for (const item of SHELL_NAVIGATION_ITEMS) {
    const gate = item.gates?.[ShellNavigationSurface.Desktop]?.find(
      (candidate) => candidate.kind === ShellNavigationGateKind.DesktopLabsItem
    );
    const pageId = item.routeId
      ? DESKTOP_SHELL_ROUTE_NAV_IDS[item.routeId]
      : null;
    if (gate?.key !== undefined && pageId !== null) {
      declared.push({ pageId, key: gate.key });
    }
  }
  return declared;
}

describe("desktop per-item Labs gate coverage (ISS-9731)", () => {
  it("declares gates for the Labs destinations that have one", () => {
    // Guards a vacuous pass: an empty declared set would satisfy every loop
    // below. Issues, Agents, Help and Documents since PRD-797 removed Routines
    // and Audit Bot.
    expect(declaredDesktopItemGates()).toHaveLength(4);
  });

  it("resolves every declared gate — closed when its key is closed", () => {
    for (const { pageId, key } of declaredDesktopItemGates()) {
      // Every OTHER declared key open, so a resolver reading the wrong one
      // returns true and this fails.
      const labsItemGates = Object.fromEntries(
        declaredDesktopItemGates().map((gate) => [gate.key, gate.key !== key])
      );

      expect(resolveLabsItemGate({ labsItemGates, pageId })).toBe(false);
    }
  });

  it("resolves every declared gate — open when its key is open", () => {
    const labsItemGates = Object.fromEntries(
      declaredDesktopItemGates().map((gate) => [gate.key, true])
    );

    for (const { pageId } of declaredDesktopItemGates()) {
      expect(resolveLabsItemGate({ labsItemGates, pageId })).toBe(true);
    }
  });
});
