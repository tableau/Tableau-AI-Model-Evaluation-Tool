/**
 * CIEDE2000 color-difference (Delta-E) plus the sRGB->XYZ->Lab chain and the
 * ColorPaletteDistinguishability aggregation.
 *
 * The reference implementation uses colour-science:
 *   sRGB(0-1) -> colour.sRGB_to_XYZ -> colour.XYZ_to_Lab -> delta_E_CIE2000.
 * We port the standard formulas directly (no dependency) using the same
 * defaults colour-science uses:
 *   - sRGB IEC 61966-2-1 EOTF (gamma) decoding
 *   - sRGB->XYZ matrix for the sRGB colourspace with D65 whitepoint
 *   - CIE Lab with the CIE 1931 2-degree D65 whitepoint
 * The CIEDE2000 implementation reproduces the Sharma et al. reference values
 * (sharma_case1 ~= 2.0425).
 *
 * IMPORTANT (matched to colour-science, verified against the golden):
 * colour-science's sRGB colourspace uses the 4-decimal-ROUNDED sRGB->XYZ matrix
 * [[0.4124,0.3576,0.1805],[0.2126,0.7152,0.0722],[0.0193,0.1192,0.9505]] and a
 * D65 whitepoint derived from chromaticity xy=[0.3127,0.329] (NOT the common
 * [0.95047,1.0,1.08883]). We reproduce both exactly so hex->Lab matches to
 * < 1e-6. The Lab illuminant is the same D65 whitepoint.
 */

// D65 whitepoint XYZ derived from chromaticity xy = [0.3127, 0.329]
// (X = x/y, Y = 1, Z = (1-x-y)/y). Matches colour-science's sRGB whitepoint
// AND its default CIE 1931 2-deg D65 Lab illuminant.
const XN = 0.3127 / 0.329;
const YN = 1.0;
const ZN = (1 - 0.3127 - 0.329) / 0.329;

/** sRGB inverse EOTF: gamma-encoded channel (0..1) -> linear (0..1). */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear sRGB (0..1 each) -> CIE XYZ (D65), colour-science's rounded matrix. */
function linearRgbToXyz(r: number, g: number, b: number): [number, number, number] {
  const x = 0.4124 * r + 0.3576 * g + 0.1805 * b;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  return [x, y, z];
}

function labF(t: number): number {
  const delta = 6 / 29;
  return t > delta * delta * delta ? Math.cbrt(t) : t / (3 * delta * delta) + 4 / 29;
}

/** CIE XYZ -> CIE Lab (D65 white point). */
export function xyzToLab(x: number, y: number, z: number): [number, number, number] {
  const fx = labF(x / XN);
  const fy = labF(y / YN);
  const fz = labF(z / ZN);
  const L = 116 * fy - 16;
  const a = 500 * (fx - fy);
  const b = 200 * (fy - fz);
  return [L, a, b];
}

/** "#rrggbb" hex -> CIE Lab. */
export function hexToLab(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const [x, y, z] = linearRgbToXyz(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b));
  return xyzToLab(x, y, z);
}

const deg2rad = (d: number) => (d * Math.PI) / 180;
const rad2deg = (r: number) => (r * 180) / Math.PI;

/**
 * CIEDE2000 Delta-E between two CIE Lab colors. Standard Sharma et al. formula
 * with kL=kC=kH=1. Reproduces the published reference values.
 */
export function deltaECIE2000(
  lab1: [number, number, number],
  lab2: [number, number, number],
): number {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const kL = 1;
  const kC = 1;
  const kH = 1;

  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const Cbar = (C1 + C2) / 2;

  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + Math.pow(25, 7))));

  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;

  const C1p = Math.sqrt(a1p * a1p + b1 * b1);
  const C2p = Math.sqrt(a2p * a2p + b2 * b2);

  const h1p = hpf(b1, a1p);
  const h2p = hpf(b2, a2p);

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  const dhp = dhpf(C1p, C2p, h1p, h2p);
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(deg2rad(dhp) / 2);

  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  const hbarp = ahpf(C1p, C2p, h1p, h2p);

  const T =
    1 -
    0.17 * Math.cos(deg2rad(hbarp - 30)) +
    0.24 * Math.cos(deg2rad(2 * hbarp)) +
    0.32 * Math.cos(deg2rad(3 * hbarp + 6)) -
    0.2 * Math.cos(deg2rad(4 * hbarp - 63));

  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));

  const Cbarp7 = Math.pow(Cbarp, 7);
  const RC = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + Math.pow(25, 7)));

  const SL = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const SC = 1 + 0.045 * Cbarp;
  const SH = 1 + 0.015 * Cbarp * T;

  const RT = -Math.sin(deg2rad(2 * dTheta)) * RC;

  const dE = Math.sqrt(
    Math.pow(dLp / (kL * SL), 2) +
      Math.pow(dCp / (kC * SC), 2) +
      Math.pow(dHp / (kH * SH), 2) +
      RT * (dCp / (kC * SC)) * (dHp / (kH * SH)),
  );
  return dE;
}

/** hue prime (degrees, 0..360). */
function hpf(b: number, ap: number): number {
  if (ap === 0 && b === 0) return 0;
  let h = rad2deg(Math.atan2(b, ap));
  if (h < 0) h += 360;
  return h;
}

/** delta hue prime (degrees), Sharma. */
function dhpf(C1p: number, C2p: number, h1p: number, h2p: number): number {
  if (C1p * C2p === 0) return 0;
  let d = h2p - h1p;
  if (d > 180) d -= 360;
  else if (d < -180) d += 360;
  return d;
}

/** average hue prime (degrees), Sharma. */
function ahpf(C1p: number, C2p: number, h1p: number, h2p: number): number {
  if (C1p * C2p === 0) return h1p + h2p;
  const diff = Math.abs(h1p - h2p);
  const sum = h1p + h2p;
  if (diff <= 180) return sum / 2;
  if (sum < 360) return (sum + 360) / 2;
  return (sum - 360) / 2;
}

export type PaletteResult = {
  score: number;
  min_distance: number | null;
  distances: [number, number, number][];
};

/**
 * ColorPaletteDistinguishability aggregation:
 *   pairwise delta-E for all index combinations; min distance vs threshold.
 *   min >= threshold -> score 1.0; else score = clamp(min/threshold, 0, 1).
 * Distances are rounded to `roundDecimals` to match the golden's recorded values
 * (the reference rounds each pairwise delta-E to 10 decimals before taking min).
 */
export function distinguishabilityScore(
  hexColors: string[],
  threshold: number,
  roundDecimals = 10,
): PaletteResult {
  if (hexColors.length < 2) return { score: 0.0, min_distance: null, distances: [] };
  const labs = hexColors.map(hexToLab);
  const round = (x: number) => {
    const f = Math.pow(10, roundDecimals);
    return Math.round(x * f) / f;
  };
  const distances: [number, number, number][] = [];
  for (let i = 0; i < labs.length; i++) {
    for (let j = i + 1; j < labs.length; j++) {
      distances.push([i, j, round(deltaECIE2000(labs[i], labs[j]))]);
    }
  }
  const minDistance = Math.min(...distances.map((d) => d[2]));
  let score: number;
  if (minDistance >= threshold) score = 1.0;
  else score = Math.max(0.0, Math.min(1.0, minDistance / threshold));
  return { score: round(score), min_distance: round(minDistance), distances };
}
