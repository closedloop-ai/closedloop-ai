"use client";
import { Badge } from "@repo/design-system/components/ui/badge";
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
  BadgeCheckIcon,
  CheckCircle2Icon,
  CloudIcon,
  FileKeyIcon,
  KeyRoundIcon,
  MoreHorizontalIcon,
  PlusIcon,
} from "lucide-react";
import {
  SettingsSection,
  ToggleSetting,
  useSettingsAnnotationsVisible,
} from "./settings-surface-parts";
export function CustomFieldsSettings() {
  const annotationsVisible = useSettingsAnnotationsVisible();

  return (
    <SettingsSection
      description="Define reusable fields for artifacts across your organization."
      title="Custom Fields"
    >
      <div className="relative">
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle>Artifact fields</CardTitle>
                <CardDescription className="mt-1">
                  Fields appear anywhere your team creates or edits artifacts.
                </CardDescription>
              </div>
              <Button size="sm">
                <PlusIcon />
                Create field
              </Button>
            </div>
          </CardHeader>
          <CardContent className="divide-y rounded-lg border p-0">
            <CustomFieldRow
              name="Priority"
              type="Single select"
              usage="18 artifacts"
            />
            <CustomFieldRow name="Customer" type="Text" usage="7 artifacts" />
            <CustomFieldRow
              name="Target date"
              type="Date"
              usage="12 artifacts"
            />
          </CardContent>
        </Card>
        {annotationsVisible ? (
          <aside
            aria-hidden="true"
            className="pointer-events-none absolute top-[calc(100%+2rem)] right-0 w-80 rounded-lg bg-violet-600 px-4 py-3 text-white shadow-lg shadow-violet-950/20"
            data-prototype-annotation="custom-fields-gridview-v2"
          >
            <span className="absolute right-8 bottom-full h-8 w-px bg-violet-500" />
            <p className="font-semibold text-[11px] text-violet-100 uppercase tracking-[0.14em]">
              Design note
            </p>
            <p className="mt-1.5 text-sm leading-5">
              We believe GridView V2 removes the need for a separate Custom
              Fields settings screen. Confirm that inline field creation and
              management cover this workflow before removing it.
            </p>
          </aside>
        ) : null}
      </div>
    </SettingsSection>
  );
}

function CustomFieldRow({
  name,
  type,
  usage,
}: {
  name: string;
  type: string;
  usage: string;
}) {
  return (
    <div className="grid grid-cols-[1fr_140px_120px_auto] items-center gap-3 p-4 text-sm">
      <span className="font-medium">{name}</span>
      <span className="text-muted-foreground">{type}</span>
      <span className="text-muted-foreground">{usage}</span>
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

export function TagsSettings() {
  return (
    <SettingsSection
      description="Create organization-wide labels for grouping and filtering work."
      title="Tags"
    >
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Organization tags</CardTitle>
              <CardDescription className="mt-1">
                Use a consistent vocabulary across sessions and artifacts.
              </CardDescription>
            </div>
            <Button size="sm">
              <PlusIcon />
              Create tag
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input aria-label="Search tags" placeholder="Search tags" />
          <div className="divide-y rounded-lg border">
            <TagRow
              color="bg-blue-500"
              name="Customer request"
              usage="24 uses"
            />
            <TagRow color="bg-violet-500" name="Experiment" usage="16 uses" />
            <TagRow color="bg-amber-500" name="Needs review" usage="9 uses" />
          </div>
        </CardContent>
      </Card>
    </SettingsSection>
  );
}

function TagRow({
  color,
  name,
  usage,
}: {
  color: string;
  name: string;
  usage: string;
}) {
  return (
    <div className="flex items-center gap-3 p-4 text-sm">
      <span className={`size-2.5 rounded-full ${color}`} />
      <span className="flex-1 font-medium">{name}</span>
      <span className="text-muted-foreground">{usage}</span>
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

export function ComplianceSettings() {
  return (
    <SettingsSection
      description="Review required distributions and compute targets that need attention."
      title="Compliance"
    >
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BadgeCheckIcon className="size-5" />
            Compliance gaps
          </CardTitle>
          <CardDescription>
            Closedloop checks required distributions against connected compute
            targets.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
            <div>
              <p className="font-medium text-sm">
                Required agent distributions
              </p>
              <p className="mt-1 text-muted-foreground text-sm">
                2 of 2 online compute targets meet organization policy.
              </p>
            </div>
            <Badge className="gap-1" variant="secondary">
              <CheckCircle2Icon className="size-3.5" />
              Up to date
            </Badge>
          </div>
          <div className="rounded-lg border border-dashed p-8 text-center">
            <p className="font-medium text-sm">No compliance gaps</p>
            <p className="mt-1 text-muted-foreground text-sm">
              Issues will appear here when a required target needs attention.
            </p>
          </div>
        </CardContent>
      </Card>
    </SettingsSection>
  );
}

export function ApiKeysSettings() {
  return (
    <SettingsSection
      description="Manage model-provider credentials and Closedloop programmatic access."
      title="API Keys"
    >
      <div className="space-y-5">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CloudIcon className="size-5" />
              Model provider keys
            </CardTitle>
            <CardDescription>
              Anthropic credentials used by cloud jobs. Personal overrides only
              apply to you.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="organization-anthropic-key">
                Organization Anthropic key
              </Label>
              <Input
                defaultValue="sk-ant-••••••••••••a92f"
                id="organization-anthropic-key"
                readOnly
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="personal-anthropic-key">Personal override</Label>
              <div className="flex gap-2">
                <Input
                  id="personal-anthropic-key"
                  placeholder="sk-ant-..."
                  type="password"
                />
                <Button variant="outline">Save</Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <FileKeyIcon className="size-5" />
                  Closedloop API keys
                </CardTitle>
                <CardDescription className="mt-1">
                  Authenticate MCP clients and REST API requests.
                </CardDescription>
              </div>
              <Button size="sm">
                <PlusIcon />
                Create key
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-dashed p-7 text-center">
              <KeyRoundIcon className="mx-auto size-6 text-muted-foreground" />
              <p className="mt-3 font-medium text-sm">
                No programmatic keys yet
              </p>
              <p className="mt-1 text-muted-foreground text-sm">
                Create a key to connect an MCP client or API integration.
              </p>
            </div>
            <div className="rounded-lg bg-muted p-4 font-mono text-xs">
              Authorization: Bearer cl_live_••••••••
            </div>
          </CardContent>
        </Card>
      </div>
    </SettingsSection>
  );
}

export function OtherLabsSettings() {
  return (
    <SettingsSection
      description="Try experimental organization features before they become generally available."
      title="Other Labs Settings"
    >
      <Card>
        <CardHeader>
          <CardTitle>Experimental analysis</CardTitle>
          <CardDescription>
            Labs settings may change as we learn from early usage.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-y rounded-lg border p-0">
          <ToggleSetting
            defaultChecked
            description="Analyze sessions for signals that help your team identify friction and improve agent workflows."
            label="Session frustration insights"
          />
        </CardContent>
      </Card>
    </SettingsSection>
  );
}
