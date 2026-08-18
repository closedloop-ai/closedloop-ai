/**
 * Bounds a promise with a deadline.
 *
 * This does not CANCEL the underlying work — Octokit's App-auth path builds its
 * own client, so there is no request signal to thread through it. What it
 * guarantees is that the caller stops WAITING, which is the property this cron's
 * budget needs: a hung GitHub call must not consume the time reserved for
 * reporting that the tick failed.
 *
 * Lives in its own module because both the route (auth and the four GitHub
 * reads) and the never-scheduled reporting (the job-probe phase) bound work with
 * it, and a second copy of a timer this subtle would drift invisibly.
 */
export function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  onTimeout: () => T
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
