import { z } from "zod";

export const setApiKeyValidator = z.object({
  key: z
    .string()
    .min(1, "API key is required")
    .max(500, "API key is too long")
    .regex(/^sk-ant-/, "API key must start with 'sk-ant-'"),
});
