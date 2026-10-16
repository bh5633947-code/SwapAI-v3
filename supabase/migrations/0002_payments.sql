-- =====================================================================
-- 0002: pagamentos via Mercado Pago (Checkout Pro + webhook)
-- Rode depois da 0001.
-- Crédito de compra só é lançado por apply_payment_status, que é idempotente
-- por evento e por pagamento, e trava a linha da compra.
-- =====================================================================

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  pack_id text not null,
  -- snapshot no momento da compra: mudar o preço do pacote depois não altera compras antigas
  credits integer not null check (credits > 0),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'BRL',
  status text not null default 'created'
    check (status in ('created', 'pending', 'approved', 'rejected', 'cancelled', 'refunded')),
  mp_preference_id text,
  mp_payment_id text unique,
  mp_status_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  paid_at timestamptz
);

create index if not exists purchases_user_status_idx on public.purchases (user_id, status, created_at);

-- Auditoria dos eventos do provedor. Sem dados pessoais: só o essencial do pagamento.
create table if not exists public.payment_events (
  id bigint generated always as identity primary key,
  provider text not null,
  event_key text not null unique,            -- "<payment_id>:<status>": evita processar o mesmo evento duas vezes
  purchase_id uuid references public.purchases(id) on delete set null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.purchases enable row level security;
alter table public.payment_events enable row level security;

-- Novo motivo de lançamento no razão: reversão de compra (reembolso / chargeback)
alter table public.credit_ledger drop constraint if exists credit_ledger_reason_check;
alter table public.credit_ledger add constraint credit_ledger_reason_check
  check (reason in ('free_grant', 'purchase', 'job_debit', 'job_refund', 'admin_adjust', 'purchase_reversal'));

-- Aplica um status de pagamento recebido do Mercado Pago.
-- Retorna: missing | duplicate_event | closed | approved | already_approved |
--          refunded | refunded_partial | refunded_unpaid | ignored_approved | updated
create or replace function public.apply_payment_status(
  p_purchase uuid,
  p_payment_id text,
  p_status text,
  p_status_detail text,
  p_event_key text,
  p_payload jsonb
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_p public.purchases%rowtype;
  v_balance integer;
  v_take integer;
begin
  -- trava a compra: notificações simultâneas do mesmo pagamento entram uma de cada vez
  select * into v_p from public.purchases p where p.id = p_purchase for update;
  if not found then return 'missing'; end if;

  -- auditoria e dedupe do evento
  insert into public.payment_events (provider, event_key, purchase_id, payload)
  values ('mercadopago', p_event_key, p_purchase, p_payload)
  on conflict (event_key) do nothing;
  if not found then return 'duplicate_event'; end if;

  -- compra já revertida é final: nenhum evento posterior reabre
  if v_p.status = 'refunded' then return 'closed'; end if;

  if p_status = 'approved' then
    if v_p.status = 'approved' then return 'already_approved'; end if;

    update public.purchases
       set status = 'approved',
           mp_payment_id = p_payment_id,
           mp_status_detail = p_status_detail,
           paid_at = now(),
           updated_at = now()
     where id = p_purchase;

    update public.profiles set credits = credits + v_p.credits where id = v_p.user_id;

    insert into public.credit_ledger (user_id, delta, reason, ref)
    values (v_p.user_id, v_p.credits, 'purchase', p_payment_id)
    on conflict (reason, ref) do nothing;

    return 'approved';
  end if;

  if p_status = 'refunded' then
    if v_p.status <> 'approved' then
      update public.purchases
         set status = 'refunded',
             mp_payment_id = coalesce(mp_payment_id, p_payment_id),
             mp_status_detail = p_status_detail,
             updated_at = now()
       where id = p_purchase;
      return 'refunded_unpaid';
    end if;

    -- tira os créditos comprados, limitado ao saldo atual (nunca fica negativo).
    -- Créditos já gastos em gerações não são recuperados: a diferença fica registrada no retorno.
    select p.credits into v_balance from public.profiles p where p.id = v_p.user_id for update;
    v_take := least(v_p.credits, v_balance);

    if v_take > 0 then
      update public.profiles set credits = credits - v_take where id = v_p.user_id;
      insert into public.credit_ledger (user_id, delta, reason, ref)
      values (v_p.user_id, -v_take, 'purchase_reversal', p_payment_id)
      on conflict (reason, ref) do nothing;
    end if;

    update public.purchases
       set status = 'refunded',
           mp_status_detail = p_status_detail,
           updated_at = now()
     where id = p_purchase;

    return case when v_take < v_p.credits then 'refunded_partial' else 'refunded' end;
  end if;

  -- rejected, cancelled, pending e demais estados intermediários
  if v_p.status = 'approved' then return 'ignored_approved'; end if;

  update public.purchases
     set status = case when p_status in ('rejected', 'cancelled') then p_status else 'pending' end,
         mp_payment_id = p_payment_id,
         mp_status_detail = p_status_detail,
         updated_at = now()
   where id = p_purchase;

  return 'updated';
end $$;

revoke execute on function public.apply_payment_status(uuid, text, text, text, text, jsonb) from public, anon, authenticated;
