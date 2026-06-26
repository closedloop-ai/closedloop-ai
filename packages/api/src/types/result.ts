export const Status = {
  Forbidden: 403,
  BadRequest: 400,
  Unauthorized: 401,
  NotFound: 404,
  Conflict: 409,
  Error: 500,
} as const;

export type StatusCode = (typeof Status)[keyof typeof Status];

export type Result<T, E = StatusCode> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const Result = {
  ok<T, E = StatusCode>(value: T): Result<T, E> {
    return { ok: true, value };
  },
  err<T, E = StatusCode>(error: E): Result<T, E> {
    return { ok: false, error };
  },
} as const;
