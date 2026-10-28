// Mock singletons + module-mock factories for the agent-sessions test
// suites. This file must import nothing but vitest: it is dynamically
// imported inside vi.mock factories, so any app import here would
// deadlock the mock registry (factory -> app module -> mocked module).
import { type Mock, vi } from "vitest";

export const mocks: {
  anyNull: symbol;
  dbNull: symbol;
  withDb: Mock & { tx: Mock };
  emitTelemetryMetric: Mock;
} = {
  // ISS-9859: distinct from `dbNull`, because a NULL-safe JSON-path filter uses
  // both and a test that cannot tell them apart proves neither.
  anyNull: Symbol("any-null"),
  dbNull: Symbol("db-null"),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  emitTelemetryMetric: vi.fn(),
};

/**
 * A minimal `Prisma.sql` fragment stand-in: exposes `.sql` (composed text with
 * `?` placeholders), `.strings` (the raw template chunks), and `.values` (the
 * flattened bound parameters) so tests can introspect the composed query without
 * a real Postgres driver. Faithful enough for `Prisma.sql`/`Prisma.join`
 * composition and the FEA-4276 reconciled-cost reader's raw aggregate.
 */
type SqlFragment = { sql: string; strings: string[]; values: unknown[] };

function isSqlFragment(value: unknown): value is SqlFragment {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as SqlFragment).strings) &&
    Array.isArray((value as SqlFragment).values)
  );
}

function sqlTag(
  strings: TemplateStringsArray | readonly string[],
  ...expressions: unknown[]
): SqlFragment {
  const parts: string[] = [strings[0] ?? ""];
  const values: unknown[] = [];
  for (const [index, expression] of expressions.entries()) {
    if (isSqlFragment(expression)) {
      // Splice a nested fragment's text/params inline (e.g. Prisma.join output).
      const merged = `${parts.pop() ?? ""}${expression.sql}${
        strings[index + 1] ?? ""
      }`;
      parts.push(merged);
      values.push(...expression.values);
    } else {
      values.push(expression);
      parts.push(strings[index + 1] ?? "");
    }
  }
  return { sql: parts.join("?"), strings: [...strings], values };
}

function sqlJoin(fragments: readonly unknown[], separator = ","): SqlFragment {
  const texts: string[] = [];
  const values: unknown[] = [];
  for (const fragment of fragments) {
    if (isSqlFragment(fragment)) {
      texts.push(fragment.sql);
      values.push(...fragment.values);
    } else {
      texts.push("?");
      values.push(fragment);
    }
  }
  return { sql: texts.join(separator), strings: texts, values };
}

export function databaseModuleMock(): {
  ArtifactType: {
    DOCUMENT: string;
    BRANCH: string;
    SESSION: string;
  };
  GitHubInstallationStatus: { ACTIVE: string };
  Prisma: {
    AnyNull: symbol;
    DbNull: symbol;
    empty: ReturnType<typeof sqlTag>;
    sql: typeof sqlTag;
    raw: (text: string) => SqlFragment;
    join: typeof sqlJoin;
    TransactionIsolationLevel: { RepeatableRead: string };
  };
  withDb: Mock & { tx: Mock };
} {
  return {
    // Mirrors the Prisma `ArtifactType` enum values used by the session-detail
    // select (records.ts filters the artifact-link lane by target type).
    ArtifactType: {
      DOCUMENT: "DOCUMENT",
      BRANCH: "BRANCH",
      SESSION: "SESSION",
    },
    GitHubInstallationStatus: {
      ACTIVE: "ACTIVE",
    },
    Prisma: {
      AnyNull: mocks.anyNull,
      DbNull: mocks.dbNull,
      empty: sqlTag([""] as const),
      sql: sqlTag,
      // Prisma.raw: literal text, no bound values.
      raw: (text: string) => sqlTag([text]),
      join: sqlJoin,
      // ISS-6892: the sorted list paths open their page read at
      // `RepeatableRead` so the count and the streamed page share one snapshot
      // (`withSessionListSnapshot`). Mirrors the Prisma enum member by value.
      TransactionIsolationLevel: { RepeatableRead: "RepeatableRead" },
    },
    withDb: mocks.withDb,
  };
}

export function telemetryModuleMock(): { emitTelemetryMetric: Mock } {
  return { emitTelemetryMetric: mocks.emitTelemetryMetric };
}
