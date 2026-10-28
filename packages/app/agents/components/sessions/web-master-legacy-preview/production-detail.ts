import type { SessionsPrototypeDetailItem } from "@repo/app/agents/components/sessions/sessions-prototype-preview";
import { type SessionRow, sessionRows } from "./mock";

const PROTOTYPE_NOW_MS = Date.UTC(2026, 7, 26, 12);
const MINUTE_MS = 60_000;

/**
 * The list item behind a Web Master row, which the shared prototype detail
 * projects into the production Session detail, so the list and the detail
 * describe one session.
 */
export function toPrototypeSessionItem(
  row: SessionRow
): SessionsPrototypeDetailItem {
  const minutesAgo = (minutes: number) =>
    new Date(PROTOTYPE_NOW_MS - minutes * MINUTE_MS);
  const startedAt = minutesAgo(row.startedAgoMinutes);
  const lastActivityAt = minutesAgo(row.lastActivityAgoMinutes);
  return {
    autonomy: row.autonomy,
    branch: row.branch,
    cwd: row.workingDir,
    endedAt: new Date(startedAt.getTime() + row.durationMs),
    estimatedCost: row.cost,
    externalSessionId: row.externalSessionId,
    harness: row.harness,
    id: row.id,
    inputTokens: row.inputTokens,
    lastActivityAt,
    model: row.model,
    name: row.name,
    outputTokens: row.outputTokens,
    prs:
      row.prNumber && row.prState
        ? [
            {
              num: row.prNumber,
              status: row.prState,
              title: row.prTitle ?? row.name,
            },
          ]
        : [],
    repositoryFullName: row.repo,
    startedAt,
    status: row.status,
    user: row.user ? toPrototypeUser(row.user.name) : null,
  };
}

/** The row's position, which the shared detail uses for its stable slug. */
export function prototypeSessionIndex(row: SessionRow): number {
  return sessionRows.indexOf(row);
}

function toPrototypeUser(name: string) {
  const [firstName = name, ...rest] = name.split(" ");
  return {
    avatarUrl: null,
    email: `${name.toLowerCase().replaceAll(" ", ".")}@example.com`,
    firstName,
    id: `prototype-user:${name.toLowerCase().replaceAll(" ", "-")}`,
    lastName: rest.join(" "),
  };
}
