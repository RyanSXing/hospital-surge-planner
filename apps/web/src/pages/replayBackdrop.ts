/**
 * Original, deterministic canvas artwork authored for Hospital Surge Planner.
 * The supplied 06-visual-patient-flow-replay.png informed the navy architectural
 * style only. No image, tile, floor plan, or third-party geometry is embedded.
 * Rooms, streets and planting are decorative synthetic context, never capacity,
 * staff, beds, geographic scale, or clinical routes. Recorded overlays own those.
 */
const surfaces = new Map<string, HTMLCanvasElement>();

type Rect = readonly [number, number, number, number];

function paintBlueprint(g: CanvasRenderingContext2D) {
  g.fillStyle = "#0b1b25";
  g.fillRect(0, 0, 1000, 620);

  // A quiet survey grid sits below the original campus geometry.
  g.strokeStyle = "rgba(89, 123, 141, 0.075)";
  g.lineWidth = 0.5;
  g.beginPath();
  for (let x = 0; x <= 1000; x += 25) {
    g.moveTo(x, 0);
    g.lineTo(x, 620);
  }
  for (let y = 0; y <= 620; y += 25) {
    g.moveTo(0, y);
    g.lineTo(1000, y);
  }
  g.stroke();

  // Service street and pedestrian edge; no operational vehicles or flow icons.
  g.fillStyle = "#152732";
  g.fillRect(0, 0, 27, 620);
  g.fillRect(0, 598, 1000, 22);
  g.strokeStyle = "#364d59";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(29.5, 0);
  g.lineTo(29.5, 594.5);
  g.lineTo(1000, 594.5);
  g.stroke();
  g.strokeStyle = "rgba(157, 180, 189, 0.23)";
  g.setLineDash([12, 12]);
  g.beginPath();
  g.moveTo(12.5, 8);
  g.lineTo(12.5, 609);
  g.lineTo(1000, 609);
  g.stroke();
  g.setLineDash([]);

  function pavedCourt(x: number, y: number, w: number, h: number) {
    g.fillStyle = "#122732";
    g.fillRect(x, y, w, h);
    g.strokeStyle = "rgba(104, 137, 151, 0.17)";
    g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    g.strokeStyle = "rgba(106, 137, 148, 0.07)";
    g.beginPath();
    for (let row = y + 12; row < y + h; row += 12) {
      g.moveTo(x, row);
      g.lineTo(x + w, row);
    }
    for (let col = x + 16; col < x + w; col += 16) {
      g.moveTo(col, y);
      g.lineTo(col, y + h);
    }
    g.stroke();
  }
  pavedCourt(38, 119, 119, 299);
  pavedCourt(421, 174, 196, 182);

  function building([x, y, w, h]: Rect) {
    g.fillStyle = "rgba(2, 10, 16, 0.48)";
    g.fillRect(x + 5, y + 6, w, h);
    const roof = g.createLinearGradient(x, y, x + w * 0.45, y + h);
    roof.addColorStop(0, "#243946");
    roof.addColorStop(1, "#172b37");
    g.fillStyle = roof;
    g.fillRect(x, y, w, h);
    g.strokeStyle = "#0b1a23";
    g.lineWidth = 5;
    g.strokeRect(x + 2.5, y + 2.5, w - 5, h - 5);
    g.lineWidth = 1;
    g.strokeStyle = "rgba(149, 175, 188, 0.30)";
    g.beginPath();
    g.moveTo(x + 3, y + h - 3);
    g.lineTo(x + 3, y + 3);
    g.lineTo(x + w - 3, y + 3);
    g.stroke();
    g.strokeStyle = "rgba(122, 151, 165, 0.17)";
    g.strokeRect(x + 8.5, y + 8.5, w - 17, h - 17);
  }

  const wings: Rect[] = [
    [171, 26, 243, 104],
    [171, 140, 243, 270],
    [171, 424, 243, 165],
    [425, 26, 191, 137],
    [425, 367, 191, 222],
    [636, 22, 342, 233],
    [636, 302, 184, 204],
    [830, 283, 148, 152],
    [830, 452, 148, 137],
  ];
  wings.forEach(building);

  // Thin partitions imply architecture without inventing usable clinical places.
  function partition([x, y, w, h]: Rect, door: "bottom" | "right" = "bottom") {
    g.fillStyle = "rgba(8, 23, 32, 0.19)";
    g.fillRect(x, y, w, h);
    g.strokeStyle = "rgba(111, 143, 158, 0.28)";
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    g.strokeStyle = "rgba(4, 15, 22, 0.65)";
    g.lineWidth = 2;
    g.beginPath();
    if (door === "bottom") {
      g.moveTo(x + w * 0.45, y + h - 0.5);
      g.lineTo(x + w * 0.45 + 10, y + h - 0.5);
    } else {
      g.moveTo(x + w - 0.5, y + h * 0.45);
      g.lineTo(x + w - 0.5, y + h * 0.45 + 10);
    }
    g.stroke();
  }
  const rooms: Rect[] = [
    [184, 39, 60, 77],
    [250, 39, 69, 77],
    [325, 39, 75, 77],
    [184, 153, 57, 48],
    [247, 153, 92, 48],
    [345, 153, 55, 48],
    [184, 212, 57, 59],
    [184, 281, 57, 57],
    [184, 348, 57, 48],
    [347, 212, 53, 59],
    [347, 281, 53, 57],
    [347, 348, 53, 48],
    [438, 39, 72, 50],
    [516, 39, 86, 50],
    [438, 98, 49, 51],
    [494, 98, 108, 51],
    [650, 35, 59, 52],
    [716, 35, 74, 52],
    [797, 35, 71, 52],
    [875, 35, 89, 52],
    [650, 198, 79, 43],
    [736, 198, 63, 43],
    [806, 198, 74, 43],
    [887, 198, 77, 43],
    [184, 438, 61, 50],
    [252, 438, 73, 50],
    [332, 438, 68, 50],
    [184, 522, 64, 53],
    [255, 522, 76, 53],
    [338, 522, 62, 53],
    [438, 381, 74, 51],
    [519, 381, 83, 51],
    [438, 530, 68, 45],
    [513, 530, 89, 45],
    [650, 316, 65, 49],
    [722, 316, 84, 49],
    [650, 443, 72, 49],
    [729, 443, 77, 49],
    [843, 296, 48, 55],
    [898, 296, 66, 55],
    [843, 363, 121, 58],
    [843, 466, 47, 53],
    [897, 466, 67, 53],
    [843, 531, 121, 44],
  ];
  rooms.forEach((room, index) =>
    partition(room, index % 3 ? "bottom" : "right"),
  );

  // Aligned corridor edges remain visible around the recorded flow overlay.
  const corridor = () => {
    g.beginPath();
    g.moveTo(145, 265);
    g.lineTo(623, 265);
    g.lineTo(623, 405);
    g.lineTo(840, 405);
    g.lineTo(840, 520);
    g.moveTo(295, 370);
    g.lineTo(295, 445);
    g.moveTo(623, 265);
    g.lineTo(623, 74);
  };
  g.lineCap = "square";
  g.lineJoin = "miter";
  g.strokeStyle = "#071720";
  g.lineWidth = 43;
  corridor();
  g.stroke();
  g.strokeStyle = "rgba(132, 162, 176, 0.24)";
  g.lineWidth = 36;
  corridor();
  g.stroke();
  g.strokeStyle = "#1b303c";
  g.lineWidth = 33;
  corridor();
  g.stroke();

  // A central light well and a planted perimeter add restrained surface depth.
  pavedCourt(443, 447, 153, 68);
  g.fillStyle = "#112a30";
  g.fillRect(456, 459, 127, 43);
  g.strokeStyle = "rgba(86, 127, 133, 0.25)";
  g.strokeRect(455.5, 458.5, 128, 44);

  function tree(x: number, y: number, radius: number) {
    g.fillStyle = "rgba(3, 14, 19, 0.4)";
    g.beginPath();
    g.ellipse(x + 2, y + 3, radius, radius * 0.8, 0, 0, Math.PI * 2);
    g.fill();
    for (let leaf = 0; leaf < 6; leaf++) {
      const angle = (leaf * Math.PI) / 3;
      const offset = radius * 0.28;
      g.fillStyle = leaf % 2 ? "#223e3c" : "#1c3535";
      g.beginPath();
      g.arc(
        x + Math.cos(angle) * offset,
        y + Math.sin(angle) * offset,
        radius * 0.65,
        0,
        Math.PI * 2,
      );
      g.fill();
    }
    g.fillStyle = "rgba(91, 128, 110, 0.16)";
    g.beginPath();
    g.arc(x - radius * 0.18, y - radius * 0.22, radius * 0.35, 0, Math.PI * 2);
    g.fill();
  }
  for (let index = 0; index < 16; index++) {
    const y = 23 + index * 36;
    if (y < 120 || y > 422) tree(148, y, 6 + (index % 3));
  }
  for (let index = 0; index < 9; index++)
    tree(47 + index * 11, 77 + (index % 2) * 13, 7);
  for (let index = 0; index < 8; index++)
    tree(45 + index * 12, 489 + (index % 3) * 20, 6 + (index % 2));
  for (let index = 0; index < 6; index++) tree(466 + index * 21, 481, 5);
  for (let index = 0; index < 12; index++)
    tree(38 + index * 79, 586, 4 + (index % 3));

  // Fine corner registration marks, not a geographic scale or a capacity key.
  g.strokeStyle = "rgba(141, 173, 186, 0.30)";
  g.lineWidth = 1;
  for (const [x, y, dx, dy] of [
    [37, 18, 1, 1],
    [986, 18, -1, 1],
    [37, 586, 1, -1],
    [986, 586, -1, -1],
  ]) {
    g.beginPath();
    g.moveTo(x + dx * 8, y);
    g.lineTo(x, y);
    g.lineTo(x, y + dy * 8);
    g.stroke();
  }
}

/** Paint a cached synthetic architectural backdrop beneath recorded overlays. */
export function drawReplayBackdrop(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
): void {
  if (
    typeof document === "undefined" ||
    !Number.isFinite(W) ||
    !Number.isFinite(H) ||
    W <= 0 ||
    H <= 0
  )
    return;
  const width = Math.ceil(W),
    height = Math.ceil(H);
  const key = `${width}x${height}`;
  let surface = surfaces.get(key);
  if (!surface) {
    surface = document.createElement("canvas");
    surface.width = width;
    surface.height = height;
    const brush = surface.getContext("2d");
    if (!brush) return;
    brush.scale(width / 1000, height / 620);
    paintBlueprint(brush);
    // Bound retained surfaces if a future viewport passes different dimensions.
    if (surfaces.size >= 3) surfaces.delete(surfaces.keys().next().value!);
    surfaces.set(key, surface);
  }
  ctx.drawImage(surface, 0, 0, W, H);
}
