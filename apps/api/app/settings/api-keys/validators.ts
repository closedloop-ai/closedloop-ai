import { z } from "zod";

export const setApiKeyValidator = z.object({
  key: z.string().min(1, "API key is required"),
});
