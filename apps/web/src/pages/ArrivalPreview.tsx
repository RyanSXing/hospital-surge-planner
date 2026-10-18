import { useElementSize } from "@mantine/hooks";
import { localDate, fmt } from "../api";
import { plannedArrivals } from "./plannedArrivalSeries";
import type { ArrivalPreviewOptions } from "./plannedArrivalSeries";

export default function ArrivalPreview(options: ArrivalPreviewOptions) {
  const { ref, width } = useElementSize();
  const W = Math.max(200, Math.round(width || 640)),
    H = 230;
  const points = plannedArrivals(options);
  const high = Math.max(
    options.baselineRate,
    ...points.map((point) => point.planned),
    ...points.map((point) => point.baseline),
    1,
  );
  const ceiling = Math.ceil((high * 1.18) / 10) * 10;
  const left = 48,
    right = W - 14,
    top = 20,
    bottom = H - 36;
  const x = (index: number) =>
    left + ((right - left) * index) / Math.max(1, points.length - 1);
  const y = (value: number) => bottom - ((bottom - top) * value) / ceiling;
  const plannedPath = points
    .map(
      (point, index) => `${index ? "L" : "M"}${x(index)},${y(point.planned)}`,
    )
    .join(" ");
  const path =
    points.length === 1
      ? `${plannedPath} L${right},${y(points[0].planned)}`
      : plannedPath;
  const baselinePath = points
    .map(
      (point, index) => `${index ? "L" : "M"}${x(index)},${y(point.baseline)}`,
    )
    .join(" ");
  const usual =
    points.reduce((sum, point) => sum + point.baseline, 0) /
    Math.max(1, points.length);
  const average =
    points.reduce((sum, point) => sum + point.planned, 0) /
    Math.max(1, points.length);
  const dates = [
    ...new Set(
      W < 350
        ? [0, points.length - 1]
        : [0, Math.floor((points.length - 1) / 2), points.length - 1],
    ),
  ];
  return (
    <section
      className="arrival-preview"
      aria-labelledby="arrival-preview-heading"
    >
      <div className="arrival-preview-heading">
        <div>
          <h3 id="arrival-preview-heading">Expected daily arrivals</h3>
          <p>
            {options.stream === "ED_MAIN"
              ? "Emergency department"
              : "Direct hospital admissions"}
          </p>
        </div>
        <span className="preview-live">
          <i aria-hidden="true" />
          Updates as you edit
        </span>
      </div>
      <div className="arrival-preview-plot" ref={ref}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Planned arrivals over ${options.days} ${options.days === 1 ? "day" : "days"}. Average ${Math.round(average)} patients per day; usual ${Math.round(usual)}.`}
          data-testid="arrival-preview-chart"
          data-usual-arrivals={points
            .map((point) => point.baseline.toFixed(2))
            .join(",")}
          data-planned-arrivals={points
            .map((point) => point.planned.toFixed(2))
            .join(",")}
        >
          <title>Planned arrivals compared with usual arrivals</title>
          {[0, 1, 2, 3, 4].map((tick) => {
            const value = (ceiling * tick) / 4;
            return (
              <g key={tick}>
                <line
                  x1={left}
                  x2={right}
                  y1={y(value)}
                  y2={y(value)}
                  stroke="#e6edf3"
                />
                <text x={left - 10} y={y(value) + 4} textAnchor="end">
                  {fmt(value, 0)}
                </text>
              </g>
            );
          })}
          <path
            d={`${path} L${right},${bottom} L${left},${bottom} Z`}
            fill="#e8f2fc"
          />
          <path
            d={
              points.length === 1
                ? `${baselinePath} L${right},${y(points[0].baseline)}`
                : baselinePath
            }
            fill="none"
            stroke="#8495a7"
            strokeWidth={1.5}
            strokeDasharray="5 5"
          />
          <path
            d={path}
            fill="none"
            stroke="#2378bf"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {points.length <= 30 &&
            points.map((point, index) => (
              <circle
                key={point.at}
                cx={x(index)}
                cy={y(point.planned)}
                r={3}
                fill="#fff"
                stroke="#2378bf"
                strokeWidth={2}
              />
            ))}
          {dates.map((index) => (
            <text
              key={index}
              x={points.length === 1 ? (left + right) / 2 : x(index)}
              y={bottom + 27}
              textAnchor={
                index === 0 && points.length > 1
                  ? "start"
                  : index === points.length - 1 && points.length > 1
                    ? "end"
                    : "middle"
              }
            >
              {localDate(points[index].at, {
                month: "short",
                day: "numeric",
                timeZone: options.timeZone,
              })}
            </text>
          ))}
        </svg>
      </div>
      <div className="arrival-preview-footer">
        <div className="arrival-preview-legend">
          <span>
            <i />
            Your plan
          </span>
          <span>
            <i />
            Usual arrivals
          </span>
        </div>
        <p>
          <strong>{fmt(average, 0)}</strong> patients / day on average
        </p>
      </div>
    </section>
  );
}
