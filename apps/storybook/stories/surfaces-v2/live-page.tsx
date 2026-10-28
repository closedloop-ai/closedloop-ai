import type { ReactNode } from "react";
import { V2AppFrame } from "../composites-v2/v2-global-nav";

/**
 * A Surfaces page: the live route's own page component, rendered in the
 * app frame (Composites/Shared/Navigation/Sidebar's Global Nav, Nerys
 * 2026-10-06) and the content column `apps/app/app/(authenticated)/layout.tsx`
 * puts every page in. Rendering the route component itself is what gives the
 * page the live header, toolbars and actions.
 *
 * `activePath` is the page's nav destination, e.g. "/dashboard".
 */
export function LivePage({
  activePath,
  children,
}: {
  activePath: string;
  children: ReactNode;
}) {
  return (
    <V2AppFrame activePath={activePath}>
      <div className="flex h-full max-h-full flex-col overflow-hidden">
        {children}
      </div>
    </V2AppFrame>
  );
}
