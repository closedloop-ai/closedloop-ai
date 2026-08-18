import { redirect } from "next/navigation";

/**
 * FEA-3983/3970: legacy (non-org-slug) Agent Monitoring session deep link. The
 * screen is removed, but a link to one specific session must not 404. Redirect
 * to the non-org Sessions detail route; the proxy's org-slug redirect then adds
 * the active org's slug segment.
 */
export default async function MonitoringSessionDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/sessions/${id}`);
}
