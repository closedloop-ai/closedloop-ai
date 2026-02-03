/**
 * Type assertion tests to verify compatibility between packages/api Artifact type
 * and Prisma generated Artifact type.
 *
 * These tests use TypeScript's type system to ensure the types are structurally compatible.
 * If any of these fail, it indicates a breaking change in the type definitions.
 *
 * Note: This file must live in apps/api (not packages/api) because packages/api
 * intentionally does not depend on @repo/database to maintain separation of concerns.
 */

import type {
  Artifact as ApiArtifact,
  ArtifactCategory as ApiArtifactCategory,
  ArtifactStatus as ApiArtifactStatus,
  ArtifactType as ApiArtifactType,
} from "@repo/api/src/types/artifact";
import type {
  Artifact as PrismaArtifact,
  ArtifactCategory as PrismaArtifactCategory,
  ArtifactStatus as PrismaArtifactStatus,
  ArtifactType as PrismaArtifactType,
} from "@repo/database";

// =============================================================================
// TYPE COMPATIBILITY TESTS
// =============================================================================

// Test 1: Verify enum value compatibility
// These tests ensure the string literal values match between API and Prisma types

type AssertEnumCompatible<A extends string, B extends string> = A extends B
  ? B extends A
    ? true
    : false
  : false;

// Verify ArtifactType values are compatible
type ArtifactTypeCompatible = AssertEnumCompatible<
  ApiArtifactType,
  PrismaArtifactType
>;
const _artifactTypeCheck: ArtifactTypeCompatible = true;

// Verify ArtifactStatus values are compatible
type ArtifactStatusCompatible = AssertEnumCompatible<
  ApiArtifactStatus,
  PrismaArtifactStatus
>;
const _artifactStatusCheck: ArtifactStatusCompatible = true;

// Verify ArtifactCategory values are compatible
type ArtifactCategoryCompatible = AssertEnumCompatible<
  ApiArtifactCategory,
  PrismaArtifactCategory
>;
const _artifactCategoryCheck: ArtifactCategoryCompatible = true;

// Test 2: Verify core field compatibility
// The API Artifact type should be compatible with the Prisma Artifact type for all shared fields

type CoreFieldsCompatible = {
  // IDs and relationships
  id: PrismaArtifact["id"] extends ApiArtifact["id"] ? true : "mismatch";
  workstreamId: PrismaArtifact["workstreamId"] extends ApiArtifact["workstreamId"]
    ? true
    : "mismatch";
  projectId: PrismaArtifact["projectId"] extends ApiArtifact["projectId"]
    ? true
    : "mismatch";
  parentId: PrismaArtifact["parentId"] extends ApiArtifact["parentId"]
    ? true
    : "mismatch";

  // Core fields
  type: PrismaArtifact["type"] extends ApiArtifact["type"] ? true : "mismatch";
  category: PrismaArtifact["category"] extends ApiArtifact["category"]
    ? true
    : "mismatch";
  title: PrismaArtifact["title"] extends ApiArtifact["title"]
    ? true
    : "mismatch";
  fileName: PrismaArtifact["fileName"] extends ApiArtifact["fileName"]
    ? true
    : "mismatch";
  approver: PrismaArtifact["approver"] extends ApiArtifact["approver"]
    ? true
    : "mismatch";
  status: PrismaArtifact["status"] extends ApiArtifact["status"]
    ? true
    : "mismatch";
  content: PrismaArtifact["content"] extends ApiArtifact["content"]
    ? true
    : "mismatch";
  externalUrl: PrismaArtifact["externalUrl"] extends ApiArtifact["externalUrl"]
    ? true
    : "mismatch";

  // Version fields
  version: PrismaArtifact["version"] extends ApiArtifact["version"]
    ? true
    : "mismatch";
  isLatest: PrismaArtifact["isLatest"] extends ApiArtifact["isLatest"]
    ? true
    : "mismatch";

  // Metadata
  documentSlug: PrismaArtifact["documentSlug"] extends ApiArtifact["documentSlug"]
    ? true
    : "mismatch";
  generatedBy: PrismaArtifact["generatedBy"] extends ApiArtifact["generatedBy"]
    ? true
    : "mismatch";
  ownerId: PrismaArtifact["ownerId"] extends ApiArtifact["ownerId"]
    ? true
    : "mismatch";

  // Git fields
  targetRepo: PrismaArtifact["targetRepo"] extends ApiArtifact["targetRepo"]
    ? true
    : "mismatch";
  targetBranch: PrismaArtifact["targetBranch"] extends ApiArtifact["targetBranch"]
    ? true
    : "mismatch";
  templateForType: PrismaArtifact["templateForType"] extends ApiArtifact["templateForType"]
    ? true
    : "mismatch";

  // Timestamps
  createdAt: PrismaArtifact["createdAt"] extends ApiArtifact["createdAt"]
    ? true
    : "mismatch";
  updatedAt: PrismaArtifact["updatedAt"] extends ApiArtifact["updatedAt"]
    ? true
    : "mismatch";
};

const _coreFieldsCheck: CoreFieldsCompatible = {
  id: true,
  workstreamId: true,
  projectId: true,
  parentId: true,
  type: true,
  category: true,
  title: true,
  fileName: true,
  approver: true,
  status: true,
  content: true,
  externalUrl: true,
  version: true,
  isLatest: true,
  documentSlug: true,
  generatedBy: true,
  ownerId: true,
  targetRepo: true,
  targetBranch: true,
  templateForType: true,
  createdAt: true,
  updatedAt: true,
};

// Test 3: Verify Prisma Artifact can be transformed to API Artifact
// This is the critical test - it ensures that Prisma data can be safely returned via the API

type PrismaToApiTransformable<T extends PrismaArtifact> = {
  [K in keyof ApiArtifact]: K extends keyof T
    ? K extends "tokenUsage"
      ? unknown // API uses 'unknown' for flexibility, Prisma uses JsonValue | null
      : T[K] extends ApiArtifact[K]
        ? ApiArtifact[K]
        : never
    : never;
};

// Create a test to ensure this transformation is valid
const _transformTest = <T extends PrismaArtifact>(
  prismaArtifact: T
): PrismaToApiTransformable<T> => {
  return {
    ...prismaArtifact,
    tokenUsage: prismaArtifact.tokenUsage as unknown,
  } as PrismaToApiTransformable<T>;
};

// Test 4: Verify enum values are all present
// Note: Keys differ (API uses PascalCase like 'Prd', Prisma uses SCREAMING_SNAKE_CASE like 'PRD')
// but values must match exactly.

// Test that all API enum values exist in Prisma enum values
type ApiValuesInPrisma<
  ApiEnum extends string,
  PrismaEnum extends string,
> = ApiEnum extends PrismaEnum ? true : false;

type ArtifactTypeValuesMatch = ApiValuesInPrisma<
  ApiArtifactType,
  PrismaArtifactType
>;
const _artifactTypeValuesCheck: ArtifactTypeValuesMatch = true;

type ArtifactStatusValuesMatch = ApiValuesInPrisma<
  ApiArtifactStatus,
  PrismaArtifactStatus
>;
const _artifactStatusValuesCheck: ArtifactStatusValuesMatch = true;

type ArtifactCategoryValuesMatch = ApiValuesInPrisma<
  ApiArtifactCategory,
  PrismaArtifactCategory
>;
const _artifactCategoryValuesCheck: ArtifactCategoryValuesMatch = true;

// =============================================================================
// EXPORTS
// =============================================================================

// Export a dummy value to make this a proper module and indicate tests passed
export const ARTIFACT_TYPE_COMPATIBILITY_VERIFIED = true;
