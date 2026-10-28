// @vitest-environment jsdom

import {
  WORKSPACE_MENU_ENTRY_LABEL,
  WORKSPACE_MENU_TRIGGER_LABEL,
  WorkspaceMenuCapabilityReason,
  WorkspaceMenuCapabilityStatus,
  WorkspaceMenuEntryId,
  WorkspaceMenuProjectionStatus,
  workspaceMenuCapabilityError,
} from "@repo/api/src/types/workspace-menu";
import {
  DesktopOs,
  DetectedPlatform,
} from "@repo/app/onboarding/lib/desktop-platform-availability";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // Set explicitly rather than driven through a stubbed user agent: the
  // detection itself has its own suite, and `null` -- the state the first commit
  // actually paints -- is one `render` flushes past before an assertion could
  // catch it.
  //
  // Typed as the union rather than `string`: these cases exist to police a
  // module whose own docstring warns about widening, and a raw "windows" would
  // go on passing against a member the union no longer has.
  detectedOs: null as DetectedPlatform | null,
}));
vi.mock("@repo/app/onboarding/hooks/use-detected-desktop-os", () => ({
  useDetectedDesktopOs: () => mocks.detectedOs,
}));

import { WorkspaceMenuHostAdapterProvider } from "../../../../../shared/workspace-menu-host/provider";
import {
  buildDesktopWorkspaceMenuCapabilities,
  buildWebWorkspaceMenuCapabilities,
} from "../../../../../shared/workspace-menu-host/workspace-menu-capabilities";
import type { WorkspaceMenuHostAdapter } from "../../../../../shared/workspace-menu-host/workspace-menu-host-adapter";
import {
  createDesktopWorkspaceMenuHostAdapterFixture,
  createWebWorkspaceMenuHostAdapterFixture,
  READY_WORKSPACE_MENU_PROJECTION,
  WEB_WORKSPACE_MENU_DOWNLOAD_URL,
} from "../../../../../shared/workspace-menu-host/workspace-menu-host-fixtures";
import { WorkspaceMenu } from "../workspace-menu";

/**
 * Spelled out rather than pulled back through `describeDesktopInstallerGap` and
 * `DESKTOP_INSTALLER_AVAILABILITY`: a fixture that reads its expectation out of
 * the module it polices passes whatever that module returns, so flipping Windows
 * to `Published` or rewriting the sentence could not fail these cases.
 */
const WINDOWS_GAP_TEXT = "Not available for Windows yet";
/** The dimmed, non-activatable download row: `aria-disabled`, never Radix's
 * `disabled` prop — see the component for why the distinction is load-bearing. */
const UNAVAILABLE_ROW = '[aria-disabled="true"]';
const DOWNLOAD_LABEL =
  WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.DownloadDesktop];
const SETTINGS_LABEL =
  WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.Settings];

function renderMenu(
  detectedOs: DetectedPlatform | null,
  adapter: WorkspaceMenuHostAdapter = createWebWorkspaceMenuHostAdapterFixture()
): void {
  mocks.detectedOs = detectedOs;
  render(
    <NavigationProvider
      adapter={
        createMemoryNavigation({
          initialPath: "/dashboard",
          orgSlug: "closedloop",
        }).adapter
      }
    >
      <SidebarProvider>
        <FeatureFlagAdapterProvider
          adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
        >
          <WorkspaceMenuHostAdapterProvider adapter={adapter}>
            <WorkspaceMenu />
          </WorkspaceMenuHostAdapterProvider>
        </FeatureFlagAdapterProvider>
      </SidebarProvider>
    </NavigationProvider>
  );
  // Radix dropdowns open on pointerdown, not click. Without this the menu never
  // renders and every "is absent" assertion below passes vacuously.
  fireEvent.pointerDown(
    screen.getByRole("button", { name: WORKSPACE_MENU_TRIGGER_LABEL }),
    { button: 0, ctrlKey: false }
  );
  screen.getByRole("menu");
}

/**
 * Found by text and walked up, never by the `link` role: `DropdownMenuItem
 * asChild` merges Radix's `role="menuitem"` onto the anchor, so the entry is not
 * exposed as a link and a role query would report every arm as "no download".
 * That is the same walk the sibling suite uses for the Members entry.
 */
function downloadAnchor(): HTMLAnchorElement | null {
  return screen.queryByText(DOWNLOAD_LABEL)?.closest("a") ?? null;
}

describe("workspace menu download entry on a platform with no installer", () => {
  it("states the gap instead of linking the macOS artifact on Windows", () => {
    renderMenu(DesktopOs.Windows);

    expect(screen.getByText(WINDOWS_GAP_TEXT)).not.toBeNull();
    expect(downloadAnchor()).toBeNull();
    // The href, not only the label: an anchor renamed but still pointing at the
    // `.dmg` is the same one-click download of an unrunnable artifact.
    expect(
      document.querySelector(`a[href="${WEB_WORKSPACE_MENU_DOWNLOAD_URL}"]`)
    ).toBeNull();
  });

  it("keeps the gap sentence out of the dimmed unavailable slot", () => {
    // Half strength puts this sentence at 3.2:1 in light mode — under WCAG
    // 1.4.3. Folding it back into the row is the regression this pins, so
    // assert the STRUCTURE: the sentence must not live inside the dimmed row.
    renderMenu(DesktopOs.Windows);

    const gap = screen.getByText(WINDOWS_GAP_TEXT);
    expect(gap.closest(UNAVAILABLE_ROW)).toBeNull();
    // Positive control: there IS an unavailable row here, so the assertion
    // above is about where the sentence sits and not about an empty render.
    expect(
      screen.getByText(DOWNLOAD_LABEL).closest(UNAVAILABLE_ROW)
    ).not.toBeNull();
  });

  it("leaves the unavailable row reachable and points it at the reason", () => {
    // Radix's `disabled` prop drops a row out of the menu's roving focus, so a
    // keyboard or screen-reader user would arrow straight past it and never
    // learn the download exists or why it is unavailable — the one thing this
    // row says. `aria-disabled` keeps it reachable; `aria-describedby` makes
    // the row and the sentence one announcement instead of two loose lines.
    renderMenu(DesktopOs.Windows);

    const row = screen.getByText(DOWNLOAD_LABEL).closest(UNAVAILABLE_ROW);
    expect(row?.getAttribute("data-disabled")).toBeNull();
    // ...and because `data-disabled` is absent, the catalog item's dimming and
    // its `cursor-pointer` override are BOTH still switched off, so the row has
    // to turn the cursor back itself. Without this it wears a pointer and
    // answers nothing on click -- the same promise the `.dmg` link was making.
    expect(row?.className).toContain("cursor-default");
    const describedBy = row?.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      WINDOWS_GAP_TEXT
    );
  });

  it("keeps macOS on the installer it can run", () => {
    // The positive sibling, and the arm that proves the branch keys off the
    // PLATFORM.
    renderMenu(DesktopOs.Mac);

    expect(downloadAnchor()?.getAttribute("href")).toBe(
      WEB_WORKSPACE_MENU_DOWNLOAD_URL
    );
    expect(screen.queryByText(WINDOWS_GAP_TEXT)).toBeNull();
  });

  it("links Linux to the AppImage, not the release's macOS artifact (ISS-12614)", () => {
    renderMenu(DesktopOs.Linux);

    expect(downloadAnchor()?.getAttribute("href")).toBe(
      "https://github.com/closedloop-ai/closedloop-ai/releases/download/desktop-latest/Closedloop-linux-x64.AppImage"
    );
    expect(document.querySelector(UNAVAILABLE_ROW)).toBeNull();
  });
});

/**
 * ISS-11400 review — the download entry on a menu that opened WITHOUT a settled
 * workspace identity.
 *
 * The release lookup needs no identity, so a failed or unsettled projection
 * still holds the link. Before the fix `WorkspaceMenuProjection` hung
 * `downloadUrl` off its `Ready` member alone and `ProjectedWorkspaceMenu`
 * mounted no `DownloadDesktopItem`, so web marked the capability `Ready` and
 * rendered nothing behind it — a valid download silently lost on exactly the
 * standing this ticket makes reachable.
 */
describe("workspace menu download entry on a non-Ready projection (ISS-11400)", () => {
  it("keeps a resolved link on a web Error projection", () => {
    renderMenu(
      DesktopOs.Mac,
      createWebWorkspaceMenuHostAdapterFixture({
        useWorkspaceMenuProjection: () => ({
          status: WorkspaceMenuProjectionStatus.Error,
          reason: WorkspaceMenuCapabilityReason.ReadFailed,
          downloadUrl: WEB_WORKSPACE_MENU_DOWNLOAD_URL,
        }),
      })
    );

    // The capability says Ready, so the row has to BE there: the assertion is
    // on the href rather than the label, because a row that renders the label
    // and no link is the same lost download wearing a different shape.
    expect(downloadAnchor()?.getAttribute("href")).toBe(
      WEB_WORKSPACE_MENU_DOWNLOAD_URL
    );
    // Positive control on the same menu: the trigger really opened onto the
    // projected body, not the Ready one.
    expect(screen.getByText("Account unavailable")).not.toBeNull();
  });

  it("still says so when that same standing could not resolve one", () => {
    // The covering permutation. Carrying the URL through must not make the
    // failed-lookup row unreachable here — rendering nothing would make an
    // outage look like web has no download feature, which is the conflation the
    // capability union exists to prevent.
    renderMenu(
      DesktopOs.Mac,
      createWebWorkspaceMenuHostAdapterFixture({
        useWorkspaceMenuProjection: () => ({
          status: WorkspaceMenuProjectionStatus.Error,
          reason: WorkspaceMenuCapabilityReason.ReadFailed,
          downloadUrl: null,
        }),
        useWorkspaceMenuCapabilities: () =>
          buildWebWorkspaceMenuCapabilities({
            download: workspaceMenuCapabilityError(
              WorkspaceMenuCapabilityReason.ReadFailed
            ),
          }),
      })
    );

    expect(downloadAnchor()).toBeNull();
    expect(screen.getByText(LOOKUP_FAILED_TEXT)).not.toBeNull();
  });
});

describe("workspace menu download entry before the platform is known", () => {
  it("offers neither the artifact nor a gap it has not measured", () => {
    // `null` is not-yet-known, which is neither of the settled answers: handing
    // out the `.dmg` may be a misroute this commit is about to retract, and
    // naming a gap asserts a measurement nobody has taken.
    renderMenu(null);

    expect(downloadAnchor()).toBeNull();
    expect(screen.queryByText(WINDOWS_GAP_TEXT)).toBeNull();
    // The entry KEEPS its slot rather than disappearing: the menu content mounts
    // on open and this read resolves a frame later, so returning nothing here
    // would insert the entry late and shove the items below it under the cursor.
    expect(
      screen.getByText(DOWNLOAD_LABEL).closest(UNAVAILABLE_ROW)
    ).not.toBeNull();
    // Positive control: the menu really opened, so the absences above are
    // findings rather than an empty render.
    expect(screen.getByText(SETTINGS_LABEL)).not.toBeNull();
  });

  it("keeps the download for an agent that named no desktop OS", () => {
    // The state `null` must not be conflated WITH. A completed read that could
    // not name a platform keeps the link: this entry names no platform, so it
    // misroutes nobody, and withholding it would strip the installer from a Mac
    // behind an unparseable agent.
    renderMenu(DetectedPlatform.Unrecognized);

    expect(downloadAnchor()?.getAttribute("href")).toBe(
      WEB_WORKSPACE_MENU_DOWNLOAD_URL
    );
  });
});

describe("workspace menu download entry on the desktop host", () => {
  it("stays absent on Windows rather than stating a gap", () => {
    // Desktop omits this entry entirely (`DESKTOP_OMITTED_WORKSPACE_MENU_ENTRIES`)
    // — a user inside Closedloop Desktop is past the question of installing it —
    // so the platform arms must never reach the renderer and invent a row there.
    renderMenu(
      DesktopOs.Windows,
      createDesktopWorkspaceMenuHostAdapterFixture()
    );

    expect(screen.queryByText(WINDOWS_GAP_TEXT)).toBeNull();
    expect(downloadAnchor()).toBeNull();
    expect(screen.getByText(SETTINGS_LABEL)).not.toBeNull();
  });
});

/**
 * ISS-9753: the sibling of the ISS-9682 download-row fix, in the file that
 * already owns this row.
 *
 * Radix drops a `disabled` menu item out of the menu's roving focus, so a
 * keyboard or screen-reader user arrows straight past it — never landing on it,
 * never hearing it announced, never learning it exists or why. ISS-9682 fixed
 * that on the platform-gap row above; the release-lookup failure in the same
 * menu still carried the original defect, which is worse than the bug because it
 * is invisible to a sighted mouse user.
 *
 * These cases DRIVE the menu by keyboard rather than asserting the attribute:
 * `aria-disabled="true"` is present whether or not roving focus includes the
 * row — Radix's own `disabled` prop emits it too — so an attribute assertion
 * passes on the broken build.
 */

/** Written out, never imported from the component: importing the copy under test
 * would make this agree with an edit that emptied it. */
const LOOKUP_FAILED_TEXT = "No download link is available.";

function failedLookupAdapter(): WorkspaceMenuHostAdapter {
  return createWebWorkspaceMenuHostAdapterFixture({
    useWorkspaceMenuCapabilities: () =>
      buildWebWorkspaceMenuCapabilities({
        download: workspaceMenuCapabilityError(
          WorkspaceMenuCapabilityReason.ReadFailed
        ),
      }),
    useWorkspaceMenuProjection: () => ({
      ...READY_WORKSPACE_MENU_PROJECTION,
      downloadUrl: null,
    }),
  });
}

/**
 * Arrow down from wherever focus sits until it lands ON `target`.
 *
 * The stopping condition is ELEMENT IDENTITY, never a step count and never the
 * focused row's text: DOM order is not focus order here (Radix skips whatever it
 * has excluded), so a count walks to the wrong row on a correct menu, and a text
 * stop would let a copy edit choose this assertion's subject. The bound is only
 * a bound — it exists so a failure reports instead of hanging.
 *
 * Radix moves roving focus on a MACROTASK (`RovingFocusGroup.Item` schedules its
 * `focusFirst` inside a `setTimeout`), so the queue has to drain between
 * presses. Without that every press re-fires from the same row and this reports
 * "unreachable" for a menu that is FINE — a test that fails on working code,
 * which is as dangerous as one that passes on broken code.
 */
async function arrowUntilFocused(
  menu: HTMLElement,
  target: Element
): Promise<boolean> {
  const bound = menu.querySelectorAll('[role^="menuitem"]').length + 2;
  for (let step = 0; step < bound; step += 1) {
    const from = menu.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : menu;
    fireEvent.keyDown(from, { key: "ArrowDown" });
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    if (document.activeElement === target) {
      return true;
    }
  }
  return false;
}

/** The row, resolved by STRUCTURE before any walk, so no copy edit can move it. */
function unavailableRow(): HTMLElement {
  const row = screen.getByRole("menu").querySelector(UNAVAILABLE_ROW);
  if (!(row instanceof HTMLElement)) {
    throw new Error("no unavailable row is rendered in this menu");
  }
  return row;
}

describe("workspace menu download entry when the release lookup fails", () => {
  it("leaves the row reachable by keyboard and announces why", async () => {
    renderMenu(DesktopOs.Mac, failedLookupAdapter());
    const menu = screen.getByRole("menu");
    const row = unavailableRow();

    expect(await arrowUntilFocused(menu, row)).toBe(true);

    // Reached is not enough — arriving must ANNOUNCE it. The row names the
    // entry; its description names the outcome.
    expect(row.textContent).toBe(DOWNLOAD_LABEL);
    const describedBy = row.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      LOOKUP_FAILED_TEXT
    );
  });

  it("still reaches an actionable row in the same menu, link intact", async () => {
    // The positive sibling. Without it the case above could pass on a menu whose
    // roving focus had stopped working altogether. It asserts the LINK rather
    // than claiming the row "acts": an href is what this render can pin.
    renderMenu(DesktopOs.Mac, failedLookupAdapter());
    const menu = screen.getByRole("menu");
    const settings = screen.getByText(SETTINGS_LABEL).closest("a");
    expect(settings).not.toBeNull();

    expect(await arrowUntilFocused(menu, settings as HTMLAnchorElement)).toBe(
      true
    );
    expect(settings?.getAttribute("href")).toBeTruthy();
    expect(settings?.getAttribute("aria-disabled")).toBeNull();
  });

  it("says nothing it cannot know about the cause", () => {
    // `ReadFailed` covers a request that failed AND a request that SUCCEEDED
    // whose URL was rejected as non-allow-listed. In the second nothing was
    // unreachable and retrying returns the same rejection forever, so a cause or
    // a retry instruction here is a confident falsehood — announced first,
    // because `aria-describedby` is what a screen reader reads.
    renderMenu(DesktopOs.Mac, failedLookupAdapter());

    const detail = document.getElementById(
      unavailableRow().getAttribute("aria-describedby") ?? ""
    );
    expect(detail?.textContent).toBe(LOOKUP_FAILED_TEXT);
    expect(detail?.textContent).not.toContain("reach");
    expect(detail?.textContent).not.toContain("Try again");
  });

  it("cannot reach this state on the desktop host at all", () => {
    // The OTHER surface, pinned at the builder rather than at a render: the
    // omitted-set loop overwrites the entry, so `Error` is unreachable there.
    // A render alone could not pin it — the desktop projection carries no
    // download URL, so the `!downloadUrl` return fires first and the case would
    // stay green with the loop deleted.
    const desktop = buildDesktopWorkspaceMenuCapabilities({ isGuest: false });
    expect(desktop[WorkspaceMenuEntryId.DownloadDesktop].status).toBe(
      WorkspaceMenuCapabilityStatus.Unavailable
    );

    renderMenu(
      DesktopOs.Mac,
      createDesktopWorkspaceMenuHostAdapterFixture({
        useWorkspaceMenuProjection: () => ({
          ...READY_WORKSPACE_MENU_PROJECTION,
          downloadUrl: WEB_WORKSPACE_MENU_DOWNLOAD_URL,
        }),
      })
    );
    expect(screen.queryByText(LOOKUP_FAILED_TEXT)).toBeNull();
    expect(downloadAnchor()).toBeNull();
    expect(screen.getByText(SETTINGS_LABEL)).not.toBeNull();
  });
});
