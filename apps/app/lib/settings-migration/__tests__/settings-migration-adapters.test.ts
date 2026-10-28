/**
 * ISS-8380 AC2 — the seven compatibility shapes the Settings migration has to
 * survive, one describe block each: old URLs, OAuth callbacks, bookmarked
 * Members links, older Desktop requests, unknown fields, rollback, and forward
 * navigation.
 *
 * Expected panels and tabs are written out by hand against the two vocabulary
 * SSOTs, never derived from the matrix under test: a test that rebuilt its
 * expectation from `LEGACY_SETTINGS_TAB_SUCCESSOR` could not fail when a row of
 * it was deleted.
 */
import {
  SettingsPanelId,
  SettingsPanelIntent,
} from "@repo/api/src/types/settings-panel";
import { parseSettingsRouteParams } from "@repo/api/src/types/settings-route";
import { describe, expect, it } from "vitest";
import { SettingsTab } from "@/app/(authenticated)/[orgSlug]/settings/settings-tabs";
import { resolveRedirectSearchParams } from "@/lib/app-route-redirects";
import {
  isRetainedLegacySettingsPath,
  resolveLegacySettingsFragmentPanel,
  resolveLegacyTabForV2Panel,
  resolveV2SettingsDeepLink,
  SettingsDeepLinkSource,
} from "@/lib/settings-migration/settings-deep-link-adapters";

const DESKTOP_AUTHORIZE_PATH = "/settings/integrations/desktop/authorize";
const DESKTOP_CONNECT_PATH = "/settings/integrations/desktop/connect";

describe("AC2.1 old URLs", () => {
  it("carries a retired /organization bookmark through both hops to the v2 General panel", () => {
    // ISS-5011 forwards the retired route to `?tab=organization`; ISS-8380 has
    // to keep that promise on the far side of the tab-to-panel rename, so the
    // two hops are asserted together rather than each in isolation.
    const overlay = resolveRedirectSearchParams("/organization", null);

    expect(overlay?.set).toEqual({ tab: SettingsTab.Organization });

    const resolved = resolveV2SettingsDeepLink({ tab: overlay?.set.tab });

    expect(resolved.panel).toBe(SettingsPanelId.OrganizationGeneral);
    expect(resolved.source).toBe(SettingsDeepLinkSource.LegacyTab);
  });

  it("resolves a bookmarked admin tab to its own panel rather than the default", () => {
    expect(resolveV2SettingsDeepLink({ tab: SettingsTab.Compliance })).toEqual({
      panel: SettingsPanelId.Compliance,
      intent: SettingsPanelIntent.View,
      source: SettingsDeepLinkSource.LegacyTab,
    });
  });
});

describe("AC2.2 OAuth callbacks", () => {
  it("sends a Linear callback to Plugins even when ?tab= names another tab", () => {
    // The legacy page gives a callback param precedence over `?tab=` so the
    // returning admin sees the card that renders the result. v2 dissolved the
    // Integrations tab, so the precedence has to survive as a per-provider
    // panel or the promise breaks.
    const resolved = resolveV2SettingsDeepLink({
      linear: "connected",
      tab: SettingsTab.Profile,
    });

    expect(resolved.panel).toBe(SettingsPanelId.Plugins);
    expect(resolved.source).toBe(SettingsDeepLinkSource.Callback);
  });

  it("reports a GitHub callback as unowned rather than sending it to Profile", () => {
    // The v2 Profile panel reads Clerk account data only: no `?github=` read,
    // so the `requires_confirmation` reset dialog that lives in the legacy
    // github-integration-card cannot run there. Routing the callback to it
    // would drop the OAuth result on a panel that cannot complete the flow, so
    // the adapter reports that it has no owner instead.
    const resolved = resolveV2SettingsDeepLink({
      github: "requires_confirmation",
    });

    expect(resolved.source).toBe(SettingsDeepLinkSource.UnownedCallback);
    expect(resolved.panel).toBe(SettingsPanelId.Profile);
  });

  it("opens Plugins for a Google Drive callback, which mounts the Drive card", () => {
    // ISS-10316 moved the Drive card and its `?google=` outcome onto Plugins.
    // An explicit `?tab=` must not outrank the returning OAuth result.
    const resolved = resolveV2SettingsDeepLink({
      google: "success",
      tab: SettingsTab.Profile,
    });

    expect(resolved.panel).toBe(SettingsPanelId.Plugins);
    expect(resolved.source).toBe(SettingsDeepLinkSource.Callback);
  });

  it("keeps an unowned callback distinct from a link that named nothing", () => {
    // Same OUTCOME panel, different fact. Collapsing the two lets a caller read
    // a dropped OAuth result as an ordinary visit to Settings.
    expect(resolveV2SettingsDeepLink({}).source).toBe(
      SettingsDeepLinkSource.Default
    );
    expect(
      resolveV2SettingsDeepLink({ github: "requires_confirmation" }).source
    ).not.toBe(SettingsDeepLinkSource.Default);
  });

  it("still detects a callback carried in a repeated key with a blank first entry", () => {
    // Callback PRESENCE is deliberately not the position-0 rule the tab and
    // panel readers use: `hasSearchParamValue` on the legacy page asks whether
    // any entry is nonempty, and both trees have to agree about whether a round
    // trip happened.
    const resolved = resolveV2SettingsDeepLink({
      linear: ["", "connected"],
      tab: SettingsTab.Profile,
    });

    expect(resolved.panel).toBe(SettingsPanelId.Plugins);
    expect(resolved.source).toBe(SettingsDeepLinkSource.Callback);
  });

  it("does not treat an empty callback value as a round trip", () => {
    // An empty string is not a callback, so `?tab=` must still win — the same
    // rule `hasSearchParamValue` enforces on the legacy page.
    const resolved = resolveV2SettingsDeepLink({
      github: "",
      tab: SettingsTab.ApiKeys,
    });

    expect(resolved.panel).toBe(SettingsPanelId.ApiKeys);
    expect(resolved.source).toBe(SettingsDeepLinkSource.LegacyTab);
  });
});

describe("AC2.3 bookmarked Members links", () => {
  it("lands a v2 Members bookmark on the legacy tab that administers members", () => {
    // Members is v2-only as a PANEL, but not as a capability: legacy
    // administers members through Clerk's embedded OrganizationProfile inside
    // the Organization tab, so the bookmark has a real legacy home.
    expect(resolveLegacyTabForV2Panel(SettingsPanelId.Members)).toBe(
      SettingsTab.Organization
    );
  });

  it("keeps Members distinct from the General panel it shares a legacy tab with", () => {
    expect(
      resolveV2SettingsDeepLink({ tab: SettingsTab.Organization }).panel
    ).toBe(SettingsPanelId.OrganizationGeneral);
  });
});

describe("AC2.4 older Desktop requests", () => {
  it("marks the device-authorize and device-connect paths as retained", () => {
    // Both are hard-coded in Desktop builds already installed on user machines,
    // which are not upgraded with the web app. A v2 route consolidation that
    // forwarded either one would break device authorization for every shipped
    // build, so they are named here and excluded from any Settings rewrite.
    expect(isRetainedLegacySettingsPath(DESKTOP_AUTHORIZE_PATH)).toBe(true);
    expect(isRetainedLegacySettingsPath(DESKTOP_CONNECT_PATH)).toBe(true);
    expect(isRetainedLegacySettingsPath(`/acme${DESKTOP_AUTHORIZE_PATH}`)).toBe(
      true
    );
  });

  it("retains the pairing URL in the form the service actually mints it", () => {
    // `verificationUrl` in apps/api/app/desktop/device-onboarding/service.ts is
    // built as `${origin}/settings/integrations/desktop/connect?code=${code}`.
    // Matching the raw remainder answered false for exactly that string — it is
    // neither equal to the retained entry nor followed by `/` — so the guard
    // protecting the two highest-risk rows failed on the only URL a Desktop
    // build ever opens. A bare-path-only assertion cannot see that.
    expect(
      isRetainedLegacySettingsPath(`${DESKTOP_CONNECT_PATH}?code=ABCD-1234`)
    ).toBe(true);
    expect(
      isRetainedLegacySettingsPath(
        `/acme${DESKTOP_AUTHORIZE_PATH}?provider=github`
      )
    ).toBe(true);
    expect(
      isRetainedLegacySettingsPath(`/acme${DESKTOP_AUTHORIZE_PATH}?tab=x#frag`)
    ).toBe(true);
  });

  it("does not let a query smuggle a retained prefix onto another path", () => {
    // The cut happens at the FIRST `?` or `#`, so a retained path appearing
    // inside a query value is not the path being requested.
    expect(
      isRetainedLegacySettingsPath(
        `/acme/settings/other?next=${DESKTOP_CONNECT_PATH}`
      )
    ).toBe(false);
  });

  it("does not retain the Settings root, which is the surface v2 replaces", () => {
    expect(isRetainedLegacySettingsPath("/acme/settings")).toBe(false);
    expect(isRetainedLegacySettingsPath("/acme/branches")).toBe(false);
  });

  it("gives a Desktop authorize URL no Settings query overlay", () => {
    expect(
      resolveRedirectSearchParams(DESKTOP_AUTHORIZE_PATH, "acme")
    ).toBeNull();
  });
});

describe("AC2.5 unknown fields", () => {
  it("returns the authorized default panel for an unrecognized tab", () => {
    // FEA-3975 retired `admin`; a bookmark still carrying it must render the
    // default panel, not throw and not leave the caller without an answer.
    const resolved = resolveV2SettingsDeepLink({ tab: "admin" });

    expect(resolved.panel).toBe(SettingsPanelId.Profile);
    expect(resolved.source).toBe(SettingsDeepLinkSource.Default);
  });

  it("returns null for an unrecognized panel instead of inventing a tab", () => {
    expect(resolveLegacyTabForV2Panel("not-a-panel")).toBeNull();
    expect(resolveLegacyTabForV2Panel(undefined)).toBeNull();
  });

  it("does not resolve a prototype-chain key as a known value", () => {
    // The value is untrusted URL text; a prototype read would hand back a
    // truthy non-successor and route the user somewhere nobody registered.
    expect(resolveV2SettingsDeepLink({ tab: "constructor" }).source).toBe(
      SettingsDeepLinkSource.Default
    );
    expect(resolveLegacyTabForV2Panel("__proto__")).toBeNull();
  });

  it("still resolves a known value to its own target", () => {
    expect(resolveLegacyTabForV2Panel(SettingsPanelId.CustomFields)).toBe(
      SettingsTab.CustomFields
    );
  });
});

describe("AC2.6 rollback", () => {
  it("maps every rolled-back v2 panel bookmark onto a legacy tab", () => {
    expect(resolveLegacyTabForV2Panel(SettingsPanelId.ApiKeys)).toBe(
      SettingsTab.ApiKeys
    );
    expect(resolveLegacyTabForV2Panel(SettingsPanelId.Plugins)).toBe(
      SettingsTab.Integrations
    );
    expect(resolveLegacyTabForV2Panel(SettingsPanelId.ConnectedDevices)).toBe(
      SettingsTab.Integrations
    );
    expect(resolveLegacyTabForV2Panel(SettingsPanelId.OtherLabs)).toBe(
      SettingsTab.Organization
    );
  });

  it("maps a retired panel id onto its successor's legacy tab", () => {
    expect(resolveLegacyTabForV2Panel("local-compute-targets")).toBe(
      SettingsTab.Integrations
    );
  });

  it("reads a repeated panel key at position 0, as both other readers do", () => {
    // BEHAVIOUR CHANGE, deliberate. This case previously expected Tags, which
    // was the wrong contract: `?panel=&panel=tags` is one bag read by three
    // things, and the other two — `parseSettingsRouteParams` in
    // packages/api/src/types/settings-route.ts and `getRequestedTab` in the
    // legacy settings page — both take `[0]`. A blank at position 0 means the
    // link named nothing, so a rolled-back bookmark opened Tags here while the
    // v2 tree and the legacy `?tab=` reader opened the default Profile.
    expect(resolveLegacyTabForV2Panel(["", SettingsPanelId.Tags])).toBeNull();
    expect(resolveLegacyTabForV2Panel([SettingsPanelId.Tags, ""])).toBe(
      SettingsTab.Tags
    );
  });

  it("agrees with the v2 parser on the same repeated-panel bag", () => {
    // The two readers are asserted against each other rather than each against
    // a literal, because the defect was not a wrong answer in isolation — it
    // was two readers of one bag giving different answers.
    const bag = ["", SettingsPanelId.Tags];

    expect(parseSettingsRouteParams({ panel: bag }).panel).toBeNull();
    expect(resolveLegacyTabForV2Panel(bag)).toBeNull();
  });
});

describe("AC2.7 forward navigation", () => {
  it("opens Plugins for the legacy Integrations tab, per the ISS-10316 ruling", () => {
    // The tab's cards went to several panels. The operator ruled on ISS-10316
    // that a bookmarked `?tab=integrations` opens Plugins: its subject is
    // connected tools, and the OAuth callbacks already resolve there. Before
    // that ruling this link degraded to the default panel on purpose.
    const resolved = resolveV2SettingsDeepLink({
      tab: SettingsTab.Integrations,
    });

    expect(resolved.panel).toBe(SettingsPanelId.Plugins);
    expect(resolved.source).toBe(SettingsDeepLinkSource.LegacyTab);
  });

  it("opens API Keys for a bookmarked Integrations link to the Anthropic card", () => {
    // The fragment never reaches the server, so this is the client half of
    // the forward map: the card that anchor names now renders on API Keys.
    expect(
      resolveLegacySettingsFragmentPanel(
        "?tab=integrations",
        "#anthropic-api-key"
      )
    ).toBe(SettingsPanelId.ApiKeys);
  });

  it("leaves Plugins in place for an Integrations link with no card fragment", () => {
    expect(
      resolveLegacySettingsFragmentPanel("?tab=integrations", "")
    ).toBeNull();
    expect(
      resolveLegacySettingsFragmentPanel("?tab=integrations", "#linear")
    ).toBeNull();
  });

  it("never lets the fragment override an explicit panel or a callback", () => {
    expect(
      resolveLegacySettingsFragmentPanel(
        "?panel=plugins&tab=integrations",
        "#anthropic-api-key"
      )
    ).toBeNull();
    expect(
      resolveLegacySettingsFragmentPanel(
        "?tab=integrations&google=success",
        "#anthropic-api-key"
      )
    ).toBeNull();
  });

  it("ignores the Anthropic fragment on a tab that never held the card", () => {
    expect(
      resolveLegacySettingsFragmentPanel("?tab=profile", "#anthropic-api-key")
    ).toBeNull();
  });

  it("forwards a single-successor tab to its own panel", () => {
    const resolved = resolveV2SettingsDeepLink({ tab: SettingsTab.Tags });

    expect(resolved.panel).toBe(SettingsPanelId.Tags);
    expect(resolved.source).toBe(SettingsDeepLinkSource.LegacyTab);
  });
});
