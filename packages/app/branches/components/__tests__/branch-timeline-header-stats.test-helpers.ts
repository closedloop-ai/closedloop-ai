const COST_STAT_RE = /\scost$/;

/**
 * ISS-12665: the Branch PR timeline header's headline cost stat. The header's
 * peak-column fact can print the same figure (a one-hour fixture's only column
 * IS its total), so the headline is located by its own unit word rather than by
 * its figure or its position among the stats.
 */
export function costStat(): HTMLElement {
  const stat = [
    ...document.querySelectorAll<HTMLElement>(".bq-stats > .bq-stat"),
  ].find((node) => COST_STAT_RE.test(node.textContent?.trim() ?? ""));
  if (!stat) {
    throw new Error("timeline header rendered no cost stat");
  }
  return stat;
}
