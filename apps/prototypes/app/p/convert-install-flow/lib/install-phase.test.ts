import { describe, expect, it } from "vitest";
import {
  ComponentKind,
  Convertibility,
  type FieldMapping,
  FieldSupport,
  Harness,
  InstallOutcome,
  type SourceComponent,
} from "../mock";
import {
  activeStepFor,
  confirmLabel,
  InstallPhase,
  isBlocked,
  phaseAfterConfirm,
  phaseAfterConvert,
} from "./install-phase";

const mapping = (over: Partial<FieldMapping>): FieldMapping => ({
  sourceField: "Field",
  targetField: "Field",
  support: FieldSupport.Supported,
  ...over,
});

const makeSource = (over: Partial<SourceComponent>): SourceComponent => ({
  id: "test-source",
  name: "test",
  kind: ComponentKind.Command,
  description: "A test component.",
  sourceHarness: Harness.Codex,
  publisher: "closedloop/test",
  convertibility: Convertibility.Clean,
  mappings: [mapping({})],
  installOutcome: InstallOutcome.Success,
  ...over,
});

const cleanSource = makeSource({ convertibility: Convertibility.Clean });
const errorSource = makeSource({
  convertibility: Convertibility.Partial,
  installOutcome: InstallOutcome.Error,
});
const blockedSource = makeSource({
  convertibility: Convertibility.Blocked,
  installOutcome: InstallOutcome.Success,
});

describe("isBlocked", () => {
  it("is true only for a blocked convertibility", () => {
    expect(isBlocked(blockedSource)).toBe(true);
    expect(isBlocked(cleanSource)).toBe(false);
  });
});

describe("phaseAfterConfirm", () => {
  it("starts converting from the resting preview", () => {
    expect(phaseAfterConfirm(InstallPhase.Preview, cleanSource)).toBe(
      InstallPhase.Converting
    );
  });

  it("retries from the error state back into converting", () => {
    expect(phaseAfterConfirm(InstallPhase.Error, errorSource)).toBe(
      InstallPhase.Converting
    );
  });

  it("is a no-op while already converting", () => {
    expect(phaseAfterConfirm(InstallPhase.Converting, cleanSource)).toBe(
      InstallPhase.Converting
    );
  });

  it("never leaves preview for a blocked component", () => {
    expect(phaseAfterConfirm(InstallPhase.Preview, blockedSource)).toBe(
      InstallPhase.Preview
    );
  });
});

describe("phaseAfterConvert", () => {
  it("resolves a successful install to installed", () => {
    expect(phaseAfterConvert(cleanSource)).toBe(InstallPhase.Installed);
  });

  it("resolves a failing install to error", () => {
    expect(phaseAfterConvert(errorSource)).toBe(InstallPhase.Error);
  });
});

describe("activeStepFor", () => {
  it("keeps Preview on the resting and error phases", () => {
    expect(activeStepFor(InstallPhase.Preview)).toBe("Preview");
    expect(activeStepFor(InstallPhase.Error)).toBe("Preview");
  });

  it("advances to Install while converting and once installed", () => {
    expect(activeStepFor(InstallPhase.Converting)).toBe("Install");
    expect(activeStepFor(InstallPhase.Installed)).toBe("Install");
  });
});

describe("confirmLabel", () => {
  it("reads Can't install when blocked, regardless of phase", () => {
    expect(confirmLabel(InstallPhase.Preview, true)).toBe("Can't install");
  });

  it("tracks the in-flight and error phases", () => {
    expect(confirmLabel(InstallPhase.Preview, false)).toBe(
      "Convert and install"
    );
    expect(confirmLabel(InstallPhase.Converting, false)).toBe("Installing");
    expect(confirmLabel(InstallPhase.Error, false)).toBe("Try again");
  });
});
