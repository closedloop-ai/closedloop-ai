"use client";

import { ClientRedirect } from "@repo/app/shared/components/client-redirect";
import { useOrgSlug } from "@/hooks/use-org-slug";

export default function App() {
  const orgSlug = useOrgSlug();
  return <ClientRedirect href={`/${orgSlug}/my-tasks`} />;
}
