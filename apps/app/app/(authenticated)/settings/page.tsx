import { auth } from "@repo/auth/server";
import { SettingsPage } from "./components/settings-page";

export type SettingsPageProperties = {
  searchParams: Promise<{
    tab?: string | string[];
  }>;
};

export default async function Page({
  searchParams,
}: Readonly<SettingsPageProperties>) {
  const [{ has }, params] = await Promise.all([auth(), searchParams]);
  const isAdmin = has({ role: "org:admin" }) || has({ role: "org:owner" });
  const requestedTab = getRequestedTab(params.tab);
  const allowedTabs = isAdmin ? [...BASE_TABS, ...ADMIN_TABS] : BASE_TABS;
  const initialTab =
    requestedTab && allowedTabs.includes(requestedTab)
      ? requestedTab
      : DEFAULT_TAB;

  return <SettingsPage initialTab={initialTab} isAdmin={isAdmin} />;
}

const DEFAULT_TAB = "profile";
const BASE_TABS = ["profile", "organization", "integrations", "api-keys"];
const ADMIN_TABS = ["admin", "custom-fields"];

function getRequestedTab(tab: string | string[] | undefined): string | null {
  if (typeof tab === "string") {
    return tab;
  }

  if (Array.isArray(tab)) {
    return tab[0] ?? null;
  }

  return null;
}
