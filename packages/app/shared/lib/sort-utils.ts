/**
 * Sort repositories by last push activity (most recent first),
 * with nulls pushed to the bottom, then alphabetically by name.
 */
export function sortRepositoriesByActivity<
  T extends { name: string; lastPushedAt: string | null },
>(repositories: T[]): T[] {
  return [...repositories].sort((a, b) => {
    if (a.lastPushedAt && b.lastPushedAt) {
      return (
        new Date(b.lastPushedAt).getTime() - new Date(a.lastPushedAt).getTime()
      );
    }
    if (a.lastPushedAt !== b.lastPushedAt) {
      return a.lastPushedAt ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}
