/**
 * Regras de pagamento sem I/O, para serem testadas sem rede nem banco.
 */

export interface MpPayment {
  id: string | number;
  status?: string;
  status_detail?: string;
  external_reference?: string | null;
  transaction_amount?: number;
  currency_id?: string;
}

export type PaymentOutcome = "approved" | "refunded" | "rejected" | "cancelled" | "pending";

/** Traduz o status do Mercado Pago para o estado interno da compra. Desconhecido vira pendente (não credita). */
export function mapPaymentStatus(status: string | undefined): PaymentOutcome {
  switch (status) {
    case "approved":
      return "approved";
    case "refunded":
    case "charged_back":
      return "refunded";
    case "rejected":
      return "rejected";
    case "cancelled":
      return "cancelled";
    default:
      // pending, in_process, in_mediation, authorized e qualquer status novo
      return "pending";
  }
}

export interface PurchaseSnapshot {
  id: string;
  amount_cents: number;
  currency: string;
}

export type MatchResult = { ok: true } | { ok: false; reason: string };

/**
 * Confere se o pagamento informado pelo Mercado Pago corresponde à compra que criamos.
 * Sem isso, um pagamento de outro valor (ou de outra compra) poderia creditar indevidamente.
 */
export function checkPaymentMatchesPurchase(payment: MpPayment, purchase: PurchaseSnapshot): MatchResult {
  if (payment.external_reference !== purchase.id) {
    return { ok: false, reason: "external_reference não corresponde à compra" };
  }
  if (payment.currency_id !== purchase.currency) {
    return { ok: false, reason: `moeda ${payment.currency_id ?? "ausente"} diferente de ${purchase.currency}` };
  }
  const paidCents = Math.round(Number(payment.transaction_amount) * 100);
  if (!Number.isFinite(paidCents) || paidCents !== purchase.amount_cents) {
    return {
      ok: false,
      reason: `valor ${payment.transaction_amount} diferente de ${purchase.amount_cents} centavos`,
    };
  }
  return { ok: true };
}

/** Só o necessário para auditoria. Não guardamos e-mail, CPF ou dados do cartão do pagador. */
export function minimalPaymentPayload(payment: MpPayment): Record<string, unknown> {
  return {
    id: String(payment.id),
    status: payment.status ?? null,
    status_detail: payment.status_detail ?? null,
    transaction_amount: payment.transaction_amount ?? null,
    currency_id: payment.currency_id ?? null,
    external_reference: payment.external_reference ?? null,
  };
}
