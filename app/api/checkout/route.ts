import { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { env } from "@/lib/config";
import { countOpenPurchases, createPurchase, markPurchaseCancelled, setPurchaseAwaitingPayment } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { apiError, json, toErrorResponse } from "@/lib/http";
import { createCheckoutPreference, MercadoPagoError } from "@/lib/mercadopago";
import { getPack } from "@/lib/pricing";
import { enforceRateLimit } from "@/lib/security/ratelimit";
import { assertSameOrigin, getClientIp } from "@/lib/security/request";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_OPEN_PURCHASES = 5;

const bodySchema = z.object({
  packId: z.string().min(1).max(20),
});

/**
 * POST /api/checkout
 * 1. Login, mesma origem e rate limit
 * 2. Pacote validado no servidor (o cliente não envia preço)
 * 3. Cria a compra no banco (status created)
 * 4. Cria a preferência no Mercado Pago com external_reference = id da compra
 * 5. Devolve a URL de pagamento. O crédito só entra pelo webhook, nunca aqui.
 */
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req.headers);
    const user = await requireUser();

    const [allowedUser, allowedIp] = await Promise.all([
      enforceRateLimit("checkout-user", user.id, 5, "10 m"),
      enforceRateLimit("checkout-ip", getClientIp(req.headers), 20, "10 m"),
    ]);
    if (!allowedUser || !allowedIp) {
      return apiError(429, "RATE_LIMITED", "Muitas tentativas de pagamento. Aguarde alguns minutos.");
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return apiError(400, "BAD_REQUEST", "Pacote inválido.");

    const pack = getPack(parsed.data.packId);
    if (!pack) return apiError(400, "UNKNOWN_PACK", "Pacote inválido.");

    const appUrl = env().NEXT_PUBLIC_APP_URL;
    if (!appUrl) {
      throw new HttpError(500, "CONFIG_ERROR", "Pagamentos ainda não estão configurados.");
    }

    if ((await countOpenPurchases(user.id)) >= MAX_OPEN_PURCHASES) {
      return apiError(
        429,
        "TOO_MANY_OPEN",
        "Você tem muitas compras em aberto. Conclua uma delas ou aguarde alguns minutos antes de tentar de novo.",
      );
    }

    const purchaseId = await createPurchase({
      userId: user.id,
      packId: pack.id,
      credits: pack.credits,
      amountCents: pack.priceCents,
      currency: "BRL",
    });

    try {
      const preference = await createCheckoutPreference({
        purchaseId,
        packId: pack.id,
        itemTitle: `SwapAI - ${pack.credits} créditos`,
        unitPrice: pack.priceCents / 100,
        payerEmail: user.email,
        appUrl,
      });

      await setPurchaseAwaitingPayment(purchaseId, preference.id);
      return json({ purchaseId, checkoutUrl: preference.init_point }, 201);
    } catch (err) {
      await markPurchaseCancelled(purchaseId);
      if (err instanceof MercadoPagoError) {
        console.error(`[SwapAI][checkout] Mercado Pago recusou a preferência (HTTP ${err.status}): ${err.message}`);
        return apiError(502, "PAYMENT_PROVIDER_ERROR", "Não foi possível iniciar o pagamento agora. Tente novamente em instantes.");
      }
      throw err;
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
