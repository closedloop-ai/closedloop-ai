/**
 * A simple LRU-style bounded Map that evicts the oldest entries
 * when the maximum size is exceeded. Relies on Map iteration order
 * (insertion order) — re-setting a key refreshes its position.
 */
export class BoundedCache<K, V> extends Map<K, V> {
  private readonly maxSize: number;

  constructor(maxSize: number) {
    super();
    this.maxSize = maxSize;
  }

  override set(key: K, value: V): this {
    // Refresh insertion order for existing keys
    if (this.has(key)) {
      super.delete(key);
    } else if (this.size >= this.maxSize) {
      const oldest = this.keys().next().value;
      if (oldest !== undefined) {
        super.delete(oldest);
      }
    }
    return super.set(key, value);
  }
}
