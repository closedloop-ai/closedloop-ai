"use client";

import { OrganizationProfile } from "@repo/auth/client";
import { Separator } from "@repo/design-system/components/ui/separator";

export default function MembersPage() {
  return (
    <div className="flex flex-1 flex-col gap-6 p-6">
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
        routing="hash"
      />
    </div>
  );
}
