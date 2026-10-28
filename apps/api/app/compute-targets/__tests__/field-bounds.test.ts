/**
 * ISS-8880 §5 — the compute-target field bounds, and the two lanes that write
 * `compute_targets.machine_name` from the same constant.
 *
 * Every case is at-bound / over-bound in a pair. A bound with only an
 * over-bound case cannot tell a correct guard from an over-rejecting one.
 */
import { describe, expect, it } from "vitest";
import {
  ALLOWED_DIRECTORIES_MAX_COUNT,
  ALLOWED_DIRECTORY_MAX_LENGTH,
  APPROVAL_REASON_MAX_LENGTH,
  isWithinMachineNameLimit,
  isWithinSupportedOperationsLimits,
  LOCK_KEY_MAX_LENGTH,
  MACHINE_NAME_MAX_LENGTH,
  OPERATION_ID_MAX_LENGTH,
  SIGNATURE_PAYLOAD_MAX_LENGTH,
  SUPPORTED_OPERATION_MAX_LENGTH,
  SUPPORTED_OPERATIONS_MAX_COUNT,
  sanitizeApprovalReason,
} from "@/lib/compute-target-field-limits";
import { parseHelloPayload } from "@/lib/desktop-gateway-wire";
import {
  createDesktopCommandValidator,
  registerComputeTargetValidator,
} from "../validators";

const AT_LIMIT_NAME = "m".repeat(MACHINE_NAME_MAX_LENGTH);
const OVER_LIMIT_NAME = "m".repeat(MACHINE_NAME_MAX_LENGTH + 1);

function registerBody(overrides: Record<string, unknown> = {}) {
  return {
    machineName: "workstation",
    platform: "linux",
    supportedOperations: ["gateway.health"],
    ...overrides,
  };
}

function commandBody(overrides: Record<string, unknown> = {}) {
  return {
    operationId: "gateway.health",
    method: "POST",
    path: "/api/gateway/health",
    ...overrides,
  };
}

function helloPayload(overrides: Record<string, unknown> = {}) {
  return {
    machineName: "workstation",
    platform: "linux",
    pluginVersion: "1.0.0",
    supportedOperations: ["gateway.health"],
    maxInFlightCommands: 1,
    ...overrides,
  };
}

describe("§5 machineName — one constant, both lanes agree", () => {
  it("REST register accepts at the bound and refuses one over", () => {
    expect(
      registerComputeTargetValidator.safeParse(
        registerBody({ machineName: AT_LIMIT_NAME })
      ).success
    ).toBe(true);
    expect(
      registerComputeTargetValidator.safeParse(
        registerBody({ machineName: OVER_LIMIT_NAME })
      ).success
    ).toBe(false);
  });

  it("the gateway wire lane PARSES an over-bound name, because refusing it here would be silent", () => {
    // `parseHelloPayload` returning `null` is answered by a bare
    // `socket.disconnect(true)` — no log, no `desktop.hello.nack`. Bounding at
    // the schema would therefore have traded today's named nack for a silent
    // drop, which is the signal loss the relay lane's bound exists to avoid.
    // The bound lives in `handleSocketHello` instead; `refuseUnboundedHelloFields`
    // and its socket-server wiring are covered in
    // `lib/__tests__/desktop-gateway-hello-field-guard.test.ts`.
    expect(
      parseHelloPayload(helloPayload({ machineName: AT_LIMIT_NAME }))
    ).not.toBeNull();
    expect(
      parseHelloPayload(helloPayload({ machineName: OVER_LIMIT_NAME }))
        ?.machineName
    ).toBe(OVER_LIMIT_NAME);
  });

  it("the wire lane does NOT rewrite a padded name", () => {
    const padded = "  workstation  ";

    const parsed = parseHelloPayload(helloPayload({ machineName: padded }));

    // `machine_name` is half of a UNIQUE identity key and this lane persists the
    // raw value today. A `.trim()` here would be a transform, silently changing
    // which row a reconnecting install resolves to.
    expect(parsed?.machineName).toBe(padded);
  });

  it("bounds the RAW length, because the raw string is what this lane stores", () => {
    // This assertion was inverted, and the inversion was the bug: measuring
    // `value.trim().length` bounded a string nothing persists. The socket lanes
    // write the value verbatim, so padding rides along to the
    // `@@unique([userId, machineName])` btree and still raises SQLSTATE 54000 —
    // the permanent handshake loop §5 exists to close.
    const paddedAtLimit = `  ${AT_LIMIT_NAME}  `;

    expect(isWithinMachineNameLimit(AT_LIMIT_NAME)).toBe(true);
    expect(isWithinMachineNameLimit(paddedAtLimit)).toBe(false);
    expect(isWithinMachineNameLimit(`${" ".repeat(3000)}x`)).toBe(false);

    // The REST lane legitimately still accepts it: it trims BEFORE it caps, so
    // what it stores is the trimmed value and that value is within bound. Each
    // lane bounds what it actually writes — that is the invariant, not a shared
    // spelling — so this difference is deliberate rather than drift.
    expect(
      registerComputeTargetValidator.safeParse(
        registerBody({ machineName: paddedAtLimit })
      ).success
    ).toBe(true);
  });

  it("the predicate refuses a padded over-bound name, which is what the socket lane gates on", () => {
    // The counterfactual for the fix above: under the trimmed measurement this
    // value passed, reached `computeTargetsService`, and 54000'd at INSERT.
    // The gate is now `refuseUnboundedHelloFields`, so this asserts the
    // predicate it calls rather than the parse.
    expect(
      isWithinMachineNameLimit(`${AT_LIMIT_NAME}${" ".repeat(3000)}`)
    ).toBe(false);
  });
});

describe("§5 desktop-command string bounds", () => {
  it("lockKey fits a real composed key and refuses one over the bound", () => {
    // The desktop builds `${operationId}:${scopedPath}`, so the bound has to
    // clear a max-length operation id plus an absolute path.
    const realistic = `${"o".repeat(OPERATION_ID_MAX_LENGTH)}:${"/p".repeat(
      1000
    )}`;
    expect(realistic.length).toBeGreaterThan(200);
    expect(
      createDesktopCommandValidator.safeParse(
        commandBody({ lockKey: realistic })
      ).success
    ).toBe(true);

    expect(
      createDesktopCommandValidator.safeParse(
        commandBody({ lockKey: "k".repeat(LOCK_KEY_MAX_LENGTH + 1) })
      ).success
    ).toBe(false);
  });

  it("signaturePayload accepts at the bound and refuses one over", () => {
    const signatureFields = {
      signature: "YQ==",
      publicKeyFingerprint: `cl:${"a".repeat(22)}`,
    };
    expect(
      createDesktopCommandValidator.safeParse(
        commandBody({
          ...signatureFields,
          signaturePayload: "s".repeat(SIGNATURE_PAYLOAD_MAX_LENGTH),
        })
      ).success
    ).toBe(true);
    expect(
      createDesktopCommandValidator.safeParse(
        commandBody({
          ...signatureFields,
          signaturePayload: "s".repeat(SIGNATURE_PAYLOAD_MAX_LENGTH + 1),
        })
      ).success
    ).toBe(false);
  });
});

describe("§5 approvalReason — invalid-input-only character rule", () => {
  const accepted = [
    ["a plain English reason", "destructive"],
    ["an accented reason", "réparation du répertoire"],
    ["a reason with a tab", "destructive\toperation"],
    ["the top of the latin-1 range", "naïve façade ÿ"],
  ] as const;

  it.each(accepted)("accepts %s", (_label, reason) => {
    expect(
      createDesktopCommandValidator.safeParse(
        commandBody({ approvalReason: reason })
      ).success
    ).toBe(true);
  });

  const refused = [
    ["a CR", "bad\rreason"],
    ["an LF", "bad\nreason"],
    ["a NUL", "bad\u0000reason"],
    ["a CJK code point", "危険な操作"],
    ["an emoji", "delete everything 🔥"],
    // Realistic and easy to type by accident: an em-dash is U+2014, so it would
    // throw at `Headers.set` on the desktop exactly like a CJK character.
    ["an em-dash", "delete the cache — it is stale"],
  ] as const;

  it.each(refused)("refuses %s", (_label, reason) => {
    // Above U+00FF, `Headers.set("x-desktop-approval-reason", …)` throws a
    // TypeError on the desktop, so these already break the consumer today.
    expect(
      createDesktopCommandValidator.safeParse(
        commandBody({ approvalReason: reason })
      ).success
    ).toBe(false);
  });

  it("accepts at the length bound and refuses one over", () => {
    expect(
      createDesktopCommandValidator.safeParse(
        commandBody({ approvalReason: "r".repeat(APPROVAL_REASON_MAX_LENGTH) })
      ).success
    ).toBe(true);
    expect(
      createDesktopCommandValidator.safeParse(
        commandBody({
          approvalReason: "r".repeat(APPROVAL_REASON_MAX_LENGTH + 1),
        })
      ).success
    ).toBe(false);
  });
});

describe("§5 array bounds", () => {
  it("supportedOperations bounds element length and array length on register", () => {
    expect(
      registerComputeTargetValidator.safeParse(
        registerBody({
          supportedOperations: ["o".repeat(SUPPORTED_OPERATION_MAX_LENGTH)],
        })
      ).success
    ).toBe(true);
    expect(
      registerComputeTargetValidator.safeParse(
        registerBody({
          supportedOperations: ["o".repeat(SUPPORTED_OPERATION_MAX_LENGTH + 1)],
        })
      ).success
    ).toBe(false);
    expect(
      registerComputeTargetValidator.safeParse(
        registerBody({
          supportedOperations: Array.from(
            { length: SUPPORTED_OPERATIONS_MAX_COUNT + 1 },
            () => "op"
          ),
        })
      ).success
    ).toBe(false);
  });

  it("allowedDirectories bounds element length and array length", () => {
    expect(
      registerComputeTargetValidator.safeParse(
        registerBody({
          allowedDirectories: [
            `/${"d".repeat(ALLOWED_DIRECTORY_MAX_LENGTH - 1)}`,
          ],
        })
      ).success
    ).toBe(true);
    expect(
      registerComputeTargetValidator.safeParse(
        registerBody({
          allowedDirectories: ["d".repeat(ALLOWED_DIRECTORY_MAX_LENGTH + 1)],
        })
      ).success
    ).toBe(false);
    expect(
      registerComputeTargetValidator.safeParse(
        registerBody({
          allowedDirectories: Array.from(
            { length: ALLOWED_DIRECTORIES_MAX_COUNT + 1 },
            () => "/tmp"
          ),
        })
      ).success
    ).toBe(false);
  });
});

describe("ISS-8880 review — the bounds the socket lanes were still missing", () => {
  it("refuses an oversized capability declaration instead of truncating it", () => {
    // A `.slice()` here acknowledged the hello as if the declaration were
    // complete. Downstream gates read the column with
    // `supportedOperations.includes(...)`, so every operation past the cutoff
    // read as unsupported on a desktop that supports it — and nothing told
    // either side. Rejecting is what the REST `.max()` already does.
    const overCount = Array.from(
      { length: SUPPORTED_OPERATIONS_MAX_COUNT + 1 },
      () => "op"
    );
    const atCount = Array.from(
      { length: SUPPORTED_OPERATIONS_MAX_COUNT },
      () => "op"
    );

    expect(isWithinSupportedOperationsLimits(atCount)).toBe(true);
    expect(isWithinSupportedOperationsLimits(overCount)).toBe(false);
    expect(
      isWithinSupportedOperationsLimits([
        "o".repeat(SUPPORTED_OPERATION_MAX_LENGTH),
      ])
    ).toBe(true);
    expect(
      isWithinSupportedOperationsLimits([
        "o".repeat(SUPPORTED_OPERATION_MAX_LENGTH + 1),
      ])
    ).toBe(false);

    // The second socket lane. It parses both — the refusal is
    // `refuseUnboundedHelloFields` in `handleSocketHello`, so that an over-count
    // declaration is NACKED rather than silently dropped — but it still must
    // not TRUNCATE, which is the defect this case was written for.
    expect(
      parseHelloPayload(helloPayload({ supportedOperations: atCount }))
        ?.supportedOperations
    ).toHaveLength(SUPPORTED_OPERATIONS_MAX_COUNT);
    expect(
      parseHelloPayload(helloPayload({ supportedOperations: overCount }))
        ?.supportedOperations
    ).toHaveLength(overCount.length);
  });

  it("drops a relay approvalReason the desktop cannot put in a header, and keeps a valid one", () => {
    const rejections: { reason: string }[] = [];
    const record = (rejection: { reason: string }) => {
      rejections.push(rejection);
    };

    // Non-English prose is VALID and must survive — it is at or below U+00FF.
    expect(sanitizeApprovalReason("Genehmigung für Größe", record)).toBe(
      "Genehmigung für Größe"
    );
    expect(rejections).toHaveLength(0);

    // Above U+00FF: `Headers.set` throws a TypeError on the desktop today, so
    // the whole command is lost rather than one advisory field.
    expect(sanitizeApprovalReason("承認が必要です", record)).toBeUndefined();
    // CRLF injection.
    expect(sanitizeApprovalReason("ok\r\nx-evil: 1", record)).toBeUndefined();
    expect(
      sanitizeApprovalReason("r".repeat(APPROVAL_REASON_MAX_LENGTH + 1), record)
    ).toBeUndefined();
    expect(rejections.map((entry) => entry.reason)).toEqual([
      "not_header_safe",
      "not_header_safe",
      "too_long",
    ]);

    // At-bound, so this is not an over-rejecting guard.
    expect(
      sanitizeApprovalReason("r".repeat(APPROVAL_REASON_MAX_LENGTH), record)
    ).toHaveLength(APPROVAL_REASON_MAX_LENGTH);
  });
});
