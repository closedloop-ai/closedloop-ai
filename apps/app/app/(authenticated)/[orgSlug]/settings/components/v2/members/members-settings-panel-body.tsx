"use client";

import { OrganizationMembersSource } from "@repo/api/src/types/organization-members";
import {
  useOrganizationMembers,
  useOrganizationMembersSource,
} from "@repo/app/organizations/hooks/use-organizations";
import { SettingsPanelLoading } from "@repo/app/settings/v2/components/settings-panel-boundary";
import type { SettingsPanelProps } from "@repo/app/settings/v2/lib/settings-panel-registry";
import { hasLocalTrustedDisplayOverrides } from "@repo/auth/auth-mode";
import {
  OrganizationProfile,
  useAuth,
  useOrganization,
} from "@repo/auth/client";
import { embeddedOrganizationProfileAppearance } from "@repo/auth/components/appearance";
import { useLocalTrustedIdentity } from "@repo/auth/local-trusted-client";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { BuildingIcon } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { ThirdPartyHeadingScope } from "@/components/third-party-heading-scope";
import {
  isClerkEmbedRouterFragment,
  resolveMembersEmbedStartHash,
} from "./members-embed-start-view";
import { SeededMembersRoster } from "./seeded-members-roster";

/**
 * @file members-settings-panel-body.tsx
 * @description The Settings v2 Members panel body (ISS-8368). Clerk's
 * `<OrganizationProfile>` is the authority for the roster, pending
 * invitations, resend/revoke, role changes and member removal, so this file
 * mounts that embed rather than reimplementing any of it — and adds no
 * repo-owned membership backend.
 *
 * The shell only mounts this body once resolution says `ready`, so the states
 * owned HERE are the ones below that line: Clerk's organization read still in
 * flight, and that read completing with no active organization. Neither may
 * render as an empty roster — "nobody is in this workspace" is a claim, and a
 * read that has not finished has not earned it. `unavailable` (desktop) and
 * `forbidden` are resolved above this body and never reach it, which is what
 * keeps all four distinct.
 *
 * Clerk's role check gates its own destructive controls, so a plain member
 * sees the roster without them; that is why the descriptor asks only for
 * `read`.
 */

function MembersNoOrganization() {
  return (
    <div data-members-panel-state="no-organization">
      <EmptyState
        description="Switch to a workspace to manage its members and invitations."
        icon={BuildingIcon}
        title="No workspace selected"
        titleAs="h2"
      />
    </div>
  );
}

export function MembersSettingsPanelBody({
  intent,
}: Readonly<SettingsPanelProps>) {
  const { isLoaded, organization } = useOrganization();
  const { userId } = useAuth();
  const localTrustedIdentity = useLocalTrustedIdentity();
  // ISS-12135: a `pnpm vibe up` stack has no Clerk, so its seeded roster
  // always comes from the API. On a seeded Vercel vibe preview the embed would
  // list the bound Clerk organization's real members, so the API says where
  // the roster comes from on a one-row page: `seeded` lists the seeded people
  // read-only; `clerk`, or no `source` (an API from before the field), keeps
  // the embed. Only `seeded` reads the whole roster. A failed read is the
  // panel's error state, never the embed. Every other local-trusted lane keeps
  // the Clerk-free answers below and makes no read.
  const vibeIdentity =
    localTrustedIdentity &&
    hasLocalTrustedDisplayOverrides(localTrustedIdentity)
      ? localTrustedIdentity
      : null;
  // Asked only once Clerk reports an active organization: with none, the read
  // has no org to answer for and the panel shows its no-organization state.
  const readsSource =
    localTrustedIdentity === null && isLoaded && Boolean(organization);
  const source = useOrganizationMembersSource({ enabled: readsSource });
  const sourcePending = readsSource && source.isPending;
  const showsSeededRoster =
    vibeIdentity !== null || source.data === OrganizationMembersSource.Seeded;
  const roster = useOrganizationMembers({ enabled: showsSeededRoster });
  const rosterPending = showsSeededRoster && roster.isPending;
  const readError = source.error ?? roster.error;
  const embedOrganization =
    showsSeededRoster || sourcePending ? null : organization;

  // Seeds the embed's opening view. `routing="hash"` means the fragment IS the
  // embed's router input, and an unseeded fragment opens Clerk's index route
  // (Organization General) rather than members. Only the fragment is written:
  // the shell's `?panel=members&intent=…` live in the query string, and a
  // router navigation would rewrite the URL that carries them.
  //
  // ORDERING, checked against the installed @clerk/ui 1.6.5 rather than assumed
  // (marisolashgrove, #6719): this effect runs AFTER any child effect, so the
  // question is what the embed does to the fragment before it. The answer is
  // nothing. `HashRouter.getPath()` is a pure read whose `fakeUrl()` falls back
  // to `new URL(origin)` on a fragment holding no URL, and its only write is
  // `internalNavigate`, on a real navigation; `BaseRouter` seeds `useState`
  // from that read and navigates only through `baseNavigate`. Neither writes
  // `#/…` at init, so the `#/` self-suppression below cannot misfire on mount
  // and strand the panel on Organization General. `OrganizationProfile` also
  // renders its host renderer only behind `clerk.loaded`, so on a cold mount
  // Clerk's router does not exist yet when this runs.
  //
  // `replaceState`, NOT `window.location.hash = …`, which PUSHES a session
  // history entry. With that entry on the stack one Back empties the fragment
  // while the panel is still mounted, Clerk's `HashRouter` re-reads it, finds
  // no route and falls to its index — Organization General inside a Members
  // panel — and nothing here listens for `popstate` to recover it. The cleanup
  // below already used `replaceState`; both halves of the fragment's life now
  // use the same verb. What the assignment was really being used for is the
  // `hashchange` it fires natively, so that is dispatched explicitly. Clerk
  // 1.6.5 registers `hashchange` directly on `window` in BOTH branches of its
  // history observer — it is the one `HASH_REFRESH_EVENTS` entry with no
  // Navigation-API mapping — so the embed re-reads on it either way, without
  // relying on Clerk's `replaceState` monkey-patch.
  useEffect(() => {
    if (!(isLoaded && embedOrganization)) {
      return;
    }
    const nextHash = resolveMembersEmbedStartHash(window.location.hash, intent);
    if (nextHash === null) {
      return;
    }
    const oldURL = window.location.href;
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${nextHash}`
    );
    window.dispatchEvent(
      new HashChangeEvent("hashchange", {
        newURL: window.location.href,
        oldURL,
      })
    );
  }, [intent, isLoaded, embedOrganization]);

  // The fragment outlives this panel, so the panel clears its own. Dismissing
  // the shell in `Overlay` mode performs no navigation, and the embed rewrites
  // the fragment as the user moves through it, so an uncleared `#/…` is what the
  // NEXT mount reads — and the seed above suppresses itself for exactly that
  // shape, opening Members on whatever view the user last clicked. Deps are `[]`
  // deliberately: this must run when the panel goes away and NEVER on a dep
  // change, or a re-identified `organization` would clear the fragment
  // mid-session and let the seed drag the user back off Billing.
  useEffect(
    () => () => {
      if (!isClerkEmbedRouterFragment(window.location.hash)) {
        return;
      }
      // `replaceState`, so closing the panel does not leave behind a history
      // entry the user has to press Back through.
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`
      );
    },
    []
  );

  if (readError) {
    throw readError;
  }
  if (sourcePending || rosterPending || !(showsSeededRoster || isLoaded)) {
    return <SettingsPanelLoading />;
  }
  if (showsSeededRoster && roster.data) {
    return (
      <MembersSection>
        <SeededMembersRoster
          currentUserId={vibeIdentity ? vibeIdentity.userId : (userId ?? "")}
          labelledBy={MEMBERS_HEADING_ID}
          members={roster.data}
        />
      </MembersSection>
    );
  }
  if (!organization) {
    return <MembersNoOrganization />;
  }

  return (
    <MembersSection>
      <ThirdPartyHeadingScope level={3}>
        <OrganizationProfile
          appearance={embeddedOrganizationProfileAppearance}
          routing="hash"
        />
      </ThirdPartyHeadingScope>
    </MembersSection>
  );
}

function MembersSection({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <section aria-labelledby={MEMBERS_HEADING_ID}>
      <div className="mb-4">
        <h2
          className="font-semibold text-lg tracking-tight"
          id={MEMBERS_HEADING_ID}
        >
          Members
        </h2>
        <p className="mt-1 text-muted-foreground text-sm">
          People in this workspace, the invitations you have sent, and the roles
          they hold.
        </p>
      </div>

      {children}
    </section>
  );
}

const MEMBERS_HEADING_ID = "settings-members-heading";
