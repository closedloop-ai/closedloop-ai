import { DesktopSecurityUpgradePage } from "./security-upgrade-page";

type SecurityUpgradeRouteProperties = {
  params: Promise<{ orgSlug: string; targetId: string }>;
};

export default async function SecurityUpgradeRoute({
  params,
}: SecurityUpgradeRouteProperties) {
  const { targetId } = await params;
  return <DesktopSecurityUpgradePage targetId={targetId} />;
}
