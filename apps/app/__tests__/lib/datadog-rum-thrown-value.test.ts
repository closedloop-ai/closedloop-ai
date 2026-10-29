/**
 * ISS-6995: what the root boundaries hand the RUM reporter when Next gives them
 * a value that is not an `Error`.
 */
import { describe, expect, it } from "vitest";
import { toReportableError } from "@/lib/datadog-rum/thrown-value";

describe("toReportableError", () => {
  it("passes a real Error through by identity so reporting is unchanged", () => {
    const error = Object.assign(new Error("route render failed"), {
      digest: "digest-identity",
    });

    expect(toReportableError(error)).toBe(error);
  });

  it("passes an Error subclass through rather than flattening it", () => {
    const error = new TypeError("not a function");

    const reportable = toReportableError(error);

    expect(reportable).toBe(error);
    expect(reportable.name).toBe("TypeError");
  });

  it("names the type of a thrown string without quoting its contents", () => {
    const reportable = toReportableError("user-entered-sensitive-text");

    expect(reportable).toBeInstanceOf(Error);
    expect(reportable.message).toBe("Non-Error value thrown (string)");
    expect(reportable.message).not.toContain("user-entered-sensitive-text");
    expect(reportable.digest).toBeUndefined();
  });

  it("reports null as null rather than as an object, and does not throw", () => {
    const reportable = toReportableError(null);

    expect(reportable.message).toBe("Non-Error value thrown (null)");
  });

  it("drops a digest a non-Error carries, so a forged one cannot suppress a real error", () => {
    // `reportNextjsError` returns without reporting when the digest names Next
    // control flow, so trusting this value lets any thrown object silence
    // itself — and ships an unvalidated string to Datadog (davetho).
    const reportable = toReportableError({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });

    expect(reportable.digest).toBeUndefined();
    expect(reportable.message).toBe("Non-Error value thrown (object)");
  });

  it("does not read a throwing digest getter, so the reporting effect cannot crash", () => {
    // The counterfactual this case exists for: a helper that reads `.digest`
    // off the thrown value propagates this getter's throw out of the error
    // boundary's effect, which is the blank page ISS-6995 is about (whitlockk).
    const thrown = {
      get digest(): string {
        throw new Error("digest getter exploded");
      },
    };

    const reportable = toReportableError(thrown);

    expect(reportable.digest).toBeUndefined();
    expect(reportable.message).toBe("Non-Error value thrown (object)");
  });

  it("keeps the digest of a real Error, so control-flow filtering still applies", () => {
    // The capability the two cases above give up for non-Errors is untouched
    // where it is actually generated: `notFound()` and `redirect()` throw real
    // `Error` instances, which take the identity branch.
    const controlFlow = Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK"), {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });

    expect(toReportableError(controlFlow).digest).toBe(
      "NEXT_HTTP_ERROR_FALLBACK;404"
    );
  });
});
