// Testa as regras de crédito e anti-abuso diretamente no Postgres (PGlite = Postgres em WASM).
// Usa a migration real do projeto. Só troca `create extension pgcrypto` (gen_random_uuid já é nativo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(new URL("../supabase/migrations/0001_init.sql", import.meta.url), "utf8")
  .replace(/create extension[^;]*;/, "");

const db = new PGlite();
await db.exec(`
  do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
  create schema if not exists auth;
  create table auth.users (id uuid primary key);
`);
await db.exec(migration);

const newUser = async () => {
  const id = crypto.randomUUID();
  await db.query("insert into auth.users (id) values ($1)", [id]);
  return id;
};

const ensure = async (user, keys, ip, eligible = true, reason = null, maxPerIp = 2) => {
  const arr = `{${keys.map((k) => `"${k}"`).join(",")}}`;
  const r = await db.query(
    "select * from public.ensure_profile($1::uuid, $2::text[], $3, $4, $5, $6, $7)",
    [user, arr, ip, eligible, reason, 1, maxPerIp],
  );
  return r.rows[0];
};

const start = async (user, idem, userLimit = 10, globalLimit = 500) => {
  const r = await db.query("select * from public.start_job($1::uuid, $2, $3, $4, $5, $6)", [
    user,
    idem,
    "https://x.public.blob.vercel-storage.com/uploads/k/image-a.jpg",
    "https://x.public.blob.vercel-storage.com/uploads/k/video-a.mp4",
    userLimit,
    globalLimit,
  ]);
  return r.rows[0];
};

const credits = async (user) => {
  const r = await db.query("select credits from public.profiles where id = $1", [user]);
  return r.rows[0].credits;
};

const claim = async (job, remote, maxAttempts = 3) => {
  const r = await db.query("select public.claim_save($1::uuid, $2, $3) as result", [job, remote, maxAttempts]);
  return r.rows[0].result;
};

// ---------- 1) Crédito grátis: uma vez por identidade ----------

test("1. primeira conta verificada ganha 1 crédito grátis", async () => {
  const u = await newUser();
  const r = await ensure(u, ["email:K1"], "ip-A");
  assert.equal(r.r_credits, 1);
  assert.equal(r.r_free_status, "granted");
});

test("2. mesma identidade em outra conta NÃO ganha crédito (status denied)", async () => {
  const u = await newUser();
  const r = await ensure(u, ["email:K1"], "ip-A");
  assert.equal(r.r_credits, 0);
  assert.equal(r.r_free_status, "denied");
});

test("3. limite de cadastros por IP bloqueia o crédito, mas a conta é criada (pending)", async () => {
  // ip-A já tem 2 contas criadas nas últimas 24h (testes 1 e 2)
  const u = await newUser();
  const r = await ensure(u, ["email:K3"], "ip-A");
  assert.equal(r.r_credits, 0);
  assert.equal(r.r_free_status, "pending");
  assert.equal(r.r_banned, false);
});

test("4. e-mail descartável não ganha crédito, mas é reavaliado e pode ganhar depois", async () => {
  const u = await newUser();
  let r = await ensure(u, ["email:K4"], "ip-B", false, "disposable_email");
  assert.equal(r.r_credits, 0);
  assert.equal(r.r_free_status, "pending");

  r = await ensure(u, ["email:K4", "phone:P4"], "ip-B", true, null);
  assert.equal(r.r_credits, 1);
  assert.equal(r.r_free_status, "granted");

  // chamar de novo não concede outra vez
  r = await ensure(u, ["email:K4", "phone:P4"], "ip-B", true, null);
  assert.equal(r.r_credits, 1);
});

test("5. apagar a conta NÃO libera o crédito grátis de novo", async () => {
  const u = await newUser();
  await ensure(u, ["email:K5"], "ip-C");
  await db.query("delete from auth.users where id = $1", [u]);

  const u2 = await newUser();
  const r = await ensure(u2, ["email:K5"], "ip-C");
  assert.equal(r.r_credits, 0);
  assert.equal(r.r_free_status, "denied");
});

// ---------- 2) Débito, idempotência, concorrência e reembolso ----------

let U;
let job1;
let job2;

test("6. start_job debita 1 crédito e cria o job", async () => {
  U = await newUser();
  await ensure(U, ["email:KU"], "ip-U");
  const r = await start(U, "idem-1");
  assert.equal(r.r_error, null);
  assert.equal(r.r_existing, false);
  assert.equal(await credits(U), 0);
  job1 = r.r_job_id;
});

test("7. mesmo idempotency_key devolve o job existente sem cobrar de novo", async () => {
  const r = await start(U, "idem-1");
  assert.equal(r.r_existing, true);
  assert.equal(r.r_job_id, job1);
  assert.equal(await credits(U), 0);
});

test("8. sem crédito, start_job recusa com NO_CREDITS", async () => {
  const r = await start(U, "idem-2");
  assert.equal(r.r_error, "NO_CREDITS");
  assert.equal(r.r_job_id, null);
});

test("9. com saldo, uma 2ª geração simultânea é bloqueada e não cobra", async () => {
  await db.query("select public.admin_grant($1::uuid, 'pay-1', 5)", [U]);
  const r = await start(U, "idem-3");
  assert.equal(r.r_error, "JOB_ALREADY_ACTIVE");
  assert.equal(await credits(U), 5);
});

test("10. admin_grant com a mesma referência não credita duas vezes", async () => {
  const again = await db.query("select public.admin_grant($1::uuid, 'pay-1', 5) as ok", [U]);
  assert.equal(again.rows[0].ok, false);
  assert.equal(await credits(U), 5);
});

test("11. falha devolve o crédito uma única vez", async () => {
  await db.query("select public.fail_job($1::uuid, 'erro')", [job1]);
  assert.equal(await credits(U), 6);
  await db.query("select public.fail_job($1::uuid, 'erro de novo')", [job1]);
  assert.equal(await credits(U), 6);
});

test("12. após a falha, nova geração é permitida e cobra 1", async () => {
  const r = await start(U, "idem-4");
  assert.equal(r.r_error, null);
  job2 = r.r_job_id;
  assert.equal(await credits(U), 5);
});

test("13. claim_save: sem salvamento duplo, retomada após expirar, fechado após sucesso", async () => {
  assert.equal(await claim(job2, "https://remote/1"), "claimed");
  assert.equal(await claim(job2, "https://remote/1"), "busy");

  await db.query("update public.jobs set updated_at = now() - interval '5 minutes' where id = $1", [job2]);
  assert.equal(await claim(job2, "https://remote/1"), "claimed");

  await db.query("update public.jobs set status = 'SUCCEEDED' where id = $1", [job2]);
  assert.equal(await claim(job2, "https://remote/1"), "closed");
});

test("14. limite diário por usuário bloqueia a geração", async () => {
  // U já tem 2 jobs nas últimas 24h
  const r = await start(U, "idem-5", 2, 500);
  assert.equal(r.r_error, "DAILY_LIMIT");
  assert.equal(await credits(U), 5);
});

test("15. limite global de serviço bloqueia quando a fila do dia está cheia", async () => {
  const r = await start(U, "idem-6", 100, 1);
  assert.equal(r.r_error, "SERVICE_BUSY");
});

test("16. livro-razão bate com o saldo de todos os usuários (nenhum crédito 'do nada')", async () => {
  const r = await db.query(`
    select p.id
      from public.profiles p
      left join public.credit_ledger l on l.user_id = p.id
     group by p.id, p.credits
    having p.credits <> coalesce(sum(l.delta), 0)
  `);
  assert.equal(r.rows.length, 0);
});

test("18. job órfão (sem task na Alibaba há mais de 2 min) é reembolsado e não trava o usuário", async () => {
  const V = await newUser();
  await ensure(V, ["email:KV"], "ip-V");
  await db.query("select public.admin_grant($1::uuid, 'pay-V', 2)", [V]);
  const first = await start(V, "v-1");
  assert.equal(first.r_error, null);
  assert.equal(await credits(V), 2); // 1 grátis + 2 comprados - 1 da geração

  // simula: o processo caiu antes de criar a tarefa na Alibaba
  await db.query("update public.jobs set created_at = now() - interval '3 minutes' where id = $1", [first.r_job_id]);

  const second = await start(V, "v-2");
  assert.equal(second.r_error, null, "não pode ficar bloqueado por job órfão");
  assert.equal(await credits(V), 2); // 3 - 1 (órfão) + 1 (reembolso) - 1 (nova)
  const st = await db.query("select status, refunded from public.jobs where id = $1", [first.r_job_id]);
  assert.equal(st.rows[0].status, "FAILED");
  assert.equal(st.rows[0].refunded, true);
});

test("19. job ativo há mais de 60 min (ex.: geração presa) também é destravado", async () => {
  const W = await newUser();
  await ensure(W, ["email:KW"], "ip-W");
  await db.query("select public.admin_grant($1::uuid, 'pay-W', 3)", [W]);
  const first = await start(W, "w-1");
  await db.query("update public.jobs set status = 'RUNNING', alibaba_task_id = 'task-w', created_at = now() - interval '61 minutes' where id = $1", [first.r_job_id]);
  const second = await start(W, "w-2");
  assert.equal(second.r_error, null);
  assert.equal(await credits(W), 3); // 1 grátis + 3 comprados = 4; -1 (travado) +1 (reembolso) -1 (nova) = 3
});
