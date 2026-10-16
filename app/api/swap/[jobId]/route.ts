import { NextRequest } from "next/server";
import { describeAlibabaError, getTaskStatus, type RemoteTask } from "@/lib/alibaba";
import { requireUser, storageKeyFor } from "@/lib/auth";
import {
  claimSave,
  completeJob,
  failJob,
  getJobForUser,
  releaseSave,
  setStatus,
  type JobRow,
} from "@/lib/db";
import { apiError, json, toErrorResponse } from "@/lib/http";
import { deleteInputs, saveVideoPermanently } from "@/lib/storage";
import { enforceRateLimit } from "@/lib/security/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_SAVE_ATTEMPTS = 3;
const START_TIMEOUT_MS = 2 * 60_000; // job sem task_id depois disso foi perdido no meio do caminho
const FAILED_MSG = "A geração do vídeo falhou. Tente outra imagem ou vídeo. Seu crédito foi devolvido.";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Params = { params: Promise<{ jobId: string }> };

/**
 * GET /api/swap/[jobId]
 * Consulta a Alibaba (PENDING -> RUNNING -> SUCCEEDED/FAILED).
 * Ao concluir, salva o vídeo no Blob (o link da Alibaba expira em 24h) e apaga os uploads de entrada.
 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const user = await requireUser();

    if (!(await enforceRateLimit("poll-user", user.id, 120, "1 m"))) {
      return apiError(429, "RATE_LIMITED", "Consultas demais. Aguarde um pouco.");
    }

    const { jobId } = await params;
    if (!UUID_RE.test(jobId)) return apiError(400, "BAD_REQUEST", "Identificador inválido.");

    // Ownership: job de outro usuário responde 404 (não confirma que existe)
    const job = await getJobForUser(jobId, user.id);
    if (!job) return apiError(404, "NOT_FOUND", "Tarefa não encontrada.");

    if (job.status === "SUCCEEDED" || job.status === "FAILED") {
      return json(toPublic(job));
    }

    if (!job.alibaba_task_id) {
      const ageMs = Date.now() - new Date(job.created_at).getTime();
      if (ageMs > START_TIMEOUT_MS) {
        await failAndCleanup(job, "Falha ao iniciar a geração. Seu crédito foi devolvido.");
      }
      return respond(jobId, user.id);
    }

    try {
      const remote = await getTaskStatus(job.alibaba_task_id);
      await applyRemoteState(job, remote);
    } catch (err) {
      const info = describeAlibabaError(err);
      // erro transitório: mantém o job e tenta de novo no próximo polling
      if (!info.transient) await failAndCleanup(job, info.message);
    }

    return respond(jobId, user.id);
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function applyRemoteState(job: JobRow, remote: RemoteTask): Promise<void> {
  switch (remote.status) {
    case "SUCCEEDED": {
      if (!remote.videoUrl) {
        console.error("[SwapAI] Tarefa concluída sem video_url:", job.alibaba_task_id);
        return failAndCleanup(job, FAILED_MSG);
      }

      const claim = await claimSave(job.id, remote.videoUrl, MAX_SAVE_ATTEMPTS);
      if (claim === "exhausted") {
        return failAndCleanup(job, "Não foi possível salvar o vídeo gerado. Seu crédito foi devolvido.");
      }
      if (claim !== "claimed") return; // outro polling está salvando ou o job já fechou

      try {
        const resultUrl = await saveVideoPermanently(remote.videoUrl, storageKeyFor(job.user_id), job.id);
        await completeJob(job.id, resultUrl);
        await deleteInputs([job.input_image_url, job.input_video_url]);
      } catch (err) {
        console.error("[SwapAI] Falha ao salvar vídeo no Blob:", err);
        await releaseSave(job.id); // o próximo polling tenta de novo
      }
      return;
    }

    case "FAILED":
    case "CANCELED":
    case "UNKNOWN":
      console.error(`[SwapAI] Tarefa ${job.alibaba_task_id} terminou com status ${remote.status}:`, remote.errorMessage);
      return failAndCleanup(job, FAILED_MSG);

    case "RUNNING":
      return setStatus(job.id, "RUNNING");

    default:
      return setStatus(job.id, "PENDING");
  }
}

async function failAndCleanup(job: JobRow, message: string): Promise<void> {
  await failJob(job.id, message);
  await deleteInputs([job.input_image_url, job.input_video_url]);
}

async function respond(jobId: string, userId: string) {
  const fresh = await getJobForUser(jobId, userId);
  if (!fresh) return apiError(404, "NOT_FOUND", "Tarefa não encontrada.");
  return json(toPublic(fresh));
}

/** Estado exposto ao cliente. SAVING é apresentado como RUNNING. */
function toPublic(job: JobRow) {
  return {
    jobId: job.id,
    status: job.status === "SAVING" ? "RUNNING" : job.status,
    resultUrl: job.status === "SUCCEEDED" ? job.result_url : undefined,
    errorMessage: job.status === "FAILED" ? job.error_message : undefined,
  };
}
