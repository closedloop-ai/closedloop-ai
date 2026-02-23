import { createHash } from "node:crypto";

/**
 * Compute the git blob SHA-1 for a file's raw bytes.
 *
 * Git hashes blobs as SHA1("blob " + byteLength + NUL + content), where
 * byteLength is the byte count of the raw content (not the character count).
 */
export function computeGitBlobSha(data: Buffer): string {
  const header = Buffer.from(`blob ${data.length}\0`);
  const hash = createHash("sha1");
  hash.update(header);
  hash.update(data);
  return hash.digest("hex");
}
