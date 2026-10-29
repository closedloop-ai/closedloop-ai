export function writeDesktopSessionsPage({
  effectivePageSize,
  pageIndex,
  params,
  writePageWithPageSize,
}: {
  effectivePageSize: number;
  pageIndex: number;
  params: URLSearchParams;
  writePageWithPageSize: (
    params: URLSearchParams,
    pageIndex: number,
    effectivePageSize: number
  ) => void;
}): void {
  writePageWithPageSize(params, pageIndex, effectivePageSize);
}
