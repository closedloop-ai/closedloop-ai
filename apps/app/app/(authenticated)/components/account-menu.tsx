"use client";

import { useIsMounted } from "@repo/app/shared/hooks/use-is-mounted";
import {
  CreateOrganization,
  useClerk,
  useOrganization,
  useOrganizationList,
  useUser,
} from "@repo/auth/client";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import {
  SidebarMenuButton,
  useSidebar,
} from "@repo/design-system/components/ui/sidebar";
import { ThemeSubmenu } from "@repo/design-system/components/ui/theme-submenu";
import { cn } from "@repo/design-system/lib/utils";
import { Link } from "@repo/navigation/link";
import { useNavigation } from "@repo/navigation/use-navigation";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  LogOutIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";
import { useState } from "react";
import { useOrgSlug } from "@/hooks/use-org-slug";

export function AccountMenu() {
  const { open: sidebarOpen } = useSidebar();
  const mounted = useIsMounted();
  const { organization } = useOrganization();
  const { user } = useUser();
  const { signOut } = useClerk();
  const { userMemberships, setActive, isLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const orgSlug = useOrgSlug();
  const { navigate } = useNavigation();
  const [createOrgOpen, setCreateOrgOpen] = useState(false);

  if (!mounted) {
    return (
      <div
        className={cn(
          "h-8 w-full animate-pulse rounded-md bg-muted",
          !sidebarOpen && "size-7"
        )}
      />
    );
  }

  const orgName = organization?.name ?? "Personal";
  const orgInitial = orgName.charAt(0).toUpperCase();
  const userName =
    user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? "Account";
  const userInitial = (user?.firstName ?? userName).charAt(0).toUpperCase();
  const memberships = isLoaded ? (userMemberships.data ?? []) : [];
  const otherMemberships = memberships.filter(
    (m) => m.organization.id !== organization?.id
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            aria-label="Open organization switcher"
            className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            size="lg"
            tooltip={sidebarOpen ? undefined : orgName}
          >
            <Avatar className="size-7 rounded-md">
              <AvatarImage alt={orgName} src={organization?.imageUrl} />
              <AvatarFallback className="rounded-md text-xs">
                {orgInitial}
              </AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{orgName}</span>
            </div>
            <ChevronsUpDownIcon className="ml-auto size-4 opacity-60" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-md"
          side="top"
          sideOffset={4}
        >
          <DropdownMenuLabel className="flex items-center gap-2 font-normal">
            <Avatar className="size-7 rounded-md">
              <AvatarImage alt={orgName} src={organization?.imageUrl} />
              <AvatarFallback className="rounded-md text-xs">
                {orgInitial}
              </AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{orgName}</span>
            </div>
            <CheckIcon className="size-4 text-muted-foreground" />
          </DropdownMenuLabel>
          {otherMemberships.length > 0 &&
            otherMemberships.map(({ organization: org }) => (
              <DropdownMenuItem
                key={org.id}
                onSelect={() => {
                  if (!setActive) {
                    return;
                  }
                  setActive({ organization: org.id })
                    .then(() => navigate(`/${org.slug}/my-tasks`))
                    .catch(() => {
                      // Clerk surfaces failures via its own toast.
                    });
                }}
              >
                <Avatar className="size-5 rounded-md">
                  <AvatarImage alt={org.name} src={org.imageUrl} />
                  <AvatarFallback className="rounded-md text-[10px]">
                    {org.name.charAt(0).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="truncate">{org.name}</span>
              </DropdownMenuItem>
            ))}
          <DropdownMenuItem onSelect={() => setCreateOrgOpen(true)}>
            <PlusIcon className="size-4" />
            Create Org
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuLabel className="flex items-center gap-2 font-normal">
            <Avatar className="size-7">
              <AvatarImage alt={userName} src={user?.imageUrl} />
              <AvatarFallback className="text-xs">{userInitial}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{userName}</span>
              {user?.primaryEmailAddress?.emailAddress && (
                <span className="truncate text-muted-foreground text-xs">
                  {user.primaryEmailAddress.emailAddress}
                </span>
              )}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href={`/${orgSlug}/settings`}>
              <SettingsIcon className="size-4" />
              Settings
            </Link>
          </DropdownMenuItem>
          <ThemeSubmenu />

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={() => signOut()}>
            <LogOutIcon className="size-4" />
            Sign Out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog onOpenChange={setCreateOrgOpen} open={createOrgOpen}>
        <DialogContent className="max-w-fit border-none bg-transparent p-0 shadow-none">
          <DialogHeader className="sr-only">
            <DialogTitle>Create Organization</DialogTitle>
          </DialogHeader>
          <CreateOrganization
            afterCreateOrganizationUrl="/:slug/my-tasks"
            skipInvitationScreen
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
