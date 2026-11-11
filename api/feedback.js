import { apiHandler, jsonResponse, requireMethod, AppError } from '../server/errors.js';
import { readConfig, requireOrigin, requireFeedbackConfig } from '../server/env.js';
import { readFeedbackJson, validateFeedback, normalizeFeedbackAttachment, feedbackCursor } from '../server/validation.js';
import { createDatabase, createFeedbackStore } from '../server/supabase.js';
import { consumeQuota } from '../server/rate-limit.js';

export function createFeedbackHandler(overrides = {}) {
  const dependencies = { readConfig, requireFeedbackConfig, createDatabase, createFeedbackStore, consumeQuota, ...overrides };
  return apiHandler(async (request, requestId) => {
    requireMethod(request, ['GET', 'POST']);
    const config = dependencies.readConfig();
    requireOrigin(request, config);
    let input;
    if (request.method === 'GET') input = feedbackCursor(request);
    else {
      if (new URL(request.url).search) throw new AppError(400, 'INVALID_INPUT', '피드백 요청을 확인해 주세요.');
      input = validateFeedback(await readFeedbackJson(request));
    }
    dependencies.requireFeedbackConfig(config);
    const db = dependencies.createDatabase(config);
    await dependencies.consumeQuota(db, request, config, request.method === 'GET' ? 'feedback_read' : 'feedback_write');
    const store = dependencies.createFeedbackStore(db);
    if (request.method === 'GET') return jsonResponse(await store.list(input), 200, requestId);
    const attachment = await normalizeFeedbackAttachment(input.attachment);
    const saved = await store.insert({ ...input, attachment });
    return jsonResponse({ item: saved.item }, saved.replay ? 200 : 201, requestId);
  });
}

export default { fetch: createFeedbackHandler() };
