import { Result } from "@repo/api/src/types/result";
import { refuse, type VibeSeedRefusal, VibeSeedRefusalCode } from "./guards";
import type { VibeSeedStage } from "./stage";

/**
 * ISS-12017: narrow the ordered stage list to `--only-stages`, keeping run
 * order. An unknown name is a refusal rather than a silent skip, so a typo in a
 * verification command cannot report a green run that ran nothing.
 */
export function selectStages(
  stages: readonly VibeSeedStage[],
  onlyStages: readonly string[] | undefined
): Result<readonly VibeSeedStage[], VibeSeedRefusal> {
  if (onlyStages === undefined || onlyStages.length === 0) {
    return Result.ok(stages);
  }
  const known = new Set(stages.map((stage) => stage.name));
  const unknown = onlyStages.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    return refuse(
      VibeSeedRefusalCode.UnknownStage,
      `unknown stage(s) ${unknown.join(", ")}; known stages: ${[...known].join(", ")}`
    );
  }
  const wanted = new Set(onlyStages);
  return Result.ok(stages.filter((stage) => wanted.has(stage.name)));
}
