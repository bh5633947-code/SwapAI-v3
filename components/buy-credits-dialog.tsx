"use client";

import { useState } from "react";
import { Loader2, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PACKS, formatBRL, type PackId } from "@/lib/pricing";

const TRUSTED_CHECKOUT_SUFFIXES = [".mercadopago.com", ".mercadopago.com.br"];

/** Só redireciona para o domínio do Mercado Pago (evita open redirect se a resposta vier adulterada). */
function isTrustedCheckout(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && TRUSTED_CHECKOUT_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

export function BuyCreditsDialog({ onClose }: { onClose: () => void }) {
  const [loadingPack, setLoadingPack] = useState<PackId | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function buy(packId: PackId) {
    if (loadingPack) return;
    setLoadingPack(packId);
    setError(null);

    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        checkoutUrl?: string;
        error?: { message: string };
      };

      if (!res.ok || !data.checkoutUrl) {
        throw new Error(data.error?.message ?? "Não foi possível iniciar o pagamento.");
      }
      if (!isTrustedCheckout(data.checkoutUrl)) {
        throw new Error("Link de pagamento inesperado. Tente novamente.");
      }

      window.location.assign(data.checkoutUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado. Tente novamente.");
      setLoadingPack(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="buy-title"
        className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="buy-title" className="text-lg font-semibold">
              Comprar créditos
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">Cada vídeo gerado usa 1 crédito.</p>
          </div>
          <button onClick={onClose} aria-label="Fechar" className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-6 grid gap-3">
          {PACKS.map((pack) => (
            <div
              key={pack.id}
              className="flex items-center justify-between gap-4 rounded-xl border border-border bg-background/50 p-4"
            >
              <div>
                <p className="font-medium">
                  {pack.name} · {pack.credits} créditos
                </p>
                <p className="text-sm text-muted-foreground">{formatBRL(pack.priceCents)}</p>
              </div>
              <Button size="sm" onClick={() => buy(pack.id)} disabled={loadingPack !== null}>
                {loadingPack === pack.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {loadingPack === pack.id ? "Abrindo..." : "Comprar"}
              </Button>
            </div>
          ))}
        </div>

        {error && (
          <p role="alert" className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        )}

        <p className="mt-5 flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
          Pagamento processado pelo Mercado Pago (Pix, cartão ou boleto, conforme disponível). O SwapAI não armazena dados do seu cartão.
        </p>
      </div>
    </div>
  );
}
