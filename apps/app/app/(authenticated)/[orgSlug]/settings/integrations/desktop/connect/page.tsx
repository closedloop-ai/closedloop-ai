import { DesktopConnectApproval } from "./desktop-connect-approval";

export default async function DesktopConnectPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ code?: string }>;
}) {
  const [{ orgSlug }, { code }] = await Promise.all([params, searchParams]);
  return (
    <DesktopConnectApproval
      initialCode={code ?? ""}
      requestedOrgSlug={orgSlug}
    />
  );
}
