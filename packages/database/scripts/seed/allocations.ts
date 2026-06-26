import { LoopCommand, LoopStatus } from "../../generated/client";

export function pickRequired<T>(
  values: readonly T[],
  index: number,
  label: string
): T {
  if (values.length === 0) {
    throw new Error(`${label}: expected at least one value`);
  }
  return values[index % values.length];
}

export function pickOptional<T>(values: readonly T[], index: number): T | null {
  if (values.length === 0) {
    return null;
  }
  return values[index % values.length];
}

export function buildActiveLoopAssignments(
  artifactIds: readonly string[],
  targetCount: number
): Array<{
  artifactId: string | null;
  command: LoopCommand;
  artifactVersion: number | null;
}> {
  const activeStatuses = [
    LoopStatus.PENDING,
    LoopStatus.CLAIMED,
    LoopStatus.RUNNING,
  ] as const;
  const activeCount = Math.min(targetCount, activeStatuses.length);
  const commands = Object.values(LoopCommand);
  const assignments: Array<{
    artifactId: string | null;
    command: LoopCommand;
    artifactVersion: number | null;
  }> = [];

  for (let index = 0; index < activeCount; index++) {
    assignments.push({
      artifactId: pickOptional(artifactIds, index),
      command: commands[index % commands.length],
      artifactVersion: index === 0 ? 1 : index,
    });
  }

  return assignments;
}
