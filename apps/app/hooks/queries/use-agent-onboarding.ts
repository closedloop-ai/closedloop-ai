"use client";

import { useAgents } from "@repo/app/agents/hooks/use-agents";
import { useGitHubIntegrationStatus } from "@repo/app/github/hooks/use-github-integration";
import { useLocalStorageState } from "@repo/app/shared/hooks/use-local-storage-state";
import { isAdminRole } from "@repo/app/shared/lib/role-utils";
import { useOrganization } from "@repo/auth/client";
import { useComputeTargets } from "@/hooks/queries/use-compute-targets";

const DISMISS_KEY_PREFIX = "agents:onboarding:dismissed";
const BOOTSTRAP_LOOP_KEY_PREFIX = "agents:bootstrap:activeLoopId";

export type AgentOnboardingState = {
  needsBootstrap: boolean;
  hasElectron: boolean;
  hasGitHub: boolean;
  prereqsMet: boolean;
  isDismissed: boolean;
  isLoading: boolean;
  isAdmin: boolean;
  bootstrapInProgress: boolean;
  shouldShow: boolean;
  dismiss: () => void;
};

export function useAgentOnboarding(): AgentOnboardingState {
  const { membership, organization } = useOrganization();
  const orgId = organization?.id;
  const dismissKey = orgId
    ? `${DISMISS_KEY_PREFIX}:${orgId}`
    : DISMISS_KEY_PREFIX;
  const bootstrapKey = orgId
    ? `${BOOTSTRAP_LOOP_KEY_PREFIX}:${orgId}`
    : BOOTSTRAP_LOOP_KEY_PREFIX;
  const [dismissed, setDismissed] = useLocalStorageState(dismissKey, false);
  const [activeLoopId] = useLocalStorageState<string | null>(
    bootstrapKey,
    null
  );
  const isAdmin = isAdminRole(membership?.role);
  const shouldFetch = !dismissed && isAdmin;
  const bootstrapInProgress = activeLoopId !== null;

  const { data: agentData, isLoading: agentsLoading } = useAgents(
    {},
    { enabled: shouldFetch }
  );
  const { data: githubStatus, isLoading: githubLoading } =
    useGitHubIntegrationStatus({ enabled: shouldFetch });
  const { data: computeTargets, isLoading: computeLoading } = useComputeTargets(
    { enabled: shouldFetch }
  );

  const needsBootstrap = agentData?.total === 0;
  const hasElectron = computeTargets?.some((t) => t.isOnline) ?? false;
  const hasGitHub = githubStatus?.connected ?? false;
  const prereqsMet = hasElectron && hasGitHub;
  const isLoading =
    shouldFetch && (agentsLoading || githubLoading || computeLoading);

  const shouldShow =
    !isLoading && needsBootstrap === true && !dismissed && isAdmin;

  return {
    needsBootstrap: needsBootstrap ?? false,
    hasElectron,
    hasGitHub,
    prereqsMet,
    isDismissed: dismissed,
    isLoading,
    isAdmin,
    bootstrapInProgress,
    shouldShow,
    dismiss: () => setDismissed(true),
  };
}
