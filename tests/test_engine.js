const assert = require('assert');
const PaletteEngine = require('../src/engine.js');

console.log('--- Running PaletteEngine Unit Tests ---');

const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} vs ${expected}`);

// RGBA byte array: [count, [r, g, b]] runs
function pixelsOf(...runs) {
  const out = [];
  for (const [n, [r, g, b]] of runs) for (let i = 0; i < n; i++) out.push(r, g, b, 255);
  return out;
}

const RED = [255, 0, 0], GREEN = [0, 255, 0], BLUE = [0, 0, 255];
const isRed = (c) => c.r > 200 && c.b < 50;
const isBlue = (c) => c.b > 200 && c.r < 50;

{
  console.log('Test: sRGB -> CIELAB reference values');
  const black = PaletteEngine.rgbToLab(0, 0, 0);
  const white = PaletteEngine.rgbToLab(255, 255, 255);
  const red = PaletteEngine.rgbToLab(255, 0, 0);
  [black.L, black.a, black.b, white.a, white.b].forEach((v) => near(v, 0, 0.05, 'neutral channel'));
  near(white.L, 100, 0.05, 'white L');
  near(red.L, 53.24, 0.5, 'red L');
  near(red.a, 80.09, 0.5, 'red a');
  near(red.b, 67.2, 0.5, 'red b');
  console.log('  Passed!');
}

{
  console.log('Test: CIEDE2000 against Sharma et al. (2005) pairs');
  const ref = { L: 50, a: 0, b: -82.7485 };
  near(PaletteEngine.deltaE2000({ L: 50, a: 2.6772, b: -79.7751 }, ref), 2.0425, 5e-4, 'pair 1');
  near(PaletteEngine.deltaE2000({ L: 50, a: 3.1571, b: -77.2803 }, ref), 2.8615, 5e-4, 'pair 2');
  near(PaletteEngine.deltaE2000({ L: 50, a: 2.8361, b: -74.02 }, ref), 3.4412, 5e-4, 'pair 3');
  const c = { L: 60, a: 14, b: -18 };
  near(PaletteEngine.deltaE2000(c, c), 0, 1e-4, 'identical');
  console.log('  Passed!');
}

{
  console.log('Test: OKLab round trip stays within 1 LSB');
  for (const rgb of [[0, 0, 0], [255, 255, 255], RED, GREEN, BLUE, [232, 121, 249], [128, 128, 128]]) {
    const lab = PaletteEngine.rgbToOklab(...rgb);
    const back = PaletteEngine.oklabToRgb(lab.L, lab.a, lab.b);
    [back.r, back.g, back.b].forEach((v, i) => assert.ok(Math.abs(v - rgb[i]) <= 1, `round trip of ${rgb}`));
  }
  near(PaletteEngine.rgbToOklab(0, 0, 0).L, 0, 0.005, 'black L');
  near(PaletteEngine.rgbToOklab(255, 255, 255).L, 1, 0.005, 'white L');
  console.log('  Passed!');
}

{
  console.log('Test: hexToRgb parses short/long hex and rejects junk');
  assert.deepStrictEqual(PaletteEngine.hexToRgb('#e879f9'), { r: 232, g: 121, b: 249 });
  assert.deepStrictEqual(PaletteEngine.hexToRgb('f0a'), { r: 255, g: 0, b: 170 });
  assert.strictEqual(PaletteEngine.hexToRgb('#12345'), null);
  assert.strictEqual(PaletteEngine.hexToRgb('nope'), null);
  assert.strictEqual(PaletteEngine.rgbToHex(232, 121, 249), '#e879f9');
  console.log('  Passed!');
}

{
  console.log('Test: K-Means separates clusters and keeps locked colors exact');
  const pixels = pixelsOf([50, RED], [50, BLUE]);
  const two = PaletteEngine.kmeans(pixels, 2, []);
  assert.strictEqual(two.length, 2);
  assert.ok(two.some(isRed) && two.some(isBlue), 'finds red and blue');

  const three = PaletteEngine.kmeans(pixels, 3, [{ r: 0, g: 255, b: 0 }]);
  const locked = three.filter((c) => c.locked);
  assert.strictEqual(three.length, 3);
  assert.strictEqual(locked.length, 1);
  assert.deepStrictEqual([locked[0].r, locked[0].g, locked[0].b], GREEN, 'locked color not in the image stays exact');
  console.log('  Passed!');
}

{
  console.log('Test: K-Means edge cases (k=1, fewer unique colors than k)');
  const single = [128, 64, 32, 255, 128, 64, 32, 255];
  const k1 = PaletteEngine.kmeans(single, 1, []);
  assert.strictEqual(k1.length, 1);
  assert.deepStrictEqual([k1[0].r, k1[0].g, k1[0].b], [128, 64, 32]);
  assert.ok(PaletteEngine.kmeans(single, 5, []).length >= 1);

  // Fewer unique colors than k plus a locked color: seeding runs out of distinct samples early
  const twoTone = PaletteEngine.kmeans(pixelsOf([200, RED], [200, GREEN]), 16, [{ r: 109, g: 94, b: 179 }]);
  assert.deepStrictEqual(twoTone.map((c) => c.hex).sort(), ['#00ff00', '#6d5eb3', '#ff0000']);
  assert.ok(twoTone.find((c) => c.hex === '#6d5eb3').locked, 'locked color kept');
  console.log('  Passed!');
}

{
  console.log('Test: K-Means keeps small vibrant accents in balanced and vibrant modes');
  const pixels = pixelsOf([950, [16, 20, 40]], [25, [255, 230, 0]], [25, [230, 0, 50]]);
  for (const mode of ['balanced', 'vibrant']) {
    const clusters = PaletteEngine.kmeans(pixels, 6, [], 1, 25, mode);
    assert.ok(clusters.some((c) => c.r > 200 && c.g > 200 && c.b < 50), `${mode} keeps yellow`);
    assert.ok(clusters.some((c) => c.r > 200 && c.g < 50), `${mode} keeps crimson`);
  }
  console.log('  Passed!');
}

{
  console.log('Test: K-Means sample cap still sees a small accent off any stride grid');
  // 256x256 dark image (above the sample cap) with a 7x60 red accent at every horizontal offset of a stride of 8
  for (const x0 of [1, 3, 8]) {
    const n = 256;
    const px = new Uint8ClampedArray(n * n * 4);
    for (let i = 0; i < n * n; i++) {
      const x = i % n, y = Math.floor(i / n);
      const red = x >= x0 && x < x0 + 7 && y >= 100 && y < 160;
      px.set(red ? [230, 20, 30, 255] : [20, 24, 40, 255], i * 4);
    }
    assert.ok(PaletteEngine.extractPalette(px, 8).some((c) => c.r > 180 && c.g < 60), `red accent at x=${x0}`);
  }
  console.log('  Passed!');
}

{
  console.log('Test: K-Means centroids are distinct and never empty');
  const four = PaletteEngine.kmeans(pixelsOf([100, [20, 20, 20]], [100, [200, 200, 200]], [100, RED], [100, BLUE]), 4, []);
  assert.strictEqual(four.length, 4);
  for (let i = 0; i < four.length; i++) {
    for (let j = i + 1; j < four.length; j++) {
      const p = PaletteEngine.rgbToOklab(four[i].r, four[i].g, four[i].b);
      const q = PaletteEngine.rgbToOklab(four[j].r, four[j].g, four[j].b);
      assert.ok(Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b) > 0.035, 'no near-duplicate centroids');
    }
  }

  const eight = PaletteEngine.kmeans(pixelsOf([400, [100, 150, 220]], [400, [50, 140, 40]], [200, [220, 40, 30]]), 8, []);
  assert.ok(eight.every((c) => c.count > 0), 'no empty cluster');
  assert.strictEqual(new Set(eight.map((c) => c.hex)).size, eight.length, 'unique swatches');
  assert.ok(eight.some((c) => c.b > 180), 'blue');
  assert.ok(eight.some((c) => c.g > 120 && c.b < 60), 'green');
  assert.ok(eight.some((c) => c.r > 180 && c.g < 60), 'red');
  console.log('  Passed!');
}

{
  console.log('Test: extraction is deterministic');
  const pixels = [];
  for (let i = 0; i < 1000; i++) {
    const t = i / 1000;
    pixels.push(Math.round(255 * t), Math.round(100 * (1 - t)), Math.round(200 * Math.sin(t * Math.PI)), 255);
  }
  const first = PaletteEngine.extractPalette(pixels, 8).map((c) => c.hex);
  for (let run = 0; run < 4; run++) {
    assert.deepStrictEqual(PaletteEngine.extractPalette(pixels, 8).map((c) => c.hex), first);
  }
  console.log('  Passed!');
}

{
  console.log('Test: Wu, Median Cut and fast K-Means find primaries and keep locked colors');
  const pixels = pixelsOf([50, RED], [50, BLUE]);
  const builders = {
    wu: () => PaletteEngine.buildWuPalette(pixels, 3, [{ r: 0, g: 255, b: 0 }]),
    median: () => PaletteEngine.buildMedianCutPalette(pixels, 3, [{ r: 0, g: 255, b: 0 }]),
    kmeans_fast: () => PaletteEngine.buildKMeansFastPalette(pixels, 3, [{ r: 0, g: 255, b: 0 }], 1, 'balanced'),
  };
  for (const [name, build] of Object.entries(builders)) {
    const clusters = build();
    assert.strictEqual(clusters.length, 3, name);
    const locked = clusters.filter((c) => c.locked);
    assert.strictEqual(locked.length, 1, `${name} locked count`);
    assert.strictEqual(locked[0].g, 255, `${name} locked color`);
    assert.ok(clusters.some(isRed) && clusters.some(isBlue), `${name} finds red and blue`);
  }
  console.log('  Passed!');
}

{
  console.log('Test: extractPalette dispatches every quantizer');
  const pixels = pixelsOf([40, RED], [40, GREEN], [40, BLUE]);
  for (const quantizer of ['kmeans', 'kmeans_fast', 'wu', 'median']) {
    const pal = PaletteEngine.extractPalette(pixels, 4, { lockedColors: [{ r: 255, g: 255, b: 0 }], quantizer });
    assert.strictEqual(pal.length, 4, quantizer);
    assert.ok(pal.some((s) => s.locked && s.r === 255 && s.g === 255 && s.b === 0), `${quantizer} keeps locked yellow`);
    assert.ok(pal.every((s) => /^#[0-9a-f]{6}$/.test(s.hex) && s.count >= 0), `${quantizer} swatch shape`);
  }
  console.log('  Passed!');
}

{
  console.log('Test: every quantizer honors a single-color palette');
  const pixels = pixelsOf([40, RED], [40, GREEN], [40, BLUE]);
  for (const quantizer of ['kmeans', 'kmeans_fast', 'wu', 'median']) {
    assert.strictEqual(PaletteEngine.extractPalette(pixels, 1, { quantizer }).length, 1, quantizer);
    const locked = PaletteEngine.extractPalette(pixels, 1, { quantizer, lockedColors: [{ r: 255, g: 255, b: 0 }] });
    assert.deepStrictEqual(locked.map((c) => [c.hex, c.locked]), [['#ffff00', true]], `${quantizer} keeps the locked color in the only slot`);
  }
  console.log('  Passed!');
}

{
  console.log('Test: gradient sort is a darkest-to-lightest path over every color');
  const greys = [255, 0, 100, 50, 200, 150].map((v) => ({ r: v, g: v, b: v, hex: PaletteEngine.rgbToHex(v, v, v), count: 10 }));
  assert.deepStrictEqual(PaletteEngine.gradientSort(greys).map((c) => c.r), [0, 50, 100, 150, 200, 255]);

  for (const n of [16, 32, 64]) {
    const colors = [];
    for (let i = 0; i < n; i++) {
      const r = (i * 37) % 256, g = (i * 73 + 50) % 256, b = (i * 109 + 100) % 256;
      colors.push({ r, g, b, hex: PaletteEngine.rgbToHex(r, g, b), count: (i * 13) % 100 + 1, locked: i % 5 === 0 });
    }
    const sorted = PaletteEngine.sortPalette(colors, 'gradient');
    assert.deepStrictEqual(new Set(sorted.map((c) => c.hex)), new Set(colors.map((c) => c.hex)), `keeps all ${n} colors`);
    assert.deepStrictEqual(
      new Set(sorted.filter((c) => c.locked).map((c) => c.hex)),
      new Set(colors.filter((c) => c.locked).map((c) => c.hex)),
      `keeps locked flags (${n})`
    );
  }

  const arbitrary = [];
  for (let i = 0; i < 24; i++) {
    const r = (i * 47 + 13) % 256, g = (i * 83 + 37) % 256, b = (i * 127 + 59) % 256;
    arbitrary.push({ r, g, b, hex: PaletteEngine.rgbToHex(r, g, b), count: 1 });
  }
  const path = PaletteEngine.gradientSort(arbitrary);
  let jump = 0;
  for (let i = 0; i < path.length - 1; i++) {
    jump += PaletteEngine.deltaE2000(PaletteEngine.rgbToLab(path[i].r, path[i].g, path[i].b), PaletteEngine.rgbToLab(path[i + 1].r, path[i + 1].g, path[i + 1].b));
  }
  assert.strictEqual(path.length, 24);
  assert.ok(jump < 380, `2-Opt path keeps total jump low (${jump})`);
  console.log('  Passed!');
}

{
  console.log('Test: dominance, luminance, hue and similarity sorts');
  const hexes = (list) => list.map((c) => c.hex);
  const rgb = [
    { r: 255, g: 0, b: 0, hex: '#ff0000', count: 50 },
    { r: 0, g: 255, b: 0, hex: '#00ff00', count: 100 },
    { r: 0, g: 0, b: 255, hex: '#0000ff', count: 20 },
  ];
  assert.deepStrictEqual(hexes(PaletteEngine.sortPalette(rgb, 'dominance')), ['#00ff00', '#ff0000', '#0000ff']);
  assert.deepStrictEqual(hexes(PaletteEngine.sortPalette(rgb, 'luminance')), ['#0000ff', '#ff0000', '#00ff00']);
  assert.deepStrictEqual(hexes(PaletteEngine.sortPalette(rgb, 'hue')), ['#ff0000', '#00ff00', '#0000ff']);

  const withNeutrals = ['#ff0000', '#808080', '#00ff00', '#ffffff', '#000000', '#0000ff'].map((hex) => ({ ...PaletteEngine.hexToRgb(hex), hex, count: 10 }));
  assert.deepStrictEqual(hexes(PaletteEngine.sortPalette(withNeutrals, 'hue')), ['#000000', '#808080', '#ffffff', '#ff0000', '#00ff00', '#0000ff'], 'neutrals first');

  const similar = [
    { r: 255, g: 0, b: 0, hex: '#ff0000', count: 100 },
    { r: 0, g: 0, b: 255, hex: '#0000ff', count: 10 },
    { r: 240, g: 20, b: 20, hex: '#f01414', count: 20 },
  ];
  assert.deepStrictEqual(hexes(PaletteEngine.sortPalette(similar, 'ciede2000')), ['#ff0000', '#f01414', '#0000ff']);
  console.log('  Passed!');
}

{
  console.log('Test: Web Worker message handler');
  const responses = {};
  const enginePath = require.resolve('../src/engine.js');
  global.importScripts = () => {};
  global.self = { postMessage: (msg) => { responses[msg.jobId] = msg; } };
  delete require.cache[enginePath];
  require(enginePath);

  const pixels = pixelsOf([1, RED], [1, GREEN], [1, BLUE], [1, [255, 255, 0]]);
  ['kmeans', 'kmeans_fast', 'wu', 'median'].forEach((quantizer, jobId) => {
    self.onmessage({ data: { jobId, method: 'extractPalette', args: [pixels, 3, { quantizer }] } });
  });
  self.onmessage({ data: { jobId: 'sort', method: 'sortPalette', args: [[{ r: 0, g: 0, b: 0, hex: '#000000', count: 1 }, { r: 9, g: 9, b: 9, hex: '#090909', count: 5 }], 'dominance'] } });
  self.onmessage({ data: { jobId: 'bad', method: 'constructor', args: [] } });

  for (let jobId = 0; jobId < 4; jobId++) assert.strictEqual(responses[jobId].result.length, 3, `job ${jobId}`);
  assert.strictEqual(responses.sort.result[0].hex, '#090909');
  assert.ok(responses.bad.error && !responses.bad.result, 'only engine entry points are callable');
  delete global.importScripts;
  delete global.self;
  console.log('  Passed!');
}

{
  console.log('Test: export formats');
  const swatches = [{ r: 20, g: 18, b: 28, hex: '#14121c' }, { r: 232, g: 121, b: 249, hex: '#E879F9' }];
  assert.deepStrictEqual(JSON.parse(PaletteEngine.formatJsonPalette(swatches, 'Test Palette')), {
    name: 'Test Palette', version: '1.0.0', count: 2, colors: ['#14121c', '#e879f9'],
  });
  assert.deepStrictEqual(PaletteEngine.formatGplPalette(swatches, 'Test Palette').split('\n'), [
    'GIMP Palette', 'Name: Test Palette', 'Columns: 8', '#', ' 20  18  28\t#14121c', '232 121 249\t#e879f9', '',
  ]);
  assert.strictEqual(PaletteEngine.formatCssPalette(swatches), ':root {\n  --color-1: #14121c;\n  --color-2: #e879f9;\n}\n');
  assert.strictEqual(PaletteEngine.formatHexPalette(swatches), '#14121c\n#e879f9\n');
  console.log('  Passed!');
}

{
  console.log('Test: fast K-Means counts pixels, not candidate colors');
  const varied = [];
  for (let i = 0; i < 1000; i++) varied.push([1, [200 + (i % 50), 100 + (i % 7), 50]]);
  const pal = PaletteEngine.buildKMeansFastPalette(pixelsOf([9000, [20, 20, 20]], ...varied), 2);
  assert.strictEqual(pal.find((c) => c.r < 50).count, 9000, 'dark swatch covers 9000 pixels');
  assert.strictEqual(PaletteEngine.sortPalette(pal, 'dominance')[0].r < 50, true, 'dark color is the most common');
  console.log('  Passed!');
}

{
  console.log('Test: Median Cut returns each color once when the image has fewer colors than k');
  const px = [];
  for (let i = 0; i < 6000; i++) px.push(...(i % 10 < 7 ? [200, 30, 30] : i % 10 < 9 ? [30, 200, 30] : [30, 30, 200]), 255);
  const pal = PaletteEngine.buildMedianCutPalette(px, 16);
  assert.deepStrictEqual(pal.map((c) => c.hex).sort(), ['#1e1ec8', '#1ec81e', '#c81e1e'], 'all three colors, no repeats');
  console.log('  Passed!');
}

{
  console.log('Test: Median Cut spends swatches on populous boxes over sparse wide ones');
  // 3000 px grey blob + 5 px spread across a wide green box: the outliers widen whichever box holds them,
  // which range-only ranking keeps splitting into slivers while half the image stays one swatch
  const px = [];
  const box = (n, c, h) => { for (let i = 0; i < n; i++) px.push(...c.map((v, j) => Math.max(0, Math.min(255, v - h + ((i * [7, 13, 29][j]) % (2 * h + 1))))), 255); };
  box(3000, [128, 128, 128], 40);
  box(5, [30, 220, 40], 60);
  const pal = PaletteEngine.buildMedianCutPalette(px, 8);
  assert.ok(Math.max(...pal.map((c) => c.count)) < 3005 / 4, `swatch sizes: ${pal.map((c) => c.count)}`);
  console.log('  Passed!');
}

{
  console.log('Test: Wu and Median Cut keep generated swatches clear of locked colors');
  const pixels = pixelsOf([50, RED], [50, GREEN], [50, BLUE]);
  for (const build of [PaletteEngine.buildWuPalette, PaletteEngine.buildMedianCutPalette]) {
    const pal = build(pixels, 3, [{ r: 250, g: 5, b: 5 }]);
    assert.deepStrictEqual(pal.map((c) => c.hex).sort(), ['#0000ff', '#00ff00', '#fa0505'], `${build.name} keeps green and blue, no red copy`);
  }
  console.log('  Passed!');
}

{
  console.log('Test: K-Means uses every pixel when the work budget allows');
  // 4 red pixels at indices the 8192-sample golden-ratio subsample skips
  const pal = PaletteEngine.kmeans(pixelsOf([50000, [0, 0, 0]], [4, RED], [50000, [255, 255, 255]]), 3, []);
  assert.ok(pal.some(isRed), `red found: ${pal.map((c) => c.hex)}`);
  console.log('  Passed!');
}

{
  console.log('Test: K-Means seeding is not captured by a single outlier pixel');
  const pal = PaletteEngine.kmeans(pixelsOf([4000, [0, 0, 0]], [4000, [30, 30, 30]], [1, [255, 255, 255]]), 2, []);
  assert.ok(pal.every((c) => c.r < 60), `both swatches are dark: ${pal.map((c) => c.hex)}`);
  console.log('  Passed!');
}

{
  console.log('Test: gradient sort finds the shortest path on small palettes');
  for (const seed of [1, 17, 18, 23]) {
    const colors = [];
    for (let i = 0; i < 8; i++) {
      const r = (i * 37 * seed + 11 * seed) % 256, g = (i * 73 + 29 * seed) % 256, b = (i * 109 * seed + 53) % 256;
      colors.push({ r, g, b, hex: PaletteEngine.rgbToHex(r, g, b), count: 1 });
    }
    const labs = colors.map((c) => PaletteEngine.rgbToLab(c.r, c.g, c.b));
    const d = labs.map((p) => labs.map((q) => PaletteEngine.deltaE2000(p, q)));
    const idx = [...colors.keys()];
    let best = Infinity;
    const permute = (k, len) => {
      if (len >= best) return;
      if (k === idx.length) { best = len; return; }
      for (let i = k; i < idx.length; i++) {
        [idx[k], idx[i]] = [idx[i], idx[k]];
        permute(k + 1, k ? len + d[idx[k - 1]][idx[k]] : 0);
        [idx[k], idx[i]] = [idx[i], idx[k]];
      }
    };
    permute(0, 0);
    const path = PaletteEngine.gradientSort(colors).map((c) => colors.indexOf(c));
    let len = 0;
    for (let i = 0; i < path.length - 1; i++) len += d[path[i]][path[i + 1]];
    near(len, best, 1e-6, `seed ${seed} path length`);
  }
  console.log('  Passed!');
}

{
  console.log('Test: sort modes are reachable by name and the hue wheel starts at red');
  const colors = ['#f06292', '#0000ff', '#ff00ff', '#ff0000'].map((hex) => ({ ...PaletteEngine.hexToRgb(hex), hex, count: 1 }));
  assert.deepStrictEqual(
    PaletteEngine.sortPalette(colors, 'gradient').map((c) => c.hex),
    PaletteEngine.gradientSort(colors).map((c) => c.hex)
  );
  assert.deepStrictEqual(PaletteEngine.sortPalette(colors, 'hue').map((c) => c.hex), ['#ff0000', '#0000ff', '#ff00ff', '#f06292'], 'pinks wrap to the end');
  console.log('  Passed!');
}

console.log('All unit tests passed successfully!');
