"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Separator } from "@repo/design-system/components/ui/separator";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { KeyRoundIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  OrgSettingsSection,
  SettingsTab,
  SettingsTabLabel,
  type SettingsTarget,
} from "../mock";
import { SettingsIntegrations } from "./settings-integrations";
import { SettingsOrganization } from "./settings-organization";

type SettingsPageProps = {
  target: SettingsTarget | null;
  workspaceName: string;
  githubConnected: boolean;
  onConnectGitHub: () => void;
  apiKeySaved: boolean;
  onSaveApiKey: () => void;
  onInvited: () => void;
};

const settingsTabs: readonly SettingsTab[] = [
  SettingsTab.Profile,
  SettingsTab.Organization,
  SettingsTab.Integrations,
  SettingsTab.ApiKeys,
];

// Presentational Settings surface. Deep-linked from the setup checklist: the
// parent remounts it with a fresh key per navigation, so the initial tab and
// org section come straight from `target` and the anchor scroll runs on mount.
export const SettingsPage = ({
  target,
  workspaceName,
  githubConnected,
  onConnectGitHub,
  apiKeySaved,
  onSaveApiKey,
  onInvited,
}: SettingsPageProps) => {
  const [tab, setTab] = useState<SettingsTab>(
    target?.tab ?? SettingsTab.Profile
  );
  const [orgSection, setOrgSection] = useState<OrgSettingsSection>(
    target?.orgSection ?? OrgSettingsSection.General
  );

  useEffect(() => {
    const anchor = target?.anchor;
    if (!anchor) {
      return;
    }
    // Wait a frame so the target tab's content has mounted before scrolling.
    const frame = globalThis.requestAnimationFrame(() => {
      const element = globalThis.document.getElementById(anchor);
      if (element) {
        element.scrollIntoView({ block: "start" });
        element.focus({ preventScroll: true });
      }
    });
    return () => globalThis.cancelAnimationFrame(frame);
  }, [target]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Manage your account settings and preferences.
        </p>
      </div>

      <Separator />

      <Tabs
        className="flex-1"
        onValueChange={(value) => setTab(value as SettingsTab)}
        value={tab}
      >
        <TabsList className="max-w-full overflow-x-auto">
          {settingsTabs.map((value) => (
            <TabsTrigger
              className="flex-initial px-4"
              key={value}
              value={value}
            >
              {SettingsTabLabel[value]}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent className="mt-3" value={SettingsTab.Profile}>
          <ProfilePanel workspaceName={workspaceName} />
        </TabsContent>

        <TabsContent className="mt-3" value={SettingsTab.Organization}>
          <SettingsOrganization
            onInvited={onInvited}
            onSectionChange={setOrgSection}
            section={orgSection}
            workspaceName={workspaceName}
          />
        </TabsContent>

        <TabsContent className="mt-3" value={SettingsTab.Integrations}>
          <SettingsIntegrations
            apiKeySaved={apiKeySaved}
            githubConnected={githubConnected}
            onConnectGitHub={onConnectGitHub}
            onSaveApiKey={onSaveApiKey}
          />
        </TabsContent>

        <TabsContent className="mt-3" value={SettingsTab.ApiKeys}>
          <ApiKeysPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
};

const ProfilePanel = ({ workspaceName }: { workspaceName: string }) => (
  <Card>
    <CardHeader>
      <CardTitle>Profile</CardTitle>
      <CardDescription>Your personal account details.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="flex items-center gap-3">
        <Avatar className="size-12">
          <AvatarFallback className="bg-primary text-primary-foreground">
            KC
          </AvatarFallback>
        </Avatar>
        <div>
          <p className="font-medium text-sm">Kaiti</p>
          <p className="text-muted-foreground text-sm">{workspaceName}</p>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="profile-name">Name</Label>
        <Input defaultValue="Kaiti" id="profile-name" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="profile-email">Email</Label>
        <Input defaultValue="kaiti@acme.dev" id="profile-email" type="email" />
      </div>
    </CardContent>
  </Card>
);

const ApiKeysPanel = () => (
  <Card>
    <EmptyState
      action={<Button>Create API key</Button>}
      description="Create a key to access the Closedloop API from scripts and CI."
      icon={KeyRoundIcon}
      title="No API keys yet"
    />
  </Card>
);
