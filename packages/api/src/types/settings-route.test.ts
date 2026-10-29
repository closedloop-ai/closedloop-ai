import { describe, expect, it } from "vitest";
import { SettingsPanelId, SettingsPanelIntent } from "./settings-panel.ts";
import { parseSettingsRouteParams } from "./settings-route.ts";
import {
  buildMembersSettingsRoute,
  buildSettingsPanelRoute,
  resolveSettingsCloseRoute,
} from "./settings-route-links.ts";

describe("settings deep-link parsing", () => {
  it("keeps an absent panel, an unknown panel, and a known panel apart", () => {
    expect(parseSettingsRouteParams({})).toEqual({
      panel: null,
      requestedPanel: null,
      intent: "view",
      returnTo: null,
    });

    expect(parseSettingsRouteParams({ panel: "integrations" })).toEqual({
      panel: null,
      requestedPanel: "integrations",
      intent: "view",
      returnTo: null,
    });

    expect(parseSettingsRouteParams({ panel: "members" })).toEqual({
      panel: "members",
      requestedPanel: "members",
      intent: "view",
      returnTo: null,
    });
  });

  it("survives a hostile or malformed parameter bag without throwing", () => {
    expect(parseSettingsRouteParams(null).panel).toBeNull();
    expect(
      parseSettingsRouteParams("?panel=members").requestedPanel
    ).toBeNull();
    expect(parseSettingsRouteParams({ panel: ["members", "tags"] })).toEqual({
      panel: "members",
      requestedPanel: "members",
      intent: "view",
      returnTo: null,
    });
    expect(parseSettingsRouteParams({ panel: "  " }).requestedPanel).toBeNull();
    expect(parseSettingsRouteParams({ intent: "escalate" }).intent).toBe(
      "view"
    );
  });

  it("discards only the malformed field, never the rest of the link", () => {
    // A single whole-bag parse would drop `panel` too, turning "the link named
    // members with junk attached" into "the link named nothing" — a different
    // fact that Settings renders as a plain visit rather than a failed deep link.
    expect(
      parseSettingsRouteParams({ panel: "members", returnTo: { evil: true } })
    ).toEqual({
      panel: "members",
      requestedPanel: "members",
      intent: "view",
      returnTo: null,
    });
    expect(
      parseSettingsRouteParams({ panel: "members", intent: 42 }).panel
    ).toBe("members");
  });

  it("reads a URLSearchParams instead of silently reading it as empty", () => {
    // Its values live in internal slots, so an own-property read finds nothing
    // and every parameter would come back absent — turning a deep link that
    // named a panel into a plain visit to the default, with nothing to notice.
    expect(
      parseSettingsRouteParams(
        new URLSearchParams("panel=members&intent=invite&returnTo=%2Fbranches")
      )
    ).toEqual({
      panel: "members",
      requestedPanel: "members",
      intent: "invite",
      returnTo: "/branches",
    });

    // A repeated key keeps its list and takes the same first-value path an
    // array-valued bag takes, rather than collapsing to the last one.
    expect(
      parseSettingsRouteParams(new URLSearchParams("panel=members&panel=tags"))
        .panel
    ).toBe("members");

    expect(parseSettingsRouteParams(new URLSearchParams()).requestedPanel).toBe(
      null
    );
  });

  it("reads a retired panel id as its successor", () => {
    const connectedDevices = {
      panel: SettingsPanelId.ConnectedDevices,
      requestedPanel: SettingsPanelId.ConnectedDevices,
      intent: "view",
      returnTo: null,
    };

    expect(
      parseSettingsRouteParams({ panel: "local-compute-targets" })
    ).toEqual(connectedDevices);
    expect(
      parseSettingsRouteParams(
        new URLSearchParams("panel=local-compute-targets")
      )
    ).toEqual(connectedDevices);
  });

  it("keeps an unknown id unknown, including prototype key names", () => {
    for (const unknownPanel of ["no-such-panel", "__proto__", "constructor"]) {
      expect(parseSettingsRouteParams({ panel: unknownPanel })).toEqual({
        panel: null,
        requestedPanel: unknownPanel,
        intent: "view",
        returnTo: null,
      });
    }
  });

  it("ignores an inherited key rather than reading it off the prototype", () => {
    expect(
      parseSettingsRouteParams(Object.create({ panel: "members" }))
        .requestedPanel
    ).toBeNull();
  });

  it("accepts only an in-app path as the close destination", () => {
    expect(
      resolveSettingsCloseRoute(
        parseSettingsRouteParams({ returnTo: "/sessions" }),
        withOrgSlug
      )
    ).toBe("/sessions");

    for (const hostile of [
      "//evil.example",
      "https://evil.example",
      String.raw`/\evil.example`,
      "/sessions\nSet-Cookie: x",
      "sessions",
    ]) {
      expect(
        resolveSettingsCloseRoute(
          parseSettingsRouteParams({ returnTo: hostile }),
          withOrgSlug
        )
      ).toBe("/acme/dashboard");
    }
  });

  it("returns a host-absolute returnTo verbatim and joins only the default", () => {
    // The web producer's own path already carries the slug (`usePathname()`),
    // and the org builder is what put it there. Running it through the builder
    // a second time produced `/acme/acme/branches`, and handing desktop — whose
    // builder is the identity — a slug-carrying path left it unroutable. Only
    // the org-relative dashboard default is joined.
    expect(
      resolveSettingsCloseRoute(
        parseSettingsRouteParams({ returnTo: "/acme/branches" }),
        withOrgSlug
      )
    ).toBe("/acme/branches");

    expect(
      resolveSettingsCloseRoute(
        parseSettingsRouteParams({ returnTo: "/branches" }),
        identityOrgPath
      )
    ).toBe("/branches");

    expect(
      resolveSettingsCloseRoute(parseSettingsRouteParams({}), identityOrgPath)
    ).toBe("/dashboard");
  });
});

describe("settings deep-link building", () => {
  it("round-trips the Members deep link, intent included", () => {
    const href = buildMembersSettingsRoute({
      intent: SettingsPanelIntent.Invite,
      returnTo: "/branches",
    });
    expect(href).toBe(
      "/settings?panel=members&intent=invite&returnTo=%2Fbranches"
    );

    const query = Object.fromEntries(new URL(href, "http://x").searchParams);
    expect(parseSettingsRouteParams(query)).toEqual({
      panel: "members",
      requestedPanel: "members",
      intent: "invite",
      returnTo: "/branches",
    });
  });

  it("omits a default intent and a rejected returnTo rather than serialising them", () => {
    expect(buildMembersSettingsRoute()).toBe("/settings?panel=members");
    expect(
      buildMembersSettingsRoute({ intent: SettingsPanelIntent.View })
    ).toBe("/settings?panel=members");
    expect(
      buildSettingsPanelRoute({
        panel: "tags",
        returnTo: "https://evil.example",
      })
    ).toBe("/settings?panel=tags");
    expect(buildSettingsPanelRoute()).toBe("/settings");
  });
});

/** Stands in for the web adapter's `useOrgPath()` builder. */
function withOrgSlug(orgRelativePath: string): string {
  return `/acme${orgRelativePath}`;
}

/** Stands in for desktop's builder, which has no slug to join. */
function identityOrgPath(orgRelativePath: string): string {
  return orgRelativePath;
}
