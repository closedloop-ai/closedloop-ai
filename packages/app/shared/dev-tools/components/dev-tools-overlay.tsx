"use client";

import { Button } from "@repo/design-system/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { usePath } from "@repo/navigation/use-path";
import { WrenchIcon } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { useIsDevModeOn } from "../../feature-flags/dev-mode/dev-mode-provider";
import { useIsMounted } from "../../hooks/use-is-mounted";
import { resetCheckedFeatureFlags } from "../lib/checked-feature-flags-store";
import { DEV_TOOLS_LABEL } from "../lib/dev-tools-copy";
import type { DevToolsRegistry } from "../lib/dev-tools-registry";
import { DEV_TOOLS_REGISTRY } from "../lib/dev-tools-sections";
import { DevToolsSectionPanel } from "./dev-tools-section-panel";

/**
 * ISS-12048: the Dev Tools overlay. A corner button, bottom right, that opens
 * a panel rendering every registered section. Renders nothing unless Dev Mode
 * is on (operator decision, 2026-10-05: Dev Mode is the gate, no PostHog flag).
 *
 * The Radix popover supplies the disclosure semantics: `aria-expanded` and
 * `aria-controls` on the trigger, focus moved into the panel on open, Escape
 * and outside click close it, and focus returns to the trigger on close.
 */
export function DevToolsOverlay({
  registry = DEV_TOOLS_REGISTRY,
}: {
  registry?: DevToolsRegistry;
}) {
  const isDevModeOn = useIsDevModeOn();
  const titleId = useId();
  useResetCheckedFeatureFlagsOnNavigation();
  // ISS-12135 bug 59: after mount only, for the reason the Dev mode sidebar
  // row gives: the server cannot know the rollout flag the browser holds.
  const isMounted = useIsMounted();

  if (!(isMounted && isDevModeOn)) {
    return null;
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        {/* Lifted above the web shell's mobile bottom nav below `md`, using
            the same token the shell reserves for it. */}
        <Button
          aria-label={DEV_TOOLS_LABEL}
          className="fixed right-4 bottom-[calc(var(--bottom-nav-height)+env(safe-area-inset-bottom)+--spacing(4))] z-[var(--z-overlay)] md:bottom-4"
          size="icon"
          variant="outline"
        >
          <WrenchIcon aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-labelledby={titleId}
        className="flex max-h-(--radix-popover-content-available-height) w-md max-w-(--radix-popover-content-available-width) flex-col p-0"
        side="top"
      >
        <h2 className="border-b px-4 py-3 font-semibold text-sm" id={titleId}>
          {DEV_TOOLS_LABEL}
        </h2>
        <div className="flex max-h-128 min-h-0 flex-col gap-2 overflow-y-auto">
          {[...registry.values()].map((section) => (
            <DevToolsSectionPanel key={section.id} section={section} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Reset after mounted flag subscriptions settle for the new route. */
function useResetCheckedFeatureFlagsOnNavigation(): void {
  const path = usePath();
  const lastPath = useRef(path);
  useEffect(() => {
    if (lastPath.current !== path) {
      lastPath.current = path;
      resetCheckedFeatureFlags(path);
    }
  }, [path]);
}
