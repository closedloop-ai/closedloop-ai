"use client";

import {
  Avatar,
  AvatarFallback,
} from "@repo/design-system/components/ui/avatar";
import { Badge } from "@repo/design-system/components/ui/badge";

// Titlebar affordance: communicates "no account yet, your work is safe" while
// in guest mode, and swaps to the user avatar once an account exists.
export const GuestBadge = ({ account }: { account: boolean }) => {
  if (account) {
    return (
      <Avatar className="size-6">
        <AvatarFallback className="bg-primary text-[10px] text-primary-foreground">
          YU
        </AvatarFallback>
      </Avatar>
    );
  }
  return (
    <Badge
      className="h-6 gap-1.5 rounded-full border-border bg-muted/70 px-2.5 font-medium text-[11px] text-muted-foreground"
      title="You're in guest mode. Your work is saved on this device, and you can create an account anytime to keep and share it."
      variant="outline"
    >
      <span className="size-1.5 rounded-full bg-current" />
      Guest
    </Badge>
  );
};
