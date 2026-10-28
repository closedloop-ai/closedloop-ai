/**
 * @file catalog-contents.test-mocks.ts
 * @description The module-mock bag the `catalog-contents` suites share. Each
 * suite keeps its own one-line `vi.mock(path, async () => (await import(this
 * file)).xModuleMock())` registrations — `vi.mock` is hoisted per file and
 * cannot be shared — while the `vi.fn` instances and the factories live here
 * once, so a sibling suite never copies the header (ISS-8883).
 *
 * Imports only vitest: a mock factory that pulls in app code would evaluate
 * it before the mocks are registered.
 */
import { type Mock, vi } from "vitest";

export const httpsGetMock: Mock = vi.fn();
export const applyContentsFetchMock: Mock = vi.fn();
export const gatewayLogWarnMock: Mock = vi.fn();
export const telemetryEmitMock: Mock = vi.fn();

export function httpsModuleMock() {
  return { default: { get: httpsGetMock } };
}

export function catalogStoreModuleMock() {
  return { applyContentsFetch: applyContentsFetchMock };
}

export function gatewayLoggerModuleMock() {
  return { gatewayLog: { warn: gatewayLogWarnMock } };
}

export function observabilityModuleMock() {
  return {
    Observability: {
      getTelemetryEmitter: () => ({ emit: telemetryEmitMock }),
    },
  };
}
