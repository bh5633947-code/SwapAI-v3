import { createHash } from "crypto";
import { headers } from "next/headers";
import { env } from "@/lib/config";
import { HttpError } from "@/lib/errors";
import { createSupabaseAdmin, createSupabaseServerClient } from "@/lib/supabase/server";
import { identityFingerprint, isDisposableEmail, normalizeEmail } from "@/lib/security/email";
import { getClientIp, hashIp } from "@/lib/security/request";

export class AuthError extends HttpError {}

export interface AuthedUser {
  id: string;
  email: string;
  storageKey: string;
  credits: number;
  freeGrantStatus: string;
}

/** Pasta não reversível no storage, derivada do userId. Não expõe o id real. */
export function storageKeyFor(userId: string): string {
  return createHash("sha256").update(`swapai-storage:${userId}`).digest("hex").slice(0, 24);
}

/**
 * Autentica a requisição com o token do Supabase (validado no servidor com getUser),
 * garante o perfil e aplica as regras de crédito grátis.
 * Lança AuthError se não houver sessão válida, e-mail confirmado ou conta ativa.
 */
export async function requireUser(): Promise<AuthedUser> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  const user = data.user;

  if (error || !user?.email) {
    throw new AuthError(401, "UNAUTHENTICATED", "Faça login para continuar.");
  }
  if (!user.email_confirmed_at) {
    throw new AuthError(403, "EMAIL_NOT_VERIFIED", "Confirme seu e-mail para continuar.");
  }

  const cfg = env();
  const { normalized, domain } = normalizeEmail(user.email);
  const ip = getClientIp(await headers());

  const phone = user.phone ? user.phone.replace(/\D/g, "") : "";
  const claimKeys = [identityFingerprint("email", normalized)];
  if (phone) claimKeys.push(identityFingerprint("phone", phone));

  let eligible = true;
  let ineligibleReason: string | null = null;
  if (isDisposableEmail(domain)) {
    eligible = false;
    ineligibleReason = "disposable_email";
  } else if (cfg.REQUIRE_PHONE_VERIFICATION && !phone) {
    eligible = false;
    ineligibleReason = "phone_required";
  }

  const { data: rows, error: rpcError } = await createSupabaseAdmin().rpc("ensure_profile", {
    p_user: user.id,
    p_claim_keys: claimKeys,
    p_ip_hash: hashIp(ip),
    p_eligible: eligible,
    p_ineligible_reason: ineligibleReason,
    p_free_credits: cfg.FREE_SIGNUP_CREDITS,
    p_max_signups_per_ip_day: cfg.MAX_SIGNUPS_PER_IP_PER_DAY,
  });

  if (rpcError || !rows?.[0]) {
    throw new Error(`ensure_profile falhou: ${rpcError?.message ?? "sem resposta"}`);
  }

  const profile = rows[0] as { r_credits: number; r_free_status: string; r_banned: boolean };
  if (profile.r_banned) {
    throw new AuthError(403, "BANNED", "Conta suspensa. Entre em contato com o suporte.");
  }

  return {
    id: user.id,
    email: user.email,
    storageKey: storageKeyFor(user.id),
    credits: profile.r_credits,
    freeGrantStatus: profile.r_free_status,
  };
}
