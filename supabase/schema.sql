-- ============================================================
-- Flux-Change Phase 1 — orders database schema (Supabase)
-- Run this ONCE in Supabase Dashboard → SQL Editor → New query → Run.
-- No secrets in this file. Service-role key lives ONLY in Vercel env vars.
-- ============================================================

-- Human-friendly order numbers: FC-1001, FC-1002, ...
create sequence if not exists order_seq start 1001;

create or replace function next_order_no()
returns text
language sql
as $$
  select 'FC-' || nextval('order_seq')::text;
$$;

-- Orders table
create table if not exists orders (
  id            uuid primary key default gen_random_uuid(),
  order_no      text unique not null,
  game          text not null,
  pack_label    text not null,
  price_bdt     numeric not null,
  payment_method text not null,              -- bkash | nagad | rocket
  merchant_number text,
  player_uid    text,                        -- game top-ups
  region        text,                        -- game top-ups
  platform      text,                        -- apex: EA | Steam
  delivery_email text,                       -- apex codes
  account_info  text,                        -- subscriptions
  sender_number text not null,               -- 01XXXXXXXXX
  trx_id        text not null,
  order_type    text not null default 'topup', -- topup | code | subscription
  status        text not null default 'pending', -- pending | approved | rejected
  customer_ip   text,
  created_at    timestamptz not null default now(),
  decided_at    timestamptz,
  decided_by    text,
  admin_note    text
);

-- Admin allowlist (login emails)
create table if not exists admins (
  email text primary key
);

insert into admins(email) values
  ('ahasanulhaqueabir2012@gmail.com'),
  ('nightalltimedark62@gmail.com'),
  ('mr.fokinni20@gmail.com')
on conflict (email) do nothing;

-- Rate-limit bookkeeping (service_role only)
create table if not exists order_attempts (
  id         bigint generated always as identity primary key,
  ip         text not null,
  created_at timestamptz not null default now()
);
create index if not exists order_attempts_ip_time
  on order_attempts (ip, created_at desc);

-- Row Level Security
alter table orders enable row level security;
alter table admins enable row level security;
alter table order_attempts enable row level security;

-- Customers (anon) may INSERT pending orders only. No SELECT/UPDATE/DELETE.
drop policy if exists "anon_insert_orders" on orders;
create policy "anon_insert_orders" on orders
  for insert to anon
  with check (status = 'pending');

-- Admins (authenticated, allowlisted email) may read and update orders.
drop policy if exists "admin_select_orders" on orders;
create policy "admin_select_orders" on orders
  for select to authenticated
  using (exists (select 1 from admins where admins.email = auth.jwt()->>'email'));

drop policy if exists "admin_update_orders" on orders;
create policy "admin_update_orders" on orders
  for update to authenticated
  using (exists (select 1 from admins where admins.email = auth.jwt()->>'email'));

-- No anon/authenticated policies on admins & order_attempts:
-- service_role (used by /api/orders) bypasses RLS.
