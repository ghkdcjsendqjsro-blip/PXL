const MIB = 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

function invalid(message = '이미지 파일을 읽지 못했어요. 다른 이미지를 선택해 주세요.') {
  const error = new Error(message);
  error.code = 'INVALID_IMAGE';
  return error;
}

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** Header inspection complements, but never replaces, the actual browser decoder. */
export function inspectImageBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isPng = bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value);
  if (isPng) {
    if (ascii(bytes, 12, 4) !== 'IHDR' || view.getUint32(8) !== 13) throw invalid();
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    let animated = false;
    let foundEnd = false;
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = view.getUint32(offset);
      if (length > bytes.length - offset - 12) throw invalid();
      const type = ascii(bytes, offset + 4, 4);
      if (type === 'acTL') animated = true;
      offset += length + 12;
      if (type === 'IEND') { foundEnd = true; break; }
    }
    if (!foundEnd) throw invalid();
    return { mimeType: 'image/png', width, height, animated };
  }

  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const declaredSize = view.getUint32(4, true) + 8;
    if (declaredSize > bytes.length || declaredSize < 20) throw invalid();
    let width = null;
    let height = null;
    let animated = false;
    let hasImage = false;
    for (let offset = 12; offset + 8 <= declaredSize;) {
      const type = ascii(bytes, offset, 4);
      const length = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (length > declaredSize - start) throw invalid();
      if (type === 'VP8X' && length >= 10) {
        animated = animated || Boolean(bytes[start] & 2);
        width = 1 + bytes[start + 4] + (bytes[start + 5] << 8) + (bytes[start + 6] << 16);
        height = 1 + bytes[start + 7] + (bytes[start + 8] << 8) + (bytes[start + 9] << 16);
      }
      if (type === 'ANIM' || type === 'ANMF') animated = true;
      if (type === 'VP8 ' || type === 'VP8L') hasImage = true;
      offset = start + length + (length % 2);
    }
    if (!hasImage && !animated) throw invalid();
    return { mimeType: 'image/webp', width, height, animated };
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) throw invalid();
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) throw invalid();
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) throw invalid();
      const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isStartOfFrame) {
        if (length < 8) throw invalid();
        return { mimeType: 'image/jpeg', width: view.getUint16(offset + 5), height: view.getUint16(offset + 3), animated: false };
      }
      offset += length;
    }
  }
  throw invalid('PNG, JPG, WEBP 형식의 실제 이미지 파일을 선택해 주세요.');
}

function checkDimensions(width, height) {
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height)) throw invalid();
  if (width * height > 20_000_000) throw invalid('이미지는 최대 2,000만 픽셀까지 사용할 수 있어요. 더 작은 이미지를 선택해 주세요.');
}

export function imageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) reject(invalid());
      else resolve(image);
    };
    image.onerror = () => reject(invalid());
    image.src = url;
  });
}

async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { throw invalid(); }
  }
  const url = URL.createObjectURL(file);
  try { return await imageFromUrl(url); }
  finally { URL.revokeObjectURL(url); }
}

/** Returns a caller-owned preview URL. Temporary source URLs are disposed internally. */
export async function normalizeImageFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function' || !file.size) throw invalid('먼저 이미지를 선택해 주세요.');
  if (file.size > 8 * MIB) throw invalid('원본 이미지는 최대 8 MiB까지 사용할 수 있어요.');
  const extension = String(file.name || '').split('.').pop().toLowerCase();
  const expectedMime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[extension];
  if (!ALLOWED_MIME.has(file.type) || !expectedMime || file.type !== expectedMime) {
    throw invalid('PNG, JPG, WEBP 이미지를 선택해 주세요.');
  }
  const info = inspectImageBytes(new Uint8Array(await file.arrayBuffer()));
  if (info.mimeType !== file.type) throw invalid('확장자와 실제 이미지 형식이 달라요. 올바른 이미지 파일을 선택해 주세요.');
  if (info.animated) throw invalid('움직이는 이미지는 지원하지 않아요. 정지된 PNG, JPG, WEBP를 선택해 주세요.');
  if (info.width !== null && info.height !== null) checkDimensions(info.width, info.height);
  const image = await decode(file);
  try {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    checkDimensions(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1024;
    const context = canvas.getContext('2d');
    if (!context) throw invalid('이 브라우저에서 이미지 처리를 사용할 수 없어요.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 1024, 1024);
    const scale = Math.min(1024 / width, 1024 / height);
    const drawWidth = width * scale;
    const drawHeight = height * scale;
    context.drawImage(image, (1024 - drawWidth) / 2, (1024 - drawHeight) / 2, drawWidth, drawHeight);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob || !blob.size) throw invalid('이미지를 변환하지 못했어요. 다른 이미지를 선택해 주세요.');
    if (blob.size > 2 * MIB) throw invalid('정사각형으로 변환한 파일이 2 MiB를 넘어요. 더 작은 이미지를 선택해 주세요.');
    return { blob, previewUrl: URL.createObjectURL(blob), width: 1024, height: 1024, name: file.name };
  } finally {
    if (typeof image.close === 'function') image.close();
  }
}
