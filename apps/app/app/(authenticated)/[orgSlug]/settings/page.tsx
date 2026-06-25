import { auth } from "@repo/auth/server";
import { SettingsPage } from "./components/settings-page";

export type SettingsPageProperties = {
  searchParams: Promise<{
    tab?: string | string[];
    github?: string | string[];
    google?: string | string[];
    linear?: string | string[];
  }>;
};

export default async function Page({
  searchParams,
}: Readonly<SettingsPageProperties>) {
  const [{ has }, params] = await Promise.all([auth(), searchParams]);
  const isAdmin = has({ role: "org:admin" }) || has({ role: "org:owner" });
  const requestedTab = getRequestedTab(params.tab);
  const allowedTabs = isAdmin ? [...BASE_TABS, ...ADMIN_TABS] : BASE_TABS;
  // Any integration OAuth callback (github / google / linear) returns the
  // admin to /settings with a status query param. Force the integrations
  // tab so the relevant card is mounted to surface the updated status,
  // toast, or (PLN-634) the different-account confirmation dialog —
  // otherwise the admin lands on the default `profile` tab and misses it.
  const isIntegrationCallback = Boolean(
    params.github ?? params.google ?? params.linear
  );
  const initialTab = resolveInitialTab({
    isIntegrationCallback,
    requestedTab,
    allowedTabs,
  });

  return <SettingsPage initialTab={initialTab} isAdmin={isAdmin} />;
}

const DEFAULT_TAB = "profile";
const BASE_TABS = ["profile", "organization", "integrations", "api-keys"];
const ADMIN_TABS = ["admin", "custom-fields", "tags"];

function getRequestedTab(tab: string | string[] | undefined): string | null {
  if (typeof tab === "string") {
    return tab;
  }

  if (Array.isArray(tab)) {
    return tab[0] ?? null;
  }

  return null;
}

function resolveInitialTab(input: {
  isIntegrationCallback: boolean;
  requestedTab: string | null;
  allowedTabs: readonly string[];
}): string {
  if (input.isIntegrationCallback) {
    return "integrations";
  }
  if (input.requestedTab && input.allowedTabs.includes(input.requestedTab)) {
    return input.requestedTab;
  }
  return DEFAULT_TAB;
}
