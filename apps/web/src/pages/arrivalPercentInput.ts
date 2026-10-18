/** NumberInput keeps incomplete text while a person is still typing. */
export function completeArrivalPercent(value: number | string): number | null {
  if (typeof value === "string" && !/^-?(?:\d+|\d*\.\d+)$/.test(value))
    return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function clampArrivalPercent(value: number): number {
  return Math.max(-100, Math.min(10000, value));
}
