-- Run only in the local Supabase SQL editor at http://127.0.0.1:54323.
-- This creates the minimum profile schema required by Argon's local test user.
-- It contains no production data and is not a production migration.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  created_at timestamptz not null default now()
);

-- EIDs are reserved permanently. Rows deliberately have no auth.users foreign key
-- and are never removed when an exhibition or account is deleted.
create table if not exists public.exhibition_eid_registry (
  eid text primary key check (eid ~ '^[A-Za-z0-9]{8}$'),
  instance_id uuid not null unique,
  owner_id uuid not null,
  created_at timestamptz not null default now()
);

alter table public.exhibition_eid_registry enable row level security;
revoke all on table public.exhibition_eid_registry from public, anon, authenticated, service_role;
grant select, insert on table public.exhibition_eid_registry to service_role;
notify pgrst, 'reload schema';

alter table public.profiles enable row level security;

grant select, update on public.profiles to authenticated;

drop policy if exists "Users can view their own profile" on public.profiles;
create policy "Users can view their own profile"
  on public.profiles for select to authenticated
  using (auth.uid() = id);

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.profiles (id, username)
  values (new.id, new.raw_user_meta_data ->> 'username');
  return new;
end;
$function$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
