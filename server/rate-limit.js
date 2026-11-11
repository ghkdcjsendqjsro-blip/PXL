import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { AppError, unavailable } from './errors.js';

export function clientSubject(request, config, now = new Date()) {
  let ip;
  if (config.localDev) {
    ip = '127.0.0.1';
  } else {
    const header = request.headers.get('x-vercel-forwarded-for');
    if (!header || header.includes(',')) throw unavailable();
    ip = header.trim();
    if (!isIP(ip)) throw unavailable();
    if (isIP(ip) === 6) {
      ip = new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase();
      const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(ip);
      if (mapped) {
        const high = Number.parseInt(mapped[1], 16);
        const low = Number.parseInt(mapped[2], 16);
        ip = [high >> 8, high & 255, low >> 8, low & 255].join('.');
      }
    }
  }
  return createHmac('sha256', config.rateSalt).update(`${now.toISOString().slice(0, 10)}:${ip}`).digest('hex');
}

export async function consumeQuota(db, request, config, scope) {
  let result;
  try {
    result = await db.rpc('consume_quota', {
      p_scope: scope,
      p_subject: clientSubject(request, config),
      p_generation_daily_limit: config.generationDailyLimit,
    });
  } catch { throw unavailable(); }
  if (!result || result.error || !Array.isArray(result.data) || result.data.length !== 1 || !result.data[0]) throw unavailable();
  const row = result.data[0];
  if (row.allowed === true) return;
  if (row.allowed !== false || !Number.isFinite(Date.parse(row.retry_at))) throw unavailable();
  const daily = row.reason === 'global';
  throw new AppError(429, daily ? 'DAILY_LIMIT' : 'RATE_LIMITED', daily
    ? '오늘의 이미지 생성 한도를 다 썼어요. 안내된 시간에 다시 만나요.'
    : '요청이 많아요. 잠시 후 다시 시도해 주세요.', {
    retryAfterSeconds: Math.max(1, Math.ceil((Date.parse(row.retry_at) - Date.now()) / 1000)),
  });
}
