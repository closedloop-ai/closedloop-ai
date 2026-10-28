import {
  SettingsActorCapabilityStatus,
  SettingsPanelCapability,
  SettingsPanelHost,
} from "@repo/api/src/types/settings-panel";
import { describe, expect, it } from "vitest";
import {
  fixturePanel,
  grantRead,
} from "../../test-fixtures/settings-panel-fixtures";
import { createSettingsPanelRegistry } from "../settings-panel-registry";
import { resolveSettingsPanel } from "../settings-panel-resolution";

const registry = createSettingsPanelRegistry([
  fixturePanel("profile"),
  fixturePanel("members"),
  fixturePanel("desktop-app", {
    hosts: [SettingsPanelHost.Desktop],
  }),
]);

const web = { host: SettingsPanelHost.Web, registry } as const;

describe("settings panel resolution", () => {
  it("resolves a plain visit to the default panel", () => {
    expect(
      resolveSettingsPanel({
        ...web,
        capabilities: grantRead("profile", "members"),
        requestedPanel: null,
      })
    ).toEqual({
      evaluatedPanelId: "profile",
      fallbackPanelId: "profile",
      panelId: "profile",
      requestedPanel: null,
      requestedPanelId: null,
      status: "ready",
    });
  });

  it("reports an unrecognised link as unknown and still offers a way in", () => {
    expect(
      resolveSettingsPanel({
        ...web,
        capabilities: grantRead("profile", "members"),
        requestedPanel: "billing",
      })
    ).toEqual({
      evaluatedPanelId: null,
      fallbackPanelId: "profile",
      panelId: null,
      requestedPanel: "billing",
      requestedPanelId: null,
      status: "unknown",
    });
  });

  it("keeps unavailable, forbidden, and unknown as three different answers", () => {
    const capabilities = grantRead("profile");

    expect(
      resolveSettingsPanel({
        ...web,
        capabilities,
        requestedPanel: "desktop-app",
      }).status
    ).toBe("unavailable");

    expect(
      resolveSettingsPanel({ ...web, capabilities, requestedPanel: "members" })
        .status
    ).toBe("forbidden");

    expect(
      resolveSettingsPanel({ ...web, capabilities, requestedPanel: "nope" })
        .status
    ).toBe("unknown");
  });

  it("never turns a capability read that is pending or failed into a denial", () => {
    const pending = resolveSettingsPanel({
      ...web,
      capabilities: { status: SettingsActorCapabilityStatus.Pending },
      requestedPanel: "members",
    });
    expect(pending).toEqual({
      evaluatedPanelId: "members",
      fallbackPanelId: null,
      panelId: null,
      requestedPanel: "members",
      requestedPanelId: "members",
      status: "pending",
    });

    expect(
      resolveSettingsPanel({
        ...web,
        capabilities: { status: SettingsActorCapabilityStatus.Error },
        requestedPanel: "members",
      }).status
    ).toBe("capability-error");
  });

  it("lets a partial read outrank a grant that is still in the projection", () => {
    // The grant says yes and the partial-failure list says "we could not tell".
    // Reading the stale grant would authorize on evidence we never got.
    expect(
      resolveSettingsPanel({
        ...web,
        capabilities: {
          grants: { members: [SettingsPanelCapability.Read] },
          status: SettingsActorCapabilityStatus.Ready,
          unreadable: ["members"],
        },
        requestedPanel: "members",
      }).status
    ).toBe("capability-error");
  });

  /**
   * ISS-10286 / davetho #4038745930 — `apps/api` and the Desktop build deploy
   * separately, so a desktop binary carrying the Desktop App panel can meet an
   * already-released `GET /settings/view-model` body written before that id
   * existed. Its grant is ABSENT, not withheld, and folding that into a denial
   * locks a user out of their own machine's settings until an unrelated deploy
   * lands.
   *
   * Two keys in the fixture on purpose: a per-panel carve-out and a blanket
   * "absent grant means ready" are indistinguishable on one, and only the
   * second case can tell them apart.
   */
  describe("a settled view-model that predates a panel", () => {
    const skewed = createSettingsPanelRegistry([
      fixturePanel("profile"),
      fixturePanel("desktop-app", { hosts: [SettingsPanelHost.Desktop] }),
    ]);
    const desktop = { host: SettingsPanelHost.Desktop, registry: skewed };
    const olderApi = {
      grants: { profile: [SettingsPanelCapability.Read] },
      status: SettingsActorCapabilityStatus.Ready,
    } as const;

    it("opens the locally-authoritative panel the response never mentions", () => {
      expect(
        resolveSettingsPanel({
          ...desktop,
          capabilities: olderApi,
          requestedPanel: "desktop-app",
        }).status
      ).toBe("ready");
    });

    it("still denies a server-authoritative panel the response never mentions", () => {
      expect(
        resolveSettingsPanel({
          ...desktop,
          capabilities: {
            grants: { "desktop-app": [SettingsPanelCapability.Read] },
            status: SettingsActorCapabilityStatus.Ready,
          },
          requestedPanel: "profile",
        }).status
      ).toBe("forbidden");
    });

    it("honours a present grant set that withholds the capability", () => {
      expect(
        resolveSettingsPanel({
          ...desktop,
          capabilities: {
            grants: { "desktop-app": [] },
            status: SettingsActorCapabilityStatus.Ready,
          },
          requestedPanel: "desktop-app",
        }).status
      ).toBe("forbidden");
    });
  });

  /**
   * ISS-10286, operator ruling 2026-09-17 — "we handle the default guest
   * desktop offline case". A guest on desktop with no cloud session and no
   * network gets NO view-model at all: `useSettingsShellCapabilities` returns
   * `Error`, which used to give every panel `capability-error`. That is the
   * user with no other route to Auth Mode, the sandbox root or the CLI paths,
   * so the panel whose controls are all on their own machine must open anyway.
   *
   * Each case carries its server-authoritative twin on the SAME capabilities
   * object: without it, a change that simply stopped honouring the pending and
   * error rungs at all would satisfy the first half and go unnoticed.
   */
  describe("a capability read that never lands (guest desktop, offline)", () => {
    const registry = createSettingsPanelRegistry([
      fixturePanel("profile"),
      fixturePanel("desktop-app", { hosts: [SettingsPanelHost.Desktop] }),
    ]);
    const desktop = { host: SettingsPanelHost.Desktop, registry };

    it("opens the locally-authoritative panel when the read FAILED", () => {
      const capabilities = {
        status: SettingsActorCapabilityStatus.Error,
      } as const;
      expect(
        resolveSettingsPanel({
          ...desktop,
          capabilities,
          requestedPanel: "desktop-app",
        }).status
      ).toBe("ready");
      expect(
        resolveSettingsPanel({
          ...desktop,
          capabilities,
          requestedPanel: "profile",
        }).status
      ).toBe("capability-error");
    });

    it("opens it while the read is still PENDING rather than spinning", () => {
      const capabilities = {
        status: SettingsActorCapabilityStatus.Pending,
      } as const;
      expect(
        resolveSettingsPanel({
          ...desktop,
          capabilities,
          requestedPanel: "desktop-app",
        }).status
      ).toBe("ready");
      expect(
        resolveSettingsPanel({
          ...desktop,
          capabilities,
          requestedPanel: "profile",
        }).status
      ).toBe("pending");
    });

    it("opens it when the server reports the domain unreadable", () => {
      const capabilities = {
        status: SettingsActorCapabilityStatus.Ready,
        unreadable: ["desktop-app", "profile"],
      } as const;
      expect(
        resolveSettingsPanel({
          ...desktop,
          capabilities,
          requestedPanel: "desktop-app",
        }).status
      ).toBe("ready");
      expect(
        resolveSettingsPanel({
          ...desktop,
          capabilities,
          requestedPanel: "profile",
        }).status
      ).toBe("capability-error");
    });
  });

  it("answers unknown for an unregistered link even while capabilities are pending", () => {
    expect(
      resolveSettingsPanel({
        ...web,
        capabilities: { status: SettingsActorCapabilityStatus.Pending },
        requestedPanel: "billing",
      }).status
    ).toBe("unknown");
  });

  /**
   * ISS-8370 D8 — a plain visit lands on the host's first available panel. The
   * default, Profile, is web-only; a desktop user who followed no link must
   * not be shown a denial for a panel they never asked for.
   */
  describe("a plain visit whose default is unavailable on this host", () => {
    const hostRegistry = createSettingsPanelRegistry([
      fixturePanel("profile", { hosts: [SettingsPanelHost.Web] }),
      fixturePanel("connected-devices"),
      fixturePanel("plugins", { hosts: [SettingsPanelHost.Web] }),
      fixturePanel("members"),
    ]);
    const desktop = {
      host: SettingsPanelHost.Desktop,
      registry: hostRegistry,
    } as const;

    it("lands a plain desktop visit on the first panel the host offers, ready", () => {
      expect(
        resolveSettingsPanel({
          ...desktop,
          capabilities: grantRead("connected-devices", "members"),
          requestedPanel: null,
        })
      ).toEqual({
        evaluatedPanelId: "connected-devices",
        fallbackPanelId: "connected-devices",
        panelId: "connected-devices",
        requestedPanel: null,
        requestedPanelId: null,
        status: "ready",
      });
    });

    it("keeps the unavailable screen for a link that NAMES Profile on desktop", () => {
      const explicit = resolveSettingsPanel({
        ...desktop,
        capabilities: grantRead("connected-devices"),
        requestedPanel: "profile",
      });

      expect(explicit.status).toBe("unavailable");
      expect(explicit.evaluatedPanelId).toBe("profile");
      expect(explicit.fallbackPanelId).toBe("connected-devices");
    });

    it("evaluates the substitute panel exactly as the default would have been", () => {
      // The first offered panel is not automatically ready: a denial there is
      // still a denial, about THAT panel, with recovery pointing elsewhere.
      const forbidden = resolveSettingsPanel({
        ...desktop,
        capabilities: grantRead("members"),
        requestedPanel: null,
      });

      expect(forbidden.status).toBe("forbidden");
      expect(forbidden.evaluatedPanelId).toBe("connected-devices");
      expect(forbidden.fallbackPanelId).toBe("members");
    });

    it("reports unavailable on the default, with no fallback, when the host offers nothing", () => {
      const webOnlyRegistry = createSettingsPanelRegistry([
        fixturePanel("profile", { hosts: [SettingsPanelHost.Web] }),
        fixturePanel("plugins", { hosts: [SettingsPanelHost.Web] }),
      ]);

      expect(
        resolveSettingsPanel({
          host: SettingsPanelHost.Desktop,
          registry: webOnlyRegistry,
          capabilities: grantRead("profile", "plugins"),
          requestedPanel: null,
        })
      ).toEqual({
        evaluatedPanelId: "profile",
        fallbackPanelId: null,
        panelId: null,
        requestedPanel: null,
        requestedPanelId: null,
        status: "unavailable",
      });
    });
  });

  it("falls back to a panel the actor can actually open, not just the default", () => {
    expect(
      resolveSettingsPanel({
        ...web,
        capabilities: grantRead("members"),
        requestedPanel: "profile",
      })
    ).toEqual({
      evaluatedPanelId: "profile",
      fallbackPanelId: "members",
      panelId: null,
      requestedPanel: "profile",
      requestedPanelId: "profile",
      status: "forbidden",
    });
  });
});
