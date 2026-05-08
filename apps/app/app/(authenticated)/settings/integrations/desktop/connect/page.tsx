import { DesktopConnectApproval } from "./desktop-connect-approval";

export default async function DesktopConnectPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  return <DesktopConnectApproval initialCode={code ?? ""} />;
}
