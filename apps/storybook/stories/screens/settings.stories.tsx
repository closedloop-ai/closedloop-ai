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

const SettingsScreen = () => (
  <AppScreenShell activePath="/settings" breadcrumbs={["Settings"]}>
    <div className="flex min-h-0 flex-1 flex-col gap-6 p-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Manage your organization, members, and integrations.
        </p>
      </div>

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
        </TabsList>
      </Tabs>

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

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>People with access to this org.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table className="text-sm">
            <TableBody>
              {MEMBERS.map((member) => (
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
    </div>
  </AppScreenShell>
);

const meta = {
  title: "Screens/Settings",
  component: SettingsScreen,
  parameters: { controls: { disable: true }, layout: "fullscreen" },
} satisfies Meta<typeof SettingsScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
