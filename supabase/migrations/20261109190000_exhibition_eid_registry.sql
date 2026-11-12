-- Exhibition IDs are globally unique, randomly generated, and never reused.
-- Keep these rows even after the owning account or exhibition is deleted.
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
