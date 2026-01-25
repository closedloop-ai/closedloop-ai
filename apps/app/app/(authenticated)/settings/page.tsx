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
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { LinearIntegrationCard } from "./components/linear-integration-card";

export default function SettingsPage() {
  const { membership } = useOrganization();
  const isAdmin = membership?.role === "org:admin";

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
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="organization">Organization</TabsTrigger>
          {isAdmin ? <TabsTrigger value="admin">Admin</TabsTrigger> : null}
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
        </TabsList>

        <TabsContent className="mt-6 space-y-6" value="profile">
          <Card>
            <CardHeader>
              <CardTitle>User Profile</CardTitle>
              <CardDescription>
                Manage your personal account settings, security, and profile
                information.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <UserProfile
                appearance={{
                  elements: {
                    rootBox: "w-full",
                    cardBox: "shadow-none border-0",
                  },
                }}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent className="mt-6 space-y-6" value="organization">
          <Card>
            <CardHeader>
              <CardTitle>Organization Settings</CardTitle>
              <CardDescription>
                Manage organization information, members, and roles.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <OrganizationProfile
                appearance={{
                  elements: {
                    rootBox: "w-full",
                    cardBox: "shadow-none border-0",
                  },
                }}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent className="mt-6 space-y-6" value="admin">
          {/* biome-ignore lint/a11y/useValidAriaRole: This is a Clerk role prop, not an ARIA role */}
          <Protect
            fallback={
              <Card>
                <CardHeader>
                  <CardTitle>Access Denied</CardTitle>
                  <CardDescription>
                    You must be an organization admin to view this section.
                  </CardDescription>
                </CardHeader>
              </Card>
            }
            role="org:admin"
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
