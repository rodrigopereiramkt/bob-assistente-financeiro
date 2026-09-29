import { waitUntil } from '@vercel/functions';
import { timingSafeEqual } from 'node:crypto';
import { handleMessage } from '../src/bob.js';
import { config } from '../src/config.js';
import { EvolutionClient, isAllowed, parseWebhook } from '../src/evolution.js';
import { GeminiAI } from '../src/gemini.js';
import { SupabaseStore } from '../src/store-supabase.js';
import type { IncomingMessage } from '../src/types.js';

const MAX_MEDIA_BYTES = 15 * 1024 * 1024; // limite de dados inline do Gemini é ~20MB

function tokenOk(given: string | null): boolean {
  const expected = Buffer.from(config.webhookToken);
  const got = Buffer.from(given ?? '');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export async function GET() {
  return Response.json({ ok: true, bot: 'Bob' });
}

export async function POST(request: Request) {
  if (!tokenOk(new URL(request.url).searchParams.get('token'))) {
    console.log('Webhook com token inválido');
    return new Response('unauthorized', { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = parseWebhook(body);
  if (!parsed) {
    console.log('Webhook ignorado:', body?.event, body?.data?.key?.remoteJid ?? '');
    return Response.json({ ignored: true });
  }

  if (!isAllowed(parsed.message.from, config.allowedNumbers)) {
    console.log('Número fora de ALLOWED_NUMBERS:', parsed.message.from);
    return Response.json({ ignored: 'not-allowed' });
  }

  // Responde 200 na hora para a Evolution não reenviar, e processa em segundo plano.
  waitUntil(processMessage(parsed));
  return Response.json({ ok: true });
}

async function processMessage(parsed: NonNullable<ReturnType<typeof parseWebhook>>) {
  const evolution = new EvolutionClient(config.evolution);
  const to = parsed.message.from;
  try {
    await evolution.typing(to);

    let media: IncomingMessage['media'] = null;
    if (parsed.mediaKind) {
      const fetched = parsed.inlineBase64
        ? { base64: parsed.inlineBase64, mimeType: parsed.mimeType }
        : await evolution.getMediaBase64(parsed.raw);
      if (fetched.base64.length * 0.75 > MAX_MEDIA_BYTES) {
        await evolution.sendText(to, 'Esse arquivo é grandão demais pra mim 😅 Manda um áudio mais curto ou uma foto menor?');
        return;
      }
      // Remove parâmetros como "; codecs=opus", que o Gemini não aceita.
      const mimeType = (fetched.mimeType ?? parsed.mimeType ?? 'application/octet-stream').split(';')[0].trim();
      media = { base64: fetched.base64, mimeType };
    }

    const reply = await handleMessage(
      { ...parsed.message, media },
      {
        store: new SupabaseStore(config.supabase.url, config.supabase.serviceKey),
        ai: new GeminiAI(config.gemini.apiKey, config.gemini.model, config.gemini.fallbackModels),
        timezone: config.timezone,
      },
    );
    if (reply) await evolution.sendText(to, reply);
  } catch (err) {
    console.error('Erro ao processar mensagem', parsed.message.messageId, err);
    await evolution
      .sendText(to, 'Opa, tropecei aqui nos meus cálculos 🤕 Tenta de novo em instantes?')
      .catch((e) => console.error('Falha ao avisar o usuário', e));
  }
}
