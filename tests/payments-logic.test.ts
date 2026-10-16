import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "crypto";
import { checkPaymentMatchesPurchase, mapPaymentStatus, minimalPaymentPayload } from "@/lib/payments/logic";
import { verifyMercadoPagoSignature } from "@/lib/payments/signature";

const PURCHASE = {
  id: "9f1c2a3b-4d5e-4f60-8a7b-1c2d3e4f5a6b",
  amount_cents: 1990,
  currency: "BRL",
};

test("status do Mercado Pago viram estados internos corretos", () => {
  assert.equal(mapPaymentStatus("approved"), "approved");
  assert.equal(mapPaymentStatus("refunded"), "refunded");
  assert.equal(mapPaymentStatus("charged_back"), "refunded");
  assert.equal(mapPaymentStatus("rejected"), "rejected");
  assert.equal(mapPaymentStatus("cancelled"), "cancelled");
  assert.equal(mapPaymentStatus("in_process"), "pending");
  assert.equal(mapPaymentStatus("pending"), "pending");
  assert.equal(mapPaymentStatus("status_novo_desconhecido"), "pending"); // nunca credita por engano
  assert.equal(mapPaymentStatus(undefined), "pending");
});

test("pagamento correspondente à compra é aceito", () => {
  const r = checkPaymentMatchesPurchase(
    { id: 1, external_reference: PURCHASE.id, transaction_amount: 19.9, currency_id: "BRL" },
    PURCHASE,
  );
  assert.deepEqual(r, { ok: true });
});

test("valor menor que o do pacote é recusado (não credita)", () => {
  const r = checkPaymentMatchesPurchase(
    { id: 2, external_reference: PURCHASE.id, transaction_amount: 1, currency_id: "BRL" },
    PURCHASE,
  );
  assert.equal(r.ok, false);
});

test("pagamento de outra compra é recusado", () => {
  const r = checkPaymentMatchesPurchase(
    { id: 3, external_reference: "00000000-0000-4000-8000-000000000000", transaction_amount: 19.9, currency_id: "BRL" },
    PURCHASE,
  );
  assert.equal(r.ok, false);
});

test("moeda diferente é recusada", () => {
  const r = checkPaymentMatchesPurchase(
    { id: 4, external_reference: PURCHASE.id, transaction_amount: 19.9, currency_id: "USD" },
    PURCHASE,
  );
  assert.equal(r.ok, false);
});

test("pagamento sem valor ou referência é recusado", () => {
  assert.equal(checkPaymentMatchesPurchase({ id: 5, external_reference: PURCHASE.id, currency_id: "BRL" }, PURCHASE).ok, false);
  assert.equal(checkPaymentMatchesPurchase({ id: 6, transaction_amount: 19.9, currency_id: "BRL" }, PURCHASE).ok, false);
});

test("payload guardado no banco não tem dados pessoais do pagador", () => {
  const payload = minimalPaymentPayload({
    id: 99,
    status: "approved",
    transaction_amount: 19.9,
    currency_id: "BRL",
    external_reference: PURCHASE.id,
    payer: { email: "alguem@exemplo.com", identification: { number: "123" } },
  } as never);
  assert.equal(JSON.stringify(payload).includes("alguem@exemplo.com"), false);
  assert.equal(JSON.stringify(payload).includes("identification"), false);
  assert.equal(payload.id, "99");
});

// ---------- assinatura do webhook ----------

const SECRET = "segredo-de-teste-do-webhook-1234567890";

function sign(dataId: string, requestId: string, ts: string, secret = SECRET): string {
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  return createHmac("sha256", secret).update(manifest).digest("hex");
}

test("assinatura válida é aceita", () => {
  const ts = "1700000000";
  const v1 = sign("123456", "req-abc", ts);
  assert.equal(
    verifyMercadoPagoSignature({ secret: SECRET, signatureHeader: `ts=${ts},v1=${v1}`, requestId: "req-abc", dataId: "123456" }),
    true,
  );
});

test("data.id em maiúsculas é normalizado antes de validar", () => {
  const ts = "1700000001";
  const v1 = sign("abc123", "req-1", ts); // assinado em minúsculas
  assert.equal(
    verifyMercadoPagoSignature({ secret: SECRET, signatureHeader: `ts=${ts},v1=${v1}`, requestId: "req-1", dataId: "ABC123" }),
    true,
  );
});

test("data.id trocado invalida a assinatura (não dá para reaproveitar a assinatura de outro pagamento)", () => {
  const ts = "1700000002";
  const v1 = sign("111", "req-2", ts);
  assert.equal(
    verifyMercadoPagoSignature({ secret: SECRET, signatureHeader: `ts=${ts},v1=${v1}`, requestId: "req-2", dataId: "222" }),
    false,
  );
});

test("request-id, ts ou segredo errados invalidam a assinatura", () => {
  const ts = "1700000003";
  const v1 = sign("333", "req-3", ts);
  assert.equal(
    verifyMercadoPagoSignature({ secret: SECRET, signatureHeader: `ts=${ts},v1=${v1}`, requestId: "outro", dataId: "333" }),
    false,
  );
  assert.equal(
    verifyMercadoPagoSignature({ secret: SECRET, signatureHeader: `ts=9999,v1=${v1}`, requestId: "req-3", dataId: "333" }),
    false,
  );
  assert.equal(
    verifyMercadoPagoSignature({
      secret: "outro-segredo-totalmente-diferente-0000",
      signatureHeader: `ts=${ts},v1=${v1}`,
      requestId: "req-3",
      dataId: "333",
    }),
    false,
  );
});

test("cabeçalho ausente ou malformado é recusado", () => {
  const base = { secret: SECRET, requestId: "r", dataId: "1" };
  assert.equal(verifyMercadoPagoSignature({ ...base, signatureHeader: null }), false);
  assert.equal(verifyMercadoPagoSignature({ ...base, signatureHeader: "" }), false);
  assert.equal(verifyMercadoPagoSignature({ ...base, signatureHeader: "lixo" }), false);
  assert.equal(verifyMercadoPagoSignature({ ...base, signatureHeader: "ts=1,v1=" }), false);
  assert.equal(verifyMercadoPagoSignature({ ...base, signatureHeader: "v1=abc" }), false);
});
