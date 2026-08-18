/**
 * @file crewd-harness-stub.ts
 * @description ISS-5154: the non-behavioral half of a stubbed `@repo/crewd`
 * `Harness`, shared by the desktop suites that drive `AuditService` through a
 * fake engine.
 *
 * Those suites only ever vary `isAvailable` and `run` — the identity, capability
 * block, and model enumeration are boilerplate every stub repeated, and each
 * copy had drifted off the real contract (a bare `{ nativeSchedule: "none" }`
 * with no `availableModels`/`defaultModel`, and no `listModels` at all). A stub
 * that cannot satisfy `Harness` is the test asserting against a contract the
 * production registry does not have, so the fields are filled from crewd's own
 * exported model tables rather than re-spelled here.
 *
 * `nativeSchedule` stays `NativeSchedule.None` for every stubbed harness, which
 * is what these suites have always declared: they exercise cascade EXECUTION
 * (run this prompt through this engine), never native schedule registration, so
 * a stub that claimed a native scheduling target would be describing a code path
 * the suite does not drive.
 */
import {
  AVAILABLE_MODELS,
  DEFAULT_MODEL,
  type Harness,
  type HarnessName,
  NativeSchedule,
} from "@repo/crewd";

/**
 * The identity + capability surface of a stubbed harness. Spread into a stub
 * that supplies the behavior under test:
 *
 * ```ts
 * { ...stubHarnessBase(name), isAvailable: async () => true, run: … }
 * ```
 */
export function stubHarnessBase(
  name: HarnessName
): Pick<Harness, "name" | "capabilities" | "listModels"> {
  return {
    name,
    capabilities: {
      nativeSchedule: NativeSchedule.None,
      availableModels: AVAILABLE_MODELS[name],
      defaultModel: DEFAULT_MODEL[name],
    },
    listModels: () => Promise.resolve(AVAILABLE_MODELS[name]),
  };
}
