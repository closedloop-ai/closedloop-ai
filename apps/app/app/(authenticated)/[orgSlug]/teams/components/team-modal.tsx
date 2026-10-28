"use client";

import {
  TeamModal as SharedTeamModal,
  type TeamModalProps,
} from "@repo/app/teams/components/team-modal";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useOrgSlug } from "@/hooks/use-org-slug";

export function TeamModal(props: Omit<TeamModalProps, "onCreated">) {
  const navigation = useNavigation();
  const orgSlug = useOrgSlug();
  return (
    <SharedTeamModal
      {...props}
      onCreated={(team) =>
        navigation.navigate(`/${orgSlug}/teams/${team.id}/projects`)
      }
    />
  );
}
