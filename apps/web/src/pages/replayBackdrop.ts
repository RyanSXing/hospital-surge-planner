/**
 * Original deterministic campus illustration. Geographic reference: Vanderbilt
 * University Medical Center,1211 Medical Center Drive,Nashville,TN37232.
 * Official source: https://www.vanderbilthealth.com/locations/vanderbilt-university-medical-center
 * The adult ED is west of Medical Center Dr; East Garage is across that street:
 * https://www.vanderbilthealth.com/locations/vanderbilt-emergency-department
 * Buildings and care-zone geometry are schematic, not a Vanderbilt floor plan.
 * No actual patient locations, operational counts, tiles or third-party artwork.
 */
const surfaces = new Map<string, HTMLCanvasElement>();

function paintCampus(g: CanvasRenderingContext2D) {
  g.fillStyle = "#f6f9fb";
  g.fillRect(0, 0, 1000, 620);
  // Local campus context replaces a region-wide or decorative city grid.
  g.fillStyle = "#edf4ed";
  g.beginPath();
  g.roundRect(18, 18, 160, 120, 22);
  g.fill();
  g.fillStyle = "#dceadf";
  for (const [x, y, r] of [
    [45, 45, 14],
    [82, 34, 12],
    [130, 56, 18],
    [58, 102, 16],
    [135, 106, 12],
  ]) {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = "#e7edf1";
  g.beginPath();
  g.roundRect(186, 35, 626, 545, 24);
  g.fill();
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.roundRect(197, 46, 604, 523, 18);
  g.fill();
  g.strokeStyle = "#d3dfe6";
  g.lineWidth = 1;
  g.stroke();
  // Medical Center Drive at the campus edge and its east-side parking context.
  g.fillStyle = "#e2e8ec";
  g.fillRect(966, 0, 34, 620);
  g.strokeStyle = "#fff";
  g.lineWidth = 2;
  g.setLineDash([9, 9]);
  g.beginPath();
  g.moveTo(983, 0);
  g.lineTo(983, 620);
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = "#ebf0f3";
  g.fillRect(0, 590, 1000, 30);
  g.fillStyle = "#536b7d";
  g.font = "11px system-ui";
  g.fillText("VANDERBILT CAMPUS · NASHVILLE", 219, 70);
  g.fillText("Medical Center Drive · schematic campus edge", 602, 609);
  g.save();
  g.translate(975, 290);
  g.rotate(-Math.PI / 2);
  g.fillText("MEDICAL CENTER DR", 0, 0);
  g.restore();
  g.fillStyle = "#536b7d";
  g.font = "10px system-ui";
  g.fillText("N", 33, 162);
  g.strokeStyle = "#536b7d";
  g.lineWidth = 1.2;
  g.beginPath();
  g.moveTo(37, 183);
  g.lineTo(37, 168);
  g.moveTo(32, 173);
  g.lineTo(37, 168);
  g.lineTo(42, 173);
  g.stroke();
}

export function drawReplayBackdrop(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  if (typeof document === "undefined") return;
  // Keep geometry cached; animation frames only composite this static surface.
  const key = `${Math.round(width)}:${Math.round(height)}`;
  let surface = surfaces.get(key);
  if (!surface) {
    surface = document.createElement("canvas");
    surface.width = Math.round(width);
    surface.height = Math.round(height);
    const g = surface.getContext("2d");
    if (!g) return;
    g.scale(width / 1000, height / 620);
    paintCampus(g);
    if (surfaces.size >= 4) surfaces.delete(surfaces.keys().next().value!);
    surfaces.set(key, surface);
  }
  ctx.drawImage(surface, 0, 0, width, height);
}
