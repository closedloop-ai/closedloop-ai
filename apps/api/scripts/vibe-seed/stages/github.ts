import { replayAcmeBranches } from "../github/acme-branches";
import { replayGoldenBranches } from "../github/branch-replay";
import { linkGoldenSessionsToBranches } from "../github/session-links";
import { linkTeamRepositories } from "../github/team-repositories";
import type { VibeSeedStage } from "../stage";

export const STAGES: readonly VibeSeedStage[] = [
  {
    name: "github-session-links",
    models: ["PublicRepository", "GitHubObservedRepository"],
    run: linkGoldenSessionsToBranches,
  },
  {
    name: "github-branch-evidence",
    models: [
      "BranchPushContribution",
      "CommitDetail",
      "BranchFileChange",
      "BranchStatusCheck",
      "BranchActivityAtom",
      "GitHubCommentThreadProjection",
      "GitHubCommentProjection",
      "ExternalCommentAuthor",
    ],
    run: replayGoldenBranches,
  },
  {
    name: "acme-branches",
    models: [],
    run: replayAcmeBranches,
  },
  {
    name: "team-repositories",
    models: ["TeamRepository"],
    run: linkTeamRepositories,
  },
];
