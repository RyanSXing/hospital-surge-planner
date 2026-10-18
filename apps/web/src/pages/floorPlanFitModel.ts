export interface FloorPlanFitSize {
  viewportWidth: number;
  viewportHeight: number;
  contentWidth: number;
  contentHeight: number;
}

/** Fit the complete measured map, reserving a pixel for rounded browser bounds. */
export function floorPlanFitScale({
  viewportWidth,
  viewportHeight,
  contentWidth,
  contentHeight,
}: FloorPlanFitSize): number {
  if (
    [viewportWidth, viewportHeight, contentWidth, contentHeight].some(
      (value) => !Number.isFinite(value) || value <= 0,
    )
  )
    return 1;
  const scale = Math.min(
    1,
    Math.max(0, viewportWidth - 1) / contentWidth,
    Math.max(0, viewportHeight - 1) / contentHeight,
  );
  return Math.max(0.0001, Math.floor(scale * 10000) / 10000);
}

export function floorPlanNaturalWidth(viewportWidth: number): number {
  return Number.isFinite(viewportWidth)
    ? Math.max(1000, Math.floor(viewportWidth))
    : 1000;
}
