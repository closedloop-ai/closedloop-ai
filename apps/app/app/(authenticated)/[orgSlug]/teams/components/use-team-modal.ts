"use client";

import {
  type UseTeamModalArgs,
  useTeamModal as useSharedTeamModal,
} from "@repo/app/teams/components/use-team-modal";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgSlug } from "@/hooks/use-org-slug";

// biome-ignore lint/performance/noBarrelFile: single-module migration seam preserves existing web import paths after promotion to @repo/app.
export {
  type TeamMemberDraft,
  type TeamModalState,
  TeamModalTab,
  type TeamRepositoryDraft,
  type TeamRepositoryDraftRepo,
} from "@repo/app/teams/components/use-team-modal";

export function useTeamModal(props: Omit<UseTeamModalArgs, "onCreated">) {
  const navigation = useNavigation();
  const orgSlug = useOrgSlug();
  return useSharedTeamModal({
    ...props,
    onCreated: (team) =>
      navigation.navigate(`/${orgSlug}/teams/${team.id}/projects`),
  });
}
