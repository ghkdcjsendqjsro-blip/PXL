begin;

create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  client_request_id uuid not null,
  nickname text not null default '익명',
  content text not null,
  public_consent boolean not null,
  created_at timestamptz not null default now(),
  constraint feedback_request_unique unique (client_request_id),
  constraint feedback_nickname_length
    check (char_length(nickname) between 1 and 20),
  constraint feedback_nickname_trimmed check (nickname = btrim(nickname)),
  constraint feedback_content_length
    check (char_length(content) between 1 and 500),
  constraint feedback_content_trimmed check (content = btrim(content)),
  constraint feedback_consent_required check (public_consent = true)
);

create index feedback_latest_idx
  on public.feedback (created_at desc, id desc);

alter table public.feedback enable row level security;

revoke all on table public.feedback
  from public, anon, authenticated, service_role;
grant select, insert on table public.feedback to service_role;

commit;
