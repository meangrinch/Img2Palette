/**
 * PaletteEngine - Palette extraction, sorting and export formatting.
 *
 * Implements:
 * 1. sRGB -> CIELAB (D65) with CIEDE2000, and sRGB <-> OKLab (Ottosson, 2020)
 * 2. Quantizers: K-Means++ in OKLab (chroma-weighted, locked colors, deduplication),
 *    fast two-stage K-Means++, Wu variance, and Median Cut
 * 3. Sorting: smooth gradient (TSP 2-Opt on CIEDE2000), dominance, luminance, hue, similarity
 * 4. Text export formats (JSON, GPL, CSS, hex)
 *
 * Runs in the page and, unchanged, as a Web Worker (see the message handler at the bottom).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PaletteEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Convert sRGB [0..255] values to CIELAB [L*, a*, b*] under standard D65 illuminant.
   * @param {number} r 0..255
   * @param {number} g 0..255
   * @param {number} b 0..255
   * @returns {{ L: number, a: number, b: number }}
   */
  function rgbToLab(r, g, b) {
    // 1. Normalize sRGB to [0, 1]
    const nr = Math.max(0, Math.min(255, r)) / 255.0;
    const ng = Math.max(0, Math.min(255, g)) / 255.0;
    const nb = Math.max(0, Math.min(255, b)) / 255.0;

    // 2. Inverse sRGB companding (linearization)
    const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const rLin = lin(nr);
    const gLin = lin(ng);
    const bLin = lin(nb);

    // 3. sRGB to XYZ with D65 illuminant matrix (IEC 61966-2-1)
    const x = rLin * 0.4124564 + gLin * 0.3575761 + bLin * 0.1804375;
    const y = rLin * 0.2126729 + gLin * 0.7151522 + bLin * 0.0721750;
    const z = rLin * 0.0193339 + gLin * 0.1191920 + bLin * 0.9503041;

    // 4. Normalize to D65 reference white point
    const xn = 0.95047;
    const yn = 1.00000;
    const zn = 1.08883;

    const xr = x / xn;
    const yr = y / yn;
    const zr = z / zn;

    // 5. CIE f(t) transformation function
    const delta = 6.0 / 29.0;
    const delta3 = delta * delta * delta; // ~0.008856
    const f = (t) => (t > delta3 ? Math.cbrt(t) : (t * (24389.0 / 27.0) + 16.0) / 116.0);

    const fx = f(xr);
    const fy = f(yr);
    const fz = f(zr);

    // 6. CIELAB coordinates
    const L = 116.0 * fy - 16.0;
    const aVal = 500.0 * (fx - fy);
    const bVal = 200.0 * (fy - fz);

    return { L, a: aVal, b: bVal };
  }

  /**
   * Calculate the CIEDE2000 (deltaE 2000) perceptual difference between two CIELAB colors.
   * Standard implementation matching ISO/CIE and Sharma et al. (2005).
   * @param {{ L: number, a: number, b: number }} lab1
   * @param {{ L: number, a: number, b: number }} lab2
   * @param {number} [kL=1.0]
   * @param {number} [kC=1.0]
   * @param {number} [kH=1.0]
   * @returns {number}
   */
  function deltaE2000(lab1, lab2, kL = 1.0, kC = 1.0, kH = 1.0) {
    const L1 = lab1.L;
    const a1 = lab1.a;
    const b1 = lab1.b;

    const L2 = lab2.L;
    const a2 = lab2.a;
    const b2 = lab2.b;

    // 1. Calculate C* and mean C*
    const C1 = Math.hypot(a1, b1);
    const C2 = Math.hypot(a2, b2);
    const C_bar = (C1 + C2) / 2.0;

    // 2. Calculate G factor
    const C_bar7 = Math.pow(C_bar, 7);
    const G = 0.5 * (1.0 - Math.sqrt(C_bar7 / (C_bar7 + 6103515625.0))); // 25^7 = 6103515625

    // 3. Compute a'
    const a1_prime = (1.0 + G) * a1;
    const a2_prime = (1.0 + G) * a2;

    // 4. Compute C'
    const C1_prime = Math.hypot(a1_prime, b1);
    const C2_prime = Math.hypot(a2_prime, b2);

    // 5. Compute h' (in degrees [0, 360))
    const get_h_deg = (b, a_prime) => {
      if (a_prime === 0 && b === 0) return 0.0;
      let deg = (Math.atan2(b, a_prime) * 180.0) / Math.PI;
      return deg >= 0 ? deg : deg + 360.0;
    };

    const h1_prime = get_h_deg(b1, a1_prime);
    const h2_prime = get_h_deg(b2, a2_prime);

    // 6. Differences deltaL', deltaC', deltah'
    const delta_L_prime = L2 - L1;
    const delta_C_prime = C2_prime - C1_prime;

    let delta_h_prime = 0.0;
    if (C1_prime * C2_prime !== 0) {
      const dh = h2_prime - h1_prime;
      if (Math.abs(dh) <= 180.0) {
        delta_h_prime = dh;
      } else if (dh > 180.0) {
        delta_h_prime = dh - 360.0;
      } else {
        delta_h_prime = dh + 360.0;
      }
    }

    const delta_H_prime =
      2.0 * Math.sqrt(C1_prime * C2_prime) * Math.sin((delta_h_prime / 2.0) * (Math.PI / 180.0));

    // 7. Means L_bar', C_bar', h_bar'
    const L_bar_prime = (L1 + L2) / 2.0;
    const C_bar_prime = (C1_prime + C2_prime) / 2.0;

    let h_bar_prime = 0.0;
    if (C1_prime * C2_prime === 0) {
      h_bar_prime = h1_prime + h2_prime;
    } else {
      const dh = Math.abs(h1_prime - h2_prime);
      if (dh <= 180.0) {
        h_bar_prime = (h1_prime + h2_prime) / 2.0;
      } else if (h1_prime + h2_prime < 360.0) {
        h_bar_prime = (h1_prime + h2_prime + 360.0) / 2.0;
      } else {
        h_bar_prime = (h1_prime + h2_prime - 360.0) / 2.0;
      }
    }

    // 8. T function
    const deg2rad = Math.PI / 180.0;
    const T =
      1.0 -
      0.17 * Math.cos((h_bar_prime - 30.0) * deg2rad) +
      0.24 * Math.cos(2.0 * h_bar_prime * deg2rad) +
      0.32 * Math.cos((3.0 * h_bar_prime + 6.0) * deg2rad) -
      0.2 * Math.cos((4.0 * h_bar_prime - 63.0) * deg2rad);

    // 9. Weighting functions S_L, S_C, S_H
    const L_50_sq = (L_bar_prime - 50.0) * (L_bar_prime - 50.0);
    const S_L = 1.0 + (0.015 * L_50_sq) / Math.sqrt(20.0 + L_50_sq);
    const S_C = 1.0 + 0.045 * C_bar_prime;
    const S_H = 1.0 + 0.015 * C_bar_prime * T;

    // 10. Rotation factor R_T
    const delta_theta = 30.0 * Math.exp(-Math.pow((h_bar_prime - 275.0) / 25.0, 2));
    const C_bar_prime7 = Math.pow(C_bar_prime, 7);
    const R_C = 2.0 * Math.sqrt(C_bar_prime7 / (C_bar_prime7 + 6103515625.0));
    const R_T = -Math.sin(2.0 * delta_theta * deg2rad) * R_C;

    // 11. Total CIEDE2000 color difference
    const vL = delta_L_prime / (kL * S_L);
    const vC = delta_C_prime / (kC * S_C);
    const vH = delta_H_prime / (kH * S_H);

    const dE2 = vL * vL + vC * vC + vH * vH + R_T * vC * vH;
    return Math.sqrt(Math.max(0.0, dE2));
  }

  /**
   * Convert sRGB [0..255] to OKLab [L, a, b].
   * Reference: Björn Ottosson (2020), A perceptual color space for image processing.
   * @param {number} r 0..255
   * @param {number} g 0..255
   * @param {number} b 0..255
   * @returns {{ L: number, a: number, b: number }}
   */
  function rgbToOklab(r, g, b) {
    const nr = Math.max(0, Math.min(255, r)) / 255.0;
    const ng = Math.max(0, Math.min(255, g)) / 255.0;
    const nb = Math.max(0, Math.min(255, b)) / 255.0;

    const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const rLin = lin(nr);
    const gLin = lin(ng);
    const bLin = lin(nb);

    const l = 0.4122214708 * rLin + 0.5363325363 * gLin + 0.0514459929 * bLin;
    const m = 0.2119034982 * rLin + 0.6806995451 * gLin + 0.1073969566 * bLin;
    const s = 0.0883024619 * rLin + 0.2817188376 * gLin + 0.6299787005 * bLin;

    const l_ = Math.cbrt(l);
    const m_ = Math.cbrt(m);
    const s_ = Math.cbrt(s);

    return {
      L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
      a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
      b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    };
  }

  /**
   * Convert OKLab [L, a, b] to sRGB [r, g, b] [0..255].
   * @param {number} L
   * @param {number} a
   * @param {number} b
   * @returns {{ r: number, g: number, b: number }}
   */
  function oklabToRgb(L, a, b) {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;

    const rLin = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

    const delin = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(0, c), 1.0 / 2.4) - 0.055);
    return {
      r: Math.max(0, Math.min(255, Math.round(delin(rLin) * 255.0))),
      g: Math.max(0, Math.min(255, Math.round(delin(gLin) * 255.0))),
      b: Math.max(0, Math.min(255, Math.round(delin(bLin) * 255.0))),
    };
  }


  /**
   * Format RGB into a 7-character hex string (#rrggbb).
   * @param {number} r
   * @param {number} g
   * @param {number} b
   * @returns {string}
   */
  function rgbToHex(r, g, b) {
    const toHex = (c) =>
      Math.max(0, Math.min(255, Math.round(c)))
        .toString(16)
        .padStart(2, '0');
    return '#' + toHex(r) + toHex(g) + toHex(b);
  }

  /**
   * Normalize input pixels to flat array of [r, g, b] samples.
   * Supports RGBA Uint8ClampedArray/Uint8Array, RGB arrays, and object arrays.
   */
  function parsePixels(pixels, quality = 1) {
    if (!pixels) return [];
    const samples = [];
    const q = Math.max(1, Math.floor(quality || 1));

    // Case 1: Array or TypedArray of RGBA or RGB numbers
    if (Array.isArray(pixels) || (pixels.buffer && typeof pixels.length === 'number')) {
      if (pixels.length === 0) return [];

      // Detect if array of color objects [{r, g, b}]
      if (typeof pixels[0] === 'object' && pixels[0] !== null) {
        for (let i = 0; i < pixels.length; i += q) {
          const p = pixels[i];
          if (Array.isArray(p)) {
            samples.push([p[0], p[1], p[2]]);
          } else if (p.r !== undefined) {
            samples.push([p.r, p.g, p.b]);
          }
        }
        return samples;
      }

      // TypedArray or flat number array
      const isRgba = pixels.length % 4 === 0 && pixels.length >= 4;
      const step = isRgba ? 4 * q : 3 * q;

      if (isRgba) {
        for (let i = 0; i < pixels.length; i += step) {
          const a = pixels[i + 3];
          // Skip fully or mostly transparent pixels
          if (a < 128) continue;
          samples.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
        }
        // If image is transparent and no visible pixels found, take all
        if (samples.length === 0) {
          for (let i = 0; i < pixels.length; i += step) {
            samples.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
          }
        }
      } else {
        for (let i = 0; i < pixels.length; i += step) {
          samples.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
        }
      }
    }

    return samples;
  }

  // OKLab distance under which two swatches read as the same color
  const MIN_SWATCH_DIST = 0.035;

  /**
   * Take at most `max` samples along a golden-ratio sequence. A fixed stride aliases with the image width on a
   * raster and skips whole columns (and the accents in them).
   */
  function subsample(samples, max) {
    if (samples.length <= max) return samples;
    const out = new Array(max);
    for (let j = 0; j < max; j++) out[j] = samples[Math.floor(((j * 0.6180339887498949) % 1) * samples.length)];
    return out;
  }

  /**
   * Seed centroids by weight x squared distance to the nearest existing seed.
   * Sampled (k-means++, Arthur & Vassilvitskii, 2007): each seed is drawn with probability proportional to that score,
   * so a lone outlier pixel among many per-pixel samples rarely wins a slot. A fixed-seed PRNG keeps re-extraction
   * stable. Greedy (farthest point): each seed is the top score; suits few points that already carry pixel counts.
   * @param {Float64Array} L OKLab L per point
   * @param {Float64Array} A OKLab a per point
   * @param {Float64Array} B OKLab b per point
   * @param {Float64Array} W Weight per point
   * @param {Array<{ okL: number, oka: number, okb: number }>} seeds Existing seeds (at least one)
   * @param {number} k Total seed count wanted
   * @param {boolean} sampled k-means++ draw rather than greedy farthest point
   * @returns {number[]} Indices of the new seeds; fewer when the points run out of distinct colors
   */
  function pickSeeds(L, A, B, W, seeds, k, sampled) {
    const n = L.length;
    const minD = new Float64Array(n).fill(Infinity);
    const relax = (sL, sA, sB) => {
      for (let i = 0; i < n; i++) {
        const dL = L[i] - sL;
        const da = A[i] - sA;
        const db = B[i] - sB;
        const d = dL * dL + da * da + db * db;
        if (d < minD[i]) minD[i] = d;
      }
    };
    seeds.forEach((c) => relax(c.okL, c.oka, c.okb));

    let state = 0x2545f491;
    const rand = () => {
      // mulberry32
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const picked = [];
    while (seeds.length + picked.length < k) {
      let total = 0;
      for (let i = 0; i < n; i++) total += minD[i] * W[i];
      if (!(total > 0)) break;

      let idx = -1;
      if (sampled) {
        let t = rand() * total;
        for (let i = 0; i < n && t >= 0; i++) {
          const mass = minD[i] * W[i];
          if (mass > 0) {
            idx = i;
            t -= mass;
          }
        }
      } else {
        let best = 0;
        for (let i = 0; i < n; i++) {
          if (minD[i] * W[i] > best) {
            best = minD[i] * W[i];
            idx = i;
          }
        }
      }
      picked.push(idx);
      relax(L[idx], A[idx], B[idx]);
    }
    return picked;
  }

  /**
   * Run a quantizer that can't steer around locked colors, asking it for more swatches until enough sit clear of
   * every locked color; a near-copy of a locked color would otherwise waste a slot.
   * @param {(k: number) => Array<{ r: number, g: number, b: number, count: number }>} quantize
   * @param {number} targetK
   * @param {Array<{ r: number, g: number, b: number }>} lockedColors
   */
  function quantizeAroundLocked(quantize, targetK, lockedColors) {
    const locked = lockedColors.slice(0, targetK).map((c) => {
      const r = Math.max(0, Math.min(255, Math.round(c.r)));
      const g = Math.max(0, Math.min(255, Math.round(c.g)));
      const b = Math.max(0, Math.min(255, Math.round(c.b)));
      return { r, g, b, hex: rgbToHex(r, g, b), count: 1, locked: true };
    });
    const remainingK = targetK - locked.length;
    if (remainingK <= 0) return locked;

    const lockedLab = locked.map((c) => rgbToOklab(c.r, c.g, c.b));
    const isClear = (s) => {
      const p = rgbToOklab(s.r, s.g, s.b);
      return lockedLab.every((q) => Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b) >= MIN_SWATCH_DIST);
    };

    let request = remainingK;
    let kept;
    for (;;) {
      const generated = quantize(request);
      kept = generated.filter(isClear);
      // Quantizers cap at 256 colors, so an exhausted image or the cap ends the loop
      if (kept.length >= remainingK || generated.length < request) break;
      request += remainingK - kept.length;
    }
    // One split can clear two swatches at once; drop the smallest overshoot
    if (kept.length > remainingK) kept = kept.sort((a, b) => b.count - a.count).slice(0, remainingK);
    return [...locked, ...kept];
  }

  /**
   * K-Means++ clustering algorithm in OKLab perceptual color space with chroma-weighted
   * accent preservation, fixed seeds for locked colors, and minimum distance deduplication.
   * @param {Array|TypedArray} pixels
   * @param {number} k Target color count (1..256)
   * @param {Array<{ r: number, g: number, b: number }>} [lockedColors=[]]
   * @param {number} [quality=1] Downsampling step
   * @param {number} [maxIterations=25]
   * @param {string} [mode='balanced'] 'balanced'|'vibrant'|'dominant'
   * @returns {Array<{ r: number, g: number, b: number, hex: string, count: number, locked: boolean }>}
   */
  function kmeans(pixels, k, lockedColors = [], quality = 1, maxIterations = 25, mode = 'balanced') {
    const targetK = Math.max(1, Math.min(256, Math.floor(k || 16)));

    // Lloyd's cost is samples x k x iterations, so samples are capped to a fixed work budget of ~2M distance
    // evaluations per iteration: small palettes see every pixel, 256 colors see 8192 samples.
    const samples = subsample(parsePixels(pixels, quality), Math.max(8192, Math.floor(2097152 / targetK)));

    if (samples.length === 0) {
      if (lockedColors && lockedColors.length > 0) {
        return lockedColors.slice(0, targetK).map((c) => ({
          r: c.r,
          g: c.g,
          b: c.b,
          hex: rgbToHex(c.r, c.g, c.b),
          count: 1,
          locked: true,
        }));
      }
      return [{ r: 0, g: 0, b: 0, hex: '#000000', count: 1, locked: false }];
    }

    // Check unique colors in samples
    const colorMap = new Map();
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const key = (s[0] << 16) | (s[1] << 8) | s[2];
      colorMap.set(key, (colorMap.get(key) || 0) + 1);
    }

    // If unique colors <= targetK and no locked colors need preservation
    const validLocked = Array.isArray(lockedColors) ? lockedColors : [];
    if (colorMap.size <= targetK && validLocked.length === 0) {
      const res = [];
      for (const [key, count] of colorMap.entries()) {
        const r = (key >> 16) & 255;
        const g = (key >> 8) & 255;
        const b = key & 255;
        res.push({ r, g, b, hex: rgbToHex(r, g, b), count, locked: false });
      }
      return res;
    }

    // Convert all samples to OKLab coordinates and compute sample weights
    const nSamples = samples.length;
    const sampleL = new Float64Array(nSamples);
    const sampleA = new Float64Array(nSamples);
    const sampleB = new Float64Array(nSamples);
    const sampleWeight = new Float64Array(nSamples);

    const chromaWeightFactor = mode === 'vibrant' ? 5.0 : mode === 'dominant' ? 0.0 : 2.0;

    for (let i = 0; i < nSamples; i++) {
      const s = samples[i];
      const lab = rgbToOklab(s[0], s[1], s[2]);
      sampleL[i] = lab.L;
      sampleA[i] = lab.a;
      sampleB[i] = lab.b;
      const chroma = Math.hypot(lab.a, lab.b);
      sampleWeight[i] = 1.0 + chromaWeightFactor * chroma;
    }

    // Initialize centroids
    const centroids = [];

    // 1. Seed locked colors first
    for (let i = 0; i < validLocked.length && centroids.length < targetK; i++) {
      const lc = validLocked[i];
      const r = Math.max(0, Math.min(255, Math.round(lc.r)));
      const g = Math.max(0, Math.min(255, Math.round(lc.g)));
      const b = Math.max(0, Math.min(255, Math.round(lc.b)));
      const lab = rgbToOklab(r, g, b);
      centroids.push({
        okL: lab.L,
        oka: lab.a,
        okb: lab.b,
        r,
        g,
        b,
        locked: true,
        count: 0,
      });
    }

    const oklabDistSq = (sIdx, c) => {
      const dL = sampleL[sIdx] - c.okL;
      const da = sampleA[sIdx] - c.oka;
      const db = sampleB[sIdx] - c.okb;
      return dL * dL + da * da + db * db;
    };

    // 2. Start from the most common color, then k-means++ seeding (samples repeat per pixel, so it's density-aware)
    if (centroids.length === 0) {
      let maxCount = -1;
      let modeKey = 0;
      for (const [key, count] of colorMap.entries()) {
        if (count > maxCount) {
          maxCount = count;
          modeKey = key;
        }
      }
      const r = (modeKey >> 16) & 255;
      const g = (modeKey >> 8) & 255;
      const b = modeKey & 255;
      const lab = rgbToOklab(r, g, b);
      centroids.push({
        okL: lab.L,
        oka: lab.a,
        okb: lab.b,
        r,
        g,
        b,
        locked: false,
        count: 0,
      });
    }

    for (const idx of pickSeeds(sampleL, sampleA, sampleB, sampleWeight, centroids, targetK, true)) {
      const s = samples[idx];
      centroids.push({
        okL: sampleL[idx],
        oka: sampleA[idx],
        okb: sampleB[idx],
        r: s[0],
        g: s[1],
        b: s[2],
        locked: false,
        count: 0,
      });
    }

    // Seeding stops early when the image runs out of distinct colors, so iterate what was seeded
    const actualK = centroids.length;

    // 3. Lloyd's iterative refinement loop in OKLab space
    const sumL = new Float64Array(actualK);
    const sumA = new Float64Array(actualK);
    const sumB = new Float64Array(actualK);
    const sumW = new Float64Array(actualK);
    const counts = new Uint32Array(actualK);

    for (let iter = 0; iter < maxIterations; iter++) {
      sumL.fill(0);
      sumA.fill(0);
      sumB.fill(0);
      sumW.fill(0);
      counts.fill(0);

      // Assignment step
      for (let i = 0; i < nSamples; i++) {
        let bestDist = Infinity;
        let bestIdx = 0;
        for (let c = 0; c < actualK; c++) {
          const d = oklabDistSq(i, centroids[c]);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = c;
          }
        }
        const w = sampleWeight[i];
        sumL[bestIdx] += sampleL[i] * w;
        sumA[bestIdx] += sampleA[i] * w;
        sumB[bestIdx] += sampleB[i] * w;
        sumW[bestIdx] += w;
        counts[bestIdx]++;
      }

      // Update step
      let maxShift = 0;
      for (let c = 0; c < actualK; c++) {
        centroids[c].count = counts[c];
        if (centroids[c].locked) continue;

        if (sumW[c] > 0) {
          const newL = sumL[c] / sumW[c];
          const newA = sumA[c] / sumW[c];
          const newB = sumB[c] / sumW[c];

          const dL = newL - centroids[c].okL;
          const da = newA - centroids[c].oka;
          const db = newB - centroids[c].okb;
          const shift = Math.sqrt(dL * dL + da * da + db * db);
          if (shift > maxShift) maxShift = shift;

          centroids[c].okL = newL;
          centroids[c].oka = newA;
          centroids[c].okb = newB;

          const rgb = oklabToRgb(newL, newA, newB);
          centroids[c].r = rgb.r;
          centroids[c].g = rgb.g;
          centroids[c].b = rgb.b;
        } else {
          // Reseed empty cluster to sample with highest residual error
          let maxErr = -1;
          let reseedIdx = 0;
          for (let i = 0; i < nSamples; i++) {
            let minD = Infinity;
            for (let k = 0; k < actualK; k++) {
              if (counts[k] > 0) {
                const d = oklabDistSq(i, centroids[k]);
                if (d < minD) minD = d;
              }
            }
            const err = minD * sampleWeight[i];
            if (err > maxErr) {
              maxErr = err;
              reseedIdx = i;
            }
          }
          centroids[c].okL = sampleL[reseedIdx];
          centroids[c].oka = sampleA[reseedIdx];
          centroids[c].okb = sampleB[reseedIdx];
          centroids[c].r = samples[reseedIdx][0];
          centroids[c].g = samples[reseedIdx][1];
          centroids[c].b = samples[reseedIdx][2];
          // Count it as occupied so another empty cluster this pass picks a different sample, and keep iterating
          counts[c] = 1;
          maxShift = Infinity;
        }
      }

      if (maxShift < 0.001) break;
    }

    // 4. Centroid Deduplication (Detect near-duplicates with DeltaE_OK < MIN_SWATCH_DIST)
    if (actualK > 1 && nSamples > actualK) {
      let reseededAny = false;
      for (let i = 0; i < actualK; i++) {
        if (centroids[i].locked) continue;
        for (let j = 0; j < i; j++) {
          const dL = centroids[i].okL - centroids[j].okL;
          const da = centroids[i].oka - centroids[j].oka;
          const db = centroids[i].okb - centroids[j].okb;
          const dist = Math.sqrt(dL * dL + da * da + db * db);

          if (dist < MIN_SWATCH_DIST) {
            // Centroid i is near-duplicate of j. Reseed i to the sample farthest from other centroids.
            let maxD = -1;
            let bestIdx = 0;
            for (let s = 0; s < nSamples; s++) {
              let localMin = Infinity;
              for (let c = 0; c < actualK; c++) {
                if (c === i) continue;
                const d = oklabDistSq(s, centroids[c]);
                if (d < localMin) localMin = d;
              }
              if (localMin * sampleWeight[s] > maxD) {
                maxD = localMin * sampleWeight[s];
                bestIdx = s;
              }
            }

            centroids[i].okL = sampleL[bestIdx];
            centroids[i].oka = sampleA[bestIdx];
            centroids[i].okb = sampleB[bestIdx];
            centroids[i].r = samples[bestIdx][0];
            centroids[i].g = samples[bestIdx][1];
            centroids[i].b = samples[bestIdx][2];
            reseededAny = true;
            break;
          }
        }
      }

      if (reseededAny) {
        for (let iter = 0; iter < 3; iter++) {
          sumL.fill(0);
          sumA.fill(0);
          sumB.fill(0);
          sumW.fill(0);
          counts.fill(0);

          for (let i = 0; i < nSamples; i++) {
            let bestDist = Infinity;
            let bestIdx = 0;
            for (let c = 0; c < actualK; c++) {
              const d = oklabDistSq(i, centroids[c]);
              if (d < bestDist) {
                bestDist = d;
                bestIdx = c;
              }
            }
            const w = sampleWeight[i];
            sumL[bestIdx] += sampleL[i] * w;
            sumA[bestIdx] += sampleA[i] * w;
            sumB[bestIdx] += sampleB[i] * w;
            sumW[bestIdx] += w;
            counts[bestIdx]++;
          }

          for (let c = 0; c < actualK; c++) {
            centroids[c].count = counts[c];
            if (centroids[c].locked) continue;
            if (sumW[c] > 0) {
              centroids[c].okL = sumL[c] / sumW[c];
              centroids[c].oka = sumA[c] / sumW[c];
              centroids[c].okb = sumB[c] / sumW[c];
              const rgb = oklabToRgb(centroids[c].okL, centroids[c].oka, centroids[c].okb);
              centroids[c].r = rgb.r;
              centroids[c].g = rgb.g;
              centroids[c].b = rgb.b;
            }
          }
        }
      }
    }

    // Format final palette output
    return centroids.map((c) => ({
      r: c.r,
      g: c.g,
      b: c.b,
      hex: rgbToHex(c.r, c.g, c.b),
      count: c.count,
      locked: !!c.locked,
    }));
  }

  /**
   * Wu's Fast Optimal 3D Variance Quantizer (Xiaolin Wu, Graphics Gems II)
   * @param {Array|TypedArray} pixels
   * @param {number} maxColors
   * @param {Array<{ r: number, g: number, b: number }>} [lockedColors=[]]
   * @param {number} [quality=1]
   * @returns {Array<{ r: number, g: number, b: number, hex: string, count: number, locked: boolean }>}
   */
  function buildWuPalette(pixels, maxColors, lockedColors = [], quality = 1) {
    const targetK = Math.max(1, Math.min(256, Math.floor(maxColors || 16)));
    const samples = parsePixels(pixels, quality);
    const validLocked = Array.isArray(lockedColors) ? lockedColors : [];

    if (samples.length === 0) {
      if (validLocked.length > 0) {
        return validLocked.slice(0, targetK).map((c) => ({
          r: c.r,
          g: c.g,
          b: c.b,
          hex: rgbToHex(c.r, c.g, c.b),
          count: 1,
          locked: true,
        }));
      }
      return [{ r: 0, g: 0, b: 0, hex: '#000000', count: 1, locked: false }];
    }

    return quantizeAroundLocked((k) => wuQuantize(samples, k), targetK, validLocked);
  }

  /**
   * Wu quantizer core: up to k unlocked swatches from a non-empty [r, g, b] sample list.
   */
  function wuQuantize(samples, k) {
    const N = 33;
    const TABLE_SIZE = 35937; // 33 * 33 * 33
    const vwt = new Float64Array(TABLE_SIZE);
    const vmr = new Float64Array(TABLE_SIZE);
    const vmg = new Float64Array(TABLE_SIZE);
    const vmb = new Float64Array(TABLE_SIZE);
    const vmq = new Float64Array(TABLE_SIZE);

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const r = s[0];
      const g = s[1];
      const b = s[2];
      const ir = (r >> 3) + 1;
      const ig = (g >> 3) + 1;
      const ib = (b >> 3) + 1;
      const idx = (ir * 33 + ig) * 33 + ib;

      vwt[idx] += 1;
      vmr[idx] += r;
      vmg[idx] += g;
      vmb[idx] += b;
      vmq[idx] += (r * r + g * g + b * b);
    }

    const areaW = new Float64Array(N);
    const areaMR = new Float64Array(N);
    const areaMG = new Float64Array(N);
    const areaMB = new Float64Array(N);
    const areaMQ = new Float64Array(N);

    for (let r = 1; r < N; r++) {
      areaW.fill(0);
      areaMR.fill(0);
      areaMG.fill(0);
      areaMB.fill(0);
      areaMQ.fill(0);
      for (let g = 1; g < N; g++) {
        let lineW = 0, lineMR = 0, lineMG = 0, lineMB = 0, lineMQ = 0;
        for (let b = 1; b < N; b++) {
          const idx = (r * 33 + g) * 33 + b;
          const prev = ((r - 1) * 33 + g) * 33 + b;

          lineW += vwt[idx];
          lineMR += vmr[idx];
          lineMG += vmg[idx];
          lineMB += vmb[idx];
          lineMQ += vmq[idx];

          areaW[b] += lineW;
          areaMR[b] += lineMR;
          areaMG[b] += lineMG;
          areaMB[b] += lineMB;
          areaMQ[b] += lineMQ;

          vwt[idx] = vwt[prev] + areaW[b];
          vmr[idx] = vmr[prev] + areaMR[b];
          vmg[idx] = vmg[prev] + areaMG[b];
          vmb[idx] = vmb[prev] + areaMB[b];
          vmq[idx] = vmq[prev] + areaMQ[b];
        }
      }
    }

    function volume(table, r0, r1, g0, g1, b0, b1) {
      return (
        table[(r1 * 33 + g1) * 33 + b1] -
        table[(r1 * 33 + g1) * 33 + b0] -
        table[(r1 * 33 + g0) * 33 + b1] +
        table[(r1 * 33 + g0) * 33 + b0] -
        table[(r0 * 33 + g1) * 33 + b1] +
        table[(r0 * 33 + g1) * 33 + b0] +
        table[(r0 * 33 + g0) * 33 + b1] -
        table[(r0 * 33 + g0) * 33 + b0]
      );
    }

    function findBestCut(box) {
      if (box.weight <= 1 || box.variance <= 0) return { axis: null, cut: -1 };
      let minVarSum = Infinity;
      let bestAxis = null;
      let bestCut = -1;

      for (let c = box.r0 + 1; c < box.r1; c++) {
        const w1 = volume(vwt, box.r0, c, box.g0, box.g1, box.b0, box.b1);
        const w2 = box.weight - w1;
        if (w1 <= 0 || w2 <= 0) continue;

        const mr1 = volume(vmr, box.r0, c, box.g0, box.g1, box.b0, box.b1);
        const mg1 = volume(vmg, box.r0, c, box.g0, box.g1, box.b0, box.b1);
        const mb1 = volume(vmb, box.r0, c, box.g0, box.g1, box.b0, box.b1);
        const mq1 = volume(vmq, box.r0, c, box.g0, box.g1, box.b0, box.b1);

        const mr2 = box.mr - mr1;
        const mg2 = box.mg - mg1;
        const mb2 = box.mb - mb1;
        const mq2 = box.mq - mq1;

        const v1 = mq1 - (mr1 * mr1 + mg1 * mg1 + mb1 * mb1) / w1;
        const v2 = mq2 - (mr2 * mr2 + mg2 * mg2 + mb2 * mb2) / w2;
        const sum = v1 + v2;
        if (sum < minVarSum) {
          minVarSum = sum;
          bestAxis = 'r';
          bestCut = c;
        }
      }

      for (let c = box.g0 + 1; c < box.g1; c++) {
        const w1 = volume(vwt, box.r0, box.r1, box.g0, c, box.b0, box.b1);
        const w2 = box.weight - w1;
        if (w1 <= 0 || w2 <= 0) continue;

        const mr1 = volume(vmr, box.r0, box.r1, box.g0, c, box.b0, box.b1);
        const mg1 = volume(vmg, box.r0, box.r1, box.g0, c, box.b0, box.b1);
        const mb1 = volume(vmb, box.r0, box.r1, box.g0, c, box.b0, box.b1);
        const mq1 = volume(vmq, box.r0, box.r1, box.g0, c, box.b0, box.b1);

        const mr2 = box.mr - mr1;
        const mg2 = box.mg - mg1;
        const mb2 = box.mb - mb1;
        const mq2 = box.mq - mq1;

        const v1 = mq1 - (mr1 * mr1 + mg1 * mg1 + mb1 * mb1) / w1;
        const v2 = mq2 - (mr2 * mr2 + mg2 * mg2 + mb2 * mb2) / w2;
        const sum = v1 + v2;
        if (sum < minVarSum) {
          minVarSum = sum;
          bestAxis = 'g';
          bestCut = c;
        }
      }

      for (let c = box.b0 + 1; c < box.b1; c++) {
        const w1 = volume(vwt, box.r0, box.r1, box.g0, box.g1, box.b0, c);
        const w2 = box.weight - w1;
        if (w1 <= 0 || w2 <= 0) continue;

        const mr1 = volume(vmr, box.r0, box.r1, box.g0, box.g1, box.b0, c);
        const mg1 = volume(vmg, box.r0, box.r1, box.g0, box.g1, box.b0, c);
        const mb1 = volume(vmb, box.r0, box.r1, box.g0, box.g1, box.b0, c);
        const mq1 = volume(vmq, box.r0, box.r1, box.g0, box.g1, box.b0, c);

        const mr2 = box.mr - mr1;
        const mg2 = box.mg - mg1;
        const mb2 = box.mb - mb1;
        const mq2 = box.mq - mq1;

        const v1 = mq1 - (mr1 * mr1 + mg1 * mg1 + mb1 * mb1) / w1;
        const v2 = mq2 - (mr2 * mr2 + mg2 * mg2 + mb2 * mb2) / w2;
        const sum = v1 + v2;
        if (sum < minVarSum) {
          minVarSum = sum;
          bestAxis = 'b';
          bestCut = c;
        }
      }

      return { axis: bestAxis, cut: bestCut };
    }

    function createBox(r0, r1, g0, g1, b0, b1) {
      const weight = volume(vwt, r0, r1, g0, g1, b0, b1);
      let mr = 0, mg = 0, mb = 0, mq = 0, variance = 0;
      if (weight > 0) {
        mr = volume(vmr, r0, r1, g0, g1, b0, b1);
        mg = volume(vmg, r0, r1, g0, g1, b0, b1);
        mb = volume(vmb, r0, r1, g0, g1, b0, b1);
        mq = volume(vmq, r0, r1, g0, g1, b0, b1);
        variance = mq - (mr * mr + mg * mg + mb * mb) / weight;
        if (variance < 0) variance = 0;
      }
      const vol = (r1 - r0) * (g1 - g0) * (b1 - b0);
      const box = { r0, r1, g0, g1, b0, b1, vol, weight, mr, mg, mb, mq, variance };
      box.cut = findBestCut(box);
      return box;
    }

    const boxes = [createBox(0, 32, 0, 32, 0, 32)];

    while (boxes.length < k) {
      let maxVar = -1;
      let splitIdx = -1;

      for (let i = 0; i < boxes.length; i++) {
        const box = boxes[i];
        if (box.cut.axis !== null && box.variance > maxVar) {
          maxVar = box.variance;
          splitIdx = i;
        }
      }

      if (splitIdx === -1) break;

      const parentBox = boxes.splice(splitIdx, 1)[0];
      let b1, b2;
      if (parentBox.cut.axis === 'r') {
        b1 = createBox(parentBox.r0, parentBox.cut.cut, parentBox.g0, parentBox.g1, parentBox.b0, parentBox.b1);
        b2 = createBox(parentBox.cut.cut, parentBox.r1, parentBox.g0, parentBox.g1, parentBox.b0, parentBox.b1);
      } else if (parentBox.cut.axis === 'g') {
        b1 = createBox(parentBox.r0, parentBox.r1, parentBox.g0, parentBox.cut.cut, parentBox.b0, parentBox.b1);
        b2 = createBox(parentBox.r0, parentBox.r1, parentBox.cut.cut, parentBox.g1, parentBox.b0, parentBox.b1);
      } else {
        b1 = createBox(parentBox.r0, parentBox.r1, parentBox.g0, parentBox.g1, parentBox.b0, parentBox.cut.cut);
        b2 = createBox(parentBox.r0, parentBox.r1, parentBox.g0, parentBox.g1, parentBox.cut.cut, parentBox.b1);
      }

      boxes.push(b1, b2);
    }

    const wuSwatches = [];
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.weight > 0) {
        const r = Math.round(box.mr / box.weight);
        const g = Math.round(box.mg / box.weight);
        const b = Math.round(box.mb / box.weight);
        wuSwatches.push({
          r,
          g,
          b,
          hex: rgbToHex(r, g, b),
          count: Math.round(box.weight),
          locked: false,
        });
      }
    }

    return wuSwatches;
  }

  /**
   * Median Cut color quantization.
   * @param {Array|TypedArray} pixels
   * @param {number} maxColors
   * @param {Array<{ r: number, g: number, b: number }>} [lockedColors=[]]
   * @param {number} [quality=1]
   * @returns {Array<{ r: number, g: number, b: number, hex: string, count: number, locked: boolean }>}
   */
  function buildMedianCutPalette(pixels, maxColors, lockedColors = [], quality = 1) {
    const targetK = Math.max(1, Math.min(256, Math.floor(maxColors || 16)));
    const samples = parsePixels(pixels, quality);
    const validLocked = Array.isArray(lockedColors) ? lockedColors : [];

    if (samples.length === 0) {
      if (validLocked.length > 0) {
        return validLocked.slice(0, targetK).map((c) => ({
          r: c.r,
          g: c.g,
          b: c.b,
          hex: rgbToHex(c.r, c.g, c.b),
          count: 1,
          locked: true,
        }));
      }
      return [{ r: 0, g: 0, b: 0, hex: '#000000', count: 1, locked: false }];
    }

    return quantizeAroundLocked((k) => medianCutQuantize(samples, k), targetK, validLocked);
  }

  /**
   * Median Cut core: up to k unlocked swatches from a non-empty [r, g, b] sample list.
   */
  function medianCutQuantize(samples, k) {
    const unique = new Map();
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i];
      const key = (p[0] << 16) | (p[1] << 8) | p[2];
      unique.set(key, (unique.get(key) || 0) + 1);
    }
    if (unique.size <= k) {
      return [...unique].map(([key, count]) => {
        const r = (key >> 16) & 255;
        const g = (key >> 8) & 255;
        const b = key & 255;
        return { r, g, b, hex: rgbToHex(r, g, b), count, locked: false };
      });
    }

    // Copy: boxes are sorted in place and the caller may run this again on the same samples
    const boxes = [subsample(samples, 5000).slice()];
    while (boxes.length < k) {
      // Rank by population x widest range: range alone keeps splitting sparse boxes a few outliers stretch
      let maxScore = 0;
      let splitIdx = -1;
      let splitChannel = 0;

      for (let b = 0; b < boxes.length; b++) {
        const box = boxes[b];
        let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0;
        for (let p = 0; p < box.length; p++) {
          const col = box[p];
          if (col[0] < minR) minR = col[0];
          if (col[0] > maxR) maxR = col[0];
          if (col[1] < minG) minG = col[1];
          if (col[1] > maxG) maxG = col[1];
          if (col[2] < minB) minB = col[2];
          if (col[2] > maxB) maxB = col[2];
        }
        const rangeR = maxR - minR;
        const rangeG = maxG - minG;
        const rangeB = maxB - minB;
        const boxMax = Math.max(rangeR, rangeG, rangeB);
        if (boxMax * box.length > maxScore) {
          maxScore = boxMax * box.length;
          splitIdx = b;
          splitChannel = boxMax === rangeR ? 0 : (boxMax === rangeG ? 1 : 2);
        }
      }

      if (splitIdx === -1) break;

      const targetBox = boxes.splice(splitIdx, 1)[0];
      targetBox.sort((a, b) => a[splitChannel] - b[splitChannel]);
      // Move the cut off the median to the nearest change in channel value, so one color never lands in two boxes
      const median = Math.floor(targetBox.length / 2);
      const v = targetBox[median][splitChannel];
      let lo = median;
      let hi = median;
      while (lo > 0 && targetBox[lo - 1][splitChannel] === v) lo--;
      while (hi < targetBox.length && targetBox[hi][splitChannel] === v) hi++;
      const cut = lo > 0 && (median - lo <= hi - median || hi === targetBox.length) ? lo : hi;
      boxes.push(targetBox.slice(0, cut), targetBox.slice(cut));
    }

    return boxes.map((box) => {
      let sumR = 0, sumG = 0, sumB = 0;
      for (let i = 0; i < box.length; i++) {
        sumR += box[i][0];
        sumG += box[i][1];
        sumB += box[i][2];
      }
      const r = Math.round(sumR / box.length);
      const g = Math.round(sumG / box.length);
      const b = Math.round(sumB / box.length);
      return {
        r,
        g,
        b,
        hex: rgbToHex(r, g, b),
        count: box.length,
        locked: false,
      };
    });
  }

  /**
   * Fast Two-Stage K-Means++ Color Quantizer (from Img2Pixel):
   * Stage 1: Candidate pre-quantization (Wu variance if > 512 unique colors).
   * Stage 2: OKLab K-Means refinement with chroma-aware weighting and locked color preservation.
   * @param {Array|TypedArray} pixels
   * @param {number} maxColors
   * @param {Array<{ r: number, g: number, b: number }>} [lockedColors=[]]
   * @param {number} [quality=1]
   * @param {string} [mode='balanced']
   * @returns {Array<{ r: number, g: number, b: number, hex: string, count: number, locked: boolean }>}
   */
  function buildKMeansFastPalette(pixels, maxColors, lockedColors = [], quality = 1, mode = 'balanced') {
    const targetK = Math.max(1, Math.min(256, Math.floor(maxColors || 16)));
    const samples = parsePixels(pixels, quality);
    const validLocked = Array.isArray(lockedColors) ? lockedColors : [];

    if (samples.length === 0) {
      if (validLocked.length > 0) {
        return validLocked.slice(0, targetK).map((c) => ({
          r: c.r,
          g: c.g,
          b: c.b,
          hex: rgbToHex(c.r, c.g, c.b),
          count: 1,
          locked: true,
        }));
      }
      return [{ r: 0, g: 0, b: 0, hex: '#000000', count: 1, locked: false }];
    }

    const colorCounts = new Map();
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const key = (s[0] << 16) | (s[1] << 8) | s[2];
      colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
    }

    if (colorCounts.size <= targetK && validLocked.length === 0) {
      const res = [];
      for (const [key, count] of colorCounts.entries()) {
        const r = (key >> 16) & 255;
        const g = (key >> 8) & 255;
        const b = key & 255;
        res.push({ r, g, b, hex: rgbToHex(r, g, b), count, locked: false });
      }
      return res;
    }

    let candidates = [];
    const candidateCount = Math.min(colorCounts.size, Math.max(2 * targetK, 256));

    if (colorCounts.size <= 512) {
      for (const [key, count] of colorCounts.entries()) {
        candidates.push({
          r: (key >> 16) & 255,
          g: (key >> 8) & 255,
          b: key & 255,
          count,
        });
      }
    } else {
      candidates = wuQuantize(samples, candidateCount).map((c) => ({ r: c.r, g: c.g, b: c.b, count: c.count || 1 }));
    }

    if (candidates.length <= targetK && validLocked.length === 0) {
      return candidates.map((c) => ({
        r: c.r,
        g: c.g,
        b: c.b,
        hex: rgbToHex(c.r, c.g, c.b),
        count: c.count,
        locked: false,
      }));
    }

    const n = candidates.length;
    const cL = new Float64Array(n);
    const ca = new Float64Array(n);
    const cb = new Float64Array(n);
    const weights = new Float64Array(n);

    const chromaWeightFactor = mode === 'vibrant' ? 5.0 : mode === 'dominant' ? 0.0 : 2.0;

    for (let i = 0; i < n; i++) {
      const c = candidates[i];
      const lab = rgbToOklab(c.r, c.g, c.b);
      cL[i] = lab.L;
      ca[i] = lab.a;
      cb[i] = lab.b;
      const chroma = Math.hypot(lab.a, lab.b);
      weights[i] = c.count * (1.0 + chromaWeightFactor * chroma);
    }

    const centroids = [];

    for (let i = 0; i < validLocked.length && centroids.length < targetK; i++) {
      const lc = validLocked[i];
      const r = Math.max(0, Math.min(255, Math.round(lc.r)));
      const g = Math.max(0, Math.min(255, Math.round(lc.g)));
      const b = Math.max(0, Math.min(255, Math.round(lc.b)));
      const lab = rgbToOklab(r, g, b);
      centroids.push({
        okL: lab.L,
        oka: lab.a,
        okb: lab.b,
        r,
        g,
        b,
        locked: true,
        count: 0,
      });
    }

    if (centroids.length === 0) {
      let maxW = -1;
      let firstIdx = 0;
      for (let i = 0; i < n; i++) {
        if (weights[i] > maxW) {
          maxW = weights[i];
          firstIdx = i;
        }
      }
      centroids.push({
        okL: cL[firstIdx],
        oka: ca[firstIdx],
        okb: cb[firstIdx],
        r: candidates[firstIdx].r,
        g: candidates[firstIdx].g,
        b: candidates[firstIdx].b,
        locked: false,
        count: 0,
      });
    }

    for (const idx of pickSeeds(cL, ca, cb, weights, centroids, targetK, false)) {
      centroids.push({
        okL: cL[idx],
        oka: ca[idx],
        okb: cb[idx],
        r: candidates[idx].r,
        g: candidates[idx].g,
        b: candidates[idx].b,
        locked: false,
        count: 0,
      });
    }

    const actualK = centroids.length;
    const sumL = new Float64Array(actualK);
    const sumA = new Float64Array(actualK);
    const sumB = new Float64Array(actualK);
    const sumW = new Float64Array(actualK);
    const counts = new Uint32Array(actualK);

    for (let iter = 0; iter < 8; iter++) {
      sumL.fill(0);
      sumA.fill(0);
      sumB.fill(0);
      sumW.fill(0);
      counts.fill(0);

      for (let i = 0; i < n; i++) {
        let bestDist = Infinity;
        let bestK = 0;
        for (let k = 0; k < actualK; k++) {
          const dL = cL[i] - centroids[k].okL;
          const da = ca[i] - centroids[k].oka;
          const db = cb[i] - centroids[k].okb;
          const d = dL * dL + da * da + db * db;
          if (d < bestDist) {
            bestDist = d;
            bestK = k;
          }
        }
        const w = weights[i];
        sumL[bestK] += cL[i] * w;
        sumA[bestK] += ca[i] * w;
        sumB[bestK] += cb[i] * w;
        sumW[bestK] += w;
        // Candidates stand for many pixels each
        counts[bestK] += candidates[i].count;
      }

      let maxShift = 0;
      for (let k = 0; k < actualK; k++) {
        centroids[k].count = counts[k];
        if (centroids[k].locked) continue;

        if (sumW[k] > 0) {
          const newL = sumL[k] / sumW[k];
          const newA = sumA[k] / sumW[k];
          const newB = sumB[k] / sumW[k];
          const dL = newL - centroids[k].okL;
          const da = newA - centroids[k].oka;
          const db = newB - centroids[k].okb;
          const shift = Math.sqrt(dL * dL + da * da + db * db);
          if (shift > maxShift) maxShift = shift;
          centroids[k].okL = newL;
          centroids[k].oka = newA;
          centroids[k].okb = newB;
          const rgb = oklabToRgb(newL, newA, newB);
          centroids[k].r = rgb.r;
          centroids[k].g = rgb.g;
          centroids[k].b = rgb.b;
        }
      }

      if (maxShift < 0.001) break;
    }

    return centroids.map((c) => ({
      r: c.r,
      g: c.g,
      b: c.b,
      hex: rgbToHex(c.r, c.g, c.b),
      count: c.count,
      locked: !!c.locked,
    }));
  }

  /**
   * Smooth gradient ordering: shortest Hamiltonian path over the CIEDE2000 metric graph
   * (nearest neighbor from every start, the shortest refined by 2-Opt edge swaps), oriented darkest to lightest.
   * @param {Array<{ r: number, g: number, b: number }>} colors
   * @returns {Array<{ r: number, g: number, b: number, hex: string, count: number }>}
   */
  function gradientSort(colors) {
    if (!colors || colors.length <= 1) {
      return colors ? colors.slice() : [];
    }

    const n = colors.length;
    if (n === 2) {
      const lab0 = rgbToLab(colors[0].r, colors[0].g, colors[0].b);
      const lab1 = rgbToLab(colors[1].r, colors[1].g, colors[1].b);
      // Darkest to lightest
      return lab0.L <= lab1.L ? [colors[0], colors[1]] : [colors[1], colors[0]];
    }

    // 1. Convert all colors to CIELAB
    const labs = colors.map((c) => rgbToLab(c.r, c.g, c.b));

    // 2. Continuous Perceptual Gradient Ordering (TSP 2-Opt on CIEDE2000 metric graph). Node n is a virtual
    // endpoint at distance 0 from every color, padded onto both ends of each path, so ordinary inner-edge 2-Opt
    // moves can also change where the open path starts or ends.
    const dist = Array.from({ length: n + 1 }, () => new Float64Array(n + 1));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = deltaE2000(labs[i], labs[j]);
        dist[i][j] = d;
        dist[j][i] = d;
      }
    }

    // Nearest-neighbor path from every start
    const tours = [];
    for (let start = 0; start < n; start++) {
      const visited = new Uint8Array(n);
      const path = [n, start];
      visited[start] = 1;
      let curr = start;
      let length = 0;

      while (path.length < n + 1) {
        let nextNode = -1;
        let nextDist = Infinity;
        for (let j = 0; j < n; j++) {
          if (!visited[j] && dist[curr][j] < nextDist) {
            nextDist = dist[curr][j];
            nextNode = j;
          }
        }
        visited[nextNode] = 1;
        path.push(nextNode);
        curr = nextNode;
        length += nextDist;
      }
      path.push(n);
      tours.push({ path, length });
    }

    // ponytail: 2-Opt only the 16 shortest starts; all n cost ~5x more at 256 colors for paths <0.5% shorter
    tours.sort((a, b) => a.length - b.length);
    let bestPath = null;
    let minTotalDist = Infinity;

    for (const { path } of tours.slice(0, 16)) {
      let improved = true;
      let iter = 0;
      while (improved && iter < 50) {
        improved = false;
        iter++;
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j <= n; j++) {
            const a = path[i];
            const b = path[i + 1];
            const c = path[j];
            const d = path[j + 1];
            if (dist[a][c] + dist[b][d] < dist[a][b] + dist[c][d] - 1e-6) {
              let l = i + 1;
              let r = j;
              while (l < r) {
                const tmp = path[l];
                path[l] = path[r];
                path[r] = tmp;
                l++;
                r--;
              }
              improved = true;
            }
          }
        }
      }

      let totalD = 0;
      for (let i = 1; i < n; i++) {
        totalD += dist[path[i]][path[i + 1]];
      }

      if (totalD < minTotalDist) {
        minTotalDist = totalD;
        bestPath = path.slice(1, n + 1);
      }
    }

    // Ensure darkest to lightest progression
    if (labs[bestPath[0]].L > labs[bestPath[bestPath.length - 1]].L) {
      bestPath.reverse();
    }

    return bestPath.map((idx) => colors[idx]);
  }

  /**
   * Sort a palette of colors by the given sort mode.
   * @param {Array<{ r: number, g: number, b: number, hex?: string, count?: number }>} palette
   * @param {string} [sortMode='gradient'] 'gradient'|'dominance'|'luminance'|'hue'|'ciede2000'
   * @returns {Array<{ r: number, g: number, b: number, hex: string, count: number }>}
   */
  function sortPalette(palette, sortMode = 'gradient') {
    if (!palette || palette.length <= 1) {
      return palette ? palette.slice() : [];
    }

    const list = palette.map((c) => ({
      r: c.r,
      g: c.g,
      b: c.b,
      hex: c.hex || rgbToHex(c.r, c.g, c.b),
      count: c.count !== undefined ? c.count : 1,
      locked: !!c.locked,
    }));

    switch (sortMode) {
      case 'gradient':
        return gradientSort(list);

      case 'dominance':
        return list.sort((a, b) => {
          const countDiff = (b.count || 0) - (a.count || 0);
          if (countDiff !== 0) return countDiff;
          const labA = rgbToOklab(a.r, a.g, a.b);
          const labB = rgbToOklab(b.r, b.g, b.b);
          return labB.L - labA.L;
        });

      case 'luminance':
        // Darkest to lightest using perceptual OKLab lightness
        return list.sort((a, b) => {
          const labA = rgbToOklab(a.r, a.g, a.b);
          const labB = rgbToOklab(b.r, b.g, b.b);
          return labA.L - labB.L;
        });

      case 'hue': {
        // Anchored neutrals (blacks, whites, grays) followed by chromatic spectrum
        const decorated = list.map((c) => {
          const lab = rgbToOklab(c.r, c.g, c.b);
          const chroma = Math.hypot(lab.a, lab.b);
          // Start the wheel at 15° (between pinks at ~350-10° and crimson/red at ~20-30°) so it runs red -> pink
          const hueDeg = ((Math.atan2(lab.b, lab.a) * 180.0) / Math.PI + 345.0) % 360.0;
          return {
            c,
            L: lab.L,
            chroma,
            hueDeg,
            isNeutral: chroma < 0.035,
          };
        });

        decorated.sort((a, b) => {
          if (a.isNeutral && !b.isNeutral) return -1;
          if (!a.isNeutral && b.isNeutral) return 1;
          if (a.isNeutral && b.isNeutral) return a.L - b.L;
          return a.hueDeg - b.hueDeg || a.L - b.L;
        });

        return decorated.map((d) => d.c);
      }

      case 'ciede2000': {
        // Find most dominant color (highest count)
        let dominant = list[0];
        for (let i = 1; i < list.length; i++) {
          if ((list[i].count || 0) > (dominant.count || 0)) dominant = list[i];
        }
        const domLab = rgbToLab(dominant.r, dominant.g, dominant.b);
        return list
          .map((c) => ({ c, d: deltaE2000(domLab, rgbToLab(c.r, c.g, c.b)) }))
          .sort((a, b) => a.d - b.d)
          .map((x) => x.c);
      }

      default:
        return list;
    }
  }

  /**
   * Parse '#rgb' or '#rrggbb' into {r, g, b}; null when the text isn't a hex color.
   */
  function hexToRgb(hex) {
    let c = String(hex || '').trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(c)) c = c.split('').map((x) => x + x).join('');
    if (!/^[0-9a-f]{6}$/i.test(c)) return null;
    const n = parseInt(c, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  const QUANTIZERS = {
    kmeans: (pixels, k, locked, mode) => kmeans(pixels, k, locked, 1, 25, mode),
    kmeans_fast: (pixels, k, locked, mode) => buildKMeansFastPalette(pixels, k, locked, 1, mode),
    wu: (pixels, k, locked) => buildWuPalette(pixels, k, locked),
    median: (pixels, k, locked) => buildMedianCutPalette(pixels, k, locked),
  };

  // Distinct opaque colors in RGBA data, counting stops once past limit
  function countColors(rgba, limit) {
    const seen = new Set();
    for (let i = 0; i < rgba.length && seen.size <= limit; i += 4) {
      if (rgba[i + 3] >= 128) seen.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
    }
    return seen.size;
  }

  /**
   * Extract and sort a palette.
   * @param {Array|TypedArray} pixels RGBA bytes (or RGB / {r,g,b} arrays)
   * @param {number} k Color count
   * @param {{ lockedColors?: Array<{r,g,b}>, sortMode?: string, mode?: string, quantizer?: string }} [opts]
   *   mode: 'balanced'|'vibrant'|'dominant' (K-Means quantizers only); quantizer: 'kmeans'|'kmeans_fast'|'wu'|'median'
   */
  function extractPalette(pixels, k, opts = {}) {
    const quantize = QUANTIZERS[opts.quantizer] || QUANTIZERS.kmeans;
    const clusters = quantize(pixels, k, opts.lockedColors || [], opts.mode || 'balanced');
    return sortPalette(clusters, opts.sortMode || 'gradient');
  }

  // --- Export Formats ---

  /**
   * JSON palette: { name, version, count, colors: ['#rrggbb', ...] }.
   */
  function formatJsonPalette(swatches, name = 'Img2Palette Export') {
    const obj = {
      name,
      version: '1.0.0',
      count: swatches.length,
      colors: swatches.map((s) => s.hex.toLowerCase()),
    };
    return JSON.stringify(obj, null, 2);
  }

  /**
   * GIMP / Aseprite ASCII GPL palette.
   */
  function formatGplPalette(swatches, name = 'Img2Palette Export') {
    const lines = ['GIMP Palette', `Name: ${name}`, 'Columns: 8', '#'];
    for (const s of swatches) {
      const r = String(s.r).padStart(3, ' ');
      const g = String(s.g).padStart(3, ' ');
      const b = String(s.b).padStart(3, ' ');
      lines.push(`${r} ${g} ${b}\t${s.hex.toLowerCase()}`);
    }
    return lines.join('\n') + '\n';
  }

  /**
   * CSS custom properties on :root.
   */
  function formatCssPalette(swatches) {
    const lines = swatches.map((s, i) => `  --color-${i + 1}: ${s.hex.toLowerCase()};`);
    return `:root {\n${lines.join('\n')}\n}\n`;
  }

  /**
   * Newline-separated hex codes.
   */
  function formatHexPalette(swatches) {
    return swatches.map((s) => s.hex.toLowerCase()).join('\n') + '\n';
  }

  const api = {
    rgbToLab,
    deltaE2000,
    rgbToOklab,
    oklabToRgb,
    rgbToHex,
    hexToRgb,
    parsePixels,
    kmeans,
    buildWuPalette,
    buildMedianCutPalette,
    buildKMeansFastPalette,
    gradientSort,
    sortPalette,
    extractPalette,
    countColors,
    formatJsonPalette,
    formatGplPalette,
    formatCssPalette,
    formatHexPalette,
  };

  // Inside a Web Worker (importScripts only exists there): run { jobId, method, args } and post back the result
  if (typeof importScripts === 'function') {
    self.onmessage = (e) => {
      const { jobId, method, args } = e.data || {};
      try {
        if (method !== 'extractPalette' && method !== 'sortPalette') throw new Error(`Unknown method: ${method}`);
        self.postMessage({ jobId, result: api[method](...args) });
      } catch (err) {
        self.postMessage({ jobId, error: (err && err.message) || String(err) });
      }
    };
  }

  return api;
});
