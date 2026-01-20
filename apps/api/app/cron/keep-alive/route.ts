import { database, ensureDatabase } from "@repo/database";

export const GET = async () => {
  await ensureDatabase();
  // Simple database ping to keep connection alive
  await database.$queryRaw`SELECT 1`;
  return new Response("OK", { status: 200 });
};
