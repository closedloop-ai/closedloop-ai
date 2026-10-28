import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";

type Row = Record<string, unknown>;
type Query = { where?: Row; data?: Row; select?: Record<string, boolean> };

// Stateful delegates evaluate the supplied predicates, including absent keys;
// they never infer tenant scope from the caller or return a canned claim count.
export function createBootstrapTestDb() {
  const tables: Record<string, Row[]> = {
    desktopBootstrapCode: [],
    organization: [],
    user: [],
    desktopSession: [],
    desktopRefreshToken: [],
  };
  const ambient = new AsyncLocalStorage<boolean>();
  let tail = Promise.resolve();
  let beforeTransaction: (() => void) | undefined;
  let failSessionCreate = false;
  function delegate(name: string) {
    return {
      findUnique({ where, select }: Query) {
        const row = tables[name].find((candidate) => matches(candidate, where));
        return Promise.resolve(row ? project(row, select) : null);
      },
      findFirst({ where, select }: Query) {
        const row = tables[name].find((candidate) => matches(candidate, where));
        return Promise.resolve(row ? project(row, select) : null);
      },
      create({ data = {}, select }: Query) {
        if (name === "desktopSession" && failSessionCreate) {
          failSessionCreate = false;
          throw new Error("session persistence failed");
        }
        const row = {
          id: `${name}-${tables[name].length + 1}`,
          active: true,
          redeemedAt: null,
          consumedAt: null,
          completedAt: null,
          organizationClerkId: null,
          ...structuredClone(data),
        };
        tables[name].push(row);
        return Promise.resolve(project(row, select));
      },
      updateMany({ where, data }: Query) {
        const rows = tables[name].filter((row) => matches(row, where));
        for (const row of rows) {
          Object.assign(row, structuredClone(data));
        }
        return Promise.resolve({ count: rows.length });
      },
      update({ where, data, select }: Query) {
        const row = tables[name].find((candidate) => matches(candidate, where));
        if (!row) {
          throw new Error("missing update target");
        }
        Object.assign(row, structuredClone(data));
        return Promise.resolve(project(row, select));
      },
      deleteMany({ where }: Query) {
        const before = tables[name].length;
        tables[name] = tables[name].filter((row) => !matches(row, where));
        return Promise.resolve({ count: before - tables[name].length });
      },
      async upsert({
        where,
        create,
        update,
        select,
      }: {
        where: Row;
        create: Row;
        update: Row;
        select?: Record<string, boolean>;
      }) {
        const row = tables[name].find((candidate) => matches(candidate, where));
        if (row) {
          Object.assign(row, structuredClone(update));
          return project(row, select);
        }
        return await this.create({ data: create, select });
      },
    };
  }
  const db = {
    desktopBootstrapCode: delegate("desktopBootstrapCode"),
    organization: delegate("organization"),
    user: delegate("user"),
    desktopSession: delegate("desktopSession"),
    desktopRefreshToken: delegate("desktopRefreshToken"),
  };
  async function withDb<T>(run: (client: typeof db) => T): Promise<Awaited<T>> {
    return await run(db);
  }
  async function tx<T>(run: (client: typeof db) => Promise<T>): Promise<T> {
    if (ambient.getStore()) {
      return await run(db);
    }
    const previous = tail;
    let release = () => {};
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    beforeTransaction?.();
    beforeTransaction = undefined;
    const snapshot = structuredClone(tables);
    try {
      return await ambient.run(true, () => run(db));
    } catch (error) {
      Object.assign(tables, snapshot);
      throw error;
    } finally {
      release();
    }
  }
  return {
    tables,
    db,
    withDb: Object.assign(withDb, { tx }),
    reset() {
      for (const name of Object.keys(tables)) {
        tables[name] = [];
      }
      beforeTransaction = undefined;
      failSessionCreate = false;
    },
    beforeNextTransaction(run: () => void) {
      beforeTransaction = run;
    },
    failNextSessionCreate() {
      failSessionCreate = true;
    },
  };
}

function project(row: Row, select?: Record<string, boolean>): Row {
  if (!select) {
    return structuredClone(row);
  }
  return structuredClone(
    Object.fromEntries(
      Object.keys(select)
        .filter((key) => select[key])
        .map((key) => [key, row[key]])
    )
  );
}

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value === undefined) {
      return true;
    }
    if (key === "OR" && Array.isArray(value)) {
      return value.some((part) => matches(row, part));
    }
    if (key === "clerkId_organizationId") {
      return matches(row, value as Row);
    }
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const filter = value as Row;
      return Object.entries(filter).every(([operator, operand]) => {
        if (operator === "not") {
          return !isDeepStrictEqual(row[key], operand);
        }
        const actual = row[key];
        if (!(actual instanceof Date && operand instanceof Date)) {
          throw new Error(`unsupported predicate ${key}.${operator}`);
        }
        if (operator === "gt") {
          return actual > operand;
        }
        if (operator === "lte") {
          return actual <= operand;
        }
        throw new Error(`unsupported predicate ${operator}`);
      });
    }
    return isDeepStrictEqual(row[key], value);
  });
}

export const bootstrapTestDb = createBootstrapTestDb();
