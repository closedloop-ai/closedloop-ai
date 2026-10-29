export const RELAY_PORT = Number(
  process.env.RELAY_PORT ?? process.env.MCP_PORT ?? "3020"
);

export const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
export const VERCEL_API_URL = process.env.CLOSEDLOOP_API_URL;
