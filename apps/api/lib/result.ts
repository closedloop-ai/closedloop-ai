export const Status = {
  Forbidden: 403,
  BadRequest: 400,
  Unauthorized: 401,
  NotFound: 404,
  Error: 500,
} as const;

export type Result<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      status: (typeof Status)[keyof typeof Status];
    };

export const Result = {
  ok: <T>(value: T): Result<T> => ({ ok: true, value }),
  err: <T>(status: (typeof Status)[keyof typeof Status]): Result<T> => ({
    ok: false,
    status,
  }),
} as const;
