"use client";

import { PendingOnboardingStep as PendingStep } from "@repo/api/src/types/onboarding-phase";
import {
  SetupGateStepList,
  setupGateStepLabel,
} from "@repo/app/onboarding/components/setup-gate-steps"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import type { SetupGate } from "@repo/app/onboarding/lib/first-user-setup-gate"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@repo/design-system/components/ui/dropdown-menu";
import { Input } from "@repo/design-system/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarNavLinkItem,
} from "@repo/design-system/components/ui/sidebar";
import { SidebarCollapsibleSection } from "@repo/design-system/components/ui/sidebar-collapsible-section";
import { SidebarCountBadge } from "@repo/design-system/components/ui/sidebar-count-badge";
import { Link } from "@repo/navigation/link";
import { usePath } from "@repo/navigation/use-path";
import {
  BarChart3,
  BotIcon,
  ChevronDownIcon,
  CloudCogIcon,
  CopyCheckIcon,
  DownloadIcon,
  FileIcon,
  GitBranchIcon,
  HistoryIcon,
  InboxIcon,
  LaptopIcon,
  Layers2Icon,
  LayoutDashboardIcon,
  type LucideIcon,
  PanelsTopLeftIcon,
  SearchIcon,
  ShieldIcon,
  SquareCheckIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import {
  artifactsNav,
  labsArtifactsNav,
  labsNav,
  type NavIconName,
  type NavItem,
  primaryNav,
  type TeamFavorite,
  type TeamItem,
  teams,
  WEB_MASTER_BASE_PATH,
} from "../mock";
import { SETUP_GATE_PROPOSED_COPY } from "./setup-gate-copy";
import { useWebMasterHostImage } from "./web-master-host-image";

const ACTIVE_WORKSPACE_ID = "closedloop";

const navIcons: Record<NavIconName, LucideIcon> = {
  dashboard: LayoutDashboardIcon,
  inbox: InboxIcon,
  "my-issues": CopyCheckIcon,
  documents: FileIcon,
  issues: SquareCheckIcon,
  sessions: HistoryIcon,
  branches: GitBranchIcon,
  agents: BotIcon,
  insights: BarChart3,
  approvals: ShieldIcon,
  requests: InboxIcon,
  "generic-artifact": Layers2Icon,
  prototypes: PanelsTopLeftIcon,
};

const NavLink = ({ item }: { item: NavItem }) => {
  const pathname = usePath();
  const Icon = navIcons[item.icon];
  const trailing =
    item.count === undefined ? undefined : (
      <SidebarCountBadge count={item.count} />
    );

  // The design-system SidebarNavLinkItem's href path routes through
  // @repo/navigation, whose provider the sandbox doesn't mount; linked items
  // use next/link directly instead (same composed SidebarMenuButton styling).
  if (item.href !== undefined) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          asChild
          className="text-sm"
          // Exact-ish match: no nav href is a prefix of another today. Revisit
          // if a subpage is added whose path prefixes a sibling's.
          isActive={pathname.startsWith(item.href)}
          tooltip={item.label}
        >
          <Link href={item.href}>
            <Icon />
            <span>{item.label}</span>
            {trailing}
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarNavLinkItem
      className="text-sm"
      icon={<Icon />}
      key={item.label}
      title={item.label}
      tooltip={item.label}
      trailing={trailing}
    />
  );
};

const SidebarSearch = () => (
  <div className="flex items-center px-2 pt-2.5">
    <div className="relative w-full">
      <SearchIcon
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
        size={14}
      />
      <Input
        aria-label="Search"
        className="h-8 rounded-full border-input-border bg-transparent py-1.5 pr-8 pl-8 text-xs shadow-none focus-visible:bg-background"
        placeholder="Search"
        readOnly
        type="text"
        value=""
      />
    </div>
  </div>
);

// A Labs row with no prototype destination stays presentational: it renders the
// shape without offering a control that would do nothing when pressed. Compute
// is one of those; the rows that do have a destination are links.
const ComputeFooterRow = () => (
  <SidebarMenuButton asChild size="lg">
    <div>
      <LaptopIcon />
      <div className="grid flex-1 text-left leading-tight">
        <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
          Compute
        </span>
        <span className="truncate font-medium text-sm">Ollama Mini Local</span>
      </div>
    </div>
  </SidebarMenuButton>
);

const ClosedloopWorkspaceIcon = ({ className }: { className?: string }) => {
  const Image = useWebMasterHostImage();
  return (
    <span className={className}>
      <Image
        alt=""
        className="size-full dark:hidden"
        height={28}
        src="/web-master/closedloop-icon-on-light.svg"
        width={28}
      />
      <Image
        alt=""
        className="hidden size-full dark:block"
        height={28}
        src="/web-master/closedloop-icon-on-dark.svg"
        width={28}
      />
    </span>
  );
};

const WorkspaceMenuButton = ({
  onDownloadDesktopApp,
  onSignOut,
}: {
  onDownloadDesktopApp?: () => void;
  onSignOut?: () => void;
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <SidebarMenuButton
        aria-label="Open account menu"
        className="h-10 rounded-lg px-2 data-[state=open]:bg-sidebar-accent"
        tooltip="Closedloop"
      >
        <ClosedloopWorkspaceIcon className="size-7 shrink-0" />
        <div className="grid flex-1 text-left text-sm leading-tight">
          <span className="truncate font-medium">Closedloop</span>
        </div>
        <ChevronDownIcon className="ml-auto size-4 opacity-60" />
      </SidebarMenuButton>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      align="start"
      className="w-72 rounded-xl p-1.5 shadow-xl"
      side="bottom"
      sideOffset={6}
    >
      <DropdownMenuItem asChild className="py-2.5">
        <Link href={`${WEB_MASTER_BASE_PATH}/settings`}>Settings</Link>
      </DropdownMenuItem>
      <DropdownMenuItem asChild className="py-2.5">
        <Link href={`${WEB_MASTER_BASE_PATH}/settings?section=members`}>
          Invite and manage members
        </Link>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem className="py-2.5" onSelect={onDownloadDesktopApp}>
        Download desktop app
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="py-2.5">
          Switch workspace
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-72 rounded-xl p-1.5 shadow-xl">
          <DropdownMenuLabel className="truncate font-normal text-muted-foreground">
            ottilie.eastwick@example.com
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup value={ACTIVE_WORKSPACE_ID}>
            <DropdownMenuRadioItem
              className="py-2.5"
              value={ACTIVE_WORKSPACE_ID}
            >
              <ClosedloopWorkspaceIcon className="size-7 shrink-0" />
              <span className="font-medium">Closedloop</span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuLabel className="pt-3 text-muted-foreground">
            Account
          </DropdownMenuLabel>
          <DropdownMenuItem asChild className="py-2.5">
            <Link href={`${WEB_MASTER_BASE_PATH}/settings`}>
              Create or join a workspace…
            </Link>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuItem className="py-2.5" onSelect={onSignOut}>
        Log out
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
);

export type PendingOnboardingStep =
  | "create-account"
  | "download-app"
  | "choose-sync"
  | "connect-github"
  | "invite-team";

const completionStepContent: Record<
  PendingOnboardingStep,
  { icon: LucideIcon; label: string }
> = {
  "create-account": { icon: UserPlusIcon, label: "Create account" },
  // Read from the shared setup-gate rows, so a row and this button never name
  // one step two ways (ISS-12363).
  "download-app": {
    icon: DownloadIcon,
    label: setupGateStepLabel(PendingStep.DownloadDesktop),
  },
  "choose-sync": {
    icon: CloudCogIcon,
    label: setupGateStepLabel(PendingStep.ChooseSessionSync),
  },
  "connect-github": { icon: GitBranchIcon, label: "Connect GitHub" },
  "invite-team": { icon: UsersIcon, label: "Invite teammates" },
};

// ISS-12363: the download and sync rows show together, with their done state,
// whenever either is the step the card is offering.
const SETUP_GATE_CARD_STEPS: ReadonlySet<PendingOnboardingStep> = new Set([
  "download-app",
  "choose-sync",
]);

const AccountCompletionCard = ({
  exiting,
  onContinue,
  pendingStep,
  progressLabel,
  setupGate,
}: {
  exiting: boolean;
  onContinue: () => void;
  pendingStep: PendingOnboardingStep;
  progressLabel: string;
  setupGate?: SetupGate;
}) => {
  const { icon: Icon, label } = completionStepContent[pendingStep];

  return (
    <section
      aria-hidden={exiting || undefined}
      aria-label="Getting started"
      className={`rounded-xl border border-sidebar-border bg-sidebar-accent/60 p-2.5 duration-200 ${
        exiting
          ? "slide-out-to-left-2 fade-out pointer-events-none animate-out"
          : "slide-in-from-left-2 fade-in animate-in"
      }`}
      data-exiting={exiting || undefined}
    >
      <div className="flex items-center gap-2 px-1 text-muted-foreground text-xs">
        <span className="font-medium">Getting started</span>
        <span className="ml-auto tabular-nums">{progressLabel}</span>
        <span
          aria-hidden="true"
          className="size-3.5 rounded-full border-2 border-primary border-t-muted"
        />
      </div>
      {setupGate && SETUP_GATE_CARD_STEPS.has(pendingStep) ? (
        <SetupGateStepList
          className="mt-2 px-1"
          completedOnly
          copy={SETUP_GATE_PROPOSED_COPY}
          gate={setupGate}
        />
      ) : null}
      <button
        className="mt-2 flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-background font-medium text-sm shadow-xs transition-colors hover:bg-sidebar-accent"
        onClick={onContinue}
        type="button"
      >
        <Icon className="size-4" />
        {label}
      </button>
    </section>
  );
};

// A team row carries an href only when its collection exists as a subpage of
// this master; the rest are Labs preview shape with no destination, so they stay
// presentational rather than offering a control that would do nothing.
const TeamRow = ({ team }: { team: TeamItem }) => {
  const content = (
    <>
      <UsersIcon />
      <span className="truncate">{team.name}</span>
    </>
  );

  if (team.href !== undefined) {
    return (
      <SidebarMenuButton asChild className="text-sm" isActive={team.isActive}>
        <Link href={team.href}>{content}</Link>
      </SidebarMenuButton>
    );
  }

  return (
    <SidebarMenuButton asChild className="text-sm" isActive={team.isActive}>
      <div>{content}</div>
    </SidebarMenuButton>
  );
};

const TeamFavoriteRow = ({ favorite }: { favorite: TeamFavorite }) => (
  <SidebarMenuSubButton asChild className="pr-0">
    <Link className="w-full" href={favorite.href}>
      <Layers2Icon />
      <span>{favorite.name}</span>
    </Link>
  </SidebarMenuSubButton>
);

const TeamsSection = () => (
  <SidebarCollapsibleSection className="px-0 py-1" title="Your Teams">
    <SidebarMenu className="gap-0">
      {teams.map((team) => (
        <SidebarMenuItem key={team.id}>
          <TeamRow team={team} />
          {team.favorites ? (
            <SidebarMenuSub className="mr-0 gap-0 pr-0">
              {team.favorites.map((favorite) => (
                <SidebarMenuSubItem key={favorite.id}>
                  <TeamFavoriteRow favorite={favorite} />
                </SidebarMenuSubItem>
              ))}
            </SidebarMenuSub>
          ) : null}
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  </SidebarCollapsibleSection>
);

const LabsArtifactsSection = () => (
  <SidebarCollapsibleSection className="px-0 py-1" title="Artifacts">
    <SidebarMenu className="gap-0">
      {labsArtifactsNav.map((item) => (
        <NavLink item={item} key={item.label} />
      ))}
    </SidebarMenu>
  </SidebarCollapsibleSection>
);

export const AppSidebar = ({
  backgroundInert = false,
  completionCardExiting = false,
  completionProgress = "2/3",
  onContinueOnboarding,
  onDownloadDesktopApp,
  onSignOut,
  pendingOnboardingStep = null,
  setupGate,
}: {
  /** Set while the blocking FTUE gate is open so the sidebar behind it is
   *  neither tabbable nor exposed to assistive tech. */
  backgroundInert?: boolean;
  completionCardExiting?: boolean;
  completionProgress?: string;
  onContinueOnboarding?: () => void;
  onDownloadDesktopApp?: () => void;
  onSignOut?: () => void;
  pendingOnboardingStep?: PendingOnboardingStep | null;
  /** Web only: the setup gate's two steps for the card's checklist. */
  setupGate?: SetupGate;
} = {}) => (
  <Sidebar inert={backgroundInert} variant="inset">
    <SidebarHeader className="pb-0">
      <SidebarMenu>
        <SidebarMenuItem>
          <WorkspaceMenuButton
            onDownloadDesktopApp={onDownloadDesktopApp}
            onSignOut={onSignOut}
          />
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>
    <SidebarContent className="gap-1 pt-2">
      <SidebarGroup className="p-1">
        <SidebarMenu className="gap-0">
          {primaryNav.map((item) => (
            <NavLink item={item} key={item.label} />
          ))}
        </SidebarMenu>
      </SidebarGroup>

      <SidebarCollapsibleSection title="Artifacts">
        <SidebarMenu className="gap-0">
          {artifactsNav.map((item) => (
            <NavLink item={item} key={item.label} />
          ))}
        </SidebarMenu>
      </SidebarCollapsibleSection>

      <SidebarCollapsibleSection defaultOpen={false} title="Labs">
        <SidebarSearch />
        <SidebarMenu className="gap-0">
          {labsNav.map((item) => (
            <NavLink item={item} key={item.label} />
          ))}
        </SidebarMenu>
        <LabsArtifactsSection />
        <TeamsSection />
        <SidebarMenu className="gap-0">
          <SidebarMenuItem>
            <ComputeFooterRow />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarCollapsibleSection>
    </SidebarContent>

    {pendingOnboardingStep && onContinueOnboarding ? (
      <SidebarFooter className="gap-2">
        <AccountCompletionCard
          exiting={completionCardExiting}
          onContinue={onContinueOnboarding}
          pendingStep={pendingOnboardingStep}
          progressLabel={completionProgress}
          setupGate={setupGate}
        />
      </SidebarFooter>
    ) : null}
  </Sidebar>
);
