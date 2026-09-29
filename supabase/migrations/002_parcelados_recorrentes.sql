-- Parcelados e recorrentes (rode depois do schema.sql)

create table if not exists public.recurring (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  type         text not null check (type in ('receita', 'despesa')),
  amount       numeric(12, 2) not null check (amount > 0),
  category     text not null default 'Outros',
  description  text,
  day_of_month int not null check (day_of_month between 1 and 31),
  next_due     date not null,               -- próxima data em que o Bob lança sozinho
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create index if not exists recurring_due_idx on public.recurring (next_due) where active;
alter table public.recurring enable row level security;

alter table public.transactions add column if not exists series_id uuid;            -- parcelas da mesma compra
alter table public.transactions add column if not exists installment_number int;
alter table public.transactions add column if not exists installment_total int;
alter table public.transactions add column if not exists recurring_id uuid references public.recurring(id) on delete set null;

-- Garante que um recorrente não é lançado duas vezes no mesmo dia (cron + mensagem ao mesmo tempo).
create unique index if not exists transactions_recurring_once_idx
  on public.transactions (recurring_id, occurred_on) where recurring_id is not null;
create index if not exists transactions_series_idx on public.transactions (series_id) where series_id is not null;
