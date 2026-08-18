"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
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
import { cn } from "@repo/design-system/lib/utils";
import { BuildingIcon, UserPlusIcon } from "lucide-react";
import { OrgSettingsSection, orgMembers } from "../mock";
import { InviteTeamDialog } from "./invite-team-dialog";

type SettingsOrganizationProps = {
  section: OrgSettingsSection;
  onSectionChange: (section: OrgSettingsSection) => void;
  workspaceName: string;
  onInvited: () => void;
};

const sectionNav = [
  { section: OrgSettingsSection.General, label: "General" },
  { section: OrgSettingsSection.Members, label: "Members" },
] as const;

// The Organization tab, mirroring the org-profile layout: a left section rail
// (General / Members) beside the active section's content.
export const SettingsOrganization = ({
  section,
  onSectionChange,
  workspaceName,
  onInvited,
}: SettingsOrganizationProps) => (
  <div className="flex flex-col gap-6 sm:flex-row">
    <nav
      aria-label="Organization settings sections"
      className="flex shrink-0 gap-1 sm:w-44 sm:flex-col"
    >
      {sectionNav.map((item) => (
        <button
          aria-current={item.section === section ? "page" : undefined}
          className={cn(
            "rounded-md px-3 py-2 text-left text-sm transition-colors",
            item.section === section
              ? "bg-muted font-medium"
              : "text-muted-foreground hover:bg-muted/50"
          )}
          key={item.section}
          onClick={() => onSectionChange(item.section)}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </nav>
    <div className="min-w-0 flex-1">
      {section === OrgSettingsSection.Members ? (
        <MembersSection onInvited={onInvited} workspaceName={workspaceName} />
      ) : (
        <GeneralSection workspaceName={workspaceName} />
      )}
    </div>
  </div>
);

const GeneralSection = ({ workspaceName }: { workspaceName: string }) => (
  <Card>
    <CardHeader>
      <CardTitle className="flex items-center gap-2">
        <BuildingIcon className="size-5" />
        General
      </CardTitle>
      <CardDescription>Your organization's name and details.</CardDescription>
    </CardHeader>
    <CardContent>
      <div className="space-y-2">
        <Label htmlFor="org-name">Organization name</Label>
        <Input defaultValue={workspaceName} id="org-name" />
      </div>
    </CardContent>
  </Card>
);

const MembersSection = ({
  workspaceName,
  onInvited,
}: {
  workspaceName: string;
  onInvited: () => void;
}) => (
  <Card>
    <CardHeader>
      <CardTitle>Members</CardTitle>
      <CardDescription>People in {workspaceName}.</CardDescription>
      <div className="pt-2">
        <InviteTeamDialog
          onInvited={onInvited}
          trigger={
            <Button size="sm">
              <UserPlusIcon className="size-4" />
              Invite
            </Button>
          }
        />
      </div>
    </CardHeader>
    <CardContent className="space-y-1">
      {orgMembers.map((member) => (
        <div
          className="flex items-center gap-3 rounded-md px-2 py-2"
          key={member.id}
        >
          <Avatar className="size-8">
            <AvatarFallback className="bg-primary text-primary-foreground text-xs">
              {member.initials}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-sm">{member.name}</p>
            <p className="truncate text-muted-foreground text-xs">
              {member.email}
            </p>
          </div>
          <Badge variant="outline">{member.role}</Badge>
        </div>
      ))}
    </CardContent>
  </Card>
);
