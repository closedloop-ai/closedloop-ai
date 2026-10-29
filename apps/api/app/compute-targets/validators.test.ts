import { describe, expect, it } from "vitest";
import { OPERATION_ID_MAX_LENGTH } from "@/lib/compute-target-field-limits";
import { createDesktopCommandValidator } from "./validators";

const unsignedCommand = {
  operationId: "op-1",
  method: "POST",
  path: "/api/gateway/symphony/chat/run-1",
  streaming: false,
  commandId: "0196b1bb-7a00-7000-8000-000000000010",
};

const signatureTriple = {
  signature: "YWJj",
  signaturePayload: "payload",
  publicKeyFingerprint: "cl:abcdefghijklmnopqrstuv",
};

const validCommand = {
  ...unsignedCommand,
  signature: signatureTriple.signature,
  signaturePayload: signatureTriple.signaturePayload,
};

// Asserted against the validator's own wording rather than re-typed per case, so
// a reworded guard fails here instead of silently passing six loosened matchers.
const SIGNATURE_TRIPLE_MESSAGE =
  "signature, signaturePayload, and publicKeyFingerprint must be provided together";

// Every proper non-empty subset of the signature triple. Each value is
// individually valid, so the sole issue has to come from the all-or-nothing
// guard and not from a field validator rejecting a malformed member.
const halfSignedCommands: [string, Partial<typeof signatureTriple>][] = [
  ["signature", { signature: signatureTriple.signature }],
  ["signaturePayload", { signaturePayload: signatureTriple.signaturePayload }],
  [
    "publicKeyFingerprint",
    { publicKeyFingerprint: signatureTriple.publicKeyFingerprint },
  ],
  [
    "signature and signaturePayload",
    {
      signature: signatureTriple.signature,
      signaturePayload: signatureTriple.signaturePayload,
    },
  ],
  [
    "signature and publicKeyFingerprint",
    {
      signature: signatureTriple.signature,
      publicKeyFingerprint: signatureTriple.publicKeyFingerprint,
    },
  ],
  [
    "signaturePayload and publicKeyFingerprint",
    {
      signaturePayload: signatureTriple.signaturePayload,
      publicKeyFingerprint: signatureTriple.publicKeyFingerprint,
    },
  ],
];

// Half of that matrix rides behind a second net: the route's own
// commandId-to-signature pairing check (validateSignatureConsistency in
// [id]/commands/route.ts) 400s a partial triple that carries a commandId. Drop
// the commandId and extractSignatureFields returns undefined, so a guard
// narrowed around commandId would dispatch the command as unsigned with
// nothing else standing there — the matrix runs against both bases.
const { commandId: _commandId, ...unsignedCommandWithoutCommandId } =
  unsignedCommand;

const halfSignedBases: [string, Record<string, unknown>][] = [
  ["with a commandId", unsignedCommand],
  ["without a commandId", unsignedCommandWithoutCommandId],
];

const halfSignedCases: [
  string,
  Record<string, unknown>,
  Partial<typeof signatureTriple>,
][] = halfSignedBases.flatMap(([baseLabel, base]) =>
  halfSignedCommands.map(
    ([fieldsLabel, signatureFields]): [
      string,
      Record<string, unknown>,
      Partial<typeof signatureTriple>,
    ] => [`${fieldsLabel}, ${baseLabel}`, base, signatureFields]
  )
);

describe("createDesktopCommandValidator", () => {
  it("accepts command public-key fingerprints with the generated 22 character suffix", () => {
    expect(
      createDesktopCommandValidator.safeParse({
        ...validCommand,
        publicKeyFingerprint: "cl:abcdefghijklmnopqrstuv",
      }).success
    ).toBe(true);
  });

  it("rejects shorter command public-key fingerprints", () => {
    const parsed = createDesktopCommandValidator.safeParse({
      ...validCommand,
      publicKeyFingerprint: "cl:abcdefghijklmnop",
    });

    expect(parsed.success).toBe(false);
    const issue = parsed.error?.issues.find(
      (candidate) => candidate.path[0] === "publicKeyFingerprint"
    );
    expect(issue?.path).toEqual(["publicKeyFingerprint"]);
    expect(issue?.code).toBe("invalid_format");
    expect(issue?.message).toBe("Must be a command public-key fingerprint");
  });

  it("accepts paths starting with /api/gateway/", () => {
    expect(
      createDesktopCommandValidator.safeParse({
        operationId: "op-1",
        method: "POST",
        path: "/api/gateway/symphony/chat/run-1",
        streaming: false,
      }).success
    ).toBe(true);
  });

  it("rejects legacy /api/engineer/* paths that are no longer in the gateway namespace", () => {
    const parsed = createDesktopCommandValidator.safeParse({
      operationId: "op-1",
      method: "GET",
      path: "/api/engineer/health-check",
      streaming: false,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((issue) =>
          issue.message.includes("/api/gateway/")
        )
      ).toBe(true);
    }
  });

  it.each(halfSignedCases)(
    "rejects a half-signed command carrying only %s",
    (_label, base, signatureFields) => {
      const parsed = createDesktopCommandValidator.safeParse({
        ...base,
        ...signatureFields,
      });

      expect(parsed.success).toBe(false);
      // Exactly one issue, so the rejection is attributable to the guard rather
      // than to a field validator that happened to reject one of the members.
      expect(parsed.error?.issues).toHaveLength(1);
      const issue = parsed.error?.issues.find(
        (candidate) => candidate.message === SIGNATURE_TRIPLE_MESSAGE
      );
      expect(issue?.path).toEqual(["signature"]);
      expect(issue?.code).toBe("custom");
    }
  );

  it("accepts a fully signed command and preserves all three signature fields", () => {
    const parsed = createDesktopCommandValidator.safeParse({
      ...unsignedCommand,
      ...signatureTriple,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject(signatureTriple);
  });

  it("accepts an unsigned command and leaves the signature fields undefined", () => {
    const parsed = createDesktopCommandValidator.safeParse(unsignedCommand);

    expect(parsed.success).toBe(true);
    expect(parsed.data?.signature).toBeUndefined();
    expect(parsed.data?.signaturePayload).toBeUndefined();
    expect(parsed.data?.publicKeyFingerprint).toBeUndefined();
  });
});

/**
 * ISS-8547 Section 7. `operationId` was `z.string().trim().min(1)` with no
 * `.max()` on all three declarations, while `operation_id` carries a plain
 * btree (`@@index([operationId])`) that Postgres refuses to index past 2704
 * bytes (SQLSTATE 54000). `createCommand`'s catch handles only `P2002`, so
 * that refusal escaped as a 500 on what is really a malformed field.
 *
 * The bound is on the command write lane, `createDesktopCommandValidator`.
 */
describe("operationId length bound (ISS-8547)", () => {
  const overLimitOperationId = "a".repeat(OPERATION_ID_MAX_LENGTH + 1);
  const veryLongOperationId = "a".repeat(3000);
  const boundaryOperationId = "a".repeat(OPERATION_ID_MAX_LENGTH);

  it("createDesktopCommandValidator rejects an operationId past the bound", () => {
    for (const operationId of [overLimitOperationId, veryLongOperationId]) {
      const parsed = createDesktopCommandValidator.safeParse({
        ...unsignedCommand,
        operationId,
      });

      expect(parsed.success).toBe(false);
      const issue = parsed.error?.issues.find(
        (candidate) => candidate.path[0] === "operationId"
      );
      expect(issue?.path).toEqual(["operationId"]);
    }
  });

  // The boundary and an ordinary id, per validator — the mutation this kills
  // is a bound that rejects the valid path (e.g. an off-by-one .max()).
  it("createDesktopCommandValidator accepts the boundary length and an ordinary id", () => {
    expect(
      createDesktopCommandValidator.safeParse({
        ...unsignedCommand,
        operationId: boundaryOperationId,
      }).success
    ).toBe(true);
    expect(
      createDesktopCommandValidator.safeParse({
        ...unsignedCommand,
        operationId: "health_check",
      }).success
    ).toBe(true);
  });
});
