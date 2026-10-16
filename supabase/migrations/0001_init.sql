-- =====================================================================
-- SwapAI: contas, créditos, anti-abuso e jobs
-- Rode no SQL Editor do Supabase (ou `supabase db push`).
-- Toda regra financeira fica dentro de funções Postgres, executadas em
-- transação com lock de linha. Assim não há corrida que gaste crédito duas vezes.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Tabelas ----------

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  credits integer not null default 0 check (credits >= 0),
  -- pending: ainda não recebeu nem perdeu o crédito grátis (pode ser reavaliado)
  -- granted: recebeu o crédito grátis
  -- denied:  identidade (e-mail/telefone) já usou o crédito grátis em outra conta
  free_grant_status text not null default 'pending'
    check (free_grant_status in ('pending', 'granted', 'denied')),
  free_grant_reason text,
  signup_ip_hash text,
  banned boolean not null default false,
  created_at timestamptz not null default now()
);

-- Identidades que já receberam o crédito grátis (e-mail normalizado, telefone).
-- SEM foreign key de propósito: apagar a conta NÃO libera o crédito grátis de novo.
create table if not exists public.free_grant_claims (
  fingerprint text primary key,
  user_id uuid not null,
  created_at timestamptz not null default now()
);

create table if not exists public.credit_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  delta integer not null,
  reason text not null
    check (reason in ('free_grant', 'purchase', 'job_debit', 'job_refund', 'admin_adjust')),
  ref text,
  created_at timestamptz not null default now(),
  -- idempotência: o mesmo pagamento / job / reembolso nunca é aplicado duas vezes
  unique (reason, ref)
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  idempotency_key text not null,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'RUNNING', 'SAVING', 'SUCCEEDED', 'FAILED')),
  input_image_url text not null,
  input_video_url text not null,
  alibaba_task_id text,
  remote_video_url text,
  result_url text,
  error_message text,
  save_attempts integer not null default 0,
  refunded boolean not null default false,
  consent_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

-- No máximo UMA geração ativa por usuário (evita gastar tudo em paralelo)
create unique index if not exists jobs_one_active_per_user
  on public.jobs (user_id)
  where status in ('PENDING', 'RUNNING', 'SAVING');

create index if not exists jobs_user_created_idx on public.jobs (user_id, created_at);
create index if not exists jobs_created_idx on public.jobs (created_at);
create index if not exists profiles_ip_created_idx on public.profiles (signup_ip_hash, created_at);

-- ---------- Segurança de acesso ----------
-- RLS ligado e SEM políticas: anon/authenticated não leem nem escrevem.
-- Só o servidor (service_role) acessa estas tabelas.
alter table public.profiles enable row level security;
alter table public.free_grant_claims enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.jobs enable row level security;

-- ---------- Funções atômicas ----------

-- 1) Garante o perfil e decide o crédito grátis (no máximo 1 por identidade).
--    Contas sem direito ficam 'pending' e são reavaliadas nos próximos acessos
--    (ex.: depois que o usuário verifica o telefone).
create or replace function public.ensure_profile(
  p_user uuid,
  p_claim_keys text[],
  p_ip_hash text,
  p_eligible boolean,
  p_ineligible_reason text,
  p_free_credits integer,
  p_max_signups_per_ip_day integer
) returns table (r_credits integer, r_free_status text, r_banned boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_profile public.profiles%rowtype;
  v_recent integer;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));

  select * into v_profile from public.profiles p where p.id = p_user for update;
  if not found then
    insert into public.profiles (id, credits, free_grant_status, signup_ip_hash)
    values (p_user, 0, 'pending', p_ip_hash)
    returning * into v_profile;
  end if;

  if v_profile.free_grant_status = 'pending' then
    select count(*) into v_recent
      from public.profiles p
     where p.signup_ip_hash = p_ip_hash
       and p.id <> p_user
       and p.created_at > now() - interval '24 hours';

    if not p_eligible then
      update public.profiles
         set free_grant_reason = coalesce(p_ineligible_reason, 'not_eligible')
       where id = p_user;
    elsif v_recent >= p_max_signups_per_ip_day then
      update public.profiles
         set free_grant_reason = 'ip_velocity'
       where id = p_user;
    else
      begin
        insert into public.free_grant_claims (fingerprint, user_id)
        select k, p_user from unnest(p_claim_keys) as k;

        update public.profiles
           set credits = credits + p_free_credits,
               free_grant_status = 'granted',
               free_grant_reason = null
         where id = p_user;

        insert into public.credit_ledger (user_id, delta, reason, ref)
        values (p_user, p_free_credits, 'free_grant', p_user::text)
        on conflict (reason, ref) do nothing;
      exception when unique_violation then
        -- a identidade já foi usada por outra conta: nega de forma definitiva
        update public.profiles
           set free_grant_status = 'denied',
               free_grant_reason = 'identity_already_claimed'
         where id = p_user;
      end;
    end if;
  end if;

  return query
    select p.credits, p.free_grant_status, p.banned
      from public.profiles p
     where p.id = p_user;
end $$;

-- 2) Inicia uma geração: trava o usuário, valida limites, debita 1 crédito e cria o job.
--    Idempotente pelo idempotency_key. Retorna erro de negócio em r_error (sem exceção).
create or replace function public.start_job(
  p_user uuid,
  p_idem text,
  p_image text,
  p_video text,
  p_daily_user_limit integer,
  p_daily_global_limit integer
) returns table (r_job_id uuid, r_status text, r_credits integer, r_error text, r_existing boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_credits integer;
  v_job public.jobs%rowtype;
  v_stale record;
  v_count integer;
begin
  -- serializa todas as requisições deste usuário
  select p.credits into v_credits from public.profiles p where p.id = p_user for update;
  if not found then
    return query select null::uuid, null::text, 0, 'NO_PROFILE'::text, false;
    return;
  end if;

  -- destrava jobs órfãos (usuário fechou a aba, processo caiu): reembolsa e libera a vaga ativa
  --  - sem task na Alibaba há mais de 2 min
  --  - ativo há mais de 60 min
  for v_stale in
    select j.id from public.jobs j
     where j.user_id = p_user
       and (
         (j.status = 'PENDING' and j.alibaba_task_id is null and j.created_at < now() - interval '2 minutes')
         or (j.status in ('PENDING', 'RUNNING', 'SAVING') and j.created_at < now() - interval '60 minutes')
       )
  loop
    perform public.fail_job(v_stale.id, 'Geração expirou. Seu crédito foi devolvido.');
  end loop;

  select p.credits into v_credits from public.profiles p where p.id = p_user;

  -- idempotência: mesmo idempotency_key devolve o job já criado (sem novo débito)
  select * into v_job from public.jobs j
   where j.user_id = p_user and j.idempotency_key = p_idem;
  if found then
    return query select v_job.id, v_job.status, v_credits, null::text, true;
    return;
  end if;

  if v_credits < 1 then
    return query select null::uuid, null::text, v_credits, 'NO_CREDITS'::text, false;
    return;
  end if;

  select count(*) into v_count from public.jobs j
   where j.user_id = p_user and j.created_at > now() - interval '24 hours';
  if v_count >= p_daily_user_limit then
    return query select null::uuid, null::text, v_credits, 'DAILY_LIMIT'::text, false;
    return;
  end if;

  select count(*) into v_count from public.jobs j
   where j.created_at > now() - interval '24 hours';
  if v_count >= p_daily_global_limit then
    return query select null::uuid, null::text, v_credits, 'SERVICE_BUSY'::text, false;
    return;
  end if;

  -- se já existe geração ativa, o índice único estoura e cai no bloco de exceção
  insert into public.jobs (user_id, idempotency_key, status, input_image_url, input_video_url)
  values (p_user, p_idem, 'PENDING', p_image, p_video)
  returning * into v_job;

  update public.profiles set credits = credits - 1 where id = p_user
  returning credits into v_credits;

  insert into public.credit_ledger (user_id, delta, reason, ref)
  values (p_user, -1, 'job_debit', v_job.id::text);

  return query select v_job.id, v_job.status, v_credits, null::text, false;
exception when unique_violation then
  return query select null::uuid, null::text, v_credits, 'JOB_ALREADY_ACTIVE'::text, false;
end $$;

-- 3) Marca o job como FAILED e devolve o crédito, uma única vez.
create or replace function public.fail_job(p_job uuid, p_message text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_job public.jobs%rowtype;
begin
  select * into v_job from public.jobs j where j.id = p_job for update;
  if not found or v_job.status in ('SUCCEEDED', 'FAILED') then
    return;
  end if;

  update public.jobs
     set status = 'FAILED',
         error_message = p_message,
         refunded = true,
         remote_video_url = null,
         updated_at = now()
   where id = p_job;

  if not v_job.refunded then
    update public.profiles set credits = credits + 1 where id = v_job.user_id;
    insert into public.credit_ledger (user_id, delta, reason, ref)
    values (v_job.user_id, 1, 'job_refund', p_job::text)
    on conflict (reason, ref) do nothing;
  end if;
end $$;

-- 4) Trava o salvamento do vídeo para que dois pollings não salvem ao mesmo tempo.
--    Retorna: claimed | busy | closed | exhausted | missing
create or replace function public.claim_save(p_job uuid, p_remote text, p_max_attempts integer)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_job public.jobs%rowtype;
begin
  select * into v_job from public.jobs j where j.id = p_job for update;
  if not found then return 'missing'; end if;
  if v_job.status = 'SAVING' and v_job.updated_at > now() - interval '90 seconds' then
    return 'busy';
  end if;
  if v_job.status not in ('PENDING', 'RUNNING', 'SAVING') then return 'closed'; end if;
  if v_job.save_attempts >= p_max_attempts then return 'exhausted'; end if;

  update public.jobs
     set status = 'SAVING',
         remote_video_url = p_remote,
         save_attempts = save_attempts + 1,
         updated_at = now()
   where id = p_job;
  return 'claimed';
end $$;

-- 5) Crédito administrativo (compensações, cortesias), idempotente pela referência.
--    Compras NÃO passam por aqui: elas são creditadas por apply_payment_status (0002).
create or replace function public.admin_grant(p_user uuid, p_ref text, p_credits integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
begin
  insert into public.credit_ledger (user_id, delta, reason, ref)
  values (p_user, p_credits, 'admin_adjust', p_ref)
  on conflict (reason, ref) do nothing
  returning id into v_id;

  if v_id is null then return false; end if;

  update public.profiles set credits = credits + p_credits where id = p_user;
  return true;
end $$;

-- Só o service_role executa estas funções
revoke execute on function public.ensure_profile(uuid, text[], text, boolean, text, integer, integer) from public, anon, authenticated;
revoke execute on function public.start_job(uuid, text, text, text, integer, integer) from public, anon, authenticated;
revoke execute on function public.fail_job(uuid, text) from public, anon, authenticated;
revoke execute on function public.claim_save(uuid, text, integer) from public, anon, authenticated;
revoke execute on function public.admin_grant(uuid, text, integer) from public, anon, authenticated;
