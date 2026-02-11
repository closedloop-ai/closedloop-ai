"use client";

import {
  OrganizationProfile,
  OrganizationSwitcher,
  Protect,
  UserProfile,
  useOrganization,
} from "@repo/auth/client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Separator } from "@repo/design-system/components/ui/separator";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { isAdminRole } from "@/lib/role-utils";
import { AnthropicApiKeyCard } from "./components/anthropic-api-key-card";
import { ComputeModeCard } from "./components/compute-mode-card";
import { GitHubIntegrationCard } from "./components/github-integration-card";
import { LinearIntegrationCard } from "./components/linear-integration-card";

/**
 * Error code to user-friendly message mapping for GitHub.
 * Must match GITHUB_ERROR_CODES from github-utils.ts
 */
const GITHUB_ERROR_MESSAGES: Record<string, string> = {
  not_authenticated: "Please sign in to connect GitHub.",
  not_configured: "GitHub integration is not configured.",
  missing_params: "Invalid authorization request. Please try again.",
  invalid_state: "Security validation failed. Please try again.",
  invalid_request: "Invalid authorization request. Please try again.",
  connection_failed: "Failed to connect to GitHub. Please try again.",
  oauth_failed: "Authorization failed. Please try again.",
  token_exchange_failed: "Token exchange failed. Please try again.",
};

// Shared appearance config for Clerk components to match design system
const clerkAppearance = {
  elements: {
    rootBox: "w-full",
    cardBox: "bg-transparent shadow-none border rounded-lg border-border",
    navbar: "border-r border-border",
    navbarButton: "text-foreground hover:bg-muted",
    navbarButtonIcon: "text-muted-foreground",
    pageScrollBox: "p-4",
    formButtonPrimary: "bg-primary text-primary-foreground hover:bg-primary/90",
    formFieldInput: "bg-background border-border",
    profileSectionPrimaryButton:
      "bg-primary text-primary-foreground hover:bg-primary/90",
    badge: "bg-muted text-muted-foreground",
    membersPageInviteButton:
      "bg-primary text-primary-foreground hover:bg-primary/90",
  },
};

export default function SettingsPage() {
  const { membership } = useOrganization();
  const isAdmin = isAdminRole(membership?.role);
  const searchParams = useSearchParams();

  // Handle GitHub OAuth callback results from URL params
  useEffect(() => {
    const githubStatus = searchParams.get("github");
    const errorCode = searchParams.get("code");

    if (githubStatus === "connected") {
      toast.success("GitHub connected successfully");
      // Clean up URL params
      window.history.replaceState({}, "", window.location.pathname);
    } else if (githubStatus === "error" && errorCode) {
      const message = GITHUB_ERROR_MESSAGES[errorCode] ?? "An error occurred.";
      toast.error(message);
      // Clean up URL params
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [searchParams]);

  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Manage your account settings and preferences.
        </p>
      </div>

      <Separator />

      <Tabs className="flex-1" defaultValue="profile">
        <TabsList className="h-auto rounded-none border-border border-b bg-transparent p-0">
          <TabsTrigger
            className="rounded-none border-transparent border-b-2 bg-transparent px-4 py-2 data-[state=active]:border-foreground data-[state=active]:bg-transparent"
            value="profile"
          >
            Profile
          </TabsTrigger>
          <TabsTrigger
            className="rounded-none border-transparent border-b-2 bg-transparent px-4 py-2 data-[state=active]:border-foreground data-[state=active]:bg-transparent"
            value="organization"
          >
            Organization
          </TabsTrigger>
          {isAdmin ? (
            <TabsTrigger
              className="rounded-none border-transparent border-b-2 bg-transparent px-4 py-2 data-[state=active]:border-foreground data-[state=active]:bg-transparent"
              value="admin"
            >
              Admin
            </TabsTrigger>
          ) : null}
          <TabsTrigger
            className="rounded-none border-transparent border-b-2 bg-transparent px-4 py-2 data-[state=active]:border-foreground data-[state=active]:bg-transparent"
            value="integrations"
          >
            Integrations
          </TabsTrigger>
        </TabsList>

        <TabsContent className="mt-6 space-y-6" value="profile">
          <UserProfile appearance={clerkAppearance} />
        </TabsContent>

        <TabsContent className="mt-6 space-y-6" value="organization">
          <OrganizationProfile appearance={clerkAppearance} />
        </TabsContent>

        <TabsContent className="mt-6 space-y-6" value="admin">
          <Protect
            condition={(has) =>
              has({ role: "org:admin" }) || has({ role: "org:owner" })
            }
            fallback={
              <Card>
                <CardHeader>
                  <CardTitle>Access Denied</CardTitle>
                  <CardDescription>
                    You must be an organization admin or owner to view this
                    section.
                  </CardDescription>
                </CardHeader>
              </Card>
            }
          >
            <Card>
              <CardHeader>
                <CardTitle>Organization Switcher</CardTitle>
                <CardDescription>
                  Switch between organizations you manage.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <OrganizationSwitcher
                  appearance={{
                    elements: {
                      rootBox: "w-full",
                      organizationSwitcherTrigger: "w-full justify-between",
                    },
                  }}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Advanced Organization Management</CardTitle>
                <CardDescription>
                  Admin-only controls for organization configuration.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground text-sm">
                  Additional admin controls can be added here in the future. For
                  now, use the Organization tab to manage members, roles, and
                  settings.
                </p>
              </CardContent>
            </Card>
          </Protect>
        </TabsContent>

        <TabsContent className="mt-6 space-y-6" value="integrations">
          <ComputeModeCard />
          <AnthropicApiKeyCard />
          <GitHubIntegrationCard />
          <LinearIntegrationCard />

          <Card>
            <CardHeader>
              <CardTitle>More Integrations</CardTitle>
              <CardDescription>
                Additional integrations will appear here as they become
                available.
              </CardDescription>
            </CardHeader>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
