/**
 * The `withDb` double the attachments-service suites install. Each suite mocks
 * `@repo/database` itself, so the `withDb` imported here is that suite's mock.
 */

import { withDb } from "@repo/database";
import { type Mock, vi } from "vitest";
import { ARTIFACT_ID } from "./attachments-service.test-fixtures";

/**
 * The two `withDb` legs every attachment path takes: the artifact-scope lookup
 * proving the artifact belongs to the caller's org, then the `fileAttachment`
 * delegate the case under test actually drives.
 */
export function installArtifactScopeThen(
  fileAttachment: Record<string, unknown>
): void {
  const mockWithDb = withDb as unknown as Mock;
  mockWithDb
    .mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({
        artifact: { findFirst: vi.fn().mockResolvedValue({ id: ARTIFACT_ID }) },
      })
    )
    .mockImplementationOnce((callback: (db: unknown) => unknown) =>
      callback({ fileAttachment })
    );
}
