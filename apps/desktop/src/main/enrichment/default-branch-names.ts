import { sqlStringList } from "../database/db-constants.js";

const DEFAULT_BRANCH_NAMES: ReadonlySet<string> = new Set([
  "main",
  "master",
  "develop",
  "HEAD",
]);

export function isDefaultBranchName(name: string): boolean {
  return DEFAULT_BRANCH_NAMES.has(name);
}

export function defaultBranchSqlList(): string {
  return sqlStringList([...DEFAULT_BRANCH_NAMES]);
}
