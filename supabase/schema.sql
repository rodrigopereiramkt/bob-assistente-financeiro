-- Bob - Assistente Financeiro: schema do Supabase
-- Rode no SQL Editor do Supabase (uma vez).

create extension if not exists pgcrypto;

create table if not exists public.users (
  id          uuid primary key default gen_random_uuid(),
  phone       text not null unique,          -- número/JID do WhatsApp
  name        text,
  created_at  timestamptz not null default now()
);

create table if not exists public.transactions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  type        text not null check (type in ('receita', 'despesa')),
  amount      numeric(12, 2) not null check (amount > 0),
  category    text not null default 'Outros',
  description text,
  occurred_on date not null,
  message_id  text,                          -- mensagem do WhatsApp que gerou o lançamento
  created_at  timestamptz not null default now()
);

create index if not exists transactions_user_date_idx
  on public.transactions (user_id, occurred_on desc);
create index if not exists transactions_user_created_idx
  on public.transactions (user_id, created_at desc);

-- Evita processar a mesma mensagem duas vezes (a Evolution pode reenviar webhooks).
create table if not exists public.processed_messages (
  message_id  text primary key,
  created_at  timestamptz not null default now()
);

-- RLS ligado e sem policies: só a service role (usada pelo backend) acessa.
alter table public.users              enable row level security;
alter table public.transactions       enable row level security;
alter table public.processed_messages enable row level security;
