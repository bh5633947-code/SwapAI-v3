import { NextRequest } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { requireUser } from "@/lib/auth";
import { HttpError } from "@/lib/errors";
import { apiError, json, toErrorResponse } from "@/lib/http";
import { enforceRateLimit } from "@/lib/security/ratelimit";
import { assertSameOrigin, getClientIp } from "@/lib/security/request";
import { IMAGE_MAX_BYTES, IMAGE_TYPES, VIDEO_MAX_BYTES, VIDEO_TYPES } from "@/lib/validation";

export const runtime = "nodejs";

/**
 * POST /api/upload
 *
 * Dois tipos de chamada chegam aqui:
 *  - blob.generate-client-token: o navegador pede permissão para enviar. Exige login.
 *  - blob.upload-completed: a Vercel avisa que o upload terminou. Vem do servidor
 *    da Vercel, sem cookie. O próprio handleUpload valida a assinatura desse callback.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as HandleUploadBody;

    if (body.type === "blob.upload-completed") {
      await handleUpload({
        body,
        request: req,
        onBeforeGenerateToken: async () => {
          throw new HttpError(400, "INVALID_EVENT", "Evento inválido.");
        },
        onUploadCompleted: async ({ blob }) => {
          console.info("[SwapAI] Upload concluído:", blob.pathname);
        },
      });
      return json({ ok: true });
    }

    assertSameOrigin(req.headers);
    const user = await requireUser();

    const [allowedUser, allowedIp] = await Promise.all([
      enforceRateLimit("upload-user", user.id, 30, "1 m"),
      enforceRateLimit("upload-ip", getClientIp(req.headers), 60, "1 m"),
    ]);
    if (!allowedUser || !allowedIp) {
      return apiError(429, "RATE_LIMITED", "Muitos uploads. Aguarde um minuto.");
    }

    const prefix = `uploads/${user.storageKey}/`;

    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        // Cada token serve só para a pasta do próprio usuário, com o tipo e o tamanho do arquivo
        if (!pathname.startsWith(prefix) || pathname.includes("..")) {
          throw new HttpError(403, "FORBIDDEN_PATH", "Caminho de upload inválido.");
        }
        if (pathname.startsWith(`${prefix}image-`)) {
          return {
            allowedContentTypes: [...IMAGE_TYPES],
            maximumSizeInBytes: IMAGE_MAX_BYTES,
            addRandomSuffix: true,
          };
        }
        if (pathname.startsWith(`${prefix}video-`)) {
          return {
            allowedContentTypes: [...VIDEO_TYPES],
            maximumSizeInBytes: VIDEO_MAX_BYTES,
            addRandomSuffix: true,
          };
        }
        throw new HttpError(400, "BAD_KIND", "Tipo de arquivo não reconhecido.");
      },
      onUploadCompleted: async () => {},
    });

    return json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
