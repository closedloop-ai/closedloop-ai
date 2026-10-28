"use client";

import { Label } from "@repo/design-system/components/ui/label";
import { SidebarMenuItem } from "@repo/design-system/components/ui/sidebar";
import { Switch } from "@repo/design-system/components/ui/switch";
import { FlaskConicalIcon } from "lucide-react";
import { useId } from "react";
import { useIsMounted } from "../../hooks/use-is-mounted";
import {
  DEV_MODE_CONTROL_LABEL,
  DEV_MODE_CUSTOMER_VIEW_SCOPE_NOTE,
} from "./dev-mode-contract";
import {
  DEV_MODE_ESCAPE_TARGET_PROPS,
  focusDevModeEscapeTargetAfterTransition,
} from "./dev-mode-escape-focus";
import { useDevMode } from "./dev-mode-provider";

/**
 * The dev-mode switch as a sidebar row, for the Labs section (ISS-9891).
 *
 * THE ONLY PRESENTATION since ISS-10195. The switch used to have a menu twin
 * built out of `DropdownMenuCheckboxItem`, which needed a Radix menu context and
 * announced itself as `menuitemcheckbox`; neither survives being lifted into a
 * nav landmark, so the move to Labs was never the same node re-parented.
 * Retiring the workspace-experience gate took the account menu that carried that
 * twin, leaving this row — which reads `useDevMode()` and speaks the shared
 * strings — as the switch's only home. It knows no flag.
 *
 * Eligibility is the ACCESS answer and stays exactly where it was: a customer
 * never sees this row even with every placement gate on, and `isDevModeAvailable`
 * already folds in the ISS-7477 rollout. That is not the placement gate wearing
 * a second hat and it is not a flag this component reads — it arrives through
 * the provider, unchanged by ISS-9891.
 *
 * The label is a sibling of the switch rather than text inside it, because text
 * nested in the control would be concatenated into its accessible NAME. It is
 * the catalog `Label` bound with `htmlFor`, matching
 * `packages/app/settings/components/org-policy-toggle-card.tsx` — the repo's
 * existing answer to "text label beside a `Switch`" — rather than a second
 * hand-rolled one. A Radix `Switch` renders a `button`, which is a labelable
 * element, so `htmlFor` both names the control and makes the label click it.
 * `aria-describedby` carries the honesty note so it is announced rather than
 * merely adjacent.
 */
export function DevModeSidebarItem() {
  const { isDevModeAvailable, isDevModeEnabled, setDevModeEnabled } =
    useDevMode();
  const switchId = useId();
  const scopeNoteId = useId();
  // ISS-12135 bug 59: rendered after mount only. The server never has the
  // rollout flag, while a browser holding PostHog's persisted flags answers it
  // on the hydration render, so with an identity known on both sides (the
  // local-trusted lane) this row existed on the client only and the sidebar
  // failed hydration. The provider is left as it is, so the API client's
  // Dev Mode fetch is chosen from the first client render.
  const isMounted = useIsMounted();

  // Toggling can unmount this very switch — OFF suppresses the flags that keep
  // the Labs instance mounted, ON dismisses the fallback instance — so after
  // the store write, orphaned focus is handed to whichever durable target the
  // new placement renders. A toggle that unmounts nothing leaves focus alone
  // (the helper only moves focus the transition actually orphaned).
  const handleCheckedChange = (checked: boolean) => {
    setDevModeEnabled(checked);
    focusDevModeEscapeTargetAfterTransition();
  };

  if (!(isMounted && isDevModeAvailable)) {
    return null;
  }

  return (
    <SidebarMenuItem className="px-2 py-1.5">
      <div className="flex items-center gap-2">
        <FlaskConicalIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <Label className="min-w-0 flex-1" htmlFor={switchId}>
          {DEV_MODE_CONTROL_LABEL}
        </Label>
        {/* Marked as an escape target: when the OTHER instance of this row
            unmounts mid-toggle (Labs ↔ v2 footer), this one receives the
            orphaned focus. Exactly one instance is mounted per tree, so the
            marker never names two candidates. */}
        <Switch
          aria-describedby={scopeNoteId}
          checked={isDevModeEnabled}
          id={switchId}
          onCheckedChange={handleCheckedChange}
          {...DEV_MODE_ESCAPE_TARGET_PROPS}
        />
      </div>
      {/* Leading tightened against the default so the one multi-line row in a
          column of single-line nav rows does not balloon the section's rhythm.
          The sentence itself is an ISS-7835 AC4 contract and stays whole. */}
      <p
        className="mt-1 text-muted-foreground text-xs leading-snug"
        id={scopeNoteId}
      >
        {DEV_MODE_CUSTOMER_VIEW_SCOPE_NOTE}
      </p>
    </SidebarMenuItem>
  );
}
