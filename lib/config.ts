import { z } from "zod";

/**
 * Todas as variáveis de ambiente são validadas na primeira leitura.
 * Se algo estiver faltando ou inválido, o app falha de forma explícita (fail-closed)
 * em vez de rodar com segurança enfraquecida.
 */
const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Segredo para HMAC das identidades (e-mail, telefone, IP). Gere com: openssl rand -hex 32
  IDENTITY_HMAC_SECRET: z.string().min(32, "IDENTITY_HMAC_SECRET precisa ter pelo menos 32 caracteres"),

  // Mercado Pago (opcionais até a loja entrar no ar; as rotas de pagamento recusam se faltarem)
  MP_ACCESS_TOKEN: z.string().optional(),
  MP_WEBHOOK_SECRET: z.string().optional(),
  NEXT_PUBLIC_APP_URL: z.string().url().optional(),

  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  FREE_SIGNUP_CREDITS: z.coerce.number().int().min(0).default(1),
  MAX_SIGNUPS_PER_IP_PER_DAY: z.coerce.number().int().min(1).default(2),
  MAX_JOBS_PER_USER_PER_DAY: z.coerce.number().int().min(1).default(10),
  MAX_GLOBAL_JOBS_PER_DAY: z.coerce.number().int().min(1).default(500),
  REQUIRE_PHONE_VERIFICATION: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Configuração inválida: ${details}`);
  }
  cached = parsed.data;
  return cached;
}
