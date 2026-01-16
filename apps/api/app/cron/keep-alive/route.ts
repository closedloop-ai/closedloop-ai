import { database } from "@repo/database";

export const GET = async () => {
  // Simple database ping to keep connection alive
  await database.$queryRaw`SELECT 1`;
  return new Response("OK", { status: 200 });
};
