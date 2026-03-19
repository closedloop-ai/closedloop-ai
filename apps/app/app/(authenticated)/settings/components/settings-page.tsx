"use client";

import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import { APPROVER_ROLE_OPTIONS, ApproverRole } from "@repo/api/src/types/user";
import {
  OrganizationProfile,
  OrganizationSwitcher,
  Protect,
  UserProfile,
} from "@repo/auth/client";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
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
import { CustomFieldsSettingsTab } from "@/components/custom-fields/custom-fields-settings-tab";
import { UserLink } from "@/components/user-link";
import { useOrganizationUsers, useUpdateUser } from "@/hooks/queries/use-users";
import { AnthropicApiKeyCard } from "./anthropic-api-key-card";
import { ApiKeysSettingsPanel } from "./api-keys-settings-panel";
import { CloudComputeModeCard } from "./cloud-compute-mode-card";
import { GitHubIntegrationCard } from "./github-integration-card";
import { GoogleIntegrationCard } from "./google-integration-card";
import { LinearIntegrationCard } from "./linear-integration-card";
import { LocalComputeTargetsCard } from "./local-compute-targets-card";
import { PublicDashboardCard } from "./public-dashboard-card";

export type SettingsPageProperties = {
  initialTab: string;
  isAdmin: boolean;
};

export function SettingsPage({
  initialTab,
  isAdmin,
}: Readonly<SettingsPageProperties>) {
  const searchParams = useSearchParams();

  useEffect(() => {
    const githubStatus = searchParams.get("github");
    const errorCode = searchParams.get("code");
    const googleStatus = searchParams.get("google");

    if (githubStatus === "connected") {
      toast.success("GitHub connected successfully");
    } else if (githubStatus === "error" && errorCode) {
      const message = GITHUB_ERROR_MESSAGES[errorCode] ?? "An error occurred.";
      toast.error(message);
    }

    if (googleStatus === "success") {
      toast.success("Google Drive connected successfully");
    } else if (googleStatus === "error") {
      toast.error("Failed to connect Google Drive");
    }

    if (githubStatus || googleStatus) {
      globalThis.history.replaceState({}, "", globalThis.location.pathname);
    }
  }, [searchParams]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Manage your account settings and preferences.
        </p>
      </div>

      <Separator />

      <Tabs className="flex-1" defaultValue={initialTab}>
        <TabsList>
          <TabsTrigger className="flex-initial px-4" value="profile">
            Profile
          </TabsTrigger>
          <TabsTrigger className="flex-initial px-4" value="organization">
            Organization
          </TabsTrigger>
          {isAdmin ? (
            <TabsTrigger className="flex-initial px-4" value="admin">
              Admin
            </TabsTrigger>
          ) : null}
          {isAdmin ? (
            <TabsTrigger className="flex-initial px-4" value="custom-fields">
              Custom Fields
            </TabsTrigger>
          ) : null}
          <TabsTrigger className="flex-initial px-4" value="integrations">
            Integrations
          </TabsTrigger>
          <TabsTrigger className="flex-initial px-4" value="api-keys">
            API Keys
          </TabsTrigger>
        </TabsList>

        <TabsContent className="mt-3 space-y-6" value="profile">
          <UserProfile appearance={clerkAppearance} routing="hash" />
        </TabsContent>

        <TabsContent className="mt-3 space-y-6" value="organization">
          <OrganizationProfile appearance={clerkAppearance} routing="hash" />
          {SHOW_CLOSEDLOOP_ROLES && <ClosedLoopRolesSection />}
        </TabsContent>

        <TabsContent className="mt-3 space-y-6" value="admin">
          <Protect
            condition={(
              has: (
                params: { role: string } | { permission: string }
              ) => boolean
            ) => has({ role: "org:admin" }) || has({ role: "org:owner" })}
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

            <PublicDashboardCard />
          </Protect>
        </TabsContent>

        <TabsContent className="mt-3 space-y-6" value="custom-fields">
          <Protect
            condition={(
              has: (
                params: { role: string } | { permission: string }
              ) => boolean
            ) => has({ role: "org:admin" }) || has({ role: "org:owner" })}
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
            <CustomFieldsSettingsTab />
          </Protect>
        </TabsContent>

        <TabsContent className="mt-3 space-y-6" value="integrations">
          <FeatureFlagged flag="the-one-flag">
            <CloudComputeModeCard isAdmin={isAdmin} />
          </FeatureFlagged>
          <LocalComputeTargetsCard />
          <AnthropicApiKeyCard isAdmin={isAdmin} />
          <GitHubIntegrationCard />
          <GoogleIntegrationCard />
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

        <TabsContent className="mt-3 space-y-6" value="api-keys">
          <ApiKeysSettingsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

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

// Toggle to show ClosedLoop Roles section in the Organization tab.
// Hidden until the roles feature is further defined.
const SHOW_CLOSEDLOOP_ROLES = false;

const ROLE_LABELS: Record<string, string> = {
  [ApproverRole.Pm]: "PM",
  [ApproverRole.Designer]: "Designer",
  [ApproverRole.TechLead]: "Tech Lead",
  [ApproverRole.Engineer]: "Engineer",
  [ApproverRole.Stakeholder]: "Stakeholder",
};

function ClosedLoopRolesSection() {
  const { data: users = [] } = useOrganizationUsers();
  const updateUser = useUpdateUser();

  if (users.length === 0) {
    return null;
  }

  return (
    <>
      <Separator />
      <div>
        <h2 className="font-semibold text-lg tracking-tight">
          ClosedLoop Roles
        </h2>
        <p className="text-muted-foreground text-sm">
          Set the ClosedLoop role for each member. Engineers will see the
          Engineer view when running locally.
        </p>
      </div>
      <div className="space-y-3">
        {users.map((user) => {
          const name = [user.firstName, user.lastName]
            .filter(Boolean)
            .join(" ");
          return (
            <div
              className="flex items-center justify-between gap-4 rounded-lg border p-3"
              key={user.id}
            >
              <div className="flex items-center gap-3">
                <Avatar className="size-8">
                  <AvatarImage alt={name} src={user.avatarUrl ?? undefined} />
                  <AvatarFallback className="text-xs">
                    {(
                      user.firstName?.[0] ??
                      user.email[0] ??
                      "?"
                    ).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <UserLink
                    className="truncate font-medium text-sm hover:underline"
                    userId={user.id}
                  >
                    {name || user.email}
                  </UserLink>
                  {name && (
                    <p className="truncate text-muted-foreground text-xs">
                      {user.email}
                    </p>
                  )}
                </div>
              </div>
              <Select
                onValueChange={(value) => {
                  updateUser.mutate(
                    {
                      id: user.id,
                      role: value as ApproverRole,
                    },
                    {
                      onSuccess: () => {
                        toast.success(
                          `Updated ${name || user.email} to ${ROLE_LABELS[value] ?? value}`
                        );
                      },
                    }
                  );
                }}
                value={user.role}
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {APPROVER_ROLE_OPTIONS.map((role) => (
                    <SelectItem key={role} value={role}>
                      {ROLE_LABELS[role] ?? role}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
    </>
  );
}

const clerkAppearance = {
  elements: {
    rootBox: "w-full",
    cardBox: {
      backgroundColor: "transparent",
      boxShadow: "none",
      borderWidth: "1px",
      borderStyle: "solid",
      borderColor: "var(--border)",
      borderRadius: "0.5rem",
    },
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
