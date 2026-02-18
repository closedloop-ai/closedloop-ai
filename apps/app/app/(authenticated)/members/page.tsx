"use client";

import {
  APPROVER_ROLE_OPTIONS,
  ApproverRole,
} from "@repo/api/src/types/artifact";
import { OrganizationProfile } from "@repo/auth/client";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Separator } from "@repo/design-system/components/ui/separator";
import { toast } from "sonner";
import { useOrganizationUsers, useUpdateUser } from "@/hooks/queries/use-users";

const ROLE_LABELS: Record<string, string> = {
  [ApproverRole.Pm]: "PM",
  [ApproverRole.Designer]: "Designer",
  [ApproverRole.TechLead]: "Tech Lead",
  [ApproverRole.Engineer]: "Engineer",
  [ApproverRole.Stakeholder]: "Stakeholder",
};

export default function MembersPage() {
  const { data: users = [] } = useOrganizationUsers();
  const updateUser = useUpdateUser();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Members</h1>
        <p className="text-muted-foreground">
          View and manage your organization members.
        </p>
      </div>

      <Separator />

      <OrganizationProfile
        appearance={{
          elements: {
            rootBox: "w-full",
            cardBox:
              "bg-transparent shadow-none border rounded-lg border-border",
            navbar: "hidden",
            pageScrollBox: "p-4",
            membersPageInviteButton:
              "bg-primary text-primary-foreground hover:bg-primary/90",
            formButtonPrimary:
              "bg-primary text-primary-foreground hover:bg-primary/90",
          },
        }}
      />

      {users.length > 0 && (
        <>
          <Separator />
          <div>
            <h2 className="font-semibold text-lg tracking-tight">
              Symphony Roles
            </h2>
            <p className="text-muted-foreground text-sm">
              Set the Symphony role for each member. Engineers will see the
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
                      <AvatarImage
                        alt={name}
                        src={user.avatarUrl ?? undefined}
                      />
                      <AvatarFallback className="text-xs">
                        {(
                          user.firstName?.[0] ??
                          user.email[0] ??
                          "?"
                        ).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="truncate font-medium text-sm">
                        {name || user.email}
                      </p>
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
                          onError: () => {
                            toast.error("Failed to update role");
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
      )}
    </div>
  );
}
