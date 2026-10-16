import { del, put } from "@vercel/blob";

const MAX_RESULT_BYTES = 300 * 1024 * 1024;

/**
 * Baixa o vídeo gerado (link da Alibaba expira em 24h) e salva de forma permanente
 * no Vercel Blob. Retorna a URL pública definitiva.
 */
export async function saveVideoPermanently(remoteUrl: string, storageKey: string, jobId: string): Promise<string> {
  const res = await fetch(remoteUrl, { cache: "no-store", signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`Falha ao baixar o vídeo gerado (HTTP ${res.status}).`);

  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_RESULT_BYTES) throw new Error("Vídeo gerado excede o tamanho máximo.");

  const body = await res.blob();
  if (body.size > MAX_RESULT_BYTES) throw new Error("Vídeo gerado excede o tamanho máximo.");

  const { url } = await put(`results/${storageKey}/${jobId}.mp4`, body, {
    access: "public",
    contentType: "video/mp4",
    addRandomSuffix: true,
  });
  return url;
}

/**
 * Apaga as fotos e vídeos enviados pelo usuário quando a geração termina.
 * Privacidade: não guardamos material de entrada além do necessário.
 */
export async function deleteInputs(urls: string[]): Promise<void> {
  try {
    await del(urls);
  } catch (err) {
    console.warn("[SwapAI] Não foi possível apagar os uploads de entrada:", err);
  }
}
