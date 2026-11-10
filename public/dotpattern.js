// Vanilla port of Punto 2's <DotPattern> (aitorru/desing · src/components/DotPattern).
// Same geometry and markup, so it picks up the `.pt-dotpattern*` styles from punto.css.

const LEVELS = 5;
const DEFAULTS = {
  grid: { period: 4, falloff: 0.9 },
  fade: { period: 4, falloff: 0.6 },
  rings: { period: 6, falloff: 0.85 },
  orb: { period: 4, falloff: 0.5 },
  wave: { period: 7, falloff: 0.9 },
  diagonal: { period: 4, falloff: 1 },
};
const WAVE_COS = Math.cos(0.61);
const WAVE_SIN = Math.sin(0.61);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function frameOf(origin, cols, rows) {
  const left = origin.endsWith("left");
  const right = origin.endsWith("right");
  const top = origin.startsWith("top");
  const bottom = origin.startsWith("bottom");
  return {
    ox: left ? -0.5 : right ? cols - 0.5 : (cols - 1) / 2,
    oy: top ? -0.5 : bottom ? rows - 0.5 : (rows - 1) / 2,
    ex: left || right ? cols : cols / 2,
    ey: top || bottom ? rows : rows / 2,
    midX: !left && !right,
    midY: !top && !bottom,
  };
}

function sample(p, f, col, row) {
  const dx = col - f.ox;
  const dy = row - f.oy;
  const d = Math.hypot(dx, dy);
  const t = d / Math.max(f.ex, f.ey);
  const fade = clamp01(1 - p.falloff * t);
  const hl = p.highlight;
  switch (p.motif) {
    case "grid": {
      const major = col % p.period === 0 && row % p.period === 0;
      return [(major ? 1 : 0.45) * fade, major && Math.round(Math.max(Math.abs(dx), Math.abs(dy)) / p.period) === hl];
    }
    case "fade": {
      const lin = f.midX && f.midY ? t : (f.midX ? 0 : Math.abs(dx) / f.ex) + (f.midY ? 0 : Math.abs(dy) / f.ey);
      return [clamp01(1 - lin * (0.6 + p.falloff)) ** 1.2, false];
    }
    case "rings": {
      const w = 0.5 + 0.5 * Math.cos((2 * Math.PI * (d - p.shift * p.period)) / p.period);
      return [t > 1 ? 0 : w ** 1.6 * fade, w > 0.55 && Math.round(d / p.period - p.shift) === hl];
    }
    case "orb":
      return [t >= 1 ? 0 : (1 - t * t) ** (0.5 + p.falloff), hl != null && d < hl * p.period];
    case "wave": {
      const across = dx * WAVE_COS + dy * WAVE_SIN;
      const along = dy * WAVE_COS - dx * WAVE_SIN;
      const phase = (across + p.period * 0.6 * Math.sin(along / (p.period * 1.6))) / p.period - p.shift;
      const w = 0.5 + 0.5 * Math.cos(2 * Math.PI * phase);
      // Moving (shift ≠ 0), every 4th crest carries the accent so the loop has no seam.
      const band = Math.round(phase);
      const accented = p.shift ? hl != null && ((band % 4) + 4) % 4 === hl % 4 : Math.abs(band) === hl;
      return [w * w * fade, w > 0.6 && accented];
    }
    case "diagonal": {
      const i = Math.round(Math.abs(dx) + Math.abs(dy));
      const on = i % p.period === 0;
      return [(on ? 1 : 0.32) * fade, on && i / p.period === hl];
    }
  }
  return [0, false];
}

function paths(p, gap) {
  const base = Array.from({ length: LEVELS }, () => []);
  const accent = Array.from({ length: LEVELS }, () => []);
  const f = frameOf(p.origin, p.cols, p.rows);
  for (let row = 0; row < p.rows; row++) {
    for (let col = 0; col < p.cols; col++) {
      const [size, hi] = sample(p, f, col, row);
      const level = Math.min(LEVELS, Math.round(size * LEVELS));
      if (level > 0) (hi ? accent : base)[level - 1].push(`M${(col + 0.5) * gap} ${(row + 0.5) * gap}h.01`);
    }
  }
  return { base: base.map((l) => l.join("")), accent: accent.map((l) => l.join("")) };
}

/**
 * Returns the SVG markup of a pattern. Same props as the React component; `cols`/`rows`
 * are required here (no fill-measuring), which is all this page needs.
 */
export function dotPattern({
  motif = "rings",
  cols,
  rows,
  gap = 8,
  dot = 0.62,
  anchor,
  origin,
  period,
  falloff,
  highlight = null,
  shift = 0,
  tone = "ink",
  intensity = 0.3,
  motion = "still",
  style = "",
  className = "",
}) {
  const p = {
    motif,
    cols,
    rows,
    origin: origin ?? (motif === "orb" ? "center" : (anchor ?? "top-right")),
    period: period ?? DEFAULTS[motif].period,
    falloff: falloff ?? DEFAULTS[motif].falloff,
    highlight,
    // Page addition, not in the React component: moves `wave` and `rings` by this many periods.
    shift,
  };
  const { base, accent } = paths(p, gap);
  const layer = (list, name) =>
    `<g class="pt-dotpattern__${name}">${list
      .map((d, i) => (d ? `<path d="${d}" stroke-width="${Math.max(0.9, (gap * dot * (i + 1)) / LEVELS)}"/>` : ""))
      .join("")}</g>`;
  const cls = [
    "pt-dotpattern",
    `pt-dotpattern--${tone}`,
    anchor && `pt-dotpattern--anchored pt-dotpattern--at-${anchor}`,
    motion === "breathe" && "pt-dotpattern--breathe",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return `<svg class="${cls}" width="${cols * gap}" height="${rows * gap}" style="--pt-pattern-intensity:${intensity};${style}" aria-hidden="true" focusable="false">${layer(base, "base")}${layer(accent, "accent")}</svg>`;
}
