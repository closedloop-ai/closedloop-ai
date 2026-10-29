/** Rejects with {@link DeadlineExceeded} when `promise` has not settled in `ms`. */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded(ms)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export class DeadlineExceeded extends Error {
  constructor(ms: number) {
    super(`No answer within ${ms} ms`);
    this.name = "DeadlineExceeded";
  }
}
