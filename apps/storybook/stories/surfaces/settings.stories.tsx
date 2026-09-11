import {
  OrgPolicyEditableCard,
  OrgPolicyErrorState,
  OrgPolicyLoadingState,
  OrgPolicyUnavailableState,
} from "@repo/app/settings/components/org-policy-toggle-card";
import {
  SessionFrustrationErrorState,
  SessionFrustrationLoadingState,
  SessionFrustrationToggleCard,
} from "@repo/app/settings/components/session-frustration-card";
import { OrgPolicyFieldState } from "@repo/app/settings/lib/org-policy-toggle-state";
import { PRIMARY_NAV_DESTINATIONS } from "@repo/app/shared/lib/primary-nav-destinations";
import { Badge } from "@repo/design-system/components/ui/badge";
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
import { fn } from "storybook/test";
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

// One source for the tab bar and for the control that drives it. The ids and
// order match `SettingsTab` in
// `apps/app/(authenticated)/[orgSlug]/settings/settings-tabs.ts`, minus the
// admin-only Custom Fields, Compliance and Tags tabs, which are gated by role
// and a feature flag this surface has no reason to model. Organization is the
// default because that is the tab every real card below actually renders on.
const SETTINGS_TABS = [
  { label: "Profile", value: "profile" },
  { label: "Organization", value: "organization" },
  { label: "Compute & Integrations", value: "integrations" },
  { label: "API Keys", value: "api-keys" },
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

// Real copy for the two admin-only privacy toggles, lifted from
// `SessionSyncPolicyCard` and `TranscriptSearchCard`
// (apps/app/(authenticated)/[orgSlug]/settings/components/). Both are thin
// wrappers around the same `OrgPolicyToggleCard` container that only choose a
// field and supply this copy; the container itself calls `useCurrentUser` and
// `useOrganization`, so it is not presentational and is not what this surface
// mounts. Copied here rather than imported for the same reason the container
// is not imported: there is no alias into `apps/app` from this Storybook.
const SESSION_SYNC_CARD_COPY = {
  description:
    "Control whether this organization's locally-captured agent-session data is allowed to sync to the ClosedLoop cloud.",
  title: "Sync session data to the cloud",
  toggleHelpText:
    "Off by default. When off, new session data stays on each member's machine; work already in progress may finish syncing.",
  toggleId: "session-sync-policy-enabled",
  toggleLabel: "Allow session data to sync to the cloud",
} as const;

const TRANSCRIPT_SEARCH_CARD_COPY = {
  description:
    "Control whether unified search can look inside AI session transcript content.",
  title: "Search session transcripts",
  toggleHelpText:
    "When on, full-text search matches the text of session transcripts, not just their titles. Transcript content can contain source code, secrets, and prompts, so this is off by default.",
  toggleId: "search-include-transcripts",
  toggleLabel: "Include transcript content in search",
} as const;

// The card is idle: no save in flight, nothing to report. Matches
// `org-policy-toggle-card.stories.tsx`'s own `idleSaveState`.
const IDLE_SAVE_STATE = {
  requested: undefined,
  isSaving: false,
  saveAlert: null,
};

// Named for what the reader sees, not for the query flags that produce it in
// the real container (`OrgPolicyToggleCard`): the org query hasn't settled,
// the read failed outright, the field came back missing (deploy skew), or a
// real value arrived. Both privacy toggles ride the same organization query
// in production, so one control governs both cards below.
const POLICY_READ_STATES = [
  "settled",
  "loading",
  "unavailable",
  "error",
] as const;
type PolicyReadState = (typeof POLICY_READ_STATES)[number];

// The frustration signal is its own query (`useFrustrationSetting`), so it
// settles independently of the two org-policy cards and gets its own control.
// It has no "unavailable" reading: the field is not optional on the wire the
// way the two policy fields are.
const FRUSTRATION_READ_STATES = ["settled", "loading", "error"] as const;
type FrustrationReadState = (typeof FRUSTRATION_READ_STATES)[number];

type OrgPolicyCardCopy = {
  description: string;
  title: string;
  toggleHelpText: string;
  toggleId: string;
  toggleLabel: string;
};

/** Renders the same four states `OrgPolicyToggleCard` chooses between in production, off the `PolicyReadState` this surface exposes instead of a live query. */
function renderOrgPolicyCard(
  readState: PolicyReadState,
  checked: boolean,
  copy: OrgPolicyCardCopy
) {
  if (readState === "loading") {
    return <OrgPolicyLoadingState title={copy.title} />;
  }
  if (readState === "error") {
    return (
      <OrgPolicyErrorState
        description={copy.description}
        message="Request failed with status 500"
        title={copy.title}
        toggleHelpText={copy.toggleHelpText}
      />
    );
  }
  if (readState === "unavailable") {
    return (
      <OrgPolicyUnavailableState
        description={copy.description}
        title={copy.title}
        toggleHelpText={copy.toggleHelpText}
      />
    );
  }
  return (
    <OrgPolicyEditableCard
      description={copy.description}
      onToggle={fn()}
      saveState={IDLE_SAVE_STATE}
      state={
        checked ? OrgPolicyFieldState.Enabled : OrgPolicyFieldState.Disabled
      }
      title={copy.title}
      toggleHelpText={copy.toggleHelpText}
      toggleId={copy.toggleId}
      toggleLabel={copy.toggleLabel}
    />
  );
}

/** Renders the three states `SessionFrustrationCard` chooses between in production, off the `FrustrationReadState` this surface exposes instead of a live query. */
function renderFrustrationCard(
  readState: FrustrationReadState,
  checked: boolean
) {
  if (readState === "loading") {
    return <SessionFrustrationLoadingState />;
  }
  if (readState === "error") {
    return (
      <SessionFrustrationErrorState message="Request failed with status 500" />
    );
  }
  return (
    <SessionFrustrationToggleCard
      checked={checked}
      hasSaveError={false}
      isSaving={false}
      onToggle={fn()}
    />
  );
}

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
  /** Show the two org privacy toggles and the frustration-signal toggle. */
  showPrivacySignals?: boolean;
  /** Which tab reads as selected. */
  activeTab?: (typeof SETTINGS_TABS)[number]["value"];
  /** How many of the fixture members to list. */
  memberCount?: number;
  /** What the org query reports for the two privacy toggles below. */
  policyReadState?: PolicyReadState;
  /** The server's reported value for the session-sync toggle, once settled. */
  sessionSyncEnabled?: boolean;
  /** The server's reported value for the transcript-search toggle, once settled. */
  transcriptSearchEnabled?: boolean;
  /** What the frustration-signal query reports, independent of the above. */
  frustrationReadState?: FrustrationReadState;
  /** The server's reported value for the frustration toggle, once settled. */
  frustrationEnabled?: boolean;
};

const SettingsSurface = ({
  activePath = "/settings",
  activeTab = "organization",
  description = SETTINGS_COPY.description,
  frustrationEnabled = false,
  frustrationReadState = "settled",
  heading = SETTINGS_COPY.heading,
  memberCount = MEMBERS.length,
  policyReadState = "settled",
  sessionSyncEnabled = false,
  showMembers = true,
  showOrganization = true,
  showPrivacySignals = true,
  transcriptSearchEnabled = false,
}: SettingsScreenProps) => (
  <AppScreenShell activePath={activePath} breadcrumbs={["Settings"]}>
    <div className="flex min-h-0 flex-1 flex-col gap-6 p-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">{heading}</h1>
        <p className="text-muted-foreground">{description}</p>
      </div>

      {/* `key` remounts on control change so the new default takes effect,
          while staying uncontrolled so clicking a tab still works. A bare
          `value` with no handler would freeze the tab bar. Presentational
          only, same as before: the cards below always render together rather
          than one panel per tab, because every real component this surface
          mounts lives on the Organization tab of the real page. */}
      <Tabs defaultValue={activeTab} key={activeTab}>
        <TabsList>
          {SETTINGS_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* HAND-BUILT: no drop-in replacement exists. The real Organization tab
          (`settings-page.tsx`) mounts Clerk's `<OrganizationProfile>` here for
          org identity, plus `OrganizationSlugSettings` for the slug — both of
          which call `useOrganization`/`useSession`/`useCurrentUser` directly
          rather than taking data as props, so neither is presentational. They
          would need a live Clerk provider and the app's query client to
          render, not just args, so this stays an approximation. */}
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
          </CardContent>
        </Card>
      ) : null}

      {/* HAND-BUILT: same reason as Organization above. The real page manages
          membership inside the same Clerk `<OrganizationProfile>` widget
          rather than through a first-party, prop-driven member list, so there
          is no composable component to mount here in its place. */}
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

      {/* REAL: the three privacy-and-signals cards `settings-page.tsx` mounts
          on the Organization tab, in the same order — `TranscriptSearchCard`,
          `SessionSyncPolicyCard`, `SessionFrustrationCard`. Each is a thin,
          hook-based container over a presentational component from
          `@repo/app/settings/components`; this surface mounts those
          presentational components directly and drives them with the same
          `PolicyReadState` / `FrustrationReadState` shape the containers
          resolve internally, rather than re-implementing the cards as
          markup. */}
      {showPrivacySignals ? (
        <div className="space-y-6">
          {renderOrgPolicyCard(
            policyReadState,
            transcriptSearchEnabled,
            TRANSCRIPT_SEARCH_CARD_COPY
          )}
          {renderOrgPolicyCard(
            policyReadState,
            sessionSyncEnabled,
            SESSION_SYNC_CARD_COPY
          )}
          {renderFrustrationCard(frustrationReadState, frustrationEnabled)}
        </div>
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
  component: SettingsSurface,
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
        "Which tab reads as selected. The tab bar is presentational here: every real card below lives on the Organization tab of the real page, so this surface renders them together rather than one panel per tab.",
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
    showPrivacySignals: {
      control: "boolean",
      description:
        "The transcript-search and session-sync privacy toggles, plus the frustration-signal toggle.",
      table: { category: "Composition" },
    },
    policyReadState: {
      options: POLICY_READ_STATES,
      control: { type: "radio" },
      description:
        "What the org query reports for the transcript-search and session-sync cards, which share one query in production: a real value, still loading, the field missing on an older API, or a failed read.",
      table: { category: "State" },
    },
    sessionSyncEnabled: {
      control: "boolean",
      description:
        "The server's reported value for session-sync, once policyReadState is settled.",
      table: { category: "State" },
    },
    transcriptSearchEnabled: {
      control: "boolean",
      description:
        "The server's reported value for transcript-search, once policyReadState is settled.",
      table: { category: "State" },
    },
    frustrationReadState: {
      options: FRUSTRATION_READ_STATES,
      control: { type: "radio" },
      description:
        "What the frustration-signal query reports. Settles independently of the two policy cards above, so the two can disagree on screen.",
      table: { category: "State" },
    },
    frustrationEnabled: {
      control: "boolean",
      description:
        "The server's reported value for the frustration toggle, once frustrationReadState is settled.",
      table: { category: "State" },
    },
  },
  args: {
    activePath: "/settings",
    activeTab: "organization",
    description: SETTINGS_COPY.description,
    frustrationEnabled: false,
    frustrationReadState: "settled",
    heading: SETTINGS_COPY.heading,
    memberCount: MEMBERS.length,
    policyReadState: "settled",
    sessionSyncEnabled: false,
    showMembers: true,
    showOrganization: true,
    showPrivacySignals: true,
    transcriptSearchEnabled: false,
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SettingsSurface>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** A brand new org, before anyone else has been invited. */
export const NoMembers: Story = {
  name: "No members",
  args: { memberCount: 0 },
};

/** Both privacy toggles opted in, and the org opted into the frustration
 * signal too, so all three real cards read as enabled at once. */
export const PrivacySignalsEnabled: Story = {
  name: "Privacy signals enabled",
  args: {
    frustrationEnabled: true,
    sessionSyncEnabled: true,
    transcriptSearchEnabled: true,
  },
};

/** The org query has not settled yet: both policy cards show their loading
 * state while the frustration card, on its own query, still reads settled. */
export const PolicyLoading: Story = {
  name: "Policy loading",
  args: { policyReadState: "loading" },
};

/** An older API stripped both optional policy fields off the wire, so each
 * card says "Status unknown" instead of guessing they are off. */
export const PolicyUnavailable: Story = {
  name: "Policy unavailable",
  args: { policyReadState: "unavailable" },
};

/** The privacy cards and members table in isolation, with the rest of the
 * screen collapsed. */
export const PrivacySignalsOnly: Story = {
  name: "Privacy signals only",
  args: {
    showMembers: false,
    showOrganization: false,
  },
};
