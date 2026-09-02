/** Resolves after `ms`. Defined once; three modules had their own copy. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
