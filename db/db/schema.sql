-- Parking Finder: Postgres schema (MVP)

create table if not exists users (
  id uuid primary key,
  username text not null unique,
  salt_hex text not null,
  password_hash_hex text not null,
  created_at_ms bigint not null,
  display_name text not null default '',
  bio text not null default '',
  reputation_score integer not null default 0
);

create table if not exists community_posts (
  id uuid primary key,
  title text not null,
  note text not null,
  fee text not null,
  lat double precision not null,
  lon double precision not null,
  created_at_ms bigint not null,
  author_user_id uuid not null references users(id) on delete restrict,
  author_username text not null,
  kind text not null default 'missing_report',
  expires_at_ms bigint,
  availability text,
  likes jsonb not null default '[]'::jsonb,
  votes jsonb not null default '{}'::jsonb,
  comments jsonb not null default '[]'::jsonb
);

create index if not exists idx_posts_created_at on community_posts(created_at_ms desc);
create index if not exists idx_posts_kind_expires on community_posts(kind, expires_at_ms);

create table if not exists reports (
  id uuid primary key,
  post_id uuid not null references community_posts(id) on delete cascade,
  reason text not null,
  reason_type text,
  created_at_ms bigint not null,
  reporter_user_id uuid not null references users(id) on delete restrict,
  reporter_username text not null
);

create index if not exists idx_reports_created_at on reports(created_at_ms desc);

alter table reports add column if not exists reason_type text;

create table if not exists bans (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  username text not null,
  created_at_ms bigint not null,
  reason text not null
);

create index if not exists idx_bans_user on bans(user_id);

-- Persisted sessions (so apps stay logged in across restarts)
create table if not exists sessions (
  token uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  username text not null,
  created_at_ms bigint not null,
  expires_at_ms bigint not null
);

create index if not exists idx_sessions_user on sessions(user_id);
create index if not exists idx_sessions_expires on sessions(expires_at_ms);

-- Live consensus events (anyone can confirm/occupied)
create table if not exists live_events (
  id uuid primary key,
  post_id uuid not null references community_posts(id) on delete cascade,
  user_id uuid not null references users(id) on delete restrict,
  username text not null,
  kind text not null, -- 'confirm_free' | 'confirm_occupied'
  created_at_ms bigint not null
);

create index if not exists idx_live_events_post on live_events(post_id, created_at_ms desc);

-- In-app notifications (polling)
create table if not exists notifications (
  id uuid primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at_ms bigint not null,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  read_at_ms bigint
);

create index if not exists idx_notifications_user on notifications(user_id, created_at_ms desc);
