-- Questlog database. Paste this whole file into Supabase > SQL Editor > New query > Run.
-- Safe to run more than once (it also upgrades an older Questlog database).

create table if not exists public.quests (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  type text not null default 'income' check (type in ('income', 'personal')),
  status text not null default 'idea' check (status in ('idea', 'active', 'paused', 'done')),
  goal numeric(14, 2),
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.diary_entries (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  quest_id uuid references public.quests(id) on delete set null,
  entry_date date not null default current_date,
  body text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.transactions (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  quest_id uuid references public.quests(id) on delete set null,
  kind text not null check (kind in ('in', 'out')),
  amount numeric(14, 2) not null check (amount >= 0),
  note text not null default '',
  txn_date date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Photos and videos (the files themselves live in Storage, see below)
create table if not exists public.media_items (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  quest_id uuid references public.quests(id) on delete cascade,
  kind text not null check (kind in ('image', 'video')),
  caption text not null default '',
  width integer,
  height integer,
  duration numeric(10, 2),
  size bigint not null default 0,
  mime text not null default '',
  taken_at timestamptz not null default now(),
  path text not null default '',
  thumb_path text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists quests_user_idx on public.quests (user_id);
create index if not exists diary_user_idx on public.diary_entries (user_id, entry_date desc);
create index if not exists txn_user_idx on public.transactions (user_id, txn_date desc);
create index if not exists txn_quest_idx on public.transactions (quest_id);
create index if not exists diary_quest_idx on public.diary_entries (quest_id);
create index if not exists media_user_idx on public.media_items (user_id, taken_at desc);
create index if not exists media_quest_idx on public.media_items (quest_id);

-- Row level security: each login can only ever see and change its own rows.
alter table public.quests enable row level security;
alter table public.diary_entries enable row level security;
alter table public.transactions enable row level security;
alter table public.media_items enable row level security;

drop policy if exists "own quests" on public.quests;
create policy "own quests" on public.quests
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own diary" on public.diary_entries;
create policy "own diary" on public.diary_entries
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own transactions" on public.transactions;
create policy "own transactions" on public.transactions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own media" on public.media_items;
create policy "own media" on public.media_items
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Private storage bucket for the photo and video files (50 MB per file is the free plan maximum).
insert into storage.buckets (id, name, public, file_size_limit)
values ('media', 'media', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

-- Each login can only touch files inside its own folder (the folder name is the user id).
drop policy if exists "own media files read" on storage.objects;
create policy "own media files read" on storage.objects
  for select to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own media files insert" on storage.objects;
create policy "own media files insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own media files update" on storage.objects;
create policy "own media files update" on storage.objects
  for update to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own media files delete" on storage.objects;
create policy "own media files delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);
