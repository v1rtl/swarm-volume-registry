/** Split into fixed-size chunks, preserving order. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error(`chunk size must be >= 1, got ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
