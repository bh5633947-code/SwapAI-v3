import { createHmac, timingSafeEqual } from "crypto";

export interface SignatureInput {
  secret: string;
  /** Cabeçalho x-signature, no formato "ts=<timestamp>,v1=<hex>" */
  signatureHeader: string | null;
  /** Cabeçalho x-request-id */
  requestId: string | null;
  /** data.id do pagamento (da query string ou do corpo) */
  dataId: string;
}

/**
 * Valida a assinatura do webhook do Mercado Pago.
 *
 * Manifesto (conforme a documentação do Mercado Pago):
 *   id:[data.id];request-id:[x-request-id];ts:[ts];
 * Assinado com HMAC-SHA256 usando a chave secreta do webhook.
 * O data.id é convertido para minúsculas quando é alfanumérico.
 */
export function verifyMercadoPagoSignature(input: SignatureInput): boolean {
  if (!input.signatureHeader || !input.dataId || !input.secret) return false;

  const parts = new Map<string, string>();
  for (const piece of input.signatureHeader.split(",")) {
    const eq = piece.indexOf("=");
    if (eq > 0) parts.set(piece.slice(0, eq).trim(), piece.slice(eq + 1).trim());
  }

  const ts = parts.get("ts");
  const v1 = parts.get("v1");
  if (!ts || !v1) return false;

  const manifest = `id:${input.dataId.toLowerCase()};request-id:${input.requestId ?? ""};ts:${ts};`;
  const expected = createHmac("sha256", input.secret).update(manifest).digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(v1, "utf8");
  // comparação em tempo constante: não vaza, pelo tempo de resposta, quantos caracteres batem
  return a.length === b.length && timingSafeEqual(a, b);
}
