export const Status = {
  Forbidden: 403,
  BadRequest: 400,
  Unauthorized: 401,
  NotFound: 404,
  Conflict: 409,
  Error: 500,
  /**
   * A dependency the request needed could not be reached, so the server could
   * not decide the request at all. Distinct from `Forbidden`, which IS a
   * decision (ISS-8661).
   */
  ServiceUnavailable: 503,
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
