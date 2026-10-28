"use client";

import {
  SETTINGS_PANEL_LABEL,
  type SettingsActorCapabilities,
  type SettingsPanelHost,
  type SettingsPanelId,
  SettingsPanelResolutionStatus,
} from "@repo/api/src/types/settings-panel";
import {
  buildSettingsPanelRoute,
  resolveSettingsCloseRoute,
  type SettingsRouteParams,
} from "@repo/api/src/types/settings-route-links";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { Suspense } from "react";
import { useSettingsFocusRestoration } from "../hooks/use-settings-focus-restoration";
import { useSettingsFragmentScroll } from "../hooks/use-settings-fragment-scroll";
import { buildSettingsNavigationModel } from "../lib/settings-navigation-model";
import type { SettingsPanelRegistry } from "../lib/settings-panel-registry";
import { resolveSettingsPanel } from "../lib/settings-panel-resolution";
import {
  type SettingsDismissal,
  SettingsDismissMode,
} from "./settings-dismissal";
import { SettingsModalNavigation } from "./settings-modal-navigation";
import {
  SettingsPanelErrorBoundary,
  SettingsPanelLoading,
} from "./settings-panel-boundary";
import { SettingsPanelStatusView } from "./settings-panel-status-view";

export type SettingsShellProps = {
  registry: SettingsPanelRegistry;
  routeParams: SettingsRouteParams;
  host: SettingsPanelHost;
  capabilities: SettingsActorCapabilities;
  /** How this mount returns the user to where they were. See {@link SettingsDismissal}. */
  dismissal: SettingsDismissal;
  onRetryCapabilities?: () => void;
  reportException?: (error: Error, componentStack?: string) => void;
};

const SETTINGS_DIALOG_DESCRIPTION =
  "Manage your user and organization settings.";

/**
 * The Settings v2 harness (ISS-8362), presented as a modal over the surface the
 * user was on (ISS-8977): the rail, the resolved panel, and the loading and
 * error boundaries around it. It knows nothing about any panel's contents — it
 * mounts whatever the registry holds — which is what lets the panel packages
 * land independently.
 *
 * A MODAL, NOT A PAGE. It renders open whenever it is mounted, so "is Settings
 * showing" is one fact owned by the host, never a second `open` prop that could
 * disagree with the mount. The dialog supplies its own accessible name and
 * bounded height, which is why the two things the page shell used to demand of
 * its mounting surface — an `h1` and a height — are no longer owed.
 *
 * The focus trap, `Escape`, and the inert underlay come from Radix and are
 * deliberately not reimplemented (ISS-8978, WCAG 2.1.2, 2.4.3). Focus
 * RESTORATION is the exception and is ours — see
 * {@link useSettingsFocusRestoration} for why Radix cannot do it here. What
 * else this component owns is where a dismiss LANDS: {@link SettingsDismissal}.
 *
 * This component never reads a feature flag; per PRD-692 only the program root
 * chooses a tree, and the whole v2 tree is already closed by default behind
 * `workspace-experience-v2`.
 */
export function SettingsShell({
  registry,
  routeParams,
  host,
  capabilities,
  dismissal,
  onRetryCapabilities,
  reportException,
}: Readonly<SettingsShellProps>) {
  const buildOrgPath = useOrgPath();
  const { navigate } = useNavigation();
  const restoreFocus = useSettingsFocusRestoration(dismissal.mode);
  useSettingsFragmentScroll();
  const context = { registry, host, capabilities };

  const resolution = resolveSettingsPanel({
    ...context,
    requestedPanel: routeParams.requestedPanel,
  });
  const groups = buildSettingsNavigationModel(context);
  const closeHref = resolveSettingsCloseRoute(routeParams, buildOrgPath);

  const buildPanelHref = (panelId: SettingsPanelId) =>
    buildOrgPath(
      buildSettingsPanelRoute({
        panel: panelId,
        returnTo: routeParams.returnTo,
      })
    );

  // Every dismissal route — the rail's close control, `Escape`, the overlay
  // click — funnels through here, so the two modes cannot drift apart per
  // gesture. Overlay hides in place; cold has nothing behind it and navigates.
  const dismiss = () => {
    if (dismissal.mode === SettingsDismissMode.Overlay) {
      dismissal.onDismiss();
      return;
    }
    navigate(closeHref);
  };

  const recovery =
    resolution.fallbackPanelId === null
      ? null
      : {
          href: buildPanelHref(resolution.fallbackPanelId),
          label: SETTINGS_PANEL_LABEL[resolution.fallbackPanelId],
        };

  const descriptor =
    resolution.panelId === null ? undefined : registry.get(resolution.panelId);
  const Panel = descriptor?.Panel;

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          dismiss();
        }
      }}
      open
    >
      <DialogContent
        className="grid grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-y-auto overflow-x-hidden p-0 md:grid-cols-[240px_minmax(0,1fr)] md:grid-rows-1 md:overflow-hidden"
        data-testid="settings-shell"
        onCloseAutoFocus={restoreFocus}
        showCloseButton={false}
        size="xlarge"
      >
        {/* Radix renders `Dialog.Title` as an `h2`, which would leave the
            document with no `h1` and put "Settings" on the same level as every
            panel section heading. `asChild` keeps Radix's accessible-name
            wiring while the outline stays correct. WCAG 2.4.6, 1.3.1. */}
        <DialogTitle asChild>
          <h1 className="sr-only">Settings</h1>
        </DialogTitle>
        <DialogDescription className="sr-only">
          {SETTINGS_DIALOG_DESCRIPTION}
        </DialogDescription>

        <SettingsModalNavigation
          activePanelId={resolution.panelId}
          buildPanelHref={buildPanelHref}
          closeHref={closeHref}
          dismissal={dismissal}
          groups={groups}
          onDismiss={dismiss}
          registry={registry}
        />

        {/* `min-w-0` is load-bearing: without it a wide table or a long
            unbroken string inside a panel pushes the grid column out and the
            rail loses its fixed track. Below `md` the dialog itself is the
            scroll container, so the column only owns its own scrolling once
            the two-column layout has a bounded row to scroll inside. */}
        <div className="min-h-0 min-w-0 md:overflow-y-auto">
          {/* Named container, because a panel body's width is now the column's
              and not the viewport's: from `md` up the rail takes a fixed 240
              off it, so at a 768px viewport this content box is ~432px while
              every viewport-keyed `sm:` rule reads 768 and lays out two-up.
              Panel CONTENT sizes against this instead (ISS-8975). This
              element's own `lg:p-10` stays viewport-keyed and cannot be
              converted — an element may not query the container it
              establishes. */}
          <div className="@container/settings-panel mx-auto w-full max-w-4xl p-8 lg:p-10">
            {Panel === undefined ||
            resolution.status !== SettingsPanelResolutionStatus.Ready ? (
              <SettingsPanelStatusView
                host={host}
                onRetryCapabilities={onRetryCapabilities}
                recovery={recovery}
                resolution={resolution}
              />
            ) : (
              // Keyed on the panel: React state survives a prop change, so
              // without this a crashed panel's error screen would still be on
              // screen after the user navigates to a working one.
              <SettingsPanelErrorBoundary
                key={resolution.panelId}
                reportException={reportException}
              >
                <Suspense fallback={<SettingsPanelLoading />}>
                  <Panel intent={routeParams.intent} />
                </Suspense>
              </SettingsPanelErrorBoundary>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
