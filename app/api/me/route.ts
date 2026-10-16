import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { getActiveJobId } from "@/lib/db";
import { apiError, json, toErrorResponse } from "@/lib/http";
import { enforceRateLimit } from "@/lib/security/ratelimit";
import { getClientIp } from "@/lib/security/request";

export const runtime = "nodejs";

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

/** GET /api/me: saldo, status do crédito grátis e chave de storage da sessão. */
export async function GET(req: NextRequest) {
  try {
    if (!(await enforceRateLimit("me-ip", getClientIp(req.headers), 60, "1 m"))) {
      return apiError(429, "RATE_LIMITED", "Muitas requisições. Aguarde um minuto.");
    }

    const user = await requireUser();
    return json({
      email: maskEmail(user.email),
      credits: user.credits,
      storageKey: user.storageKey,
      freeGrantStatus: user.freeGrantStatus,
      activeJobId: await getActiveJobId(user.id),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
