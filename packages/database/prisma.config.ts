import path from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "prisma/config";
import { keys } from "./keys";

dotenv.config({ path: path.resolve(__dirname, ".env") });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: keys().DATABASE_URL,
  },
});
