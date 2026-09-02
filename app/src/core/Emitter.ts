/**
 * The subscribe/notify half of every store in the app.
 *
 * Seven classes each grew their own copy of `new Set()` + `subscribe()` +
 * a notify loop, and the copies had already drifted: some iterated with
 * `forEach` and some with `for…of`, and five of them returned
 * `() => this.listeners.delete(listener)` — an unsubscribe whose declared
 * `void` return is really a `boolean`, which is the kind of thing that only
 * stays harmless until someone chains onto it.
 *
 * Deliberately does NOT replay the current value on subscribe. Two of the
 * subscribers here want that and five do not, and a flag for it would put the
 * decision somewhere further from the store than the one line that makes it.
 */
export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
