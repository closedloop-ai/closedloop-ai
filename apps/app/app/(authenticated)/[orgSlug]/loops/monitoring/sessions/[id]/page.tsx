import { redirect } from "next/navigation";

export default async function MonitoringSessionDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/sessions/${id}`);
}
