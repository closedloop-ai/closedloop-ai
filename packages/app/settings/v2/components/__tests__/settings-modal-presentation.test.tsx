import { SettingsPanelHost } from "@repo/api/src/types/settings-panel";
import { parseSettingsRouteParams } from "@repo/api/src/types/settings-route";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createSettingsPanelRegistry } from "../../lib/settings-panel-registry";
import {
  fixturePanel,
  grantRead,
} from "../../test-fixtures/settings-panel-fixtures";
import {
  type SettingsDismissal,
  SettingsDismissMode,
} from "../settings-dismissal";
import { SettingsShell, type SettingsShellProps } from "../settings-shell";

/**
 * ISS-8977 — Settings v2 presents as a MODAL over the surface the user was on,
 * with the modal-scale navigation rail, rather than as a page-shaped region.
 *
 * These cases assert the presentation contract itself. The layout invariants
 * (§4.1 of the ISS-8976 spec) are asserted structurally because jsdom performs
 * no layout: there is no width to measure, so the guard that actually prevents
 * clipping — a shrinkable panel track — is what gets pinned.
 */

const OVERLAY: SettingsDismissal = {
  mode: SettingsDismissMode.Overlay,
  onDismiss: () => {
    // Presentation cases never dismiss; the dismissal suite owns that axis.
  },
};

const COLD: SettingsDismissal = { mode: SettingsDismissMode.Cold };

const registry = createSettingsPanelRegistry([
  fixturePanel("profile"),
  fixturePanel("members"),
]);

const UNDERLYING_SURFACE_TEST_ID = "underlying-surface";

const CLOSE_SETTINGS_NAME = /^Close settings$/;
const CORNER_CLOSE_NAME = /^Close$/;
const SETTINGS_LANDMARK_NAME = /^Settings$/;

function renderShell(overrides: Partial<SettingsShellProps> = {}) {
  const nav = createMemoryNavigation({
    initialPath: "/branches",
    orgSlug: "acme",
  });
  return render(
    <NavigationProvider adapter={nav.adapter}>
      <main data-testid={UNDERLYING_SURFACE_TEST_ID}>
        <h1>Branches</h1>
      </main>
      <SettingsShell
        capabilities={grantRead("profile", "members")}
        dismissal={COLD}
        host={SettingsPanelHost.Web}
        registry={registry}
        routeParams={parseSettingsRouteParams({ panel: "members" })}
        {...overrides}
      />
    </NavigationProvider>
  );
}

function settingsDialog(): HTMLElement {
  return screen.getByTestId("settings-shell");
}

describe("settings modal presentation (ISS-8977)", () => {
  it("presents Settings as a modal dialog over a surface that stays mounted", () => {
    const { container } = renderShell();

    const dialog = settingsDialog();
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(dialog).toHaveAttribute("data-state", "open");

    // The surface behind it is untouched and still in the document — the whole
    // point of an overlay rather than a page navigation.
    expect(screen.getByTestId(UNDERLYING_SURFACE_TEST_ID)).toBeInTheDocument();

    // Portaled, not nested: a page-shaped region would render inside the
    // caller's own container, where it would be laid out by the surface.
    expect(
      container.querySelector('[data-testid="settings-shell"]')
    ).toBeNull();
  });

  it("names itself with an h1 so every panel section stays at h2", () => {
    renderShell();

    const dialog = settingsDialog();
    const name = document.getElementById(
      dialog.getAttribute("aria-labelledby") ?? ""
    );

    expect(name).not.toBeNull();
    expect(name).toHaveTextContent("Settings");
    // Radix renders `Dialog.Title` as an `h2` unless it is told otherwise, which
    // would leave the document with no `h1` and put "Settings" on the same
    // level as every panel heading. WCAG 1.3.1.
    expect(name?.tagName).toBe("H1");
  });

  it("describes itself for a screen reader as well as naming itself", () => {
    renderShell();

    const description = document.getElementById(
      settingsDialog().getAttribute("aria-describedby") ?? ""
    );
    expect(description).toHaveTextContent(
      "Manage your user and organization settings."
    );
  });

  it("offers exactly one close affordance, and it is the rail's", () => {
    renderShell();

    // The rail's control is present…
    expect(
      screen.getByRole("link", { name: CLOSE_SETTINGS_NAME })
    ).toBeInTheDocument();
    // …and the dialog's own corner control is not, so the surface states "you
    // can leave" once rather than twice.
    expect(
      screen.queryByRole("button", { name: CORNER_CLOSE_NAME })
    ).not.toBeInTheDocument();
  });

  it("hides the close icon from the accessibility tree behind its label", () => {
    renderShell();

    const close = screen.getByRole("link", { name: CLOSE_SETTINGS_NAME });
    expect(close).toHaveAttribute("aria-label", "Close settings");
    expect(close.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps the rail a labelled nav landmark of real lists, not bare divs", () => {
    renderShell();

    const nav = screen.getByRole("navigation", {
      name: SETTINGS_LANDMARK_NAME,
    });
    expect(nav).toBeInTheDocument();

    const lists = screen.getAllByRole("list");
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) {
      const labelledBy = list.getAttribute("aria-labelledby");
      expect(labelledBy).not.toBeNull();
      expect(document.getElementById(labelledBy ?? "")).not.toBeNull();
    }
  });

  it("lets the panel column shrink instead of being pushed out by its content", () => {
    renderShell({
      registry: createSettingsPanelRegistry([
        fixturePanel("profile"),
        fixturePanel("members", {
          Panel: () => (
            <div data-testid="panel-body-members">{"x".repeat(400)}</div>
          ),
        }),
      ]),
    });

    // jsdom has no layout, so the invariant is asserted where it is declared:
    // the track can reach zero and the column is allowed to shrink below its
    // content. Lose either and a wide table pushes the rail off its 240 track.
    expect(settingsDialog().className).toContain(
      "md:grid-cols-[240px_minmax(0,1fr)]"
    );
    const panelColumn = screen.getByTestId("panel-body-members").closest("div")
      ?.parentElement?.parentElement;
    expect(panelColumn?.className).toContain("min-w-0");
  });

  it("makes the panel body its own query container, on the element that caps its width", () => {
    renderShell({
      registry: createSettingsPanelRegistry([
        fixturePanel("profile"),
        fixturePanel("members", {
          Panel: () => <div data-testid="panel-body-members">Members</div>,
        }),
      ]),
    });

    // ISS-8975: from `md` up the rail takes a fixed 240 off the column, so a
    // panel's viewport-keyed `sm:` rule reads a width the panel does not have.
    // The container and the width cap must be the SAME element — split them and
    // every panel's threshold is off by this padding and this cap.
    const wrapper = screen.getByTestId("panel-body-members").parentElement;
    expect(wrapper?.className).toContain("@container/settings-panel");
    expect(wrapper?.className).toContain("max-w-4xl");
  });

  it("stacks the rail above the panel below md instead of holding two columns", () => {
    renderShell();

    // The operator's D1 answer: stack inside the height-capped dialog, not
    // full-bleed and not a Sheet. One column until md, two from md up.
    const dialog = settingsDialog();
    expect(dialog.className).toContain("grid-cols-1");
    expect(dialog.className).toContain("md:grid-cols-[240px_minmax(0,1fr)]");

    const rail = screen
      .getByRole("navigation", { name: SETTINGS_LANDMARK_NAME })
      .closest("aside");
    expect(rail?.className).toContain("border-b");
    expect(rail?.className).toContain("md:border-r");
    expect(rail?.className).toContain("md:border-b-0");
  });

  it("presents the same modal on desktop as on web", () => {
    // D4: the "an explicit, stated reason the desktop shell differs" escape in
    // ISS-8977's AC is deliberately not taken. One shell, one presentation.
    for (const host of [SettingsPanelHost.Web, SettingsPanelHost.Desktop]) {
      const view = renderShell({ host });
      const dialog = settingsDialog();
      expect(dialog).toHaveAttribute("role", "dialog");
      expect(dialog).toHaveAttribute("data-state", "open");
      expect(
        screen.getByRole("navigation", { name: SETTINGS_LANDMARK_NAME })
      ).toBeInTheDocument();
      view.unmount();
    }
  });

  it("has no second, page-shaped path — every dismissal mode is a dialog", () => {
    // ISS-8977 AC3: the page-based shell is removed rather than left behind a
    // flag or a prop. `open` is not a prop, so mounting IS showing, and neither
    // dismissal mode can select a non-modal render.
    for (const dismissal of [COLD, OVERLAY]) {
      const view = renderShell({ dismissal });
      expect(settingsDialog()).toHaveAttribute("role", "dialog");
      view.unmount();
    }
  });
});
