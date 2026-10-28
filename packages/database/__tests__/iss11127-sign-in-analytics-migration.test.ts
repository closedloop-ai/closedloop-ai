import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { migrationsToPrestampForPreview } from "../scripts/preview-heavy-migrations";

const statements = readFileSync(
  new URL(
    "../prisma/migrations/20261001220000_add_desktop_sign_in_analytics_attempt/migration.sql",
    import.meta.url
  ),
  "utf8"
).split(";");
it("keeps first-write-wins challenge identity and an indexed expiry cleanup path", () => {
  const table = statements.find((statement) =>
    statement.includes('CREATE TABLE "desktop_sign_in_analytics_attempt"')
  );
  expect(table).toContain('"challenge_hash" TEXT NOT NULL');
  expect(table).toContain('"flow_id" UUID NOT NULL');
  expect(table).toContain('PRIMARY KEY ("challenge_hash")');
  expect(table).toContain(
    '"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP'
  );
  expect(table).toContain('"expires_at" TIMESTAMP(3) NOT NULL');
  expect(table).not.toContain('"user_id"');
  const expiryIndex = readFileSync(
    new URL(
      "../prisma/migrations/20261001220001_desktop_sign_in_analytics_attempt_expiry_index/migration.sql",
      import.meta.url
    ),
    "utf8"
  )
    .split(";")
    .find((statement) =>
      statement.includes(
        'CREATE INDEX CONCURRENTLY "desktop_sign_in_analytics_attempt_expires_at_idx"'
      )
    );
  expect(expiryIndex).not.toContain("IF NOT EXISTS");
  expect(expiryIndex).toContain(
    'ON "desktop_sign_in_analytics_attempt"("expires_at")'
  );
});

it("skips only the expiry index on fresh and existing preview schemas", () => {
  for (const freshSchema of [false, true]) {
    const prestamped = migrationsToPrestampForPreview("preview_iss11127", {
      freshSchema,
    });
    expect(prestamped).toContain(
      "20261001220001_desktop_sign_in_analytics_attempt_expiry_index"
    );
    expect(prestamped).not.toContain(
      "20261001220000_add_desktop_sign_in_analytics_attempt"
    );
  }
});
