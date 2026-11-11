import { apiHandler, jsonResponse, requireMethod, AppError } from '../server/errors.js';
import { readConfig, requireOrigin, requireAiConfig } from '../server/env.js';
import { validateGenerate, MiB } from '../server/validation.js';
import { createDatabase } from '../server/supabase.js';
import { consumeQuota } from '../server/rate-limit.js';
import { createImageClient, generateImage } from '../server/openai.js';

export function createGenerateHandler(overrides = {}) {
  const dependencies = { readConfig, requireAiConfig, createDatabase, consumeQuota, createImageClient, generateImage, ...overrides };
  return apiHandler(async (request, requestId) => {
    requireMethod(request, ['POST']);
    const config = dependencies.readConfig();
    requireOrigin(request, config);
    if (new URL(request.url).search) throw new AppError(400, 'INVALID_INPUT', '이미지 요청을 확인해 주세요.');
    const input = await validateGenerate(request);
    dependencies.requireAiConfig(config);
    const db = dependencies.createDatabase(config);
    await dependencies.consumeQuota(db, request, config, 'generation');
    const client = dependencies.createImageClient(config);
    const image = await dependencies.generateImage(client, input, config);
    const result = { requestId, ...image };
    if (Buffer.byteLength(JSON.stringify(result)) > 3 * MiB) throw new AppError(502, 'UPSTREAM_ERROR', 'AI 결과를 처리하지 못했어요. 잠시 후 다시 시도해 주세요.');
    return jsonResponse(result, 200, requestId);
  });
}

export default { fetch: createGenerateHandler() };
