/** Keep each wire page comfortably below Desktop's bounded response reader. */
export function boundedMeshPage<T>(rows: T[], maximumItems: number): T[] {
  let bytes = 2;
  const page: T[] = [];
  for (const row of rows) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (page.length >= maximumItems || bytes + rowBytes > 240 * 1024) {
      if (page.length === 0) {
        throw new Error("Persisted Session Mesh row exceeds the wire budget");
      }
      break;
    }
    bytes += rowBytes;
    page.push(row);
  }
  return page;
}
