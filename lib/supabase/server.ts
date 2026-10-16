import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { env } from "@/lib/config";

/** Cliente com a sessão do usuário (anon key + cookies). Usado para identificar quem chama. */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const cfg = env();

  return createServerClient(cfg.NEXT_PUBLIC_SUPABASE_URL, cfg.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet: { name: string; value: string; options: CookieOptions }[]) => {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // chamado fora de Route Handler: a middleware cuida da renovação
        }
      },
    },
  });
}

/**
 * Cliente com service_role. Ignora RLS e tem acesso total.
 * NUNCA importe este arquivo em componentes "use client".
 */
export function createSupabaseAdmin() {
  const cfg = env();
  return createClient(cfg.NEXT_PUBLIC_SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
