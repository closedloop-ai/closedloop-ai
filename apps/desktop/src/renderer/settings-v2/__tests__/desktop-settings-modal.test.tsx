import { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import { SettingsDismissMode } from "@repo/app/settings/v2/components/settings-dismissal";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { RendererExceptionReporterProvider } from "../../renderer-exception-reporter";
import { DesktopSettingsModal } from "../desktop-settings-modal";
import type { DesktopSettingsV2RootProps } from "../desktop-settings-v2-root";

// The root's own composition is pinned by `desktop-settings-v2-root.test.tsx`;
// here it records what the modal hands it, which is the whole subject.
const rootProps = vi.hoisted(() => ({
  last: null as DesktopSettingsV2RootProps | null,
}));
vi.mock("../desktop-settings-v2-root", () => ({
  DesktopSettingsV2Root: (props: DesktopSettingsV2RootProps) => {
    rootProps.last = props;
    return <div data-testid="root" />;
  },
}));

function renderModal(
  initialPath: string,
  wrap: (node: ReactNode) => ReactNode = (node) => node
): DesktopSettingsV2RootProps {
  rootProps.last = null;
  const nav = createMemoryNavigation({ initialPath });
  render(
    <NavigationProvider adapter={nav.adapter}>
      {wrap(<DesktopSettingsModal returnHref="/sessions?page=2" />)}
    </NavigationProvider>
  );
  if (rootProps.last === null) {
    throw new Error("DesktopSettingsV2Root was not rendered");
  }
  return rootProps.last;
}

/**
 * ISS-8370 D6 and D9 — what the desktop shell's modal mount hands the
 * composition root: Cold dismissal, the route's own query with `returnTo`
 * defaulted to the shell's last page href, and the renderer's exception path.
 */
describe("DesktopSettingsModal", () => {
  it("mounts the root cold, with the route's panel and returnTo defaulted to the shell's last page href", () => {
    const props = renderModal(`/settings?panel=${SettingsPanelId.Tags}`);

    expect(props.dismissal.mode).toBe(SettingsDismissMode.Cold);
    expect(props.routeParams.panel).toBe(SettingsPanelId.Tags);
    expect(props.routeParams.returnTo).toBe("/sessions?page=2");
  });

  it("keeps a returnTo the link itself carried", () => {
    const props = renderModal("/settings?returnTo=%2Fbranches");

    expect(props.routeParams.returnTo).toBe("/branches");
  });

  it("routes the panel boundary's reportException to the renderer's exception path (D9), and to nothing without one", () => {
    const reportException = vi.fn();

    const wired = renderModal("/settings", (node) => (
      <RendererExceptionReporterProvider reportException={reportException}>
        {node}
      </RendererExceptionReporterProvider>
    ));
    expect(wired.reportException).toBe(reportException);

    const bare = renderModal("/settings");
    expect(bare.reportException).toBeUndefined();
  });
});
