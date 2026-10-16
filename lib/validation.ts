/**
 * Regras de validação compartilhadas entre cliente e servidor.
 * Este arquivo NÃO deve importar nada exclusivo de servidor.
 */

export const IMAGE_TYPES: readonly string[] = ["image/jpeg", "image/png"];
export const VIDEO_TYPES: readonly string[] = ["video/mp4", "video/quicktime", "video/x-msvideo", "video/avi"];
export const ALLOWED_CONTENT_TYPES: string[] = [...IMAGE_TYPES, ...VIDEO_TYPES];

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const VIDEO_MAX_BYTES = 200 * 1024 * 1024; // 200 MB
export const DIMENSION_MIN = 200;
export const DIMENSION_MAX = 4096;
export const VIDEO_MIN_SECONDS = 2;
export const VIDEO_MAX_SECONDS = 30;

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  mp4: "video/mp4",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
};

/** Alguns navegadores enviam type vazio para .mov/.avi: deduzimos pela extensão. */
export function resolveMimeType(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? "application/octet-stream";
}

// ---------- Validação no navegador (feedback imediato) ----------

export async function validateImageFile(file: File): Promise<string | null> {
  if (!IMAGE_TYPES.includes(resolveMimeType(file))) return "A imagem deve ser JPG ou PNG.";
  if (file.size > IMAGE_MAX_BYTES) return "A imagem deve ter no máximo 5 MB.";

  try {
    const { width, height } = await readImageSize(file);
    const okW = width >= DIMENSION_MIN && width <= DIMENSION_MAX;
    const okH = height >= DIMENSION_MIN && height <= DIMENSION_MAX;
    if (!okW || !okH) {
      return `Largura e altura devem estar entre ${DIMENSION_MIN} e ${DIMENSION_MAX} px (imagem atual: ${width}×${height}).`;
    }
  } catch {
    return "Não foi possível ler a imagem. Tente outro arquivo.";
  }
  return null;
}

export async function validateVideoFile(file: File): Promise<string | null> {
  if (!VIDEO_TYPES.includes(resolveMimeType(file))) return "O vídeo deve ser MP4, MOV ou AVI.";
  if (file.size > VIDEO_MAX_BYTES) return "O vídeo deve ter no máximo 200 MB.";

  try {
    const duration = await readVideoDuration(file);
    if (duration < VIDEO_MIN_SECONDS || duration > VIDEO_MAX_SECONDS) {
      return `O vídeo deve ter entre ${VIDEO_MIN_SECONDS} e ${VIDEO_MAX_SECONDS} segundos (atual: ${duration.toFixed(1)} s).`;
    }
  } catch {
    return "Não foi possível ler o vídeo. Tente outro arquivo.";
  }
  return null;
}

function readImageSize(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image load error"));
    };
    img.src = url;
  });
}

function readVideoDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const duration = video.duration;
      URL.revokeObjectURL(url);
      if (Number.isFinite(duration)) resolve(duration);
      else reject(new Error("invalid duration"));
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("video load error"));
    };
    video.src = url;
  });
}

// ---------- Validação no servidor ----------

export interface UploadCheckError {
  code: string;
  message: string;
}

/**
 * Confere no servidor se a URL enviada:
 *  - é do armazenamento Vercel Blob (evita SSRF);
 *  - pertence à sessão do usuário (evita usar arquivos de outras pessoas);
 *  - está acessível publicamente (a Alibaba precisa baixar o arquivo);
 *  - tem tipo e tamanho válidos.
 */
export async function checkRemoteUpload(
  url: string,
  storageKey: string,
  kind: "image" | "video",
): Promise<UploadCheckError | null> {
  const label = kind === "image" ? "A imagem" : "O vídeo";

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { code: "INVALID_URL", message: `${label} tem uma URL inválida.` };
  }

  const isBlobHost = parsed.protocol === "https:" && parsed.hostname.endsWith(".blob.vercel-storage.com");
  if (!isBlobHost) {
    return { code: "INVALID_URL", message: `${label} não está no armazenamento do SwapAI.` };
  }

  if (!parsed.pathname.startsWith(`/uploads/${storageKey}/`)) {
    return { code: "FORBIDDEN_FILE", message: `${label} não pertence à sua sessão. Envie o arquivo novamente.` };
  }

  let res: Response;
  try {
    res = await fetch(url, { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(10_000) });
  } catch {
    return { code: "FILE_UNREACHABLE", message: `${label} não está acessível. Envie o arquivo novamente.` };
  }
  if (!res.ok) {
    return {
      code: "FILE_UNREACHABLE",
      message: `${label} não está acessível (HTTP ${res.status}). Envie o arquivo novamente.`,
    };
  }

  const contentType = res.headers.get("content-type") ?? "";
  const size = Number(res.headers.get("content-length") ?? 0);
  const allowed: readonly string[] = kind === "image" ? IMAGE_TYPES : VIDEO_TYPES;
  const maxBytes = kind === "image" ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;

  if (!allowed.some((type) => contentType.startsWith(type))) {
    return { code: "INVALID_FILE_TYPE", message: `${label} está em um formato não suportado.` };
  }
  if (size > maxBytes) {
    return { code: "FILE_TOO_LARGE", message: `${label} excede o tamanho máximo permitido.` };
  }

  return null;
}
