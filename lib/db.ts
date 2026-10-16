import { env } from "@/lib/config";
import { createSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Acesso ao Postgres (Supabase). Regras de crédito ficam nas funções SQL
 * (supabase/migrations/0001_init.sql). Aqui só chamamos e tipamos o resultado.
 */

export type JobStatus = "PENDING" | "RUNNING" | "SAVING" | "SUCCEEDED" | "FAILED";

export interface JobRow {
  id: string;
  user_id: string;
  status: JobStatus;
  alibaba_task_id: string | null;
  remote_video_url: string | null;
  result_url: string | null;
  error_message: string | null;
  save_attempts: number;
  refunded: boolean;
  input_image_url: string;
  input_video_url: string;
  created_at: string;
  updated_at: string;
}

export type SaveClaim = "claimed" | "busy" | "closed" | "exhausted" | "missing";

const db = () => createSupabaseAdmin();

function check(error: { message: string } | null, where: string): void {
  if (error) throw new Error(`[db:${where}] ${error.message}`);
}

export interface StartJobInput {
  userId: string;
  idempotencyKey: string;
  imageUrl: string;
  videoUrl: string;
}

export interface StartJobResult {
  jobId: string | null;
  status: JobStatus | null;
  credits: number;
  error: string | null;
  existing: boolean;
}

/** Debita 1 crédito e cria o job numa única transação. */
export async function startJob(input: StartJobInput): Promise<StartJobResult> {
  const cfg = env();
  const { data, error } = await db().rpc("start_job", {
    p_user: input.userId,
    p_idem: input.idempotencyKey,
    p_image: input.imageUrl,
    p_video: input.videoUrl,
    p_daily_user_limit: cfg.MAX_JOBS_PER_USER_PER_DAY,
    p_daily_global_limit: cfg.MAX_GLOBAL_JOBS_PER_DAY,
  });
  check(error, "start_job");

  const row = (
    data as Array<{ r_job_id: string | null; r_status: JobStatus | null; r_credits: number; r_error: string | null; r_existing: boolean }>
  )[0];
  if (!row) throw new Error("[db:start_job] resposta vazia");

  return {
    jobId: row.r_job_id,
    status: row.r_status,
    credits: row.r_credits,
    error: row.r_error,
    existing: row.r_existing,
  };
}

export async function getJobForUser(jobId: string, userId: string): Promise<JobRow | null> {
  const { data, error } = await db()
    .from("jobs")
    .select("*")
    .eq("id", jobId)
    .eq("user_id", userId)
    .maybeSingle();
  check(error, "getJob");
  return (data as JobRow | null) ?? null;
}

/** Geração ainda em andamento deste usuário (para retomar o acompanhamento após recarregar a página). */
export async function getActiveJobId(userId: string): Promise<string | null> {
  const { data, error } = await db()
    .from("jobs")
    .select("id")
    .eq("user_id", userId)
    .in("status", ["PENDING", "RUNNING", "SAVING"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  check(error, "getActiveJobId");
  return (data as { id: string } | null)?.id ?? null;
}

export async function setTaskId(jobId: string, taskId: string): Promise<void> {
  const { error } = await db()
    .from("jobs")
    .update({ alibaba_task_id: taskId, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  check(error, "setTaskId");
}

/** Atualiza só se o job ainda não terminou (nunca sobrescreve SUCCEEDED/FAILED/SAVING). */
export async function setStatus(jobId: string, status: "PENDING" | "RUNNING"): Promise<void> {
  const { error } = await db()
    .from("jobs")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .in("status", ["PENDING", "RUNNING"]);
  check(error, "setStatus");
}

export async function claimSave(jobId: string, remoteUrl: string, maxAttempts: number): Promise<SaveClaim> {
  const { data, error } = await db().rpc("claim_save", {
    p_job: jobId,
    p_remote: remoteUrl,
    p_max_attempts: maxAttempts,
  });
  check(error, "claim_save");
  return data as SaveClaim;
}

export async function completeJob(jobId: string, resultUrl: string): Promise<void> {
  const { error } = await db()
    .from("jobs")
    .update({
      status: "SUCCEEDED",
      result_url: resultUrl,
      remote_video_url: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("status", "SAVING");
  check(error, "completeJob");
}

export async function releaseSave(jobId: string): Promise<void> {
  const { error } = await db()
    .from("jobs")
    .update({ status: "RUNNING", updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("status", "SAVING");
  check(error, "releaseSave");
}

/** Marca como FAILED e devolve o crédito, uma única vez. */
export async function failJob(jobId: string, message: string): Promise<void> {
  const { error } = await db().rpc("fail_job", { p_job: jobId, p_message: message });
  check(error, "fail_job");
}

// ---------- Compras (Mercado Pago) ----------

export type PurchaseStatus = "created" | "pending" | "approved" | "rejected" | "cancelled" | "refunded";

export interface PurchaseRow {
  id: string;
  user_id: string;
  pack_id: string;
  credits: number;
  amount_cents: number;
  currency: string;
  status: PurchaseStatus;
  mp_preference_id: string | null;
  mp_payment_id: string | null;
}

/** Compras abertas (não pagas) nas últimas 24h. Limita quantos checkouts uma conta pode deixar abertos. */
export async function countOpenPurchases(userId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { count, error } = await db()
    .from("purchases")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("status", ["created", "pending"])
    .gte("created_at", since);
  check(error, "countOpenPurchases");
  return count ?? 0;
}

export async function createPurchase(input: {
  userId: string;
  packId: string;
  credits: number;
  amountCents: number;
  currency: string;
}): Promise<string> {
  const { data, error } = await db()
    .from("purchases")
    .insert({
      user_id: input.userId,
      pack_id: input.packId,
      credits: input.credits,
      amount_cents: input.amountCents,
      currency: input.currency,
      status: "created",
    })
    .select("id")
    .single();
  check(error, "createPurchase");
  return (data as { id: string }).id;
}

export async function setPurchaseAwaitingPayment(purchaseId: string, preferenceId: string): Promise<void> {
  const { error } = await db()
    .from("purchases")
    .update({ status: "pending", mp_preference_id: preferenceId, updated_at: new Date().toISOString() })
    .eq("id", purchaseId)
    .eq("status", "created");
  check(error, "setPurchaseAwaitingPayment");
}

export async function markPurchaseCancelled(purchaseId: string): Promise<void> {
  const { error } = await db()
    .from("purchases")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", purchaseId)
    .in("status", ["created", "pending"]);
  check(error, "markPurchaseCancelled");
}

export async function getPurchase(purchaseId: string): Promise<PurchaseRow | null> {
  const { data, error } = await db().from("purchases").select("*").eq("id", purchaseId).maybeSingle();
  check(error, "getPurchase");
  return (data as PurchaseRow | null) ?? null;
}

export interface ApplyPaymentInput {
  purchaseId: string;
  paymentId: string;
  status: "approved" | "refunded" | "rejected" | "cancelled" | "pending";
  statusDetail: string | null;
  eventKey: string;
  payload: Record<string, unknown>;
}

/**
 * Lança o status de pagamento na compra (creditando, revertendo ou só atualizando).
 * Retorna o resultado da função SQL (ver 0002_payments.sql).
 */
export async function applyPaymentStatus(input: ApplyPaymentInput): Promise<string> {
  const { data, error } = await db().rpc("apply_payment_status", {
    p_purchase: input.purchaseId,
    p_payment_id: input.paymentId,
    p_status: input.status,
    p_status_detail: input.statusDetail,
    p_event_key: input.eventKey,
    p_payload: input.payload,
  });
  check(error, "apply_payment_status");
  return data as string;
}
