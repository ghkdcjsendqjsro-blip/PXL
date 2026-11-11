import { createClient } from '@supabase/supabase-js';
import { AppError, unavailable } from './errors.js';
import { encodeCursor } from './validation.js';

const PUBLIC_COLUMNS = 'id,nickname,content,created_at';

export function createDatabase(config) {
  return createClient(config.supabaseUrl, config.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (url, options = {}) => fetch(url, {
        ...options,
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
      }),
    },
  });
}

export function publicFeedback(row) {
  return { id: row.id, nickname: row.nickname, content: row.content, createdAt: row.created_at };
}

export function createFeedbackStore(db) {
  return {
    async list(cursor) {
      let query = db.from('feedback').select(PUBLIC_COLUMNS)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(21);
      if (cursor) {
        // 커서는 엄격히 검증한 시간과 UUID만 허용한다. 마이크로초를 다시 직렬화하지 않는다.
        query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
      }
      const { data, error } = await query;
      if (error || !Array.isArray(data)) throw unavailable();
      const shown = data.slice(0, 20);
      return { items: shown.map(publicFeedback), nextCursor: data.length > 20 ? encodeCursor(shown.at(-1)) : null };
    },
    async insert(input) {
      const { data, error } = await db.from('feedback').insert({
        client_request_id: input.clientRequestId,
        nickname: input.nickname,
        content: input.content,
        public_consent: true,
      }).select(PUBLIC_COLUMNS).single();
      if (!error && data) return { item: publicFeedback(data), replay: false };
      if (error?.code !== '23505' || !String(error.message || '').includes('feedback_request_unique')) throw unavailable();
      const existing = await db.from('feedback').select(`${PUBLIC_COLUMNS},public_consent`)
        .eq('client_request_id', input.clientRequestId).maybeSingle();
      if (existing.error || !existing.data) throw unavailable();
      const row = existing.data;
      if (row.nickname !== input.nickname || row.content !== input.content || row.public_consent !== input.consent) {
        throw new AppError(409, 'CONFLICT', '전송 내용이 바뀌었어요. 새 전송으로 다시 시도해 주세요.');
      }
      return { item: publicFeedback(row), replay: true };
    },
  };
}
