/**
 * "Help on this" header affordance (FEA-3846 / PRD-555 M4).
 *
 * An icon-only button in the Topbar that deep-links the in-app Help view (M2) to
 * the docs page/section the current screen declared as its {@link DocsAnchor}
 * (via `NAV_DOCS_ANCHORS` or `useDocsAnchor`). Built on the design-system
 * catalog — a ghost `Button` (matching the Topbar's sidebar-toggle button) as a
 * `Link` to `helpPageHref(...)`, wrapped in a `Tooltip` — no hand-rolled
 * primitives.
 *
 * Self-gating: renders null when the `docsHelp` Labs flag is off (the whole
 * Docs/Help surface stays dark) or when the active screen declares no anchor, so
 * the Topbar can mount it unconditionally.
 */
import { Button } from "@closedloop-ai/design-system/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@closedloop-ai/design-system/components/ui/tooltip";
import { Link } from "@repo/navigation/link";
import { CircleHelp } from "lucide-react";
import type { DocsAnchor } from "../../navigation/docs-anchor";
import { helpPageHref } from "../../navigation/route-table";
import { useDocsHelpSurfaceEnabled } from "../../navigation/use-nav-gates";

export function HelpOnThisButton({
  anchor,
}: Readonly<{ anchor: DocsAnchor | null }>) {
  const flagOn = useDocsHelpSurfaceEnabled();
  // Mounted unconditionally by the Topbar — stay dark unless the Docs/Help
  // SURFACE is on (its own Labs flag AND the ISS-5037 Labs container gate above
  // it) AND the active screen declared an anchor to link to. Without the
  // container gate this button kept offering a jump to `#/help` after Labs was
  // switched off.
  if (!(flagOn && anchor)) {
    return null;
  }
  const label = "Help on this screen";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          asChild
          className="app-region-no-drag touch:min-h-tap-min touch:min-w-tap-min text-[var(--muted-foreground)]"
          size="icon-sm"
          variant="ghost"
        >
          <Link href={helpPageHref(anchor.page, anchor.heading)}>
            <CircleHelp className="size-4" />
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
