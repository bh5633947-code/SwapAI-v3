# SwapAI

Substitua a pessoa principal de um vídeo pelo rosto de uma imagem, usando a API `wan2.2-animate-mix`
da Alibaba Cloud Model Studio.

**Stack:** Next.js 15 (App Router) · React 19 · Tailwind · componentes no padrão shadcn/ui ·
Route Handlers · **Supabase** (Postgres + Auth) · **Upstash Redis** (rate limit) ·
**Cloudflare Turnstile** (anti-bot) · **Vercel Blob** (arquivos).

---

## Como funciona

1. A pessoa entra com um **código enviado por e-mail** (sem senha), passando pelo captcha.
2. Ela envia a foto e o vídeo direto ao Vercel Blob, marca a confirmação de autorização e clica em "Gerar".
3. `POST /api/swap` valida tudo, debita 1 crédito numa transação e cria a tarefa na Alibaba.
4. A página consulta `GET /api/swap/{jobId}` a cada 15 s até o resultado.
5. Ao concluir, o vídeo é salvo de forma permanente no Blob e os uploads de entrada são apagados.
6. Se a geração falhar, o crédito volta sozinho (uma única vez).

## Crédito grátis: uma vez por pessoa

O crédito grátis é concedido **uma única vez por identidade**, e a regra fica no banco
(`ensure_profile` em `supabase/migrations/0001_init.sql`). Camadas:

| Proteção | O que bloqueia |
|---|---|
| Código por e-mail (OTP) | Conta sem e-mail real. O crédito só sai depois da confirmação. |
| Captcha Turnstile no login | Criação de contas em massa por robôs. |
| Lista de e-mails descartáveis | Mailinator, 10minutemail e similares não recebem crédito. |
| Normalização do e-mail | `a.b.c+x@gmail.com` e `abc@gmail.com` são a mesma identidade. |
| Fingerprint HMAC (não reversível) | O banco guarda só um hash da identidade, sem o e-mail em claro. |
| Tabela `free_grant_claims` **sem FK** | Apagar a conta e criar outra **não** libera o crédito de novo. |
| Limite de cadastros por IP (24 h) | Muitas contas do mesmo IP não ganham crédito (padrão: 2). |
| Verificação de telefone (opcional) | Uma linha de telefone = um crédito. Recomendado em produção. |
| Status `pending` | Quem não tem direito ainda pode ser reavaliado depois (ex.: após validar o telefone). |

## Proteção da cobrança e da API

| Proteção | Detalhe |
|---|---|
| Débito atômico | `start_job` trava a linha do usuário (`FOR UPDATE`) e debita na mesma transação. Duas requisições não gastam dois créditos. |
| Uma geração ativa por vez | Índice único parcial em `jobs`. O usuário não consegue disparar 20 gerações em paralelo. |
| Limite diário por usuário e global | `MAX_JOBS_PER_USER_PER_DAY` e `MAX_GLOBAL_JOBS_PER_DAY`. Limita o custo máximo. |
| Reembolso uma única vez | `fail_job` marca `refunded` e o `ledger` tem chave única `(motivo, referência)`. |
| Razão de créditos | Todo movimento fica em `credit_ledger`. Um teste verifica que saldo = soma do razão. |
| Compra idempotente | `grant_purchase` ignora o mesmo pagamento se o webhook chegar duas vezes. |
| Job órfão | Se a pessoa fecha a aba no meio, o job é destravado e reembolsado (2 min sem task, 60 min ativo). |
| Retomada | Ao voltar à página, o app retoma o acompanhamento da geração em andamento. |
| Rate limit | Upstash por usuário e por IP em cada rota. Em produção, sem Redis, o app **não sobe** (fail-closed). |
| Autorização | Cada rota exige sessão válida (`getUser` no servidor). Job de outra pessoa responde 404. |
| Upload restrito | Cada token de upload só vale para a pasta do próprio usuário, com tipo e tamanho do arquivo. |
| Validação do servidor | URL precisa ser do Blob, da própria pasta, existir e ter tipo/tamanho corretos. Antes de debitar. |
| Anti-SSRF | O servidor só consulta URLs do armazenamento do SwapAI. |
| Anti-CSRF | Rotas que alteram estado exigem mesma origem (`Origin` / `Sec-Fetch-Site`). |
| RLS | Tabelas com RLS ligado e sem políticas. Só o servidor (service role) acessa. |
| Funções protegidas | `REVOKE EXECUTE` de `anon` e `authenticated` nas funções financeiras. |
| Cabeçalhos | CSP, HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`. |
| Segredos | Chave `service_role` e `IDENTITY_HMAC_SECRET` só no servidor. Erros internos não vão ao cliente. |
| Consentimento | Checkbox obrigatório de autorização da pessoa da imagem, registrado em `jobs.consent_at`. |
| Privacidade | Uploads de entrada são apagados após a geração. Pasta de storage derivada por hash, não pelo id. |

### O que NÃO dá para garantir (seja honesto com quem for lançar)

- **Ninguém consegue impedir 100% de múltiplas contas.** Quem tem vários e-mails reais e vários
  telefones ainda consegue crédito grátis em cada um. Por isso o limite real é o **custo por crédito grátis**
  (1 geração), a verificação de telefone e os limites globais. O modelo de negócio precisa aguentar esse custo.
- **IP compartilhado** (CGNAT, rede de escritório, 4G) pode bloquear pessoas legítimas no limite de cadastros.
  Ajuste `MAX_SIGNUPS_PER_IP_PER_DAY` se isso acontecer.
- **Deepfake.** O consentimento e os termos reduzem risco jurídico, mas não impedem alguém de mentir no checkbox.
  Para produção pública, considere moderação de conteúdo e revisão de denúncias.

---

## Configuração

### 1. Supabase

1. Crie um projeto em supabase.com.
2. **SQL Editor**: cole e execute `supabase/migrations/0001_init.sql`.
3. **Authentication > Providers > Email**: deixe o provedor de e-mail ativo e o **Confirm email** ligado.
4. **Authentication > Email Templates > Magic Link**: o corpo precisa mostrar o código com `{{ .Token }}`
   (o código de 6 dígitos é o que o app pede). Ex.: `<h2>Seu código: {{ .Token }}</h2>`.
5. **Authentication > Attack Protection**: ative **CAPTCHA** com Cloudflare Turnstile e cole a secret key.
6. **Authentication > Rate Limits**: deixe os limites padrão ou mais restritivos para envio de e-mail.
7. **Authentication > SMTP**: em produção, configure SMTP próprio (Resend, Amazon SES, Postmark).
   O SMTP padrão do Supabase é limitado e não serve para lançamento.
8. (Opcional, recomendado) **Authentication > Phones**: ative com um provedor SMS (Twilio) e defina
   `REQUIRE_PHONE_VERIFICATION=true`.
9. Copie URL, anon key e service_role key em **Project Settings > API**.

### 2. Cloudflare Turnstile

1. Em dash.cloudflare.com > Turnstile, crie um widget para o seu domínio.
2. Use a **site key** em `NEXT_PUBLIC_TURNSTILE_SITE_KEY` e a **secret key** no painel do Supabase (passo 5 acima).

### 3. Upstash Redis

1. Crie um banco Redis em upstash.com (plano gratuito serve para começar).
2. Copie `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`.

### 4. Vercel Blob

1. No projeto da Vercel: **Storage > Create > Blob**. Isso cria `BLOB_READ_WRITE_TOKEN`.

### 5. Variáveis de ambiente

Copie `.env.example` para `.env.local` (local) ou cadastre na Vercel (produção).
Gere o segredo do HMAC com `openssl rand -hex 32`.

### 6. Rodar

```bash
npm install
cp .env.example .env.local   # preencha as variáveis
npm run dev
```

Abra http://localhost:3000. Em desenvolvimento, sem Upstash, o rate limit fica desligado.
Em produção ele é obrigatório.

### 7. Deploy

Suba o repositório na Vercel, configure as variáveis e faça o deploy.
Rode a migration no Supabase antes do primeiro acesso.

---

## Pagamentos (Mercado Pago)

Compra de créditos pelo **Checkout Pro**: Pix, cartão ou boleto, conforme o que estiver disponível na conta.

### Fluxo

1. A pessoa escolhe um pacote em `lib/pricing.ts`. Só o id do pacote vai ao servidor, nunca o preço.
2. `POST /api/checkout` cria a compra (`purchases`, status `created`) e a preferência no Mercado Pago, com
   `external_reference` = id da compra. Devolve a URL de pagamento e o navegador é redirecionado para lá.
3. Depois do pagamento, o Mercado Pago chama `POST /api/webhooks/mercadopago`.
4. O webhook confere a assinatura, busca o pagamento na API, confere valor, moeda e a compra, e aplica o status.
5. Pagamento aprovado soma os créditos. Reembolso ou chargeback tira os créditos comprados.

### Regras de segurança

- **Crédito só entra pelo webhook.** A página de retorno nunca credita nada.
- **Assinatura obrigatória.** Sem `x-signature` válida, o webhook responde 401 e não faz nada.
- **O corpo da notificação não é confiável.** Ele só diz "há um pagamento X". Status e valor vêm da API.
- **Valor, moeda e referência conferidos** contra a compra. Divergência não credita e gera log `DIVERGÊNCIA` para revisão.
- **Idempotência em três níveis:** evento duplicado (`payment_events`), compra já aprovada (`already_approved`) e
  chave única por pagamento. Mesmo com notificações repetidas ou simultâneas, o crédito entra uma vez.
- **Erros transitórios respondem 5xx**, e o Mercado Pago reenvia. Pagamento inexistente responde 200.
- **Preço gravado na compra.** Mudar o preço do pacote depois não altera compras já feitas.
- **Dados do pagador não são guardados.** A auditoria (`payment_events`) tem só id, status e valor.

### Configuração

1. Crie uma aplicação em https://www.mercadopago.com.br/developers.
2. **Comece com credenciais de teste.** Copie o Access Token de teste para `MP_ACCESS_TOKEN`.
   Use os usuários e cartões de teste do Mercado Pago para simular pagamentos.
3. **Webhook:** em *Suas integrações > Webhooks*, cadastre a URL
   `https://SEU-DOMINIO/api/webhooks/mercadopago`, com o evento **Pagamentos** (`payment`).
   Copie a *assinatura secreta* para `MP_WEBHOOK_SECRET`.
4. Defina `NEXT_PUBLIC_APP_URL=https://SEU-DOMINIO` (sem barra no final).
5. Rode `supabase/migrations/0002_payments.sql` no SQL Editor do Supabase.
6. **Em desenvolvimento local**, o Mercado Pago precisa alcançar seu webhook. Use um túnel
   (`ngrok http 3000` ou `cloudflared tunnel`) e coloque a URL do túnel em `NEXT_PUBLIC_APP_URL`.
   Cadastre o webhook com a mesma URL.
7. **Para produção:** troque para o Access Token de produção e cadastre o webhook de produção,
   que tem a própria assinatura secreta.

### Limitações conhecidas

- **Reembolso parcial** não é tratado: o status continua `approved` no Mercado Pago. Revise manualmente.
- **Créditos já gastos** em gerações não são recuperados num reembolso. A reversão é limitada ao saldo.
- **Notas fiscais** não são emitidas automaticamente. Para venda no Brasil, avalie a emissão (NFS-e ou NF-e) com seu contador.
- **Divergências** (valor ou moeda diferentes) precisam de revisão manual. Recomendo um alerta para o log `DIVERGÊNCIA`.

---

## Testes

```bash
npm test
```

- `tests/db.test.mjs`: roda a migration real em um Postgres de verdade (PGlite, Postgres em WebAssembly)
  e testa crédito grátis único por identidade, conta apagada, limites, idempotência, reembolso,
  job órfão, lock de salvamento e a invariante do livro-razão.
- `tests/email.test.ts`: normalização de Gmail/aliases e detecção de descartáveis.
- `tests/payments-logic.test.ts`: mapeamento de status, conferência de valor/moeda/referência e assinatura do webhook (válida, adulterada, segredo errado).
- `tests/payments-db.test.mjs`: fluxo de pagamento no Postgres: aprovação única, dedupe, reembolso total e parcial, pagamento pendente, rejeição seguida de aprovação e compra revertida final.

Além disso, `npx tsc --noEmit` e `npm run build` passam.

**O que os testes NÃO cobrem:** a chamada real à API da Alibaba e do Mercado Pago, o envio de e-mail do Supabase,
o captcha e o Blob em produção. Para o Mercado Pago, teste um pagamento de teste ponta a ponta (checkout, webhook e crédito). Teste esses pontos com um vídeo curto e uma imagem nítida antes de liberar para público.

---

## Antes de lançar: checklist

- [ ] Confirmar no console da Model Studio o endpoint da sua região (`WORKSPACE_ID` ou `DASHSCOPE_BASE_URL`).
- [ ] Confirmar o campo do resultado: o código lê `output.results.video_url` e cai para `output.video_url`.
- [ ] Testar uma geração real de ponta a ponta (sucesso, falha e reembolso).
- [ ] Testar um pagamento de teste ponta a ponta (checkout, webhook e crédito) antes de trocar para credenciais de produção.
- [ ] Ligar `REQUIRE_PHONE_VERIFICATION=true` e medir o custo por crédito grátis.
- [ ] Publicar Termos de Uso e Política de Privacidade (LGPD, no Brasil): dados de fotos de terceiros exigem base legal e prazo de retenção.
- [ ] Definir a política de retenção dos vídeos gerados (hoje ficam no Blob até você apagar).
- [ ] Configurar monitoramento (Sentry) e alerta para falhas de geração e de reembolso.
- [ ] Backup do Supabase e plano de resposta a incidentes.
- [ ] Revisar a emissão de nota fiscal dos pagamentos.
- [ ] Rever `IDENTITY_HMAC_SECRET`: trocá-lo depois de lançar invalida os fingerprints antigos.

## Limitações conhecidas

- Os tipos de evento do Blob (`blob.generate-client-token` e `blob.upload-completed`) foram verificados
  no SDK instalado, mas o callback de upload só dispara em produção (não em `localhost`).
- A proteção de IP depende de a plataforma repassar o IP real (`x-real-ip`). Na Vercel isso é o padrão.
- O job órfão é destravado quando a pessoa faz uma nova chamada à API. Não há cron. Se quiser, adicione
  uma rota agendada que chame a mesma rotina de limpeza.
