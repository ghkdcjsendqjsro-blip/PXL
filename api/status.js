import { apiHandler, jsonResponse, requireMethod } from '../server/errors.js';
import { readConfig, requireOrigin, aiConfigured, feedbackConfigured } from '../server/env.js';

export function createStatusHandler(overrides = {}) {
  return apiHandler(async (request, requestId) => {
    requireMethod(request, ['GET']);
    const config = (overrides.readConfig || readConfig)();
    requireOrigin(request, config);
    return jsonResponse({ aiConfigured: aiConfigured(config), feedbackConfigured: feedbackConfigured(config), localPreview: true }, 200, requestId);
  });
}

export default { fetch: createStatusHandler() };
