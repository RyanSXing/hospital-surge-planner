import type { Ref } from "react";
import "./aegisBrand.css";

export interface AegisLogoProps {
  variant?: "wordmark" | "symbol";
  className?: string;
  ref?: Ref<SVGSVGElement>;
  decorative?: boolean;
}
/** Display crops of the supplied artwork without modifying its source pixels. */
export default function AegisLogo({
  variant = "wordmark",
  className = "",
  ref,
  decorative = variant === "symbol",
}: AegisLogoProps) {
  const symbol = variant === "symbol";
  return (
    <svg
      ref={ref}
      className={`aegis-logo aegis-logo--${variant} ${className}`}
      viewBox={symbol ? "245 120 610 430" : "80 610 950 113"}
      width={symbol ? 610 : 950}
      height={symbol ? 430 : 113}
      preserveAspectRatio="xMidYMid meet"
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : "AEGIS"}
      aria-hidden={decorative ? true : undefined}
      focusable="false"
    >
      {!decorative && <title>AEGIS</title>}
      <image
        href="/assets/aegis-logo.png"
        x="0"
        y="0"
        width="1114"
        height="874"
        preserveAspectRatio="xMinYMin meet"
      />
    </svg>
  );
}
