"use client";

import { ClientRedirect } from "@repo/app/shared/components/client-redirect";

export default function AuthenticatedRootPage() {
  return <ClientRedirect href="/my-tasks" />;
}
