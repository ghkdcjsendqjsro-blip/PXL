import sharp from 'sharp';
import { AppError } from './errors.js';

export const MiB = 1024 * 1024;
const FEEDBACK_IMAGE_LIMIT = MiB;
const FEEDBACK_IMAGE_BASE64_LIMIT = 4 * Math.ceil(FEEDBACK_IMAGE_LIMIT / 3);
const FEEDBACK_JSON_LIMIT = FEEDBACK_IMAGE_BASE64_LIMIT + 24 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (message = '입력 내용을 다시 확인해 주세요.') => new AppError(400, 'INVALID_INPUT', message);
const tooLarge = (message = '전송할 수 있는 용량을 넘었어요. 더 작은 파일을 골라 주세요.') => new AppError(413, 'PAYLOAD_TOO_LARGE', message);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function isStaticPng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  for (let offset = 8; offset + 12 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length || ['acTL', 'fcTL', 'fdAT'].includes(type)) return false;
    if (type === 'IEND') return length === 0 && end === buffer.length;
    offset = end;
  }
  return false;
}

export function cleanText(value, max, { optional = false, fallback = '' } = {}) {
  if (value === undefined && optional) return fallback;
  if (typeof value !== 'string' || !value.isWellFormed() || value.includes('\0')) throw invalid();
  const text = value.trim();
  if ((!optional && !text) || [...text].length > max) throw invalid(`내용은 ${max}자 이내로 입력해 주세요.`);
  return text || fallback;
}

export async function boundedBody(request, limit) {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
    throw tooLarge();
  }
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid('요청을 읽지 못했어요. 다시 시도해 주세요.');
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

export async function readFeedbackJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON 형식으로 전송해 주세요.');
  }
  const bytes = await boundedBody(request, FEEDBACK_JSON_LIMIT);
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
    if (!Object.hasOwn(parsed, 'attachment') && bytes.length > 8 * 1024) throw tooLarge();
    return parsed;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid('올바른 JSON 요청이 아니에요.');
  }
}

function validateFeedbackAttachment(attachment) {
  if (attachment === undefined) return null;
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)
    || Object.keys(attachment).some((key) => !['imageBase64', 'prompt'].includes(key))
    || typeof attachment.imageBase64 !== 'string' || !attachment.imageBase64 || typeof attachment.prompt !== 'string') {
    throw invalid('공개할 이미지와 설명을 확인해 주세요.');
  }
  const prompt = cleanText(attachment.prompt, 1000, { optional: true });
  if (attachment.imageBase64.length > FEEDBACK_IMAGE_BASE64_LIMIT) throw tooLarge('첨부 이미지는 1 MiB 이하여야 해요.');
  const image = Buffer.from(attachment.imageBase64, 'base64');
  if (image.length > FEEDBACK_IMAGE_LIMIT) throw tooLarge('첨부 이미지는 1 MiB 이하여야 해요.');
  if (image.toString('base64') !== attachment.imageBase64) throw invalid('첨부 이미지 형식이 올바르지 않아요.');
  return { image, prompt };
}

export function validateFeedback(input) {
  if (Object.keys(input).some((key) => !['clientRequestId', 'nickname', 'content', 'consent', 'website', 'attachment'].includes(key))) throw invalid();
  if (typeof input.clientRequestId !== 'string' || !UUID.test(input.clientRequestId)) throw invalid('전송 번호가 올바르지 않아요. 새로고침 후 다시 시도해 주세요.');
  if (input.consent === undefined || input.consent === false) throw new AppError(403, 'FORBIDDEN', '피드백 공개에 동의해 주세요.');
  if (input.consent !== true) throw invalid('공개 동의 항목을 확인해 주세요.');
  if (input.website !== undefined && input.website !== '') throw invalid();
  return {
    clientRequestId: input.clientRequestId.toLowerCase(),
    nickname: cleanText(input.nickname, 20, { optional: true, fallback: '익명' }),
    content: cleanText(input.content, 500),
    consent: true,
    attachment: validateFeedbackAttachment(input.attachment),
  };
}

export async function normalizeFeedbackAttachment(attachment) {
  if (!attachment) return null;
  const png = await normalizeSquarePng(attachment.image, FEEDBACK_IMAGE_LIMIT);
  return { imageBase64: png.toString('base64'), prompt: attachment.prompt };
}

function validTimestamp(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.exec(value);
  if (!m || !Number.isFinite(Date.parse(value))) return false;
  const [, y, mo, d, h, min, sec] = m.map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1] && h <= 23 && min <= 59 && sec <= 59;
}

export function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: row.id })).toString('base64url');
}

export function decodeCursor(value) {
  const bad = () => new AppError(400, 'INVALID_CURSOR', '목록 위치가 올바르지 않아요. 목록을 새로 불러와 주세요.');
  try {
    if (!value || Buffer.byteLength(value) > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) throw bad();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) throw bad();
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!parsed || Array.isArray(parsed) || Object.keys(parsed).sort().join(',') !== 'createdAt,id'
      || typeof parsed.id !== 'string' || !UUID.test(parsed.id)
      || typeof parsed.createdAt !== 'string' || !validTimestamp(parsed.createdAt)) throw bad();
    return { createdAt: parsed.createdAt, id: parsed.id.toLowerCase() };
  } catch { throw bad(); }
}

export function feedbackCursor(request) {
  const search = new URL(request.url).searchParams;
  if ([...search.keys()].some((key) => key !== 'cursor') || search.getAll('cursor').length > 1) {
    throw new AppError(400, 'INVALID_CURSOR', '목록 요청이 올바르지 않아요.');
  }
  return search.has('cursor') ? decodeCursor(search.get('cursor')) : null;
}

export function feedbackImageId(request) {
  const search = new URL(request.url).searchParams;
  const id = search.get('id');
  if (search.size !== 1 || !id || !UUID.test(id)) throw invalid('피드백 이미지 주소가 올바르지 않아요.');
  return id.toLowerCase();
}

async function normalizeSquarePng(buffer, limit) {
  try {
    if (!isStaticPng(buffer)) throw new Error('invalid static PNG');
    const image = sharp(buffer, { limitInputPixels: 1024 * 1024 });
    const metadata = await image.metadata();
    if (metadata.format !== 'png' || metadata.width !== 1024 || metadata.height !== 1024 || (metadata.pages || 1) !== 1) throw new Error('dimensions');
    const normalized = await image.rotate().flatten({ background: '#ffffff' }).removeAlpha().toColourspace('srgb').png().toBuffer();
    if (normalized.length > limit) throw tooLarge(`변환한 이미지는 ${limit / MiB} MiB 이하여야 해요.`);
    return normalized;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, 'INVALID_IMAGE', '이미지를 읽지 못했어요. 올바른 PNG 파일을 골라 주세요.');
  }
}

export async function validateGenerate(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', '이미지 전송 형식을 확인해 주세요.');
  const bytes = await boundedBody(request, 3 * MiB);
  let form;
  try { form = await new Request(request.url, { method: 'POST', headers: { 'content-type': contentType }, body: bytes }).formData(); }
  catch { throw invalid('이미지 전송 형식이 올바르지 않아요.'); }
  const entries = [...form.entries()];
  if (entries.length > 3 || entries.some(([key]) => !['mode', 'prompt', 'image'].includes(key))
    || new Set(entries.map(([key]) => key)).size !== entries.length) throw invalid();
  const mode = form.get('mode');
  if (mode !== 'image' && mode !== 'prompt') throw invalid();
  const prompt = cleanText(form.has('prompt') ? form.get('prompt') : undefined, 1000, { optional: mode === 'image' });
  const image = form.get('image');
  if (mode === 'prompt') {
    if (image !== null) throw invalid('글로 만들기에서는 이미지를 첨부하지 않아요.');
    return { mode, prompt, imageBuffer: null };
  }
  if (!(image instanceof File)) throw invalid('먼저 이미지를 선택해 주세요.');
  if (image.type !== 'image/png') throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', '정규화한 PNG 이미지를 보내 주세요.');
  if (image.size > 2 * MiB) throw tooLarge('변환한 이미지는 2 MiB 이하여야 해요.');
  const imageBuffer = await normalizeSquarePng(Buffer.from(await image.arrayBuffer()), 2 * MiB);
  return { mode, prompt, imageBuffer };
}
