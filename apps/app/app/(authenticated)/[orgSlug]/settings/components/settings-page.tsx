"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import { APPROVER_ROLE_OPTIONS, ApproverRole } from "@repo/api/src/types/user";
import { AgentComplianceSettingsTab } from "@repo/app/agents/components/agent-compliance-settings-tab";
import { CustomFieldsSettingsTab } from "@repo/app/custom-fields/components/custom-fields-settings-tab";
import { githubKeys } from "@repo/app/github/hooks/use-github-integration";
import {
  FeatureFlagPending,
  useFeatureFlagSettleDeadline,
} from "@repo/app/shared/components/feature-flag-pending";
import { UserLink } from "@repo/app/shared/components/user-link";
import { TagsSettingsTab } from "@repo/app/tags/components/tags-settings-tab";
import {
  useOrganizationUsers,
  useUpdateUser,
} from "@repo/app/users/hooks/use-users";
import { OrganizationProfile, Show, UserProfile } from "@repo/auth/client";
import {
  embeddedOrganizationProfileAppearance,
  embeddedProfileAppearance,
} from "@repo/auth/components/appearance";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Separator } from "@repo/design-system/components/ui/separator";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { toast } from "@repo/design-system/components/ui/sonner";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@repo/design-system/components/ui/tabs";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useQueryClient } from "@tanstack/react-query";
import { TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useFeatureFlagsSettledForUser } from "@/components/feature-flags-settled";
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TAB_PARAM,
  SettingsTab,
} from "../settings-tabs";
import { AnthropicApiKeyCard } from "./anthropic-api-key-card";
import { ApiKeysSettingsPanel } from "./api-keys-settings-panel";
import { CloudComputeModeCard } from "./cloud-compute-mode-card";
import { GitHubIntegrationCard } from "./github-integration-card";
import { GoogleIntegrationCard } from "./google-integration-card";
import { LinearIntegrationCard } from "./linear-integration-card";
import { LocalComputeTargetsCard } from "./local-compute-targets-card";
import { OrganizationSlugSettings } from "./organization-slug-settings";
import { SessionFrustrationCard } from "./session-frustration-card";
import { SessionSyncPolicyCard } from "./session-sync-policy-card";
import { TranscriptSearchCard } from "./transcript-search-card";

export type SettingsPageProperties = {
  initialTab: string;
  isAdmin: boolean;
};

export function SettingsPage({
  initialTab,
  isAdmin,
}: Readonly<SettingsPageProperties>) {
  const searchParams = useSearchParamsValue();
  const queryClient = useQueryClient();
  // The Tags trigger and content only render on `enabled === true`
  // (`<FeatureFlagged>`), so an unresolved flag looks exactly like a disabled
  // one, and `?tab=tags` is server-allowlisted regardless because the flag is
  // unknown server-side. All three flag states are therefore this component's
  // problem, and each gets a different answer below.
  const tagsFlagEnabled = useFeatureFlag("artifact-tags")?.enabled;

  // `Tabs` is CONTROLLED, so the URL, the user's click, and a late-resolving
  // flag all move one piece of state. The uncontrolled `defaultValue` plus
  // remount `key` this replaced could not: a key collapses distinct requests
  // that happen to resolve alike (`?tab=tags`-while-unavailable and
  // `?tab=profile`), so a soft navigation between them never remounted and the
  // URL ended up disagreeing with the screen.
  const [selectedTab, setSelectedTab] = useState(initialTab);
  const [requestedTab, setRequestedTab] = useState(initialTab);
  // The URL wins whenever it changes, and only then. ISS-5011 (wongk, PR
  // #4501): the `/organization` forward is a params-only soft navigation that
  // re-renders this component in place rather than remounting it. A click or a
  // flag resolution leaves `initialTab` alone, so neither disturbs the user's
  // own selection. Render-time state adjustment, not an Effect that resets
  // state from a prop (apps/app/AGENTS.md, "Rendering and Navigation").
  if (requestedTab !== initialTab) {
    setRequestedTab(initialTab);
    setSelectedTab(initialTab);
  }

  // Resolved OFF is a decision, so bounce off Tags at once and silently, which
  // is what the tab strip already says by hiding the trigger. Still unresolved
  // is not a decision: falling back here would render a genuine flag-ON user a
  // full Profile and then snap them to Tags, so that state stays on Tags and
  // shows a pending panel instead (ISS-4566).
  //
  // A `false` is only a DECISION once PostHog is answering for the signed-in
  // user. `<AnalyticsProvider bootstrapFeatureFlags>` resolves flags against the
  // ANONYMOUS distinct id first, so the common shape of "not answered yet" is a
  // `false`, not an `undefined` — and this bounce is one-way. Treating that
  // pre-`identify()` `false` as resolved would move the selection off Tags,
  // rewrite the query to `?tab=profile` below, and leave a user who genuinely
  // HAS the flag with no route back to the tab they deep-linked, not even by
  // reloading. So the bounce waits on the same identify handshake the route gate
  // withholds its `notFound()` for.
  //
  // The wait is NOT bounded here, and deliberately: a deadline is a timeout, not
  // a decision, and this bounce is the one irreversible action on the page — it
  // rewrites the address bar and the history entry below, so a slow handshake
  // would cost a flag-ON user the tab AND the link back to it. `FeatureFlagRoute
  // Gate` takes the same position at the same deadline for the same reason,
  // rendering its failed-read surface instead of the one-way `notFound()`
  // "because the flag may be ON for this user". Nothing is held open by this:
  // `TagsFlagPending` below runs its OWN bounded wait and commits
  // `TagsFlagUnavailable` inside the panel, which states the failure honestly,
  // keeps the user in Settings, and leaves the deep link intact so a reload can
  // still resolve it.
  //
  // The bounce MOVES the selection rather than deriving a different tab to
  // render from it. A derived `activeTab` leaves `selectedTab` on `tags`
  // forever: Radix's controlled `useControllableState` only fires
  // `onValueChange` when the next value DIFFERS from the `value` prop, so
  // clicking the already-rendered Profile trigger cannot clear it either. The
  // stale selection then wins the moment the flag reloads ON — the screen jumps
  // from Profile to Tags with no user action, which is the exact snap this
  // fallback exists to prevent. Render-time state adjustment, the same pattern
  // as the `requestedTab` reconciliation above.
  const flagsSettledForUser = useFeatureFlagsSettledForUser();
  const tagsFlagDisabled = tagsFlagEnabled === false && flagsSettledForUser;
  if (selectedTab === SettingsTab.Tags && tagsFlagDisabled) {
    setSelectedTab(DEFAULT_SETTINGS_TAB);
  }
  const tagsSelected = selectedTab === SettingsTab.Tags;

  // A bounced `?tab=tags` leaves the query naming a tab the user is not on, so
  // the address bar, any bookmark, and any share of that link all describe the
  // wrong screen. Rewrite it to the tab actually rendered, with the same
  // `replaceState` mechanism the OAuth-callback effect below uses to drop its
  // consumed params. Scoped to the stale window: once the query agrees with the
  // screen the condition is false and nothing is written.
  const urlTab = searchParams.get(SETTINGS_TAB_PARAM);
  const tagsQueryIsStale =
    tagsFlagDisabled &&
    urlTab === SettingsTab.Tags &&
    selectedTab !== SettingsTab.Tags;
  useEffect(() => {
    if (!tagsQueryIsStale) {
      return;
    }
    const url = new URL(globalThis.location.href);
    url.searchParams.set(SETTINGS_TAB_PARAM, selectedTab);
    globalThis.history.replaceState(
      {},
      "",
      `${url.pathname}${url.search}${url.hash}`
    );
  }, [tagsQueryIsStale, selectedTab]);

  useEffect(() => {
    const githubStatus = searchParams.get("github");
    const errorCode = searchParams.get("code");
    const googleStatus = searchParams.get("google");

    // `requires_confirmation` is the PLN-634 different-account reconnect
    // state. The GitHubIntegrationCard reads the same query params to render
    // its confirmation dialog, so we must NOT toast, invalidate, or strip the
    // URL — those would tear the dialog down before the admin can respond.
    const isTerminalGithubStatus =
      githubStatus === "connected" || githubStatus === "error";

    if (githubStatus === "connected") {
      toast.success("GitHub connected successfully");
    } else if (githubStatus === "error" && errorCode) {
      const message = GITHUB_ERROR_MESSAGES[errorCode] ?? "An error occurred.";
      toast.error(message);
    }
    if (isTerminalGithubStatus) {
      queryClient.invalidateQueries({ queryKey: githubKeys.all });
    }

    if (googleStatus === "success") {
      toast.success("Google Drive connected successfully");
    } else if (googleStatus === "error") {
      toast.error("Failed to connect Google Drive");
    }

    if (isTerminalGithubStatus || googleStatus) {
      globalThis.history.replaceState({}, "", globalThis.location.pathname);
    }
  }, [queryClient, searchParams]);

  useScrollToDeepLinkedCard();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-auto p-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Manage your account settings and preferences.
        </p>
      </div>

      <Separator />

      <Tabs
        className="flex-1"
        onValueChange={setSelectedTab}
        value={selectedTab}
      >
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger
            className="flex-initial px-4"
            value={SettingsTab.Profile}
          >
            Profile
          </TabsTrigger>
          <TabsTrigger
            className="flex-initial px-4"
            value={SettingsTab.Organization}
          >
            Organization
          </TabsTrigger>
          {isAdmin ? (
            <TabsTrigger
              className="flex-initial px-4"
              value={SettingsTab.CustomFields}
            >
              Custom Fields
            </TabsTrigger>
          ) : null}
          {isAdmin ? (
            <TabsTrigger
              className="flex-initial px-4"
              value={SettingsTab.Compliance}
            >
              Compliance
            </TabsTrigger>
          ) : null}
          {/* Unresolved is not "off", and the strip has to say so too. While
              the panel holds on Tags, a hidden trigger leaves NO tab reading as
              selected and makes the open panel a `tabpanel` whose
              `aria-labelledby` points at an element that does not exist — and
              while the identify handshake is unresolved that is the end state,
              not a flicker.
              A selection is therefore answered here rather than by the flag
              gate's fallback: `<FeatureFlagged>` renders NEITHER branch until
              its own mount effect runs, so routing the selected case through it
              drops the trigger for the first painted frame of every `?tab=tags`
              load — the dangling `tabpanel` again, on the flag-ON path too. A
              resolved-off flag has already moved the selection away, so the
              gated tab still stays unadvertised to everyone else. */}
          {tagsSelected ? (
            TAGS_TAB_TRIGGER
          ) : (
            <FeatureFlagged flag="artifact-tags">
              {TAGS_TAB_TRIGGER}
            </FeatureFlagged>
          )}
          <TabsTrigger
            className="flex-initial px-4"
            value={SettingsTab.Integrations}
          >
            Compute & Integrations
          </TabsTrigger>
          <TabsTrigger
            className="flex-initial px-4"
            value={SettingsTab.ApiKeys}
          >
            API Keys
          </TabsTrigger>
        </TabsList>

        <TabsContent className="mt-3 space-y-6" value={SettingsTab.Profile}>
          <Card>
            <CardContent>
              <UserProfile
                appearance={embeddedProfileAppearance}
                routing="hash"
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent
          className="mt-3 space-y-6"
          value={SettingsTab.Organization}
        >
          <Card>
            <CardContent>
              <OrganizationProfile
                appearance={embeddedOrganizationProfileAppearance}
                routing="hash"
              />
            </CardContent>
          </Card>
          <OrganizationSlugSettings isAdmin={isAdmin} />
          <TranscriptSearchCard isAdmin={isAdmin} />
          <SessionSyncPolicyCard isAdmin={isAdmin} />
          <SessionFrustrationCard isAdmin={isAdmin} />
          {isAdmin && SHOW_CLOSEDLOOP_ROLES && <ClosedloopRolesSection />}
        </TabsContent>

        <AdminOnlyTabContent value={SettingsTab.CustomFields}>
          <CustomFieldsSettingsTab />
        </AdminOnlyTabContent>

        <AdminOnlyTabContent value={SettingsTab.Compliance}>
          <AgentComplianceSettingsTab />
        </AdminOnlyTabContent>

        <TabsContent className="mt-3 space-y-6" value={SettingsTab.Tags}>
          {/* Only reachable while the flag is enabled or still unresolved,
              because a resolved-off flag moves the selection off Tags. The
              fallback here is therefore the unresolved window, not a decision. */}
          <FeatureFlagged fallback={<TagsFlagPending />} flag="artifact-tags">
            <TagsSettingsTab />
          </FeatureFlagged>
        </TabsContent>

        <TabsContent
          className="mt-3 space-y-6"
          value={SettingsTab.Integrations}
        >
          <FeatureFlagged flag="the-one-flag">
            <CloudComputeModeCard />
          </FeatureFlagged>
          <LocalComputeTargetsCard />
          <AnthropicApiKeyCard isAdmin={isAdmin} />
          <GitHubIntegrationCard />
          <FeatureFlagged flag="google-drive">
            <GoogleIntegrationCard />
          </FeatureFlagged>
          <LinearIntegrationCard />
        </TabsContent>

        <TabsContent className="mt-3 space-y-6" value={SettingsTab.ApiKeys}>
          <ApiKeysSettingsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * A `TabsContent` panel whose body is gated to org admins/owners.
 *
 * The tab *trigger* is already admin-gated in the tab strip and a member who
 * deep-links `?tab=<admin-tab>` is bounced to Profile by the server page, so
 * this fallback is a defense-in-depth backstop rather than an expected state —
 * hence the plain, non-shouty copy. Extracted so the CustomFields and
 * Compliance panels (and any future admin-only tab) share one gate instead of
 * duplicating the `Show` + fallback block.
 */
function AdminOnlyTabContent({
  value,
  children,
}: Readonly<{ value: SettingsTab; children: ReactNode }>) {
  return (
    <TabsContent className="mt-3 space-y-6" value={value}>
      <Show
        fallback={
          <Card>
            <CardHeader>
              <CardTitle>Admins only</CardTitle>
              <CardDescription>
                You need an organization admin or owner role to view this
                section.
              </CardDescription>
            </CardHeader>
          </Card>
        }
        when={(
          has: (params: { role: string } | { permission: string }) => boolean
        ) => has({ role: "org:admin" }) || has({ role: "org:owner" })}
      >
        {children}
      </Show>
    </TabsContent>
  );
}

/**
 * Error code to user-friendly message mapping for GitHub.
 * Must match GITHUB_ERROR_CODES from github-utils.ts
 */
const GITHUB_ERROR_MESSAGES: Record<string, string> = {
  not_authenticated: "Please sign in to connect GitHub.",
  not_configured: "GitHub integration is not configured.",
  missing_params: "Invalid authorization request. Please try again.",
  invalid_state: "Security validation failed. Please try again.",
  invalid_request: "Invalid authorization request. Please try again.",
  connection_failed: "Failed to connect to GitHub. Please try again.",
  oauth_failed: "Authorization failed. Please try again.",
  token_exchange_failed: "Token exchange failed. Please try again.",
};

// Toggle to show Closedloop Roles section in the Organization tab.
// Hidden until the roles feature is further defined.
const SHOW_CLOSEDLOOP_ROLES = false;

const ROLE_LABELS: Record<ApproverRole, string> = {
  [ApproverRole.Pm]: "PM",
  [ApproverRole.Designer]: "Designer",
  [ApproverRole.TechLead]: "Tech Lead",
  [ApproverRole.Engineer]: "Engineer",
  [ApproverRole.Stakeholder]: "Stakeholder",
};

function ClosedloopRolesSection() {
  const { data: users = [] } = useOrganizationUsers();
  const updateUser = useUpdateUser();

  if (users.length === 0) {
    return null;
  }

  return (
    <>
      <Separator />
      <div>
        <h2 className="font-semibold text-lg tracking-tight">
          Closedloop Roles
        </h2>
        <p className="text-muted-foreground text-sm">
          Set the Closedloop role for each member. Engineers will see the
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
                  <AvatarImage alt={name} src={user.avatarUrl ?? undefined} />
                  <AvatarFallback className="text-xs">
                    {(
                      user.firstName?.[0] ??
                      user.email[0] ??
                      "?"
                    ).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <UserLink
                    className="truncate font-medium text-sm hover:underline"
                    userId={user.id}
                  >
                    {name || user.email}
                  </UserLink>
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
                          `Updated ${name || user.email} to ${ROLE_LABELS[value as ApproverRole] ?? value}`
                        );
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
  );
}

/**
 * Scrolls a card-anchored deep link into view once, after the tab content has
 * actually rendered.
 *
 * A cold load of `?tab=integrations#anthropic-api-key` cannot rely on the
 * browser's own fragment scroll: the browser looks for the element before
 * React has rendered the tab, finds nothing, and gives up silently — leaving
 * the arriving user at the top of a six-card stack. Running after mount is the
 * point of the Effect. In-app navigation to the same fragment is already
 * handled by the App Router, which scrolls on push.
 *
 * Deliberately mount-only: re-running would yank a user who has since scrolled
 * away back to the anchor.
 */
function useScrollToDeepLinkedCard(): void {
  useEffect(() => {
    const anchorId = globalThis.location.hash.slice(1);
    if (!anchorId) {
      return;
    }
    const target = globalThis.document.getElementById(anchorId);
    if (!target) {
      return;
    }
    target.scrollIntoView({ block: "start" });
    // Keyboard and screen-reader users follow the same link, so move focus
    // with the viewport instead of only moving the pixels.
    target.focus({ preventScroll: true });
  }, []);
}

/**
 * The `?tab=tags` window where `artifact-tags` has not answered yet.
 *
 * Bounded on purpose. A skeleton that waits forever is the same dead end as the
 * blank panel it replaced, and a flag that never resolves at all (posthog-js
 * blocked by an extension or a corporate proxy, `/flags` failing) is exactly the
 * ISS-4566 report. Past the settle deadline this is a failed read, so it says
 * so rather than quietly claiming the tab is off. It fails closed either way:
 * `TagsSettingsTab` is never rendered from here.
 *
 * The deadline is armed HERE, by the component that renders the wait, so it is
 * measured from the moment the pending state starts. Armed unconditionally by
 * `SettingsPage` instead it latched true ten seconds after the page mounted and
 * stayed true, so a pending window that opened later — the mid-session
 * `identify()` flag reload this panel exists for — skipped the wait entirely and
 * hit the failure surface on its first unresolved render. It also cost every
 * Settings visit a timer and a full re-render of the page tree, Clerk widgets
 * included, for a value only this component reads.
 *
 * This is the ONLY deadline on the page, and that is the whole reason it can be
 * one: everything it commits to stays inside this panel. `SettingsPage`'s bounce
 * off Tags rewrites the address bar and the history entry, so it waits on the
 * identify handshake and on nothing else — a timeout cannot decide a flag.
 *
 * The bars are decorative; the live region and its announcement are
 * {@link FeatureFlagPending}, shared with the route gate's pending region.
 */
function TagsFlagPending() {
  const settleDeadlineElapsed = useFeatureFlagSettleDeadline();

  if (settleDeadlineElapsed) {
    return <TagsFlagUnavailable />;
  }

  return (
    <FeatureFlagPending label={TAGS_PENDING_LABEL}>
      <Skeleton className="h-9 w-64" />
      <Skeleton className="h-64 w-full" />
    </FeatureFlagPending>
  );
}

/**
 * What one Settings TAB shows when its flag read never landed.
 *
 * Deliberately not `FeatureFlagUnavailable`, which is the whole-ROUTE surface
 * `FeatureFlagRouteGate` swaps in for a page it is replacing entirely. Nested in
 * a `TabsContent`, under a Settings header and a tab strip that both plainly
 * rendered, its "Couldn't load this page" reads as a lie about a page the user
 * can see working, its "Back to dashboard" walks them out of Settings over a
 * failure that costs them one tab, and its `h-full` has no definite height to
 * resolve against on a flex child. So this states the real scope, keeps the user
 * where they are, and offers the one recovery that can actually change the
 * answer — a reload re-initializes posthog-js and re-runs the bounded wait.
 *
 * `role="alert"`, for the same reason the route-gate surface uses it: this
 * replaces a `role="status"` loading region, so without it a screen-reader user
 * is never told the wait ended.
 */
function TagsFlagUnavailable() {
  return (
    <div role="alert">
      <EmptyState
        action={
          <Button
            onClick={() => {
              globalThis.location.reload();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Try again
          </Button>
        }
        description="We couldn't check whether Tags is available for your organization. Your other settings are unaffected."
        icon={TriangleAlertIcon}
        size="compact"
        title="Couldn't load Tags"
      />
    </div>
  );
}

/**
 * Accessible name of the Tags pending region. Exported so tests assert against
 * the string the page actually renders instead of respelling it.
 */
export const TAGS_PENDING_LABEL = "Loading Tags";

/**
 * The Tags trigger, as one element used by both branches of its flag gate.
 *
 * `TabsTrigger` reads its selected state from the `Tabs` context, so the same
 * element is correct whether the flag resolved ON or is still unresolved with
 * the panel holding on Tags — and defining it once keeps the two branches from
 * drifting in label or styling.
 */
const TAGS_TAB_TRIGGER = (
  <TabsTrigger className="flex-initial px-4" value={SettingsTab.Tags}>
    Tags
  </TabsTrigger>
);
