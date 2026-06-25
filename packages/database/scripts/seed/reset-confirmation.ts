import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { createInterface } from "node:readline/promises";
import { SeedResetFailureReason } from "./reset";

type TtyLike = {
  isTTY?: boolean;
};

export type ResetConfirmationOptions = {
  force: boolean;
  organizationId: string;
  userId: string;
  targetSource: string;
  profile: string;
  totalRows: number;
  input?: TtyLike;
  output?: TtyLike;
  question?: (prompt: string) => Promise<string>;
  log?: (message: string) => void;
};

export async function confirmResetIfNeeded({
  force,
  organizationId,
  userId,
  targetSource,
  profile,
  totalRows,
  input = defaultInput,
  output = defaultOutput,
  question,
  log = console.log,
}: ResetConfirmationOptions): Promise<void> {
  if (force) {
    return;
  }
  if (!(input.isTTY && output.isTTY)) {
    throw new Error(
      `${SeedResetFailureReason.ResetConfirmationRequired}: non-interactive reset requires --force.`
    );
  }
  log("[seed] Reset requested for:");
  log(`[seed]   organizationId=${organizationId}`);
  log(`[seed]   userId=${userId}`);
  log(`[seed]   targetSource=${targetSource}`);
  log(`[seed]   profile=${profile}`);
  log(`[seed]   resettableRows=${totalRows}`);
  log("[seed] Credential/runtime fields will be cleared.");

  const answer = question
    ? await question("[seed] Type the organization UUID to confirm reset: ")
    : await askOnProcessStdio(
        "[seed] Type the organization UUID to confirm reset: "
      );
  if (answer.trim().toLowerCase() !== organizationId.toLowerCase()) {
    throw new Error(
      `${SeedResetFailureReason.ResetCancelled}: reset confirmation did not match the organization UUID.`
    );
  }
}

async function askOnProcessStdio(prompt: string): Promise<string> {
  const readline = createInterface({
    input: defaultInput,
    output: defaultOutput,
  });
  try {
    return await readline.question(prompt);
  } finally {
    readline.close();
  }
}
