"use client";

import type { OrganizationDetails } from "@repo/app/onboarding/components/guided-onboarding-types"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import { MultiEmailInviteField } from "@repo/app/organizations/components/multi-email-invite-field"; // Cross-slice: preview settings reuse the shipped invite field (ISS-12938).
import {
  Avatar,
  AvatarFallback,
  avatarInitial,
} from "@repo/design-system/components/ui/avatar";
import { Badge } from "@repo/design-system/components/ui/badge";
import {
  GitHubMark,
  GoogleGlyph,
} from "@repo/design-system/components/ui/brand-icons";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Building2Icon,
  CheckCircle2Icon,
  KeyRoundIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PlusIcon,
  UserPlusIcon,
} from "lucide-react";
import { useState } from "react";
import { SettingsSection, ToggleSetting } from "./settings-surface-parts";
import { useWebMasterPrototype } from "./web-master-prototype-context";
export function ProfileSettings() {
  const { accountMethod, accountSkipped, openAccountSetup } =
    useWebMasterPrototype();

  return (
    <SettingsSection
      description="Your personal details and the methods you use to sign in."
      title="Profile"
    >
      <div className="space-y-5">
        <Card>
          <CardContent className="divide-y p-0">
            <SettingsRow label="Profile">
              <div className="flex flex-1 flex-wrap items-center gap-3">
                <Avatar className="size-12">
                  <AvatarFallback>AE</AvatarFallback>
                </Avatar>
                <div>
                  <p className="font-medium">Ottilie Eastwick</p>
                  <p className="text-muted-foreground text-sm">
                    Product builder
                  </p>
                </div>
                <Button className="ml-auto" size="sm" variant="outline">
                  Update profile
                </Button>
              </div>
            </SettingsRow>

            <SettingsRow label="Email addresses">
              <div className="flex-1 space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm">ottilie.eastwick@example.com</span>
                  <Badge variant="outline">Primary</Badge>
                  <MoreHorizontalIcon className="ml-auto size-4 text-muted-foreground" />
                </div>
                <Button className="px-0" size="sm" variant="ghost">
                  <PlusIcon />
                  Add email address
                </Button>
              </div>
            </SettingsRow>

            <SettingsRow label="Sign-in methods">
              {accountSkipped ? (
                <div className="flex flex-1 items-center justify-between gap-4">
                  <p className="text-muted-foreground text-sm">
                    Create an account to save sessions and collaborate with your
                    team.
                  </p>
                  <Button onClick={openAccountSetup} size="sm" type="button">
                    <UserPlusIcon />
                    Create account
                  </Button>
                </div>
              ) : (
                <div className="flex-1 space-y-3">
                  <ProviderRow
                    detail={
                      accountMethod === "github" ? "aeyecoe" : "Available"
                    }
                    icon={<GitHubMark className="size-4" />}
                    label="GitHub"
                    primary={accountMethod === "github"}
                  />
                  <ProviderRow
                    detail="ottilie.eastwick@example.com"
                    icon={<GoogleGlyph className="size-4" />}
                    label="Google"
                    primary={accountMethod === "google"}
                  />
                </div>
              )}
            </SettingsRow>

            <SettingsRow label="Password">
              <div className="flex flex-1 items-center justify-between gap-4">
                <div>
                  <p className="font-medium text-sm">Password not set</p>
                  <p className="mt-1 text-muted-foreground text-sm">
                    Add a password as another way to sign in.
                  </p>
                </div>
                <Button size="sm" variant="outline">
                  <KeyRoundIcon />
                  Set password
                </Button>
              </div>
            </SettingsRow>
          </CardContent>
        </Card>

        <Card className="border-destructive/30">
          <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5 sm:p-6">
            <div>
              <p className="font-medium text-sm">Delete account</p>
              <p className="mt-1 text-muted-foreground text-sm">
                Permanently remove your profile and personal account data.
              </p>
            </div>
            <Button variant="destructive">Delete account</Button>
          </CardContent>
        </Card>
      </div>
    </SettingsSection>
  );
}

function SettingsRow({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="grid gap-4 px-5 py-5 sm:grid-cols-[180px_1fr] sm:px-6">
      <p className="font-medium text-sm">{label}</p>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function ProviderRow({
  detail,
  icon,
  label,
  primary,
}: {
  detail: string;
  icon: React.ReactNode;
  label: string;
  primary: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {icon}
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">· {detail}</span>
      {primary ? <Badge variant="outline">Current sign-in</Badge> : null}
      <MoreHorizontalIcon className="ml-auto size-4 text-muted-foreground" />
    </div>
  );
}

export function OrganizationSettings() {
  const { organizationDetails, setOrganizationDetails } =
    useWebMasterPrototype();
  const [draft, setDraft] = useState(organizationDetails);
  const [nameSaved, setNameSaved] = useState(false);
  const editDraft = (next: OrganizationDetails) => {
    setDraft(next);
    setNameSaved(false);
  };

  return (
    <SettingsSection
      description="Manage the company profile shared across Closedloop."
      title="General"
    >
      <div className="space-y-5">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2Icon className="size-5" />
              Organization profile
            </CardTitle>
            <CardDescription>
              Details teammates see throughout the product.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="organization-name">Organization name</Label>
              <Input
                id="organization-name"
                onChange={(event) =>
                  editDraft({ ...draft, name: event.target.value })
                }
                value={draft.name}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="organization-slug">Organization URL</Label>
              <div className="flex items-center rounded-md border bg-background px-3">
                <span className="shrink-0 text-muted-foreground text-sm">
                  app.closedloop.ai/
                </span>
                <Input
                  className="border-0 px-1 shadow-none focus-visible:ring-0"
                  id="organization-slug"
                  onChange={(event) =>
                    editDraft({ ...draft, slug: event.target.value })
                  }
                  value={draft.slug}
                />
              </div>
            </div>
            <div className="flex items-center gap-3 sm:col-span-2">
              <Button
                disabled={draft.name.trim().length === 0}
                onClick={() => {
                  setOrganizationDetails({
                    name: draft.name.trim(),
                    slug: draft.slug.trim(),
                  });
                  setNameSaved(true);
                }}
                type="button"
                variant="outline"
              >
                Save changes
              </Button>
              {nameSaved ? (
                <span className="flex items-center gap-1.5 text-sm text-success">
                  <CheckCircle2Icon className="size-4" />
                  Saved
                </span>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Data controls</CardTitle>
            <CardDescription>
              Decide how organization data is searched, synced, and analyzed.
            </CardDescription>
          </CardHeader>
          <CardContent className="divide-y rounded-lg border p-0">
            <ToggleSetting
              defaultChecked
              description="Let teammates find matching text in synced session transcripts."
              label="Search session transcripts"
            />
            <ToggleSetting
              defaultChecked
              description="Allow approved session data to sync to Closedloop's secure cloud."
              label="Allow session data sync"
            />
          </CardContent>
        </Card>
      </div>
    </SettingsSection>
  );
}

export function PluginsSettings() {
  const { connectGitHub, disconnectGitHub, githubConnected } =
    useWebMasterPrototype();

  return (
    <SettingsSection
      description="Connect the tools you use to give your sessions more context."
      title="Plugins"
    >
      <Card>
        <CardHeader>
          <CardTitle>Connected tools</CardTitle>
          <CardDescription>
            Add context from your code, documents, and project trackers. You
            control which accounts are connected.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y rounded-lg border p-0">
          <IntegrationRow
            action={githubConnected ? "Disconnect" : "Connect GitHub"}
            connected={githubConnected}
            description="See which sessions, agents, skills, and spend contributed to your pull requests."
            icon={<GitHubMark className="size-5" />}
            label="GitHub"
            onAction={githubConnected ? disconnectGitHub : connectGitHub}
          />
          <IntegrationRow
            action="Connect Google"
            description="Connect your Drive documents to the sessions and work they support."
            icon={<GoogleGlyph className="size-5" />}
            label="Google Drive"
          />
          <IntegrationRow
            action="Connect Linear"
            description="Connect your Linear issues and projects to related sessions and shipped work."
            icon={<LinkIcon className="size-5" />}
            label="Linear"
          />
        </CardContent>
      </Card>
    </SettingsSection>
  );
}

export function MemberSettings() {
  const { inviteTeam, invitedEmails, teamInvited } = useWebMasterPrototype();

  return (
    <SettingsSection
      description="Invite and manage the people in your organization."
      title="Members"
    >
      <div className="space-y-5">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserPlusIcon className="size-5" />
              Invite teammates
            </CardTitle>
            <CardDescription>
              Add several people at once by pasting a comma-separated list.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <MultiEmailInviteField onSubmit={inviteTeam} />
            {teamInvited ? (
              <p className="flex items-center gap-2 text-sm text-success">
                <CheckCircle2Icon className="size-4" />
                {invitedEmails.length === 1
                  ? "Invitation sent"
                  : `${invitedEmails.length} invitations sent`}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>People</CardTitle>
                <CardDescription className="mt-1">
                  3 members · 1 invitation · 0 requests
                </CardDescription>
              </div>
              <Input
                aria-label="Search members"
                className="max-w-56"
                placeholder="Search members"
              />
            </div>
          </CardHeader>
          <CardContent className="divide-y rounded-lg border p-0">
            <MemberRow
              email="ottilie.eastwick@example.com"
              memberRole="Owner"
              name="Ottilie Eastwick"
            />
            <MemberRow
              email="maya@closedloop.ai"
              memberRole="Admin"
              name="Maya Chen"
            />
            <MemberRow
              email="marisol@closedloop.ai"
              memberRole="Member"
              name="Marisol Rivera"
            />
            <MemberRow
              email="jon@company.com"
              memberRole="Invited"
              name="Invitation pending"
            />
          </CardContent>
        </Card>
      </div>
    </SettingsSection>
  );
}

function IntegrationRow({
  action,
  connected = false,
  description,
  icon,
  label,
  onAction,
}: {
  action: string;
  connected?: boolean;
  description: string;
  icon: React.ReactNode;
  label: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-4 p-4">
      <div className="flex size-9 items-center justify-center rounded-md border bg-background">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="font-medium text-sm">{label}</p>
          {connected ? <Badge variant="secondary">Connected</Badge> : null}
        </div>
        <p className="mt-1 text-muted-foreground text-sm">{description}</p>
      </div>
      <Button onClick={onAction} size="sm" type="button" variant="outline">
        {action}
      </Button>
    </div>
  );
}

function MemberRow({
  email,
  memberRole,
  name,
}: {
  email: string;
  memberRole: string;
  name: string;
}) {
  return (
    <div className="flex items-center gap-3 p-4">
      <Avatar className="size-9">
        <AvatarFallback>{avatarInitial(name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-sm">{name}</p>
        <p className="truncate text-muted-foreground text-sm">{email}</p>
      </div>
      <Badge variant="outline">{memberRole}</Badge>
      <Button
        aria-label={`More options for ${name}`}
        size="icon"
        variant="ghost"
      >
        <MoreHorizontalIcon className="size-4" />
      </Button>
    </div>
  );
}
