/** Deterministic, browser-local palette reduction and integer pixel rendering. */
const GRIDS = new Set([32, 64, 128]);
const PALETTES = new Set(['original', '16', '32']);

function checkRgba(rgba) {
  if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray) || rgba.length % 4 !== 0) {
    throw new TypeError('RGBA 바이트 배열이 필요해요.');
  }
}

/** Composite transparency over white and always return independent opaque pixels. */
export function flattenPixels(rgba) {
  checkRgba(rgba);
  const output = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3] / 255;
    output[i] = Math.round(rgba[i] * alpha + 255 * (1 - alpha));
    output[i + 1] = Math.round(rgba[i + 1] * alpha + 255 * (1 - alpha));
    output[i + 2] = Math.round(rgba[i + 2] * alpha + 255 * (1 - alpha));
    output[i + 3] = 255;
  }
  return output;
}

function histogram(rgba) {
  const colors = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    const key = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    const previous = colors.get(key);
    if (previous) previous.count += 1;
    else colors.set(key, { key, r: rgba[i], g: rgba[i + 1], b: rgba[i + 2], count: 1 });
  }
  return [...colors.values()].sort((a, b) => a.key - b.key);
}

export function countColors(rgba) {
  checkRgba(rgba);
  const unique = new Set();
  for (let i = 0; i < rgba.length; i += 4) {
    unique.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
  }
  return unique.size;
}

function makeBox(colors, order) {
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  let weight = 0;
  for (const color of colors) {
    const channels = [color.r, color.g, color.b];
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i], channels[i]);
      max[i] = Math.max(max[i], channels[i]);
    }
    weight += color.count;
  }
  const ranges = max.map((value, i) => value - min[i]);
  const range = Math.max(...ranges);
  // indexOf makes channel ties R -> G -> B.
  return { colors, weight, range, channel: ['r', 'g', 'b'][ranges.indexOf(range)], order };
}

/** Weighted median-cut with stable RGB tie breaks. No dithering or network calls. */
export function quantizePixels(rgba, maxColors) {
  if (!Number.isInteger(maxColors) || maxColors < 1 || maxColors > 256) {
    throw new RangeError('색상 수는 1~256 사이의 정수여야 해요.');
  }
  const output = flattenPixels(rgba);
  if (output.length === 0) return output;
  const colors = histogram(output);
  if (colors.length <= maxColors) return output;

  let nextOrder = 1;
  const boxes = [makeBox(colors, 0)];
  while (boxes.length < maxColors) {
    const candidates = boxes.filter((box) => box.colors.length > 1 && box.range > 0);
    candidates.sort((a, b) => b.range - a.range || b.weight - a.weight || a.order - b.order);
    if (!candidates.length) break;
    const box = candidates[0];
    const sorted = [...box.colors].sort((a, b) => a[box.channel] - b[box.channel] || a.key - b.key);
    let accumulated = 0;
    let split = sorted.length - 1;
    for (let i = 0; i < sorted.length - 1; i += 1) {
      accumulated += sorted[i].count;
      if (accumulated >= box.weight / 2) {
        split = i + 1;
        break;
      }
    }
    split = Math.max(1, Math.min(sorted.length - 1, split));
    boxes.splice(boxes.indexOf(box), 1);
    boxes.push(makeBox(sorted.slice(0, split), nextOrder++));
    boxes.push(makeBox(sorted.slice(split), nextOrder++));
  }

  const paletteMap = new Map();
  for (const box of boxes) {
    const totals = box.colors.reduce((sum, color) => [
      sum[0] + color.r * color.count,
      sum[1] + color.g * color.count,
      sum[2] + color.b * color.count,
    ], [0, 0, 0]);
    const rgb = totals.map((total) => Math.round(total / box.weight));
    paletteMap.set((rgb[0] << 16) | (rgb[1] << 8) | rgb[2], rgb);
  }
  const palette = [...paletteMap.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1]);
  const mapping = new Map();
  for (const color of colors) {
    let nearest = palette[0];
    let bestDistance = Infinity;
    for (const rgb of palette) {
      const distance = (color.r - rgb[0]) ** 2 + (color.g - rgb[1]) ** 2 + (color.b - rgb[2]) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        nearest = rgb;
      }
    }
    mapping.set(color.key, nearest);
  }
  for (let i = 0; i < output.length; i += 4) {
    const key = (output[i] << 16) | (output[i + 1] << 8) | output[i + 2];
    const rgb = mapping.get(key);
    output[i] = rgb[0];
    output[i + 1] = rgb[1];
    output[i + 2] = rgb[2];
  }
  return output;
}

function canvas(size) {
  const element = document.createElement('canvas');
  element.width = element.height = size;
  const context = element.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('이 브라우저에서 이미지 처리를 사용할 수 없어요. 최신 브라우저로 열어 주세요.');
  return { element, context };
}

function toPng(element) {
  return new Promise((resolve, reject) => {
    element.toBlob((blob) => {
      if (blob && blob.size > 0) resolve(blob);
      else reject(new Error('PNG 파일을 만들지 못했어요. 다시 시도해 주세요.'));
    }, 'image/png');
  });
}

/** The caller owns the returned object URL and must revoke it when replaced. */
export async function renderPixelImage(source, { grid = 64, palette = '32' } = {}) {
  grid = Number(grid);
  palette = String(palette);
  if (!GRIDS.has(grid) || !PALETTES.has(palette)) throw new Error('픽셀 크기와 색상 설정을 다시 선택해 주세요.');
  const width = source?.naturalWidth || source?.width;
  const height = source?.naturalHeight || source?.height;
  if (!width || !height) throw new Error('이미지를 읽지 못했어요. 다른 이미지를 선택해 주세요.');

  const logical = canvas(grid);
  logical.context.fillStyle = '#ffffff';
  logical.context.fillRect(0, 0, grid, grid);
  logical.context.imageSmoothingEnabled = true;
  logical.context.imageSmoothingQuality = 'high';
  logical.context.drawImage(source, 0, 0, grid, grid);
  const imageData = logical.context.getImageData(0, 0, grid, grid);
  const processed = palette === 'original' ? flattenPixels(imageData.data) : quantizePixels(imageData.data, Number(palette));
  imageData.data.set(processed);
  logical.context.putImageData(imageData, 0, 0);

  const output = canvas(1024);
  output.context.imageSmoothingEnabled = false;
  output.context.drawImage(logical.element, 0, 0, 1024, 1024);
  const blob = await toPng(output.element);
  return {
    blob,
    url: URL.createObjectURL(blob),
    width: 1024,
    height: 1024,
    grid,
    palette,
    colorCount: countColors(processed),
  };
}
