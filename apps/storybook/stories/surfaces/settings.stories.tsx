import { PRIMARY_NAV_DESTINATIONS } from "@repo/app/shared/lib/primary-nav-destinations";
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
import { Separator } from "@repo/design-system/components/ui/separator";
import { Switch } from "@repo/design-system/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@repo/design-system/components/ui/table";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import type { Meta, StoryObj } from "@storybook/react";
import { AppScreenShell } from "./app-shell";

const MEMBERS = [
  {
    email: "matt.stephens@closedloop.ai",
    name: "Matt Stephens",
    role: "Admin",
  },
  { email: "andrew@closedloop.ai", name: "Andrew Eye", role: "Owner" },
  { email: "mike@closedloop.ai", name: "Mike", role: "Member" },
];

// One source for the tab bar and for the control that drives it.
const SETTINGS_TABS = [
  { label: "General", value: "general" },
  { label: "Members", value: "members" },
  { label: "Integrations", value: "integrations" },
  { label: "Billing", value: "billing" },
] as const;

// Derived from the same canonical nav the shell renders, so the control can
// never offer a destination the product does not have.
const NAV_PATHS = PRIMARY_NAV_DESTINATIONS.map(
  (destination) => destination.path
);

const SETTINGS_COPY = {
  heading: "Settings",
  description: "Manage your organization, members, and integrations.",
} as const;

type SettingsScreenProps = {
  /** Org-relative path the sidebar should mark as current. */
  activePath?: string;
  /** Page heading. */
  heading?: string;
  /** Supporting line under the heading. */
  description?: string;
  /** Show the Organization card. */
  showOrganization?: boolean;
  /** Show the Members card. */
  showMembers?: boolean;
  /** Show the Preferences card. */
  showPreferences?: boolean;
  /** Which tab reads as selected. */
  activeTab?: (typeof SETTINGS_TABS)[number]["value"];
  /** How many of the fixture members to list. */
  memberCount?: number;
};

const SettingsScreen = ({
  activePath = "/settings",
  activeTab = "general",
  description = SETTINGS_COPY.description,
  heading = SETTINGS_COPY.heading,
  memberCount = MEMBERS.length,
  showMembers = true,
  showOrganization = true,
  showPreferences = true,
}: SettingsScreenProps) => (
  <AppScreenShell activePath={activePath} breadcrumbs={["Settings"]}>
    <div className="flex min-h-0 flex-1 flex-col gap-6 p-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">{heading}</h1>
        <p className="text-muted-foreground">{description}</p>
      </div>

      {/* `key` remounts on control change so the new default takes effect,
          while staying uncontrolled so clicking a tab still works. A bare
          `value` with no handler would freeze the tab bar. */}
      <Tabs defaultValue={activeTab} key={activeTab}>
        <TabsList>
          {SETTINGS_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {showOrganization ? (
        <Card>
          <CardHeader>
            <CardTitle>Organization</CardTitle>
            <CardDescription>
              How your organization appears across the product.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2 sm:max-w-sm">
              <Label htmlFor="org-name">Name</Label>
              <Input defaultValue="ClosedLoop" id="org-name" />
            </div>
            <div className="grid gap-2 sm:max-w-sm">
              <Label htmlFor="org-slug">URL slug</Label>
              <Input defaultValue="closedloop" id="org-slug" />
              <p className="text-muted-foreground text-xs">
                app.closedloop.ai/closedloop
              </p>
            </div>
            <Separator />
            <div className="flex justify-end">
              <Button>Save changes</Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {showMembers ? (
        <Card>
          <CardHeader>
            <CardTitle>Members</CardTitle>
            <CardDescription>People with access to this org.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table className="text-sm">
              <TableBody>
                {MEMBERS.slice(0, memberCount).map((member) => (
                  <TableRow className="last:border-0" key={member.email}>
                    <TableCell className="px-6 py-3">
                      <p className="font-medium">{member.name}</p>
                      <p className="text-muted-foreground text-xs">
                        {member.email}
                      </p>
                    </TableCell>
                    <TableCell className="px-6 py-3 text-right">
                      <Badge variant="secondary">{member.role}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {showPreferences ? (
        <Card>
          <CardHeader>
            <CardTitle>Preferences</CardTitle>
            <CardDescription>
              Defaults applied to everyone in this organization.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {[
              {
                description:
                  "Email a digest of agent activity every weekday morning.",
                label: "Daily activity digest",
                on: true,
              },
              {
                description:
                  "Require a human review before an agent branch can merge.",
                label: "Mandatory review",
                on: true,
              },
              {
                description: "Show experimental surfaces under a Labs section.",
                label: "Labs features",
                on: false,
              },
            ].map((pref) => (
              <div
                className="flex items-start justify-between gap-6"
                key={pref.label}
              >
                <div className="space-y-0.5">
                  <p className="font-medium text-sm">{pref.label}</p>
                  <p className="text-muted-foreground text-xs">
                    {pref.description}
                  </p>
                </div>
                <Switch defaultChecked={pref.on} />
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  </AppScreenShell>
);

/**
 * The organization settings screen, showing the overall shape of account and
 * org configuration separate from a single feature's own settings, like data
 * sync.
 */
const meta = {
  title: "Surfaces/Settings",
  component: SettingsScreen,
  tags: ["autodocs"],
  argTypes: {
    activePath: {
      options: NAV_PATHS,
      control: { type: "select" },
      description: "Which sidebar destination renders as current.",
      table: { category: "Shell" },
    },
    activeTab: {
      options: SETTINGS_TABS.map((tab) => tab.value),
      control: { type: "radio" },
      description:
        "Which tab reads as selected. The tab bar is presentational here: the cards below always render Organization, Members and Preferences together, rather than one panel per tab.",
      table: { category: "Content" },
    },
    memberCount: {
      control: { type: "number", min: 0, max: MEMBERS.length, step: 1 },
      description: "Rows listed in the members table.",
      table: { category: "Content" },
    },
    heading: { control: "text", table: { category: "Content" } },
    description: { control: "text", table: { category: "Content" } },
    showOrganization: {
      control: "boolean",
      description: "The Organization card.",
      table: { category: "Composition" },
    },
    showMembers: {
      control: "boolean",
      description: "The Members card.",
      table: { category: "Composition" },
    },
    showPreferences: {
      control: "boolean",
      description: "The Preferences card.",
      table: { category: "Composition" },
    },
  },
  args: {
    activePath: "/settings",
    activeTab: "general",
    description: SETTINGS_COPY.description,
    heading: SETTINGS_COPY.heading,
    memberCount: MEMBERS.length,
    showMembers: true,
    showOrganization: true,
    showPreferences: true,
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SettingsScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** A brand new org, before anyone else has been invited. */
export const NoMembers: Story = {
  name: "No members",
  args: { memberCount: 0 },
};

/** The Members tab in isolation. */
export const MembersOnly: Story = {
  name: "Members only",
  args: {
    activeTab: "members",
    showOrganization: false,
    showPreferences: false,
  },
};
