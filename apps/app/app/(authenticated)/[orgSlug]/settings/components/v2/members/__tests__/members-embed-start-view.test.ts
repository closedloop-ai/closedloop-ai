import { SettingsPanelIntent } from "@repo/api/src/types/settings-panel";
import { describe, expect, it } from "vitest";
import {
  CLERK_ORGANIZATION_MEMBERS_PATH,
  MEMBERS_EMBED_START_PATH_BY_INTENT,
  resolveMembersEmbedStartHash,
} from "../members-embed-start-view";

/**
 * Clerk's own route name for the members page, written out rather than imported
 * from the module under test. It is a CROSS-BOUNDARY contract value —
 * `OrganizationProfileRoutes` in @clerk/ui 1.6.5 routes exactly
 * `organization-general`, `organization-members`, `organization-billing` and
 * `organization-api-keys` — so an assertion that reads our constant on both
 * sides proves only that a variable equals itself, and would stay green while
 * the panel sent the embed to a path Clerk does not route (which silently
 * falls back to the index route, Organization General).
 */
const CLERK_MEMBERS_ROUTE_LITERAL = "/organization-members";

describe("resolveMembersEmbedStartHash", () => {
  it("seeds the members view from an empty fragment", () => {
    // Without this the embed opens Clerk's index route, which is Organization
    // General — a page the organizationGeneral panel already owns. A Members
    // panel showing General is the wrong panel, so the seed is load-bearing
    // rather than cosmetic.
    expect(resolveMembersEmbedStartHash("", SettingsPanelIntent.View)).toBe(
      `#${CLERK_MEMBERS_ROUTE_LITERAL}`
    );
  });

  it("names the route Clerk actually serves the members page on", () => {
    expect(CLERK_ORGANIZATION_MEMBERS_PATH).toBe(CLERK_MEMBERS_ROUTE_LITERAL);
  });

  it("still seeds the members view for the invite intent", () => {
    // The panel-contract fallback, and on the installed Clerk it is the ONLY
    // path: @clerk/ui 1.6.5 routes no invitations page — invitations is a tab
    // inside the members page whose Tabs takes no defaultIndex, and the invite
    // composer behind it is uncontrolled Action state. So `intent=invite`
    // lands on the members view, where Clerk's own Invitations tab and Invite
    // button are, and never on a blank frame or a different panel.
    expect(resolveMembersEmbedStartHash("", SettingsPanelIntent.Invite)).toBe(
      `#${CLERK_MEMBERS_ROUTE_LITERAL}`
    );
  });

  it("writes nothing once the fragment is already Clerk's own route", () => {
    // `#/…` is the shape Clerk's hasUrlInFragment recognises, so by then the
    // fragment IS the embed's navigation state. Re-seeding would drag a user
    // who clicked through to Billing back to the roster under them.
    expect(
      resolveMembersEmbedStartHash(
        "#/organization-billing",
        SettingsPanelIntent.View
      )
    ).toBeNull();
    expect(
      resolveMembersEmbedStartHash(
        "#/organization-billing",
        SettingsPanelIntent.Invite
      )
    ).toBeNull();
  });

  it("seeds over a fragment that is not Clerk's, such as a bare anchor", () => {
    // `#members` is not `#/…`, so Clerk's router ignores it and would open the
    // index route. Treating any non-empty fragment as Clerk's would leave the
    // panel on General.
    expect(
      resolveMembersEmbedStartHash("#members", SettingsPanelIntent.View)
    ).toBe(`#${CLERK_ORGANIZATION_MEMBERS_PATH}`);
  });
});

describe("MEMBERS_EMBED_START_PATH_BY_INTENT", () => {
  it("covers every intent, so a new one cannot fall through silently", () => {
    // The map is exhaustive by type; this pins that every member of the union
    // really has an entry at runtime, which a widened key type would not catch.
    for (const intent of Object.values(SettingsPanelIntent)) {
      expect(MEMBERS_EMBED_START_PATH_BY_INTENT[intent]).toBe(
        CLERK_ORGANIZATION_MEMBERS_PATH
      );
    }
  });
});
