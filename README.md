# Bob 🤖💸 Assistente financeiro no WhatsApp

Registra gastos e receitas por texto, áudio ou foto de nota e gera relatórios quando você pergunta.
Stack 100% free tier: **Evolution API** (WhatsApp) → **Vercel** (webhook) → **Gemini** (entende a mensagem) → **Supabase** (guarda os dados).

```
WhatsApp ──► Evolution API ──webhook──► Vercel /api/webhook ──► Gemini (1 chamada: intenção + dados)
                  ▲                            │
                  └──────── sendText ◄─────────┴──► Supabase (users, transactions)
```

- **1 chamada ao Gemini por mensagem** (texto, áudio ou imagem vão direto pro modelo, sem transcrição separada). "ajuda" e "desfaz" nem chamam o Gemini.
- **Relatórios calculados no código**, não pela IA: o Gemini só entende o pedido ("quanto gastei de mercado em agosto?" → período + categoria), a soma é feita com os dados do banco.
- O webhook responde 200 na hora e processa em segundo plano (`waitUntil`), então a Evolution não reenvia. Mensagens repetidas são ignoradas (`processed_messages`).

## O que o Bob entende

| Você manda | Bob faz |
|---|---|
| "gastei 45 no ifood", "uber 23,90 e mercado 180 ontem" | registra 1 ou mais despesas com categoria e data |
| "recebi 3500 de salário" | registra receita |
| 🎤 áudio ou 📷 foto da nota | mesma coisa |
| "quanto gastei esse mês?", "resumo da semana", "quanto foi de mercado em agosto?" | relatório com receitas, despesas, saldo e ranking por categoria |
| "mostra meus últimos gastos" | lista os últimos lançamentos |
| "desfaz" | apaga o último lançamento (ou o último lote) |
| "ajuda" | mostra o menu |
| qualquer outra coisa | conversa com bom humor e dicas de finanças |

## Estrutura

```
api/webhook.ts          # função da Vercel (POST do webhook da Evolution)
src/bob.ts              # cérebro: decide o que fazer com cada mensagem
src/gemini.ts           # prompt, schema JSON e validação da resposta do Gemini
src/evolution.ts        # parse do webhook + envio de mensagens/mídia
src/store-supabase.ts   # acesso ao banco
src/store-memory.ts     # banco em memória (testes e simulador)
src/format.ts           # textos das respostas (relatórios, piadas, ajuda)
supabase/schema.sql     # tabelas
scripts/chat.ts         # conversar com o Bob no terminal
test/bob.test.ts        # testes
```

## Passo a passo do deploy

### 1. Supabase
1. Crie um projeto em https://supabase.com (plano Free).
2. Abra **SQL Editor**, cole o conteúdo de `supabase/schema.sql` e rode.
3. Em **Project Settings → API**, copie a **Project URL** e a **service_role key** (é secreta, só vai na Vercel).

### 2. Gemini
1. Gere uma chave em https://aistudio.google.com/apikey.
2. Modelo padrão: `gemini-2.5-flash`. Se bater no limite diário, troque `GEMINI_MODEL` para `gemini-2.5-flash-lite` (cota gratuita maior). Confira os limites atuais em https://ai.google.dev/gemini-api/docs/rate-limits.

### 3. Testar no terminal (opcional, sem WhatsApp)
```bash
npm install
GEMINI_API_KEY=sua-chave npm run chat
```
Sem variáveis do Supabase ele guarda tudo em memória. Com `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` definidas, grava no banco de verdade.

### 4. Vercel
1. Suba esta pasta para um repositório no GitHub e importe em https://vercel.com/new (plano Hobby). Framework: **Other**.
2. Em **Settings → Environment Variables**, cadastre as variáveis de `.env.example`.
3. Faça o deploy e teste `https://SEU-APP.vercel.app/api/webhook` no navegador: deve aparecer `{"ok":true,"bot":"Bob"}`.

### 5. Evolution API
Aponte o webhook da instância para a Vercel, com o token na URL e só o evento `MESSAGES_UPSERT`.
Ligue o **Webhook Base64** para áudios e fotos chegarem prontos (se não ligar, o Bob busca a mídia pela API, também funciona).

Pelo Manager da Evolution, ou via API:
```bash
curl -X POST "$EVOLUTION_API_URL/webhook/set/$EVOLUTION_INSTANCE" \
  -H "apikey: $EVOLUTION_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "webhook": {
      "enabled": true,
      "url": "https://SEU-APP.vercel.app/api/webhook?token=SEU_WEBHOOK_TOKEN",
      "byEvents": false,
      "base64": true,
      "events": ["MESSAGES_UPSERT"]
    }
  }'
```

Pronto: mande "ajuda" para o número da instância. 🎉

## Variáveis de ambiente

| Variável | Para quê |
|---|---|
| `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE` | enviar respostas e baixar mídia |
| `WEBHOOK_TOKEN` | segredo na URL do webhook (bloqueia chamadas de terceiros) |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | IA |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | banco |
| `ALLOWED_NUMBERS` | opcional: só esses números podem usar (protege sua cota gratuita) |
| `TIMEZONE` | padrão `America/Sao_Paulo` |

## Limites do free tier (bom saber)
- **Gemini free**: limite por minuto e por dia; quando estoura, o Bob avisa com bom humor e pede pra tentar depois. Os dados do free tier podem ser usados pelo Google para melhorar os modelos.
- **Supabase Free**: o projeto pausa depois de ~1 semana sem uso; é só reativar no painel.
- **Vercel Hobby**: uso pessoal/não comercial.

## Desenvolvimento
```bash
npm test          # testes (não precisam de chaves)
npm run typecheck
```

## Próximos passos sugeridos
Orçamento por categoria com alerta ("você já usou 80% do limite de delivery"), resumo semanal automático (Vercel Cron), gastos recorrentes/parcelados, exportar CSV, editar um lançamento específico.
