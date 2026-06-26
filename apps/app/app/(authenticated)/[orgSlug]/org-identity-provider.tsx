"use client";

import {
  useAuth,
  useClerk,
  useOrganization,
  useOrganizationList,
} from "@repo/auth/client";
import { useNavigation } from "@repo/navigation/use-navigation";
import { Loader2Icon } from "lucide-react";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

type OrgIdentityProviderProps = {
  readonly orgSlug: string;
  readonly children: ReactNode;
};

export default function OrgIdentityProvider({
  orgSlug,
  children,
}: OrgIdentityProviderProps) {
  const navigation = useNavigation();
  const { setActive } = useClerk();
  const { orgSlug: activeOrgSlug, isLoaded: authLoaded } = useAuth();
  const { organization: activeOrg, isLoaded: activeOrgLoaded } =
    useOrganization();
  const { userMemberships, isLoaded } = useOrganizationList({
    userMemberships: { infinite: true },
  });
  const [switching, setSwitching] = useState(false);
  const switchFailed = useRef(false);

  const {
    data: membershipData,
    isLoading: membershipsLoading,
    hasNextPage,
    fetchNext,
  } = userMemberships;

  // The session's active org (the JWT `org_slug`) already matches the URL. The
  // server redirect builds in-app links from this same claim, so the user is
  // authorized and on the right org — render without consulting the membership
  // list. That list is paginated (and large for users in many orgs) and is not
  // a reliable "am I on this org" signal: it can omit the active org entirely.
  const onRequestedOrg = authLoaded && activeOrgSlug === orgSlug;

  const allPagesLoaded = isLoaded && !membershipsLoading && !hasNextPage;
  const membership = isLoaded
    ? membershipData?.find((m) => m.organization.slug === orgSlug)
    : undefined;

  // Cross-org navigation only: page through memberships to locate the target.
  useEffect(() => {
    if (
      onRequestedOrg ||
      !isLoaded ||
      membershipsLoading ||
      membership ||
      !hasNextPage
    ) {
      return;
    }
    fetchNext?.();
  }, [
    onRequestedOrg,
    isLoaded,
    membershipsLoading,
    membership,
    hasNextPage,
    fetchNext,
  ]);

  // Switch the active session to the URL's org. Guard on activeOrgLoaded so an
  // unresolved active org isn't read as a mismatch, and on the active org id so
  // a completed switch isn't re-fired before the JWT slug propagates.
  useEffect(() => {
    if (
      onRequestedOrg ||
      switching ||
      switchFailed.current ||
      !(membership && activeOrgLoaded) ||
      membership.organization.id === activeOrg?.id
    ) {
      return;
    }

    setSwitching(true);
    setActive({ organization: membership.organization.id })
      .then(() => {
        navigation.refresh();
      })
      .catch(() => {
        switchFailed.current = true;
      })
      .finally(() => {
        setSwitching(false);
      });
  }, [
    onRequestedOrg,
    switching,
    membership,
    activeOrgLoaded,
    activeOrg?.id,
    setActive,
    navigation,
  ]);

  if (onRequestedOrg) {
    return <>{children}</>;
  }

  if (switchFailed.current) {
    notFound();
  }

  // Once auth has resolved (so this is a genuine cross-org navigation) and every
  // membership page has loaded, a missing target org means the user isn't a
  // member. Gate on authLoaded so a not-yet-known active org isn't a 404.
  if (authLoaded && allPagesLoaded && !membership) {
    notFound();
  }

  return <FullPageSpinner />;
}

function FullPageSpinner() {
  return (
    <div className="flex h-screen items-center justify-center">
      <Loader2Icon className="h-6 w-6 animate-spin" />
    </div>
  );
}
