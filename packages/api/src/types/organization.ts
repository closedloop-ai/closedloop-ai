import type { JsonObject } from "./common";

export type Organization = {
  id: string;
  clerkId: string;
  name: string;
  slug: string;
  active: boolean;
  settings: JsonObject;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateOrganizationInput = {
  clerkId: string;
  name: string;
  slug: string;
};

export type UpdateOrganizationInput = {
  id: string;
  name?: string;
  slug?: string;
  settings?: JsonObject;
  active?: boolean;
};
