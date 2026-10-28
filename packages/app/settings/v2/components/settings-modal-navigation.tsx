"use client";

import type { SettingsPanelId } from "@repo/api/src/types/settings-panel";
import { Button } from "@repo/design-system/components/ui/button";
import { Link } from "@repo/navigation/link";
import { XIcon } from "lucide-react";
import type { SettingsNavigationGroupModel } from "../lib/settings-navigation-model";
import type { SettingsPanelRegistry } from "../lib/settings-panel-registry";
import {
  type SettingsDismissal,
  SettingsDismissMode,
} from "./settings-dismissal";
import { SettingsNavigation } from "./settings-navigation";

export type SettingsModalNavigationProps = {
  groups: readonly SettingsNavigationGroupModel[];
  registry: SettingsPanelRegistry;
  activePanelId: SettingsPanelId | null;
  buildPanelHref: (panelId: SettingsPanelId) => string;
  dismissal: SettingsDismissal;
  /** Where a cold dismiss lands. Unused in overlay mode, which navigates nowhere. */
  closeHref: string;
  onDismiss: () => void;
};

const CLOSE_LABEL = "Close settings";

/**
 * The modal-scale navigation rail (ISS-8977).
 *
 * Below `md` it stacks above the panel inside the height-capped dialog rather
 * than going full-bleed or becoming a Sheet, which is the answer the page shell
 * already shipped and the one the operator chose for the modal.
 *
 * The close control's ELEMENT follows the dismissal mode rather than a style
 * preference — see {@link SettingsDismissal}. A cold dismiss really is a
 * navigation, so it is an anchor and keeps middle-click and "open in new tab".
 * An overlay dismiss navigates nowhere, so an anchor would advertise a URL that
 * does not restore the surface behind the modal; it is a button.
 */
export function SettingsModalNavigation({
  groups,
  registry,
  activePanelId,
  buildPanelHref,
  dismissal,
  closeHref,
  onDismiss,
}: Readonly<SettingsModalNavigationProps>) {
  return (
    <aside className="flex min-h-0 flex-col gap-5 border-b bg-muted/20 p-3 md:border-r md:border-b-0">
      {dismissal.mode === SettingsDismissMode.Cold ? (
        <Button aria-label={CLOSE_LABEL} asChild size="icon" variant="ghost">
          <Link href={closeHref}>
            <XIcon aria-hidden="true" className="size-5" />
          </Link>
        </Button>
      ) : (
        <Button
          aria-label={CLOSE_LABEL}
          onClick={onDismiss}
          size="icon"
          type="button"
          variant="ghost"
        >
          <XIcon aria-hidden="true" className="size-5" />
        </Button>
      )}
      {/* The entries scroll, the close control does not. With Labs open the
          rail runs past a short viewport, and scrolling the one way out of the
          dialog off the top is how a keyboard user loses it. */}
      <div className="min-h-0 md:flex-1 md:overflow-y-auto">
        <SettingsNavigation
          activePanelId={activePanelId}
          buildPanelHref={buildPanelHref}
          groups={groups}
          registry={registry}
        />
      </div>
    </aside>
  );
}
