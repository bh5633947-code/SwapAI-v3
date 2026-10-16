import { NextRequest } from "next/server";
import { json, toErrorResponse } from "@/lib/http";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { assertSameOrigin } from "@/lib/security/request";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req.headers);
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
    return json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
