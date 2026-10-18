/** A single aggregate is one observation, centered rather than an invisible line. */
export function forecastXDomain(count: number): [number, number] {
  return count === 1 ? [-0.5, 0.5] : [0, Math.max(1, count - 1)];
}

/** Isolated observations need a marker because an SVG move has no visible stroke. */
export function isolatedForecastIndexes<T>(
  rows: T[],
  isValid: (row: T) => boolean,
): number[] {
  return rows.flatMap((row, index) =>
    isValid(row) && !isValid(rows[index - 1]) && !isValid(rows[index + 1])
      ? [index]
      : [],
  );
}
