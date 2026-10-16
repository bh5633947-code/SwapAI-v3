/**
 * Cliente da API wan2.2-animate-mix (Alibaba Cloud Model Studio / DashScope).
 *
 * Fluxo assíncrono:
 *   1) POST .../video-synthesis (header X-DashScope-Async: enable) -> task_id
 *   2) GET  /api/v1/tasks/{task_id} -> PENDING | RUNNING | SUCCEEDED | FAILED
 *
 * Este módulo é usado apenas no servidor. A API key nunca chega ao navegador.
 */

const MODEL = "wan2.2-animate-mix";
const REQUEST_TIMEOUT_MS = 30_000;

export class AlibabaApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "AlibabaApiError";
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

interface AlibabaConfig {
  apiKey: string;
  baseUrl: string;
  mode: "wan-std" | "wan-pro";
}

function getConfig(): AlibabaConfig {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  const workspaceId = process.env.WORKSPACE_ID;

  if (!apiKey) throw new ConfigError("Variável DASHSCOPE_API_KEY não definida.");

  const baseUrl =
    process.env.DASHSCOPE_BASE_URL ??
    (workspaceId ? `https://${workspaceId}.ap-southeast-1.maas.aliyuncs.com` : undefined);
  if (!baseUrl) throw new ConfigError("Variável WORKSPACE_ID (ou DASHSCOPE_BASE_URL) não definida.");

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    mode: process.env.SWAP_MODE === "wan-pro" ? "wan-pro" : "wan-std",
  };
}

interface AlibabaEnvelope {
  request_id?: string;
  code?: string;
  message?: string;
  output?: {
    task_id?: string;
    task_status?: string;
    code?: string;
    message?: string;
    results?: { video_url?: string };
    video_url?: string;
  };
}

async function callAlibaba(url: string, init: RequestInit): Promise<AlibabaEnvelope> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "erro desconhecido";
    throw new AlibabaApiError(503, "NETWORK", `Falha de rede ao falar com o provedor de IA: ${reason}`);
  }

  const text = await res.text();
  let data: AlibabaEnvelope = {};
  try {
    data = text ? (JSON.parse(text) as AlibabaEnvelope) : {};
  } catch {
    // corpo não-JSON: mantém objeto vazio e usa o status HTTP
  }

  if (!res.ok) {
    throw new AlibabaApiError(res.status, data.code, data.message ?? `HTTP ${res.status}`);
  }
  return data;
}

/**
 * Cria a tarefa de troca de pessoa. Retorna o task_id da Alibaba.
 */
export async function createAnimateMixTask(imageUrl: string, videoUrl: string): Promise<string> {
  const { apiKey, baseUrl, mode } = getConfig();

  const data = await callAlibaba(`${baseUrl}/api/v1/services/aigc/image2video/video-synthesis`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-DashScope-Async": "enable", // obrigatório: sem ele a API recusa a chamada síncrona
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      input: {
        image_url: imageUrl,
        video_url: videoUrl,
      },
      parameters: {
        mode,
        check_image: true,
      },
    }),
  });

  const taskId = data.output?.task_id;
  if (!taskId) {
    throw new AlibabaApiError(502, "NO_TASK_ID", "Resposta inesperada do provedor (task_id ausente).");
  }
  return taskId;
}

export type RemoteStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "UNKNOWN";

export interface RemoteTask {
  status: RemoteStatus;
  videoUrl?: string;
  errorMessage?: string;
}

function normalizeStatus(raw: string | undefined): RemoteStatus {
  switch (raw) {
    case "PENDING":
    case "RUNNING":
    case "SUCCEEDED":
    case "FAILED":
    case "CANCELED":
      return raw;
    default:
      return "UNKNOWN";
  }
}

/**
 * Consulta o status de uma tarefa. Quando SUCCEEDED, output.results.video_url traz o vídeo
 * (link temporário, válido por 24h).
 */
export async function getTaskStatus(taskId: string): Promise<RemoteTask> {
  const { apiKey, baseUrl } = getConfig();

  const data = await callAlibaba(`${baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  const output = data.output ?? {};
  return {
    status: normalizeStatus(output.task_status),
    videoUrl: output.results?.video_url ?? output.video_url,
    errorMessage: output.message ?? data.message,
  };
}

export interface ProviderErrorInfo {
  status: number;
  code: string;
  message: string;
  transient: boolean;
}

/**
 * Converte qualquer erro em uma resposta segura para o usuário.
 * Detalhes técnicos vão para o log do servidor, nunca para o cliente.
 */
export function describeAlibabaError(err: unknown): ProviderErrorInfo {
  if (err instanceof ConfigError) {
    console.error("[SwapAI] Configuração ausente:", err.message);
    return {
      status: 500,
      code: "CONFIG_ERROR",
      message: "O serviço de IA não está configurado. Entre em contato com o suporte.",
      transient: false,
    };
  }

  if (err instanceof AlibabaApiError) {
    console.error(`[SwapAI] Provedor respondeu HTTP ${err.status} (${err.code ?? "sem código"}): ${err.message}`);

    if (err.status === 401 || err.status === 403) {
      return {
        status: 502,
        code: "PROVIDER_AUTH",
        message: "Falha de autenticação com o serviço de IA (chave de API inválida ou sem permissão).",
        transient: false,
      };
    }
    if (err.status === 400) {
      return {
        status: 422,
        code: "INVALID_INPUT",
        message:
          "Não foi possível processar a imagem ou o vídeo. Verifique se a imagem tem um rosto bem visível e se o vídeo mostra uma pessoa.",
        transient: false,
      };
    }
    if (err.status === 429) {
      return {
        status: 429,
        code: "RATE_LIMITED",
        message: "Muitas requisições no momento. Aguarde alguns segundos e tente novamente.",
        transient: true,
      };
    }
    if (err.status >= 500 || err.code === "NETWORK") {
      return {
        status: 503,
        code: "PROVIDER_UNAVAILABLE",
        message: "O serviço de IA está temporariamente indisponível. Tente novamente em instantes.",
        transient: true,
      };
    }
    return {
      status: 502,
      code: "PROVIDER_ERROR",
      message: "O serviço de IA retornou um erro. Tente novamente.",
      transient: false,
    };
  }

  console.error("[SwapAI] Erro inesperado:", err);
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "Erro interno inesperado. Tente novamente.",
    transient: false,
  };
}
