import { createHmac } from "crypto";
import disposableDomains from "disposable-email-domains/index.json";
import { env } from "@/lib/config";

const DISPOSABLE = new Set<string>(disposableDomains as string[]);

// Domínios que são o mesmo provedor com outro nome
const DOMAIN_ALIASES: Record<string, string> = { "googlemail.com": "gmail.com" };

// Gmail ignora pontos no usuário: a.b@gmail.com == ab@gmail.com
const DOTS_IGNORED = new Set(["gmail.com"]);

/**
 * Normaliza o e-mail para detectar contas duplicadas.
 * Usado SÓ para a identidade do crédito grátis; o login continua usando o e-mail original.
 */
export function normalizeEmail(raw: string): { normalized: string; domain: string } {
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  const rawDomain = email.slice(at + 1);
  const domain = DOMAIN_ALIASES[rawDomain] ?? rawDomain;

  let local = email.slice(0, at).split("+")[0]; // remove +alias
  if (DOTS_IGNORED.has(domain)) local = local.replace(/\./g, "");

  return { normalized: `${local}@${domain}`, domain };
}

export function isDisposableEmail(domain: string): boolean {
  return DISPOSABLE.has(domain);
}

/**
 * Fingerprint irreversível (HMAC com segredo do servidor).
 * Guardamos só o hash: não dá para descobrir o e-mail a partir do banco.
 */
export function identityFingerprint(kind: "email" | "phone", value: string): string {
  const mac = createHmac("sha256", env().IDENTITY_HMAC_SECRET)
    .update(`${kind}:${value}`)
    .digest("hex");
  return `${kind}:${mac}`;
}
