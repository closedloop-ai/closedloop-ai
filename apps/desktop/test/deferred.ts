export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
