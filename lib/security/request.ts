import { createHmac } from "crypto";
import { HttpError } from "@/lib/errors";
import { env } from "@/lib/config";

/**
 * IP do cliente. Na Vercel o x-real-ip é definido pela plataforma.
 * Fallback: último IP da cadeia x-forwarded-for (o que o proxy acrescentou por último).
 * Confirme o comportamento na sua hospedagem antes de depender do limite por IP.
 */
export function getClientIp(headers: Headers): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;

  const chain = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return chain[chain.length - 1] ?? "unknown";
}

/** Hash irreversível do IP, para contar cadastros por IP sem guardar o IP em claro. */
export function hashIp(ip: string): string {
  return createHmac("sha256", env().IDENTITY_HMAC_SECRET).update(`ip:${ip}`).digest("hex");
}

/**
 * Proteção contra CSRF: requisições que alteram estado só são aceitas
 * se vierem do próprio site. Browsers sempre enviam Origin ou Sec-Fetch-Site.
 */
export function assertSameOrigin(headers: Headers): void {
  const origin = headers.get("origin");
  if (origin) {
    const host = headers.get("x-forwarded-host") ?? headers.get("host");
    const proto = headers.get("x-forwarded-proto") ?? (process.env.NODE_ENV === "production" ? "https" : "http");
    if (!host || origin !== `${proto}://${host}`) {
      throw new HttpError(403, "CROSS_ORIGIN", "Requisição bloqueada por segurança.");
    }
    return;
  }

  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new HttpError(403, "CROSS_ORIGIN", "Requisição bloqueada por segurança.");
  }
}
