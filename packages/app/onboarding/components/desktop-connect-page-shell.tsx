import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import type { ReactNode } from "react";

/**
 * Shared centered-card scaffold for the Desktop-first browser approval routes.
 *
 * Both the org-scoped approval page and the bare `org_required` page compose
 * this so the centering wrapper + `<Card>` layout lives in one place. It is
 * layout-only (no hooks), so it stays usable from either a server or client
 * component.
 *
 * The wrapper is a plain `<div>`: both mount sites live under the authenticated
 * shell, whose SidebarInset owns the page's single `<main>` (ISS-4673).
 */
export function DesktopConnectPageShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-xl items-center px-6 py-12">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">{children}</CardContent>
      </Card>
    </div>
  );
}
