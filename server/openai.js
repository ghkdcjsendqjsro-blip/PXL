import OpenAI, { toFile } from 'openai';
import sharp from 'sharp';
import { AppError } from './errors.js';
import { isStaticPng, MiB } from './validation.js';

const STYLE = 'Create one square pixel-art image with clear block shapes, readable silhouettes, limited harmonious colors, and a clean game-art look. Avoid photorealism, gradients, blur, watermark, and added text unless the user explicitly asks for text.';

export function createImageClient(config) {
  return new OpenAI({ apiKey: config.openaiKey, baseURL: 'https://api.openai.com/v1', timeout: 80000, maxRetries: 0 });
}

export function mapProviderError(error) {
  if (error instanceof AppError) return error;
  if (['APIConnectionTimeoutError', 'AbortError', 'TimeoutError'].includes(error?.name)) {
    return new AppError(504, 'GENERATION_TIMEOUT', '이미지 생성 시간이 길어졌어요. 입력을 유지했으니 잠시 후 다시 시도해 주세요.');
  }
  if (['content_policy_violation', 'moderation_blocked', 'content_filter'].includes(error?.code)
    || ['content_policy_violation', 'moderation_blocked', 'content_filter'].includes(error?.error?.code)) {
    return new AppError(422, 'CONTENT_REJECTED', '이 요청으로 이미지를 만들 수 없어요. 설명을 바꿔 주세요.');
  }
  if ([400, 401, 403, 404, 429].includes(error?.status)) {
    return new AppError(503, 'SERVICE_UNAVAILABLE', '현재 AI 생성에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.');
  }
  return new AppError(502, 'UPSTREAM_ERROR', 'AI 응답을 받지 못했어요. 입력을 유지했으니 잠시 후 다시 시도해 주세요.');
}

export async function generateImage(client, input, config) {
  const instruction = input.mode === 'image'
    ? 'Edit the supplied image into pixel art. Preserve the main subject, composition, recognizable features, and major colors as closely as possible.'
    : 'Create the subject described below as a new image.';
  const options = {
    model: config.imageModel,
    prompt: `${STYLE}\n${instruction}\nUser description:\n${input.prompt}`,
    n: 1,
    size: '1024x1024',
    quality: 'medium',
    output_format: 'png',
    background: 'opaque',
  };
  try {
    const result = input.mode === 'image'
      ? await client.images.edit({ ...options, image: await toFile(input.imageBuffer, 'input.png', { type: 'image/png' }) })
      : await client.images.generate(options);
    const encoded = result?.data?.[0]?.b64_json;
    if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(10 * MiB / 3) * 4
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('invalid image payload');
    const buffer = Buffer.from(encoded, 'base64');
    if (!buffer.length || buffer.length > 10 * MiB || buffer.toString('base64') !== encoded || !isStaticPng(buffer)) throw new Error('invalid image bytes');
    const output = await sharp(buffer, { limitInputPixels: 16 * 1024 * 1024 })
      .rotate().resize(512, 512, { fit: 'contain', background: '#ffffff' })
      .flatten({ background: '#ffffff' }).removeAlpha().toColourspace('srgb').png().toBuffer();
    if (output.length > 2 * MiB) throw new Error('output too large');
    return { imageBase64: output.toString('base64'), mimeType: 'image/png', width: 512, height: 512 };
  } catch (error) { throw mapProviderError(error); }
}
