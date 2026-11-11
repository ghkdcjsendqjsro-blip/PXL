import { AppError, unavailable } from './errors.js';

export function readConfig(env = process.env) {
  const localDev = env.LOCAL_DEV === 'true' && !env.VERCEL;
  let origin = env.APP_ORIGIN || (localDev ? 'http://localhost:3000' : '');
  if (env.VERCEL_ENV === 'production' && (!origin.startsWith('https://') || !validOrigin(origin))) {
    const productionOrigin = `https://${env.VERCEL_PROJECT_PRODUCTION_URL || ''}`;
    origin = validOrigin(productionOrigin) ? productionOrigin : '';
  }

  return {
    origin,
    openaiKey: env.OPENAI_API_KEY || '',
    imageModel: env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-flare',
    supabaseUrl: env.SUPABASE_URL || '',
    supabaseKey: env.SUPABASE_SECRET_KEY || '',
    rateSalt: env.RATE_LIMIT_SALT || '',
    generationEnabled: env.GENERATION_ENABLED !== 'false',
    generationDailyLimit: Number(env.GENERATION_DAILY_LIMIT || 50),
    localDev,
  };
}

function validOrigin(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && url.origin === value && !url.username && !url.password;
  } catch { return false; }
}

export function feedbackConfigured(config) {
  try {
    const url = new URL(config.supabaseUrl);
    return url.protocol === 'https:' && !url.username && !url.password && Boolean(config.supabaseKey)
      && Buffer.byteLength(config.rateSalt) >= 32 && validOrigin(config.origin)
      && Number.isInteger(config.generationDailyLimit) && config.generationDailyLimit >= 1 && config.generationDailyLimit <= 1000;
  } catch { return false; }
}

export function aiConfigured(config) {
  return feedbackConfigured(config) && Boolean(config.openaiKey) && Boolean(config.imageModel) && config.generationEnabled;
}

export function requireFeedbackConfig(config) {
  if (!feedbackConfigured(config)) throw unavailable();
}

export function requireAiConfig(config) {
  if (!aiConfigured(config)) throw unavailable();
}

export function requireOrigin(request, config) {
  if (!validOrigin(config.origin)) throw unavailable();
  const origin = request.headers.get('origin');
  if ((request.method === 'POST' && origin !== config.origin) || (origin && origin !== config.origin)) {
    throw new AppError(403, 'FORBIDDEN', '이 페이지에서 다시 요청해 주세요.');
  }
}
