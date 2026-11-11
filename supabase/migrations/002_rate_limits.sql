begin;

create table public.rate_limit_windows (
  scope text not null,
  subject text not null,
  bucket_start timestamptz not null,
  hits integer not null check (hits >= 0),
  expires_at timestamptz not null,
  primary key (scope, subject, bucket_start)
);
create index rate_limit_expiry_idx
  on public.rate_limit_windows (expires_at);
alter table public.rate_limit_windows enable row level security;
revoke all on public.rate_limit_windows
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.rate_limit_windows to service_role;

create function public.consume_quota(
  p_scope text,
  p_subject text,
  p_generation_daily_limit integer default 50
)
returns table (allowed boolean, retry_at timestamptz, reason text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_start timestamptz;
  v_day timestamptz;
  v_seconds integer;
  v_limit integer;
  v_hits integer;
  v_retry timestamptz := null;
  v_reason text := null;
begin
  if p_scope is null
    or p_scope not in ('generation','feedback_write','feedback_read')
    or p_subject is null or p_subject !~ '^[0-9a-f]{64}$'
    or p_generation_daily_limit is null
    or p_generation_daily_limit not between 1 and 1000 then
    raise exception 'invalid quota arguments';
  end if;

  -- 모든 API 인스턴스의 검사와 차감을 같은 DB 잠금으로 순서대로 처리한다.
  perform pg_catalog.pg_advisory_xact_lock(73641921::bigint);
  v_now := pg_catalog.clock_timestamp();
  v_seconds := case when p_scope = 'feedback_read' then 60 else 600 end;
  v_limit := case p_scope
    when 'generation' then 3 when 'feedback_write' then 10 else 60 end;
  v_start := pg_catalog.to_timestamp(
    floor(extract(epoch from v_now) / v_seconds) * v_seconds);
  v_day := date_trunc('day', v_now at time zone 'UTC') at time zone 'UTC';

  delete from public.rate_limit_windows where expires_at <= v_now;
  select coalesce((select b.hits from public.rate_limit_windows b
    where b.scope = p_scope and b.subject = p_subject
      and b.bucket_start = v_start), 0) into v_hits;
  if v_hits >= v_limit then
    v_retry := v_start + make_interval(secs => v_seconds);
    v_reason := 'client';
  end if;

  if p_scope = 'generation' then
    select coalesce((select b.hits from public.rate_limit_windows b
      where b.scope = 'generation_daily' and b.subject = 'global'
        and b.bucket_start = v_day), 0) into v_hits;
    if v_hits >= p_generation_daily_limit then
      v_retry := greatest(v_retry, v_day + interval '1 day');
      v_reason := 'global';
    end if;
  end if;

  if v_retry is not null then
    return query select false, v_retry, v_reason;
    return;
  end if;

  insert into public.rate_limit_windows as b
    (scope,subject,bucket_start,hits,expires_at)
  values (p_scope,p_subject,v_start,1,v_start + interval '24 hours')
  on conflict (scope,subject,bucket_start)
  do update set hits = b.hits + 1;

  if p_scope = 'generation' then
    insert into public.rate_limit_windows as b
      (scope,subject,bucket_start,hits,expires_at)
    values ('generation_daily','global',v_day,1,v_day + interval '1 day')
    on conflict (scope,subject,bucket_start)
    do update set hits = b.hits + 1;
  end if;
  return query select true, null::timestamptz, null::text;
end;
$$;

revoke all on function public.consume_quota(text,text,integer)
  from public, anon, authenticated;
grant execute on function public.consume_quota(text,text,integer) to service_role;
commit;
