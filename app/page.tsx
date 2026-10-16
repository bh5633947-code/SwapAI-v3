"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { AlertTriangle, Coins, Download, Loader2, LogOut, RotateCcw, Share2, Sparkles, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UploadDropzone } from "@/components/upload-dropzone";
import { GenerationProgress } from "@/components/generation-progress";
import { AuthGate } from "@/components/auth-gate";
import { BuyCreditsDialog } from "@/components/buy-credits-dialog";
import { resolveMimeType, validateImageFile, validateVideoFile } from "@/lib/validation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

type Stage = "idle" | "uploading" | "creating" | "queued" | "processing" | "finalizing" | "done" | "error";
type AuthState = "loading" | "anon" | "authed";

interface Me {
  email: string;
  credits: number;
  storageKey: string;
  freeGrantStatus: string;
  activeJobId: string | null;
}

interface SelectedFile {
  file: File;
  previewUrl: string;
}

interface JobPayload {
  status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";
  resultUrl?: string;
  errorMessage?: string;
}

const POLL_INTERVAL_MS = 15_000; // a API é assíncrona: consultamos o status a cada 15s
const FINALIZING_AFTER_MS = 150_000;
const CREDIT_COST = 1;

const STAGE_LABEL: Record<Stage, string> = {
  idle: "",
  uploading: "Enviando para a nuvem...",
  creating: "Criando tarefa de IA...",
  queued: "Na fila de processamento...",
  processing: "Processando troca de rosto...",
  finalizing: "Finalizando vídeo...",
  done: "Vídeo pronto!",
  error: "",
};

const BUSY_STAGES: Stage[] = ["uploading", "creating", "queued", "processing", "finalizing"];

function progressFor(stage: Stage, elapsedMs: number): number {
  switch (stage) {
    case "uploading":
      return 10;
    case "creating":
      return 20;
    case "queued":
      return 25;
    case "processing":
      return 25 + Math.min(elapsedMs / 240_000, 1) * 60;
    case "finalizing":
      return 92;
    case "done":
      return 100;
    default:
      return 0;
  }
}

function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function readApiError(res: Response): Promise<{ code: string; message: string }> {
  try {
    const data = (await res.json()) as { error?: { code: string; message: string } };
    if (data.error) return data.error;
  } catch {
    // corpo não-JSON
  }
  return { code: `HTTP_${res.status}`, message: `Erro inesperado (HTTP ${res.status}).` };
}

export default function HomePage() {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [authState, setAuthState] = useState<AuthState>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [accountNotice, setAccountNotice] = useState<string | null>(null);
  const [image, setImage] = useState<SelectedFile | null>(null);
  const [video, setVideo] = useState<SelectedFile | null>(null);
  const [consent, setConsent] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [progress, setProgress] = useState(0);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showBuy, setShowBuy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [paymentNotice, setPaymentNotice] = useState<string | null>(null);

  const cancelledRef = useRef(false);
  const startingRef = useRef(false);
  const attemptKeyRef = useRef<string | null>(null);
  const resumedJobRef = useRef<string | null>(null);

  const isBusy = BUSY_STAGES.includes(stage);

  const loadMe = useCallback(async () => {
    const res = await fetch("/api/me", { cache: "no-store" });
    if (res.status === 401 || res.status === 403) {
      const err = await readApiError(res);
      setMe(null);
      setAuthState("anon");
      if (err.code === "BANNED") setAccountNotice(err.message);
      return;
    }
    if (!res.ok) {
      const err = await readApiError(res);
      throw new Error(err.message);
    }
    setMe((await res.json()) as Me);
    setAuthState("authed");
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    loadMe().catch((err: unknown) => {
      setAuthState("anon");
      setErrorMsg(err instanceof Error ? err.message : "Não foi possível carregar sua conta.");
    });
    return () => {
      cancelledRef.current = true;
    };
  }, [loadMe]);

  async function waitForCredits(before: number) {
    for (let i = 0; i < 12; i++) {
      await sleep(3000);
      if (cancelledRef.current) return;
      const res = await fetch("/api/me", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as Me;
      setMe(data);
      if (data.credits > before) {
        setPaymentNotice("Pagamento confirmado! Seus créditos já estão disponíveis.");
        return;
      }
    }
    setPaymentNotice("Ainda não recebemos a confirmação do pagamento. Ela pode levar alguns minutos. Atualize a página depois.");
  }

  // Volta do checkout do Mercado Pago: ?pagamento=sucesso | pendente | falha
  useEffect(() => {
    if (authState !== "authed" || !me) return;
    const outcome = new URLSearchParams(window.location.search).get("pagamento");
    if (!outcome) return;
    window.history.replaceState(null, "", window.location.pathname);

    if (outcome === "falha") {
      setPaymentNotice("O pagamento não foi concluído. Você pode tentar de novo quando quiser.");
      return;
    }
    setPaymentNotice(
      outcome === "sucesso"
        ? "Pagamento recebido. Estamos liberando seus créditos..."
        : "Pagamento em análise. Os créditos entram assim que for aprovado.",
    );
    void waitForCredits(me.credits);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState]);

  function resetAttempt() {
    attemptKeyRef.current = null;
  }

  // Se a pessoa saiu no meio de uma geração, retoma o acompanhamento ao voltar
  useEffect(() => {
    const jobId = me?.activeJobId;
    if (authState !== "authed" || !jobId || resumedJobRef.current === jobId) return;
    resumedJobRef.current = jobId;
    cancelledRef.current = false;
    pollJob(jobId).catch((err: unknown) => {
      setStage("error");
      setErrorMsg(err instanceof Error ? err.message : "Erro ao acompanhar a geração.");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authState, me?.activeJobId]);

  async function handleSelect(kind: "image" | "video", file: File) {
    setErrorMsg(null);
    const validationError = kind === "image" ? await validateImageFile(file) : await validateVideoFile(file);
    if (validationError) {
      setErrorMsg(validationError);
      return;
    }

    const selected: SelectedFile = { file, previewUrl: URL.createObjectURL(file) };
    if (kind === "image") {
      if (image) URL.revokeObjectURL(image.previewUrl);
      setImage(selected);
    } else {
      if (video) URL.revokeObjectURL(video.previewUrl);
      setVideo(selected);
    }
    setResultUrl(null);
    setStage("idle");
    resetAttempt();
  }

  function clearFile(kind: "image" | "video") {
    if (kind === "image") {
      if (image) URL.revokeObjectURL(image.previewUrl);
      setImage(null);
    } else {
      if (video) URL.revokeObjectURL(video.previewUrl);
      setVideo(null);
    }
    resetAttempt();
  }

  function uploadTo(key: string, kind: "image" | "video", selected: SelectedFile) {
    const pathname = `uploads/${key}/${kind}-${crypto.randomUUID()}-${safeName(selected.file.name)}`;
    return upload(pathname, selected.file, {
      access: "public",
      handleUploadUrl: "/api/upload",
      contentType: resolveMimeType(selected.file),
      multipart: kind === "video",
    });
  }

  async function pollJob(jobId: string) {
    const startedAt = Date.now();
    setStage("queued");

    while (!cancelledRef.current) {
      await sleep(POLL_INTERVAL_MS);
      if (cancelledRef.current) return;

      const res = await fetch(`/api/swap/${jobId}`, { cache: "no-store" });
      if (!res.ok) throw new Error((await readApiError(res)).message);

      const job = (await res.json()) as JobPayload;

      if (job.status === "SUCCEEDED" && job.resultUrl) {
        setResultUrl(job.resultUrl);
        setProgress(100);
        setStage("done");
        resetAttempt();
        return;
      }
      if (job.status === "FAILED") {
        throw new Error(job.errorMessage ?? "A geração falhou. Seu crédito foi devolvido.");
      }

      const elapsed = Date.now() - startedAt;
      const next: Stage = job.status === "PENDING" ? "queued" : elapsed > FINALIZING_AFTER_MS ? "finalizing" : "processing";
      setStage(next);
      setProgress(progressFor(next, elapsed));
    }
  }

  async function handleGenerate() {
    if (!image || !video || !me || startingRef.current || isBusy) return;
    if (!consent) {
      setErrorMsg("Confirme que você tem autorização da pessoa da imagem para continuar.");
      return;
    }

    startingRef.current = true;
    cancelledRef.current = false;
    setErrorMsg(null);
    setResultUrl(null);
    // uma chave por clique: o índice único de jobs ativos é a proteção contra cobrança duplicada
    attemptKeyRef.current = crypto.randomUUID();

    try {
      setStage("uploading");
      setProgress(progressFor("uploading", 0));

      const [imageBlob, videoBlob] = await Promise.all([
        uploadTo(me.storageKey, "image", image),
        uploadTo(me.storageKey, "video", video),
      ]);
      if (cancelledRef.current) return;

      setStage("creating");
      setProgress(progressFor("creating", 0));

      const res = await fetch("/api/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageUrl: imageBlob.url,
          videoUrl: videoBlob.url,
          consent: true,
          idempotencyKey: attemptKeyRef.current,
        }),
      });

      if (res.status === 402) {
        setStage("idle");
        setShowBuy(true);
        return;
      }
      if (res.status === 401 || res.status === 403) {
        setStage("idle");
        await loadMe();
        return;
      }
      if (!res.ok) throw new Error((await readApiError(res)).message);

      const { jobId, credits } = (await res.json()) as { jobId: string; credits: number };
      setMe((prev) => (prev ? { ...prev, credits } : prev));

      await pollJob(jobId);
    } catch (err) {
      if (cancelledRef.current) return;
      setStage("error");
      setErrorMsg(err instanceof Error ? err.message : "Erro inesperado. Tente novamente.");
    } finally {
      startingRef.current = false;
      resetAttempt();
    }
  }

  async function handleDownload() {
    if (!resultUrl) return;
    try {
      const res = await fetch(resultUrl);
      if (!res.ok) throw new Error("download falhou");
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = "swapai-video.mp4";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch {
      window.open(resultUrl, "_blank", "noopener,noreferrer");
    }
  }

  async function handleShare() {
    if (!resultUrl) return;
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: "Meu vídeo no SwapAI", text: "Confira meu vídeo criado com SwapAI", url: resultUrl });
        return;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(resultUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copie o link do vídeo:", resultUrl);
    }
  }

  function handleReset() {
    cancelledRef.current = true;
    if (image) URL.revokeObjectURL(image.previewUrl);
    if (video) URL.revokeObjectURL(video.previewUrl);
    setImage(null);
    setVideo(null);
    setConsent(false);
    setResultUrl(null);
    setStage("idle");
    setProgress(0);
    setErrorMsg(null);
    resetAttempt();
  }

  async function handleSignOut() {
    cancelledRef.current = true;
    handleReset();
    await supabase.auth.signOut();
    await fetch("/api/auth/signout", { method: "POST" }).catch(() => undefined);
    setMe(null);
    setAuthState("anon");
  }

  const canGenerate = Boolean(image && video && me && !isBusy && consent);
  const noCreditsForFree = me !== null && me.credits === 0 && me.freeGrantStatus === "denied";

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/70 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600">
              <Sparkles className="h-4 w-4 text-white" />
            </span>
            SwapAI
          </div>

          {authState === "authed" && me && (
            <div className="flex items-center gap-2 sm:gap-3">
              <div className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm">
                <Coins className="h-4 w-4 text-amber-400" />
                <span className="tabular-nums font-medium">{me.credits}</span>
                <span className="hidden text-muted-foreground sm:inline">créditos</span>
              </div>
              <Button variant="outline" size="sm" onClick={() => setShowBuy(true)}>
                Comprar
              </Button>
              <Button variant="ghost" size="sm" onClick={handleSignOut} aria-label="Sair">
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </header>

      <main className="px-4 pb-20 sm:px-6">
        <section className="mx-auto max-w-3xl pt-12 text-center sm:pt-16">
          <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-violet-300">
            <Wand2 className="h-3.5 w-3.5" />
            Troca de rosto com IA
          </span>
          <h1 className="mt-5 text-4xl font-bold tracking-tight sm:text-5xl">
            SwapAI -{" "}
            <span className="bg-gradient-to-r from-violet-400 to-indigo-400 bg-clip-text text-transparent">
              Substitua Pessoas em Vídeos com IA
            </span>
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
            Envie uma foto de quem deve aparecer e um vídeo base. Em alguns minutos, a pessoa do vídeo é substituída.
          </p>
        </section>

        {authState === "loading" && (
          <div className="mt-16 flex justify-center text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}

        {authState === "anon" && <AuthGate onAuthenticated={loadMe} notice={accountNotice} />}

        {authState === "authed" && me && (
          <>
            <section className="mx-auto mt-12 grid max-w-5xl gap-6 md:grid-cols-2">
              <UploadDropzone
                kind="image"
                title="1. Imagem da pessoa"
                hint="JPG ou PNG · 200–4096 px · até 5 MB"
                previewUrl={image?.previewUrl}
                disabled={isBusy}
                onSelect={(file) => handleSelect("image", file)}
                onClear={() => clearFile("image")}
              />
              <UploadDropzone
                kind="video"
                title="2. Vídeo base"
                hint="MP4, MOV ou AVI · 2–30 s · até 200 MB"
                previewUrl={video?.previewUrl}
                disabled={isBusy}
                onSelect={(file) => handleSelect("video", file)}
                onClear={() => clearFile("video")}
              />
            </section>

            {errorMsg && (
              <div
                role="alert"
                className="mx-auto mt-6 flex max-w-5xl items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="flex-1">{errorMsg}</p>
                <button onClick={() => setErrorMsg(null)} aria-label="Fechar aviso" className="text-red-200/70 hover:text-red-100">
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            {paymentNotice && (
              <div
                role="status"
                className="mx-auto mt-6 flex max-w-5xl items-start gap-3 rounded-xl border border-violet-500/30 bg-violet-500/10 px-4 py-3 text-sm text-violet-100"
              >
                <p className="flex-1">{paymentNotice}</p>
                <button onClick={() => setPaymentNotice(null)} aria-label="Fechar aviso" className="text-violet-100/70 hover:text-violet-50">
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            <section className="mx-auto mt-8 max-w-5xl">
              {stage === "done" && resultUrl ? (
                <div className="rounded-2xl border border-border bg-card/70 p-4 backdrop-blur sm:p-6">
                  <h2 className="text-lg font-semibold">Seu vídeo está pronto</h2>
                  <video src={resultUrl} controls playsInline className="mt-4 w-full rounded-xl bg-black" />
                  <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                    <Button size="lg" className="flex-1" onClick={handleDownload}>
                      <Download className="h-4 w-4" /> Baixar
                    </Button>
                    <Button size="lg" variant="outline" className="flex-1" onClick={handleShare}>
                      <Share2 className="h-4 w-4" /> {copied ? "Link copiado!" : "Compartilhar"}
                    </Button>
                    <Button size="lg" variant="ghost" onClick={handleReset}>
                      <RotateCcw className="h-4 w-4" /> Criar outro
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <label className="flex items-start gap-3 rounded-xl border border-border bg-card/50 p-4 text-sm text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={consent}
                      disabled={isBusy}
                      onChange={(e) => setConsent(e.target.checked)}
                      className="mt-0.5 h-4 w-4 accent-violet-500"
                    />
                    <span>
                      Tenho autorização da pessoa da imagem para usá-la neste vídeo. Não vou usar o resultado para enganar,
                      difamar, criar conteúdo sexual ou se passar por outra pessoa.
                    </span>
                  </label>

                  <Button
                    size="lg"
                    disabled={!canGenerate}
                    onClick={handleGenerate}
                    className="mt-4 h-14 w-full rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 text-base shadow-lg shadow-violet-600/25 hover:opacity-90"
                  >
                    {isBusy ? (
                      "Gerando..."
                    ) : (
                      <>
                        <Wand2 className="h-5 w-5" /> Gerar Vídeo
                      </>
                    )}
                  </Button>
                  <p className="mt-2 text-center text-xs text-muted-foreground">
                    Custo: {CREDIT_COST} crédito por vídeo · reembolsado automaticamente se a geração falhar
                  </p>
                  {noCreditsForFree && (
                    <p className="mt-2 text-center text-xs text-amber-300">
                      O crédito grátis já foi usado por este e-mail. Compre créditos para continuar gerando vídeos.
                    </p>
                  )}
                </>
              )}

              {isBusy && (
                <div className="mt-6">
                  <GenerationProgress label={STAGE_LABEL[stage]} progress={progress} />
                </div>
              )}
            </section>

            <p className="mx-auto mt-12 max-w-xl text-center text-xs text-muted-foreground">
              Dica: use fotos nítidas com o rosto de frente e vídeos com uma única pessoa para melhores resultados.
            </p>
          </>
        )}
      </main>

      {showBuy && <BuyCreditsDialog onClose={() => setShowBuy(false)} />}
    </div>
  );
}
