import { BRANCH_NAME_MAX_LENGTH } from "@repo/api/src/types/artifact";
import { describe, expect, it } from "vitest";
import { PREVIEW_SCHEMA_REQUEST_MAX_BYTES } from "@/app/preview-schemas/constants";
import { EnsureTarget } from "@/app/preview-schemas/ensure/constants";

describe("preview schema request cap", () => {
  it("stays above the largest body a max-length branch can produce", () => {
    // The two constants have different owners: `BRANCH_NAME_MAX_LENGTH` belongs
    // to the branch-materialization surface and can be raised without anyone
    // reading this file. If it outgrows the byte cap, the cap silently becomes
    // the binding constraint and a legitimate max-length branch starts getting
    // a 413 instead of being accepted — on routes whose only caller is a deploy
    // job that fails on any non-2xx. Nothing else catches that: every other
    // probe on this surface pads with single-byte characters.
    //
    // A control character is the worst case JSON can produce, escaping to six
    // bytes while still counting as one character against `.max()`.
    const worstCase = JSON.stringify({
      branch: "\u0001".repeat(BRANCH_NAME_MAX_LENGTH),
      target: EnsureTarget.Public,
    });

    expect(Buffer.byteLength(worstCase, "utf8")).toBeLessThanOrEqual(
      PREVIEW_SCHEMA_REQUEST_MAX_BYTES
    );
  });
});
