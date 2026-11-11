import { apiHandler, requireMethod, AppError } from '../server/errors.js';
import { readConfig, requireOrigin, requireFeedbackConfig } from '../server/env.js';
import { feedbackImageId } from '../server/validation.js';
import { createDatabase, createFeedbackStore } from '../server/supabase.js';
import { consumeQuota } from '../server/rate-limit.js';

export function createFeedbackImageHandler(overrides = {}) {
  const dependencies = { readConfig, requireFeedbackConfig, createDatabase, createFeedbackStore, consumeQuota, ...overrides };
  return apiHandler(async (request, requestId) => {
    requireMethod(request, ['GET']);
    const config = dependencies.readConfig();
    requireOrigin(request, config);
    const id = feedbackImageId(request);
    dependencies.requireFeedbackConfig(config);
    const db = dependencies.createDatabase(config);
    await dependencies.consumeQuota(db, request, config, 'feedback_read');
    const image = await dependencies.createFeedbackStore(db).readImage(id);
    if (!image) throw new AppError(404, 'NOT_FOUND', '피드백 이미지를 찾을 수 없어요.');
    return new Response(image, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
        'X-Request-Id': requestId,
      },
    });
  });
}

export default { fetch: createFeedbackImageHandler() };
