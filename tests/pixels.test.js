import test from 'node:test';
import assert from 'node:assert/strict';
import { countColors, flattenPixels, quantizePixels } from '../public/js/pixelate.js';
import { inspectImageBytes, normalizeImageFile } from '../public/js/image-input.js';

function rgba(colors) { return new Uint8ClampedArray(colors.flatMap((color) => color.length === 3 ? [...color, 255] : color)); }

test('palette cap and opaque output hold for detailed 128 x 128 image', () => {
  const pixels = new Uint8ClampedArray(128 * 128 * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = (i * 17 + 3) % 256;
    pixels[i + 1] = Math.floor(i / 29) % 256;
    pixels[i + 2] = Math.floor(i / 71) % 256;
    pixels[i + 3] = (i / 4) % 256;
  }
  for (const cap of [16, 32]) {
    const result = quantizePixels(pixels, cap);
    assert.equal(result.length, pixels.length);
    assert.ok(countColors(result) <= cap);
    for (let i = 3; i < result.length; i += 4) assert.equal(result[i], 255);
  }
});

test('unchanged palette retains exact colors and does not mutate source', () => {
  const input = rgba([[15, 30, 45], [250, 0, 25], [15, 30, 45]]);
  const copy = input.slice();
  const result = quantizePixels(input, 16);
  assert.deepEqual(result, copy);
  assert.deepEqual(input, copy);
  assert.notEqual(result, input);
});

test('single representative uses occurrence-weighted mean rather than unique-color mean', () => {
  const result = quantizePixels(rgba([[0, 0, 0], [0, 0, 0], [0, 0, 0], [200, 100, 40]]), 1);
  assert.deepEqual([...result], [50, 25, 10, 255, 50, 25, 10, 255, 50, 25, 10, 255, 50, 25, 10, 255]);
});

test('fully transparent and half-transparent pixels composite over white', () => {
  const result = flattenPixels(rgba([[255, 0, 0, 0], [0, 0, 0, 128], [10, 20, 30, 255]]));
  assert.deepEqual([...result], [255, 255, 255, 255, 127, 127, 127, 255, 10, 20, 30, 255]);
});

test('weighted median splits a dominant color into a nonempty box', () => {
  const input = rgba([...Array(99).fill([0, 0, 0]), [255, 255, 255], [254, 254, 254]]);
  const result = quantizePixels(input, 2);
  assert.equal(countColors(result), 2);
  assert.deepEqual([...result.slice(0, 4)], [0, 0, 0, 255]);
  assert.deepEqual([...result.slice(-4)], [255, 255, 255, 255]);
});

test('deterministic tie breaks give equal output on reordered input colors', () => {
  const colors = [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255]];
  const original = quantizePixels(rgba(colors), 3);
  const reversed = quantizePixels(rgba([...colors].reverse()), 3);
  const reversedBack = [];
  for (let i = reversed.length - 4; i >= 0; i -= 4) reversedBack.push(...reversed.slice(i, i + 4));
  assert.deepEqual([...original], reversedBack);
  assert.deepEqual(quantizePixels(rgba(colors), 3), original);
});

test('invalid palette and malformed RGBA input are rejected', () => {
  for (const cap of [0, 257, NaN, 1.5, '16']) assert.throws(() => quantizePixels(rgba([[1, 2, 3]]), cap));
  assert.throws(() => quantizePixels(new Uint8Array([1, 2, 3]), 16));
  assert.deepEqual([...quantizePixels(new Uint8Array(), 16)], []);
});

function png(width = 32, height = 32, animated = false) {
  const bytes = new Uint8Array(animated ? 65 : 45);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set(new TextEncoder().encode('IHDR'), 12);
  view.setUint32(16, width); view.setUint32(20, height);
  let end = 33;
  if (animated) {
    view.setUint32(33, 8);
    bytes.set(new TextEncoder().encode('acTL'), 37);
    end = 53;
  }
  bytes.set(new TextEncoder().encode('IEND'), end + 4);
  return bytes;
}

test('PNG header metadata detects animation and oversized advertised dimensions before decode', () => {
  assert.deepEqual(inspectImageBytes(png(120, 60)), { mimeType: 'image/png', width: 120, height: 60, animated: false });
  assert.equal(inspectImageBytes(png(50000, 40000)).width, 50000);
  assert.equal(inspectImageBytes(png(32, 32, true)).animated, true);
  assert.throws(() => inspectImageBytes(png().slice(0, 30)));
});

test('WebP extended container distinguishes static and animation flags', () => {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('RIFF'), 0);
  view.setUint32(4, 38, true);
  bytes.set(new TextEncoder().encode('WEBPVP8X'), 8);
  view.setUint32(16, 10, true);
  bytes[24] = 31; bytes[27] = 63;
  bytes.set(new TextEncoder().encode('VP8 '), 30);
  view.setUint32(34, 8, true);
  assert.deepEqual(inspectImageBytes(bytes), { mimeType: 'image/webp', width: 32, height: 64, animated: false });
  bytes[20] = 2;
  assert.equal(inspectImageBytes(bytes).animated, true);
});

test('JPEG start-of-frame dimensions are parsed and impostor text is rejected', () => {
  const bytes = new Uint8Array([255, 216, 255, 192, 0, 11, 8, 0, 60, 0, 120, 1, 1, 17, 0]);
  assert.deepEqual(inspectImageBytes(bytes), { mimeType: 'image/jpeg', width: 120, height: 60, animated: false });
  assert.throws(() => inspectImageBytes(new TextEncoder().encode('<html>fake image</html>')));
});

test('file validation rejects MIME/extension/signature mismatch, animation, over-limit files before browser APIs', async () => {
  const makeFile = (bytes, name, type, size = bytes.length) => ({ name, type, size, arrayBuffer: async () => bytes.buffer });
  await assert.rejects(normalizeImageFile(makeFile(png(), 'wrong.jpg', 'image/jpeg')), /실제 이미지 형식/);
  await assert.rejects(normalizeImageFile(makeFile(png(), 'wrong.png', '')), /PNG, JPG, WEBP/);
  await assert.rejects(normalizeImageFile(makeFile(png(), 'large.png', 'image/png', 8 * 1024 * 1024 + 1)), /8 MiB/);
  await assert.rejects(normalizeImageFile(makeFile(png(32, 32, true), 'animated.png', 'image/png')), /움직이는/);
  await assert.rejects(normalizeImageFile(makeFile(png(20001, 1000), 'huge.png', 'image/png')), /2,000만/);
});
