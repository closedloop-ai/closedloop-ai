// ArtifactVersion types for API contract

export type ArtifactVersion = {
  id: string;
  artifactId: string;
  version: number;
  content: string | null;
  createdById: string | null;
  createdAt: Date;
};
