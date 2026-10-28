/**
 * The date-range filter's accessible name, in a JSX-free module.
 *
 * Split out of `date-range-filter.tsx` so a consumer compiled without `--jsx`
 * can import it. `apps/desktop/test/e2e/helpers/shell-route-matrix.ts` is the
 * one that forced it: the desktop NODE lane's `shell-route-matrix-coverage`
 * suite imports that helper, and its tsconfig sets no `jsx`, so reaching
 * through the component module is a compile error. The component re-exports
 * this so existing importers are unchanged.
 */
export const DATE_RANGE_FILTER_ARIA_LABEL = "Date range";
