import { describe, expect, it } from "vitest";
import { transcriptObjectChecksums } from "./transcript-checksums";

/**
 * Expected values are the published CRC-64/NVME and SHA-256 check values for
 * the ASCII string "123456789" (CRC-64/NVME check 0xae8b14860a799888), not
 * values computed by the code under test.
 */
const CHECK_INPUT = new TextEncoder().encode("123456789");
const CRC64_NVME_CHECK = "rosUhgp5mIg=";
const SHA256_CHECK =
  "15e2b0d3c33891ebb0f1ef609ec419420c20e320ce94c65fbc8c3312448eb225";

describe("transcriptObjectChecksums", () => {
  it("returns the standard check values and the byte length", async () => {
    await expect(transcriptObjectChecksums(CHECK_INPUT)).resolves.toEqual({
      sha256Hex: SHA256_CHECK,
      crc64NvmeBase64: CRC64_NVME_CHECK,
      byteLength: 9,
    });
  });

  it("checksums an empty object", async () => {
    const checksums = await transcriptObjectChecksums(new Uint8Array());

    expect(checksums.byteLength).toBe(0);
    expect(checksums.sha256Hex).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
});
