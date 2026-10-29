import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { INSTALL_STATE_LABEL, PackInstallState } from "../../lib/install-state";
import {
  type PackContentEntry,
  PackContentKind,
  type PackView,
} from "../../lib/pack-view";
import { mockPackViews } from "../../lib/pack-view-mock";
import { createPacksContext, PacksMode } from "../../lib/packs-context";
import { CONTENTS_EMPTY_NOTE, PackDetail } from "../pack-detail";

/**
 * FEA-4071 — per-component desktop install state on the Contents tab.
 *
 * Each bundled component renders its honest install state (installed / not
 * installed on THIS machine) through the shared FEA-4083 `InstallStateStatus`
 * treatment when the surface resolved it (desktop). The web surface, which has
 * no local filesystem, shows no per-component markers and instead points the
 * viewer to the desktop app — never a fabricated "not installed".
 */

const BASE_PACK = mockPackViews[0];

const MACHINE_NOTE_RE = /for this machine/i;
const DESKTOP_APP_RE = /desktop app/i;
const CONTENTS_UNAVAILABLE_RE = /bundled contents could not be refreshed/i;
const NO_CACHED_CONTENTS_RE = /no cached contents are available yet/i;

const CONTENTS: PackContentEntry[] = [
  {
    name: "Installed Skill",
    kind: PackContentKind.Skill,
    installState: PackInstallState.Installed,
  },
  {
    name: "Missing Command",
    kind: PackContentKind.Command,
    installState: PackInstallState.NotInstalled,
  },
];

function renderPack(
  pack: PackView,
  mode: PacksMode,
  options: { contentsUnavailable?: boolean } = {}
) {
  const nav = createMemoryNavigation({
    initialPath: "/packs/code",
    orgSlug: "org-test",
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
  );
  return render(
    <PackDetail
      contentsUnavailable={options.contentsUnavailable}
      context={createPacksContext(mode)}
      pack={pack}
    />,
    { wrapper }
  );
}

describe("PackDetail Contents per-component install state (FEA-4071)", () => {
  it("renders installed vs not-installed per component from data (desktop)", () => {
    renderPack({ ...BASE_PACK, contents: CONTENTS }, PacksMode.DesktopTeam);

    // The shared status treatment says the state once, in words — so it reads
    // without color perception. Installed skill and not-installed command each
    // carry their honest label.
    const installedRow = screen.getByText("Installed Skill").closest("li");
    const missingRow = screen.getByText("Missing Command").closest("li");
    expect(installedRow).not.toBeNull();
    expect(missingRow).not.toBeNull();

    expect(
      within(installedRow as HTMLElement).getByText(
        INSTALL_STATE_LABEL[PackInstallState.Installed]
      )
    ).toBeInTheDocument();
    expect(
      within(missingRow as HTMLElement).getByText(
        INSTALL_STATE_LABEL[PackInstallState.NotInstalled]
      )
    ).toBeInTheDocument();
  });

  it("scopes the markers to this machine with an honest note (desktop)", () => {
    renderPack({ ...BASE_PACK, contents: CONTENTS }, PacksMode.DesktopTeam);

    expect(screen.getByText(MACHINE_NOTE_RE)).toBeInTheDocument();
  });

  it("discloses unavailable refresh while preserving cached contents", () => {
    renderPack({ ...BASE_PACK, contents: CONTENTS }, PacksMode.DesktopTeam, {
      contentsUnavailable: true,
    });

    expect(screen.getByText(CONTENTS_UNAVAILABLE_RE)).toBeInTheDocument();
    expect(screen.getByText("Installed Skill")).toBeInTheDocument();
    expect(screen.getByText("Missing Command")).toBeInTheDocument();
  });

  it("discloses unavailable refresh without implying cache exists", () => {
    renderPack({ ...BASE_PACK, contents: [] }, PacksMode.DesktopTeam, {
      contentsUnavailable: true,
    });

    expect(screen.getByText(NO_CACHED_CONTENTS_RE)).toBeInTheDocument();
    expect(screen.queryByText(CONTENTS_EMPTY_NOTE)).not.toBeInTheDocument();
  });

  it("shows no per-component markers on web, points to the desktop app", () => {
    // Web catalog read: contents carry NO installState (no local filesystem).
    const webContents: PackContentEntry[] = CONTENTS.map(
      ({ installState, ...rest }) => rest
    );
    renderPack({ ...BASE_PACK, contents: webContents }, PacksMode.WebAdmin);

    // No fabricated install/not-installed markers on the web surface.
    expect(
      screen.queryByText(INSTALL_STATE_LABEL[PackInstallState.Installed])
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(INSTALL_STATE_LABEL[PackInstallState.NotInstalled])
    ).not.toBeInTheDocument();
    // Instead, an honest desktop-only pointer.
    expect(screen.getByText(DESKTOP_APP_RE)).toBeInTheDocument();
  });

  it("shows no note on a desktop surface before per-component state loads", () => {
    const desktopUnloaded: PackContentEntry[] = CONTENTS.map(
      ({ installState, ...rest }) => rest
    );
    renderPack(
      { ...BASE_PACK, contents: desktopUnloaded },
      PacksMode.DesktopTeam
    );

    // Install-capable surface, states not yet resolved → the markers are the
    // signal once they arrive; no premature note, no desktop-only pointer.
    expect(screen.queryByText(MACHINE_NOTE_RE)).not.toBeInTheDocument();
    expect(screen.queryByText(DESKTOP_APP_RE)).not.toBeInTheDocument();
  });
});
