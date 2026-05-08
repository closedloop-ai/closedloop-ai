import AdmZip from "adm-zip";

/**
 * Build a ZIP buffer from a list of file entries.
 * Used for testing ZIP parsing logic.
 *
 * @param entries - Array of file entries with name and content
 * @returns Buffer containing the ZIP file
 */
export function buildZipWithEntries(
  entries: Array<{ name: string; content: string }>
): Buffer {
  const zip = new AdmZip();
  for (const entry of entries) {
    zip.addFile(entry.name, Buffer.from(entry.content, "utf-8"));
  }
  return zip.toBuffer();
}
