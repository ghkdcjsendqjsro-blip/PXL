import { randomUUID } from 'node:crypto';

export class AppError extends Error {
  constructor(status, code, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.allow = options.allow;
  }
}

export const unavailable = () => new AppError(503, 'SERVICE_UNAVAILABLE', '현재 서비스를 연결하는 중이에요. 잠시 후 다시 시도해 주세요.');

export function jsonResponse(data, status, requestId, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Request-Id': requestId,
      ...extraHeaders,
    },
  });
}

export function errorResponse(error, requestId) {
  const safe = error instanceof AppError ? error : new AppError(500, 'INTERNAL_ERROR', '처리 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.');
  const payload = { code: safe.code, message: safe.message, requestId };
  const headers = {};
  if (safe.status === 429 && Number.isFinite(safe.retryAfterSeconds)) {
    payload.retryAfterSeconds = Math.max(1, Math.ceil(safe.retryAfterSeconds));
    headers['Retry-After'] = String(payload.retryAfterSeconds);
  }
  if (safe.allow) headers.Allow = safe.allow;
  return jsonResponse({ error: payload }, safe.status, requestId, headers);
}

export function apiHandler(action) {
  return async (request) => {
    const requestId = randomUUID();
    try {
      return await action(request, requestId);
    } catch (error) {
      // 요청 본문이나 외부 SDK 오류 원문은 기록하거나 응답하지 않는다.
      return errorResponse(error, requestId);
    }
  };
}

export function requireMethod(request, allowed) {
  if (!allowed.includes(request.method)) {
    throw new AppError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청 방식이에요.', { allow: allowed.join(', ') });
  }
}
