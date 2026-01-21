import {
  createArtifactSchema,
  updateArtifactSchema,
} from "@/app/artifacts/schemas";

describe("createArtifactSchema", () => {
  it("validates valid artifact data", () => {
    const validData = {
      type: "PRD",
      title: "My Feature",
    };
    const result = createArtifactSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it("rejects missing title", () => {
    const invalidData = {
      type: "PRD",
    };
    const result = createArtifactSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("Invalid input");
    }
  });

  it("rejects empty title", () => {
    const invalidData = {
      type: "PRD",
      title: "",
    };
    const result = createArtifactSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe("Title is required");
    }
  });

  it("accepts optional fields", () => {
    const dataWithOptionals = {
      type: "PRD",
      title: "My Feature",
      workstreamId: "ws-123",
      projectId: "proj-456",
      fileName: "feature.md",
      content: "# Content",
      status: "DRAFT",
    };
    const result = createArtifactSchema.safeParse(dataWithOptionals);
    expect(result.success).toBe(true);
  });

  it("rejects invalid artifact type", () => {
    const invalidData = {
      type: "INVALID_TYPE",
      title: "Test",
    };
    const result = createArtifactSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });

  it("validates externalUrl must be valid URL", () => {
    const invalidData = {
      type: "PRD",
      title: "Test",
      externalUrl: "not-a-url",
    };
    const result = createArtifactSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("Invalid");
    }
  });
});

describe("updateArtifactSchema", () => {
  it("validates partial update data", () => {
    const validData = {
      title: "Updated Title",
    };
    const result = updateArtifactSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it("accepts nullable approver", () => {
    const validData = {
      approver: null,
    };
    const result = updateArtifactSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it("accepts empty object (all fields optional)", () => {
    const result = updateArtifactSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects empty title string", () => {
    const invalidData = {
      title: "",
    };
    const result = updateArtifactSchema.safeParse(invalidData);
    expect(result.success).toBe(false);
  });
});
