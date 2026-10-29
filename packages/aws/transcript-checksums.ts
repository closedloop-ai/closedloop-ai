import { createHash } from "node:crypto";
import { Crc64Nvme } from "@aws-sdk/crc64-nvme";

/**
 * The two checksums the transcript control plane expects for an archive
 * object window (`packages/api/src/types/desktop-transcripts.ts`): sha256 is
 * the archive identity, CRC64NVME (base64, as S3 reports it) the full-object
 * integrity check S3 verifies on upload. The Desktop lane computes the same
 * pair in `transcript-upload-window.ts`; this is the server-side twin for
 * callers that upload transcript bytes without Desktop (ISS-12017, the vibe
 * seed).
 */
export type TranscriptObjectChecksums = {
  readonly sha256Hex: string;
  readonly crc64NvmeBase64: string;
  readonly byteLength: number;
};

export async function transcriptObjectChecksums(
  bytes: Uint8Array
): Promise<TranscriptObjectChecksums> {
  const crc = new Crc64Nvme();
  crc.update(bytes);
  return {
    sha256Hex: createHash("sha256").update(bytes).digest("hex"),
    crc64NvmeBase64: Buffer.from(await crc.digest()).toString("base64"),
    byteLength: bytes.byteLength,
  };
}
