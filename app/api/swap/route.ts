import { NextRequest } from "next/server";
import { z } from "zod";
import { createAnimateMixTask, describeAlibabaError } from "@/lib/alibaba";
import { requireUser } from "@/lib/auth";
import { failJob, setTaskId, startJob } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { apiError, json, toErrorResponse } from "@/lib/http";
import { deleteInputs } from "@/lib/storage";
import { enforceRateLimit } from "@/lib/security/ratelimit";
import { assertSameOrigin, getClientIp } from "@/lib/security/request";
import { checkRemoteUpload } from "@/lib/validation";

export const runtime = "nodejs";
export const maxDuration = 30;

const bodySchema = z.object({
  imageUrl: z.string().url().max(2048),
  videoUrl: z.string().url().max(2048),
  idempotencyKey: z.string().uuid(),
  consent: z.literal(true, {
    errorMap: () => ({ message: "Confirme que você tem autorização da pessoa da imagem." }),
  }),
});

const START_ERRORS: Record<string, { status: number; message: string }> = {
  NO_PROFILE: { status: 403, message: "Conta não encontrada. Faça login novamente." },
  NO_CREDITS: { status: 402, message: "Você não tem créditos. Compre créditos para continuar." },
  DAILY_LIMIT: { status: 429, message: "Você atingiu o limite diário de gerações. Tente amanhã." },
  SERVICE_BUSY: { status: 503, message: "Estamos com muita demanda agora. Tente em alguns minutos." },
  JOB_ALREADY_ACTIVE: { status: 409, message: "Você já tem um vídeo sendo gerado. Aguarde terminar." },
};

/**
 * POST /api/swap
 * 1. Login e conta verificada (requireUser)
 * 2. Rate limit por usuário e por IP
 * 3. Valida o corpo, o consentimento e as URLs (pertencem ao usuário, existem, tipo e tamanho)
 * 4. Cria o job e debita 1 crédito numa transação (start_job)
 * 5. Cria a tarefa na Alibaba. Se falhar, devolve o crédito.
 */
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req.headers);
    const user = await requireUser();

    const [allowedUser, allowedIp] = await Promise.all([
      enforceRateLimit("swap-user", user.id, 10, "1 m"),
      enforceRateLimit("swap-ip", getClientIp(req.headers), 30, "1 m"),
    ]);
    if (!allowedUser || !allowedIp) {
      return apiError(429, "RATE_LIMITED", "Muitas requisições. Aguarde um minuto.");
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return apiError(400, "BAD_REQUEST", parsed.error.issues[0]?.message ?? "Dados inválidos.");
    }
    const { imageUrl, videoUrl, idempotencyKey } = parsed.data;

    // Validação antes de debitar: arquivo inválido não consome crédito
    const imageError = await checkRemoteUpload(imageUrl, user.storageKey, "image");
    if (imageError) return json({ error: imageError }, 422);

    const videoError = await checkRemoteUpload(videoUrl, user.storageKey, "video");
    if (videoError) return json({ error: videoError }, 422);

    const start = await startJob({ userId: user.id, idempotencyKey, imageUrl, videoUrl });

    if (start.error) {
      const mapped = START_ERRORS[start.error] ?? { status: 500, message: "Não foi possível iniciar a geração." };
      return apiError(mapped.status, start.error, mapped.message);
    }
    if (!start.jobId || !start.status) {
      throw new HttpError(500, "INTERNAL_ERROR", "Não foi possível iniciar a geração.");
    }

    // Clique repetido ou retry com a mesma chave: devolve o job existente sem novo débito
    if (start.existing) {
      return json({ jobId: start.jobId, status: start.status, credits: start.credits });
    }

    try {
      const taskId = await createAnimateMixTask(imageUrl, videoUrl);
      await setTaskId(start.jobId, taskId);
    } catch (err) {
      await failJob(start.jobId, "Não foi possível iniciar a geração. Seu crédito foi devolvido.");
      await deleteInputs([imageUrl, videoUrl]);
      const info = describeAlibabaError(err);
      return apiError(info.status, info.code, info.message);
    }

    return json({ jobId: start.jobId, status: "PENDING", credits: start.credits }, 202);
  } catch (err) {
    return toErrorResponse(err);
  }
}
