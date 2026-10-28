import { readFileSync } from "node:fs";
import path from "node:path";
import { Prisma } from "@repo/database/generated/client";
import ts from "typescript6";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const apiOrganizationTypesPath = path.join(
  repoRoot,
  "packages/api/src/types/organization.ts"
);
const scalarFieldEnumSuffixPattern = /ScalarFieldEnum$/;
const organizationApiTypes = [
  "Organization",
  "CreateOrganizationInput",
  "UpdateOrganizationInput",
] as const;
const forbiddenOrganizationLogoFields = new Set([
  "avatarUrl",
  "image",
  "imageAssetKey",
  "imageId",
  "imageUrl",
  "logo",
  "logoAssetBucket",
  "logoAssetKey",
  "logoId",
  "logoFile",
  "logoUrl",
]);

describe("ISS-8568 organization logo persistence boundary", () => {
  it("keeps Prisma Organization free of parallel logo fields", () => {
    expect(
      forbiddenFields(Object.values(Prisma.OrganizationScalarFieldEnum))
    ).toEqual([]);
  });

  it("keeps Prisma free of organization-logo store models", () => {
    expect(
      [
        ...Object.values(Prisma.ModelName).filter(isOrganizationLogoStoreModel),
        ...prismaScalarFieldEntries()
          .filter(isLogoStoreAttachedToOrganization)
          .map(({ modelName }) => modelName),
      ].sort()
    ).toEqual([]);
  });

  it("keeps shared Organization API contracts free of parallel logo fields", () => {
    expect(
      organizationApiTypes.flatMap((typeName) =>
        forbiddenFields(apiTypePropertyNames(typeName))
      )
    ).toEqual([]);
  });
});

function apiTypePropertyNames(typeName: string): string[] {
  const source = parse(apiOrganizationTypesPath);
  for (const statement of source.statements) {
    if (
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === typeName &&
      ts.isTypeLiteralNode(statement.type)
    ) {
      return statement.type.members.flatMap(propertyNameText);
    }
  }

  throw new Error(`Missing ${typeName} in shared organization API types`);
}

function forbiddenFields(fieldNames: readonly string[]) {
  return fieldNames.filter(
    (fieldName) =>
      forbiddenOrganizationLogoFields.has(fieldName) ||
      isOrganizationLogoFieldName(fieldName)
  );
}

function isOrganizationLogoFieldName(fieldName: string) {
  return hasLogoTerm(fieldName);
}

function isOrganizationLogoStoreModel(modelName: string) {
  const normalizedModelName = modelName.toLowerCase();
  return normalizedModelName.includes("organization") && hasLogoTerm(modelName);
}

function isLogoStoreAttachedToOrganization({
  fieldNames,
  modelName,
}: PrismaScalarFieldEntry) {
  return (
    hasLogoTerm(modelName) &&
    fieldNames.some((fieldName) =>
      fieldName.toLowerCase().includes("organization")
    )
  );
}

function hasLogoTerm(value: string) {
  const normalizedValue = value.toLowerCase();
  return (
    normalizedValue.includes("logo") ||
    normalizedValue.includes("avatar") ||
    normalizedValue.includes("image")
  );
}

function prismaScalarFieldEntries(): PrismaScalarFieldEntry[] {
  return Object.entries(Prisma).flatMap(([key, value]) => {
    if (!(key.endsWith("ScalarFieldEnum") && isStringRecord(value))) {
      return [];
    }
    return [
      {
        fieldNames: Object.values(value),
        modelName: key.replace(scalarFieldEnumSuffixPattern, ""),
      },
    ];
  });
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((fieldValue) => typeof fieldValue === "string")
  );
}

type PrismaScalarFieldEntry = {
  fieldNames: string[];
  modelName: string;
};

function parse(filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
}

function propertyNameText(member: ts.TypeElement): string[] {
  if (
    ts.isPropertySignature(member) &&
    (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))
  ) {
    return [member.name.text];
  }
  return [];
}
