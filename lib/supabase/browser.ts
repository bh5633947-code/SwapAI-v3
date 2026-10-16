import { createBrowserClient } from "@supabase/ssr";

/** Cliente do navegador: usa apenas a anon key (pública). Segurança vem do RLS e do servidor. */
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
