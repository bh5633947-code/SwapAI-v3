import { env } from "@/lib/config";
import type { MpPayment } from "@/lib/payments/logic";

const API_BASE = "https://api.mercadopago.com";
const TIMEOUT_MS = 15_000;

export class MercadoPagoError extends Error {
  constructor(
    readonly status: number, // 0 = falha de rede
    message: string,
  ) {
    super(message);
    this.name = "MercadoPagoError";
  }

  /** Erros que vale tentar de novo (o webhook do Mercado Pago é reenviado quando respondemos 5xx). */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

function accessToken(): string {
  const token = env().MP_ACCESS_TOKEN;
  if (!token) throw new Error("MP_ACCESS_TOKEN não configurado.");
  return token;
}

async function mpFetch<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; idempotencyKey?: string },
): Promise<T> {
  const token = accessToken();

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.idempotencyKey ? { "X-Idempotency-Key": init.idempotencyKey } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new MercadoPagoError(0, `Falha de rede no Mercado Pago: ${(err as Error).message}`);
  }

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // corpo não-JSON: usa só o status
  }

  if (!res.ok) {
    const message = (data as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
    throw new MercadoPagoError(res.status, message);
  }
  return data as T;
}

export interface CheckoutPreference {
  id: string;
  init_point: string;
}

export interface CreatePreferenceInput {
  purchaseId: string;
  packId: string;
  itemTitle: string;
  unitPrice: number; // em reais, ex.: 19.9
  payerEmail: string;
  appUrl: string;
}

/**
 * Cria a preferência do Checkout Pro.
 * external_reference = id da compra: é isso que liga o pagamento ao usuário no webhook.
 * X-Idempotency-Key = id da compra: repetir a chamada não cria duas preferências.
 */
export async function createCheckoutPreference(input: CreatePreferenceInput): Promise<CheckoutPreference> {
  return mpFetch<CheckoutPreference>("/checkout/preferences", {
    method: "POST",
    idempotencyKey: `pref-${input.purchaseId}`,
    body: {
      items: [
        {
          id: input.packId,
          title: input.itemTitle,
          quantity: 1,
          unit_price: input.unitPrice,
          currency_id: "BRL",
        },
      ],
      external_reference: input.purchaseId,
      notification_url: `${input.appUrl}/api/webhooks/mercadopago`,
      back_urls: {
        success: `${input.appUrl}/?pagamento=sucesso`,
        failure: `${input.appUrl}/?pagamento=falha`,
        pending: `${input.appUrl}/?pagamento=pendente`,
      },
      auto_return: "approved",
      statement_descriptor: "SWAPAI",
      payer: { email: input.payerEmail },
      payment_methods: { installments: 1 },
    },
  });
}

/** Busca o pagamento direto na API. Nunca confiamos no corpo do webhook. */
export async function getPayment(paymentId: string): Promise<MpPayment> {
  return mpFetch<MpPayment>(`/v1/payments/${encodeURIComponent(paymentId)}`, { method: "GET" });
}
