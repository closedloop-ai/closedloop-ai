"use client";

import {
  BranchCompatibilityOutcome,
  type BranchCompatibilityResolution,
} from "@repo/api/src/types/branch-compatibility";
import {
  BranchDetailLoading,
  BranchDetailNotFound,
} from "@repo/app/branches/components/branch-detail-states";
import { BranchBackLabel } from "@repo/app/branches/lib/branch-back-href";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import { useFeatureFlagGate } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { ELIGIBLE_BRANCH_NAVIGATION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

type BranchCompatibilityRedirectProps = {
  branchArtifactId: string;
  orgSlug: string;
};

/** Resolve the retired Branch View route through one fail-closed API decision. */
export function BranchCompatibilityRedirect({
  branchArtifactId,
  orgSlug,
}: Readonly<BranchCompatibilityRedirectProps>) {
  const apiClient = useApiClient();
  const navigation = useNavigation();
  const searchParams = useSearchParamsValue();
  const rollout = useFeatureFlagGate(
    ELIGIBLE_BRANCH_NAVIGATION_FEATURE_FLAG_KEY
  );
  const query = useQuery({
    queryKey: ["branch-compatibility", orgSlug, branchArtifactId],
    queryFn: () =>
      apiClient.get<BranchCompatibilityResolution>(
        `/branches/${encodeURIComponent(branchArtifactId)}/compatibility`
      ),
    enabled: Boolean(branchArtifactId),
  });
  const redirect = resolveBranchCompatibilityRedirect({
    resolution: query.data,
    requestFailed: query.isError,
    rolloutEnabled: rollout.enabled,
    rolloutReady: rollout.isReady,
    orgSlug,
    search: searchParams.toString(),
  });

  useEffect(() => {
    if (redirect.kind === LegacyBranchRedirectKind.Internal) {
      navigation.replace(redirect.href);
    } else if (redirect.kind === LegacyBranchRedirectKind.External) {
      globalThis.location.replace(redirect.href);
    }
  }, [navigation, redirect.href, redirect.kind]);

  if (
    query.isPending ||
    redirect.kind === LegacyBranchRedirectKind.Pending ||
    redirect.kind === LegacyBranchRedirectKind.Internal ||
    redirect.kind === LegacyBranchRedirectKind.External
  ) {
    return <BranchDetailLoading />;
  }
  return (
    <BranchDetailNotFound
      backHref={`/${orgSlug}/branches`}
      backLabel={BranchBackLabel.Branches}
    />
  );
}

export const LegacyBranchRedirectKind = {
  External: "external",
  Internal: "internal",
  Pending: "pending",
  Unavailable: "unavailable",
} as const;
export type LegacyBranchRedirectKind =
  (typeof LegacyBranchRedirectKind)[keyof typeof LegacyBranchRedirectKind];

type LegacyBranchRedirect =
  | { kind: typeof LegacyBranchRedirectKind.External; href: string }
  | { kind: typeof LegacyBranchRedirectKind.Internal; href: string }
  | { kind: typeof LegacyBranchRedirectKind.Pending; href?: undefined }
  | { kind: typeof LegacyBranchRedirectKind.Unavailable; href?: undefined };

export function resolveBranchCompatibilityRedirect(input: {
  resolution?: BranchCompatibilityResolution;
  requestFailed?: boolean;
  rolloutEnabled: boolean;
  rolloutReady: boolean;
  orgSlug: string;
  search: string;
}): LegacyBranchRedirect {
  if (input.requestFailed) {
    return { kind: LegacyBranchRedirectKind.Unavailable };
  }
  if (!(input.resolution && input.rolloutReady)) {
    return { kind: LegacyBranchRedirectKind.Pending };
  }
  if (input.resolution.outcome !== BranchCompatibilityOutcome.Eligible) {
    return { kind: LegacyBranchRedirectKind.Unavailable };
  }
  if (!input.rolloutEnabled) {
    return input.resolution.providerUrl
      ? {
          kind: LegacyBranchRedirectKind.External,
          href: input.resolution.providerUrl,
        }
      : { kind: LegacyBranchRedirectKind.Unavailable };
  }
  const query = input.search ? `?${input.search}` : "";
  return {
    kind: LegacyBranchRedirectKind.Internal,
    href: `/${encodeURIComponent(input.orgSlug)}/branches/${encodeURIComponent(
      input.resolution.branchArtifactId
    )}${query}`,
  };
}
