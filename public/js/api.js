export class ApiError extends Error {
  constructor(message, { code = 'NETWORK_ERROR', status = 0, requestId, retryAfterSeconds } = {}) {
    super(message);
    this.name = 'ApiError';
    Object.assign(this, { code, status, requestId, retryAfterSeconds });
  }
}

export async function requestJson(path, { timeout = 15_000, ...options } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, { ...options, signal: controller.signal, cache: 'no-store' });
    let payload;
    try { payload = await response.json(); } catch {
      throw new ApiError(response.status === 413 ? '파일이 너무 커요. 더 작은 이미지를 선택해 주세요.' : '서버 응답을 읽지 못했어요. 잠시 후 다시 시도해 주세요.', {
        code: response.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_RESPONSE', status: response.status,
      });
    }
    if (!response.ok) {
      throw new ApiError(payload?.error?.message || '요청을 처리하지 못했어요.', {
        ...payload?.error, status: response.status,
      });
    }
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error.name === 'AbortError') {
      throw new ApiError('응답을 기다리는 시간이 길어졌어요. 입력은 그대로 유지했어요.', { code: 'TIMEOUT' });
    }
    throw new ApiError('연결을 확인한 뒤 다시 시도해 주세요.');
  } finally { clearTimeout(timer); }
}

export function friendlyError(error) {
  let message = error instanceof Error ? error.message : '요청을 처리하지 못했어요.';
  if (error.retryAfterSeconds) {
    const minutes = Math.ceil(error.retryAfterSeconds / 60);
    message += minutes < 60 ? ` 약 ${minutes}분 후 다시 시도해 주세요.` : ' 이용 한도가 초기화된 후 다시 시도해 주세요.';
  }
  return message;
}
