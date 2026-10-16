import { NextResponse } from "next/server";
import { HttpError } from "@/lib/errors";

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function apiError(status: number, code: string, message: string): NextResponse {
  return json({ error: { code, message } }, status);
}

/** Converte qualquer erro em resposta. Detalhes internos vão só para o log. */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof HttpError) return apiError(err.status, err.code, err.message);
  console.error("[SwapAI] erro interno:", err);
  return apiError(500, "INTERNAL_ERROR", "Erro interno. Tente novamente.");
}
