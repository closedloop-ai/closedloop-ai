import pg from "pg";

export function createSslClient(databaseUrl: string) {
  const url = new URL(databaseUrl);
  url.searchParams.delete("sslmode");
  return new pg.Client({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: false },
  });
}

export function quoteIdentifier(value: string) {
  return `"${String(value).replace(/"/g, '""')}"`;
}
