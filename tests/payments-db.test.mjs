// Fluxo de pagamento no Postgres real (PGlite), com as migrations 0001 e 0002.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const load = (file) =>
  readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8").replace(/create extension[^;]*;/, "");

const db = new PGlite();
await db.exec(`
  do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
  create schema if not exists auth;
  create table auth.users (id uuid primary key);
`);
await db.exec(load("0001_init.sql"));
await db.exec(load("0002_payments.sql"));

const newUser = async () => {
  const id = crypto.randomUUID();
  await db.query("insert into auth.users (id) values ($1)", [id]);
  await db.query(`select * from public.ensure_profile($1::uuid, '{"email:pay"}'::text[], $2, true, null, 1, 99)`, [
    id,
    `ip-${id}`,
  ]);
  return id;
};

const newPurchase = async (user, credits = 10, cents = 1990) => {
  const r = await db.query(
    `insert into public.purchases (user_id, pack_id, credits, amount_cents, currency, status)
     values ($1, 'starter', $2, $3, 'BRL', 'pending') returning id`,
    [user, credits, cents],
  );
  return r.rows[0].id;
};

const apply = async (purchase, paymentId, status, eventKey = `${paymentId}:${status}`) => {
  const r = await db.query("select public.apply_payment_status($1::uuid, $2, $3, null, $4, $5::jsonb) as r", [
    purchase,
    paymentId,
    status,
    eventKey,
    JSON.stringify({ id: paymentId, status }),
  ]);
  return r.rows[0].r;
};

const credits = async (user) => (await db.query("select credits from public.profiles where id = $1", [user])).rows[0].credits;

const purchaseStatus = async (purchase) =>
  (await db.query("select status from public.purchases where id = $1", [purchase])).rows[0].status;

const M = await newUser(); // conta com 1 crédito grátis

test("1. pagamento aprovado credita o pacote uma única vez", async () => {
  const p1 = await newPurchase(M);
  assert.equal(await apply(p1, "pay-1", "approved"), "approved");
  assert.equal(await credits(M), 11);
  assert.equal(await purchaseStatus(p1), "approved");
});

test("2. mesma notificação recebida de novo é ignorada pelo dedupe", async () => {
  const p1 = (await db.query("select id from public.purchases where mp_payment_id = 'pay-1'")).rows[0].id;
  assert.equal(await apply(p1, "pay-1", "approved"), "duplicate_event");
  assert.equal(await credits(M), 11);
});

test("3. outra notificação de aprovação para a mesma compra não credita de novo", async () => {
  const p1 = (await db.query("select id from public.purchases where mp_payment_id = 'pay-1'")).rows[0].id;
  assert.equal(await apply(p1, "pay-1", "approved", "pay-1:approved:retry"), "already_approved");
  assert.equal(await credits(M), 11);
});

test("4. reembolso total tira os créditos comprados", async () => {
  const p1 = (await db.query("select id from public.purchases where mp_payment_id = 'pay-1'")).rows[0].id;
  assert.equal(await apply(p1, "pay-1", "refunded"), "refunded");
  assert.equal(await credits(M), 1);
  assert.equal(await purchaseStatus(p1), "refunded");
});

test("5. reembolso sem saldo suficiente tira só o que há (nunca fica negativo)", async () => {
  const p2 = await newPurchase(M);
  assert.equal(await apply(p2, "pay-2", "approved"), "approved");
  assert.equal(await credits(M), 11);

  // usuário gasta 9 créditos em gerações
  await db.query("update public.profiles set credits = credits - 9 where id = $1", [M]);
  await db.query(
    "insert into public.credit_ledger (user_id, delta, reason, ref) values ($1, -9, 'job_debit', 'gastos-teste')",
    [M],
  );
  assert.equal(await credits(M), 2);

  assert.equal(await apply(p2, "pay-2", "refunded"), "refunded_partial");
  assert.equal(await credits(M), 0);
});

test("6. pagamento rejeitado não credita; depois aprovado credita uma única vez", async () => {
  const p3 = await newPurchase(M);
  assert.equal(await apply(p3, "pay-3r", "rejected"), "updated");
  assert.equal(await purchaseStatus(p3), "rejected");
  assert.equal(await credits(M), 0);

  assert.equal(await apply(p3, "pay-3", "approved"), "approved");
  assert.equal(await credits(M), 10);

  // notificação de rejeição chegando depois da aprovação não desfaz nada
  assert.equal(await apply(p3, "pay-3x", "rejected"), "ignored_approved");
  assert.equal(await purchaseStatus(p3), "approved");
  assert.equal(await credits(M), 10);
});

test("7. pagamento pendente (Pix/boleto) não credita ainda", async () => {
  const p4 = await newPurchase(M);
  assert.equal(await apply(p4, "pay-4", "pending"), "updated");
  assert.equal(await purchaseStatus(p4), "pending");
  assert.equal(await credits(M), 10);
});

test("8. reembolso de compra nunca paga não mexe no saldo", async () => {
  const p5 = await newPurchase(M);
  assert.equal(await apply(p5, "pay-5", "refunded"), "refunded_unpaid");
  assert.equal(await purchaseStatus(p5), "refunded");
  assert.equal(await credits(M), 10);
});

test("9. compra já revertida é final: aprovação atrasada não reabre", async () => {
  const p5 = (await db.query("select id from public.purchases where mp_payment_id = 'pay-5'")).rows[0].id;
  assert.equal(await apply(p5, "pay-5b", "approved"), "closed");
  assert.equal(await purchaseStatus(p5), "refunded");
  assert.equal(await credits(M), 10);
});

test("10. notificação de compra desconhecida não faz nada", async () => {
  assert.equal(await apply(crypto.randomUUID(), "pay-x", "approved"), "missing");
});

test("11. livro-razão bate com o saldo de todos os usuários após todo o fluxo", async () => {
  const r = await db.query(`
    select p.id
      from public.profiles p
      left join public.credit_ledger l on l.user_id = p.id
     group by p.id, p.credits
    having p.credits <> coalesce(sum(l.delta), 0)
  `);
  assert.equal(r.rows.length, 0);
});

test("12. cada evento fica registrado para auditoria, sem dados do pagador", async () => {
  const r = await db.query("select count(*)::int as n from public.payment_events");
  assert.ok(r.rows[0].n >= 8);
  const pii = await db.query("select count(*)::int as n from public.payment_events where payload::text like '%payer%'");
  assert.equal(pii.rows[0].n, 0);
});
