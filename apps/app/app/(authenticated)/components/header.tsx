import {
  type HeaderProps,
  Header as SharedHeader,
} from "@repo/app/documents/editors/shared/header";
import { SidebarTrigger } from "@repo/design-system/components/ui/sidebar";
import { MobileSearchOverlay } from "./mobile-search-overlay";

export type { BreadcrumbEntry } from "@repo/app/documents/editors/shared/header";

export function Header(props: HeaderProps) {
  return (
    <SharedHeader
      {...props}
      mobileSearch={<MobileSearchOverlay />}
      sidebarTrigger={<SidebarTrigger className="-ml-1 shrink-0" />}
    />
  );
}
