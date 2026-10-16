import { NextRequest } from "next/server";
import { env } from "@/lib/config";
import { apiError, json } from "@/lib/http";
import { applyPaymentStatus, getPurchase } from "@/lib/db";
import { getPayment, MercadoPagoError } from "@/lib/mercadopago";
import { checkPaymentMatchesPurchase, mapPaymentStatus, minimalPaymentPayload } from "@/lib/payments/logic";
import { verifyMercadoPagoSignature } from "@/lib/payments/signature";

export const runtime = "nodejs";
export const maxDuration = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface WebhookBody {
  type?: string;
  topic?: string;
  data?: { id?: string | number };
}

/**
 * POST /api/webhooks/mercadopago
 *
 * Regras de segurança:
 *  - A assinatura é conferida antes de qualquer coisa. Sem assinatura válida, nada acontece.
 *  - O corpo da notificação só diz "há um pagamento X". O status e o valor vêm da API do Mercado Pago.
 *  - O valor e a moeda são conferidos contra a compra que criamos antes de creditar.
 *  - Respostas 5xx fazem o Mercado Pago reenviar. Erros definitivos respondem 200 para não ficar em loop.
 */
export async function POST(req: NextRequest) {
  const cfg = env();
  if (!cfg.MP_WEBHOOK_SECRET) {
    console.error("[SwapAI][pagamento] MP_WEBHOOK_SECRET não configurado: webhook recusado.");
    return apiError(500, "CONFIG_ERROR", "Webhook não configurado.");
  }

  let body: WebhookBody | null = null;
  try {
    body = (await req.json()) as WebhookBody;
  } catch {
    return apiError(400, "BAD_REQUEST", "Corpo inválido.");
  }

  const url = new URL(req.url);
  const dataId = String(url.searchParams.get("data.id") ?? body?.data?.id ?? "");
  const type = url.searchParams.get("type") ?? body?.type ?? body?.topic;

  const valid = verifyMercadoPagoSignature({
    secret: cfg.MP_WEBHOOK_SECRET,
    signatureHeader: req.headers.get("x-signature"),
    requestId: req.headers.get("x-request-id"),
    dataId,
  });
  if (!valid) {
    console.warn("[SwapAI][pagamento] notificação com assinatura inválida recusada.");
    return apiError(401, "INVALID_SIGNATURE", "Assinatura inválida.");
  }

  if (type !== "payment") return json({ ignored: "not_payment" });

  try {
    // Fonte da verdade: a API do Mercado Pago, não o corpo recebido
    const payment = await getPayment(dataId);

    const purchaseId = payment.external_reference ?? "";
    if (!UUID_RE.test(purchaseId)) return json({ ignored: "no_reference" });

    const purchase = await getPurchase(purchaseId);
    if (!purchase) return json({ ignored: "unknown_purchase" });

    const match = checkPaymentMatchesPurchase(payment, purchase);
    if (!match.ok) {
      // Não credita e responde 200 para não reenviar. Exige revisão manual.
      console.error(
        `[SwapAI][pagamento] DIVERGÊNCIA no pagamento ${payment.id} da compra ${purchaseId}: ${match.reason}. Revisar manualmente.`,
      );
      return json({ ok: false, reason: "mismatch" });
    }

    const outcome = mapPaymentStatus(payment.status);
    const result = await applyPaymentStatus({
      purchaseId,
      paymentId: String(payment.id),
      status: outcome,
      statusDetail: payment.status_detail ?? null,
      eventKey: `${payment.id}:${outcome}`,
      payload: minimalPaymentPayload(payment),
    });

    return json({ ok: true, result });
  } catch (err) {
    if (err instanceof MercadoPagoError && err.status === 404) {
      return json({ ignored: "payment_not_found" });
    }
    // 5xx, 429, falha de rede ou credencial errada: responde 500 para o Mercado Pago tentar de novo
    console.error("[SwapAI][pagamento] erro ao processar webhook:", err);
    return apiError(500, "WEBHOOK_RETRY", "Erro temporário. Tente novamente.");
  }
}
