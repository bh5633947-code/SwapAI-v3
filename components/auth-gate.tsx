"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Loader2, Mail, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Turnstile } from "@/components/turnstile";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

const CAPTCHA_ENABLED = Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);
const RESEND_COOLDOWN_S = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Traduz erros do Supabase sem vazar detalhes internos. */
function friendlyAuthError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("rate limit") || m.includes("too many") || m.includes("over_email_send_rate_limit")) {
    return "Muitas tentativas. Aguarde alguns minutos antes de tentar de novo.";
  }
  if (m.includes("captcha")) return "Não conseguimos confirmar que você não é um robô. Tente novamente.";
  if (m.includes("expired") || m.includes("invalid")) return "Código inválido ou expirado. Peça um novo código.";
  return "Não foi possível concluir agora. Tente novamente.";
}

interface AuthGateProps {
  onAuthenticated: () => void | Promise<void>;
  notice?: string | null;
}

export function AuthGate({ onAuthenticated, notice }: AuthGateProps) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [widgetKey, setWidgetKey] = useState(0); // remonta o captcha (token é de uso único)
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  function resetCaptcha() {
    setCaptchaToken("");
    setWidgetKey((k) => k + 1);
  }

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    const clean = email.trim().toLowerCase();

    if (!EMAIL_RE.test(clean)) {
      setError("Digite um e-mail válido.");
      return;
    }
    if (CAPTCHA_ENABLED && !captchaToken) {
      setError("Confirme que você não é um robô.");
      return;
    }

    setBusy(true);
    setError(null);
    const { error: authError } = await supabase.auth.signInWithOtp({
      email: clean,
      options: {
        shouldCreateUser: true,
        captchaToken: captchaToken || undefined,
      },
    });
    setBusy(false);
    resetCaptcha();

    if (authError) {
      setError(friendlyAuthError(authError.message));
      return;
    }

    setEmail(clean);
    setCode("");
    setStep("code");
    setCooldown(RESEND_COOLDOWN_S);
  }

  async function verifyCode(e: FormEvent) {
    e.preventDefault();
    const token = code.trim();
    if (!/^\d{6}$/.test(token)) {
      setError("Digite o código de 6 dígitos enviado ao seu e-mail.");
      return;
    }

    setBusy(true);
    setError(null);
    const { error: verifyError } = await supabase.auth.verifyOtp({ email, token, type: "email" });
    setBusy(false);

    if (verifyError) {
      setError(friendlyAuthError(verifyError.message));
      return;
    }
    await onAuthenticated();
  }

  function backToEmail() {
    setStep("email");
    setError(null);
    resetCaptcha();
  }

  return (
    <div className="mx-auto mt-12 w-full max-w-md px-4">
      <div className="rounded-2xl border border-border bg-card/80 p-6 shadow-2xl backdrop-blur sm:p-8">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600">
            <Sparkles className="h-5 w-5 text-white" />
          </span>
          <div>
            <h2 className="text-lg font-semibold">Entre para criar seus vídeos</h2>
            <p className="text-sm text-muted-foreground">Sem senha. Enviamos um código para o seu e-mail.</p>
          </div>
        </div>

        {notice && (
          <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
            {notice}
          </p>
        )}

        {step === "email" ? (
          <form onSubmit={sendCode} className="flex flex-col gap-4">
            <label className="flex flex-col gap-2 text-sm">
              <span className="font-medium">E-mail</span>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="voce@exemplo.com"
                  className="h-11 w-full rounded-lg border border-input bg-background/60 pl-9 pr-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-ring"
                />
              </div>
            </label>

            {CAPTCHA_ENABLED && <Turnstile key={widgetKey} onToken={setCaptchaToken} />}

            <Button type="submit" size="lg" disabled={busy || cooldown > 0} className="w-full rounded-xl">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {cooldown > 0 ? `Aguarde ${cooldown}s` : "Enviar código"}
            </Button>
          </form>
        ) : (
          <form onSubmit={verifyCode} className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Enviamos um código para <span className="font-medium text-foreground">{email}</span>.
            </p>

            <label className="flex flex-col gap-2 text-sm">
              <span className="font-medium">Código de 6 dígitos</span>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="000000"
                className="h-12 w-full rounded-lg border border-input bg-background/60 text-center text-2xl tracking-[0.5em] outline-none focus:border-primary focus:ring-2 focus:ring-ring"
              />
            </label>

            <Button type="submit" size="lg" disabled={busy || code.length !== 6} className="w-full rounded-xl">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Entrar
            </Button>

            <div className="flex items-center justify-between text-sm">
              <button type="button" onClick={backToEmail} className="text-muted-foreground hover:text-foreground">
                Usar outro e-mail
              </button>
              <button
                type="button"
                onClick={backToEmail}
                disabled={cooldown > 0}
                className="text-primary hover:underline disabled:opacity-50 disabled:no-underline"
              >
                {cooldown > 0 ? `Reenviar em ${cooldown}s` : "Reenviar código"}
              </button>
            </div>
          </form>
        )}

        {error && (
          <p role="alert" className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        )}

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Ao continuar, você concorda em usar o SwapAI apenas com pessoas que autorizaram o uso da própria imagem.
        </p>
      </div>
    </div>
  );
}
