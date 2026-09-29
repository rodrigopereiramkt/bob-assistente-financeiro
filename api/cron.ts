import { timingSafeEqual } from 'node:crypto';
import { materializeDue } from '../src/bob.js';
import { config } from '../src/config.js';
import { todayIn } from '../src/dates.js';
import { EvolutionClient } from '../src/evolution.js';
import { formatAutoLaunched } from '../src/format.js';
import { SupabaseStore } from '../src/store-supabase.js';
import type { Transaction } from '../src/types.js';

/** A Vercel chama esta rota 1x por dia (vercel.json) com "Authorization: Bearer CRON_SECRET". */
function authorized(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(header ?? '');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export async function GET(request: Request) {
  if (!authorized(request.headers.get('authorization'))) {
    console.log('Cron sem autorização (CRON_SECRET ausente ou diferente)');
    return new Response('unauthorized', { status: 401 });
  }

  const store = new SupabaseStore(config.supabase.url, config.supabase.serviceKey);
  const { today } = todayIn(config.timezone);
  const due = await store.dueRecurring(today);

  // Agrupa por usuário para mandar um aviso só por conversa.
  const byUser = new Map<string, { phone: string; launched: Transaction[] }>();
  for (const r of due) {
    const launched = await materializeDue(store, r, today);
    const entry = byUser.get(r.userId) ?? { phone: r.user.phone, launched: [] };
    entry.launched.push(...launched);
    byUser.set(r.userId, entry);
  }

  const evolution = new EvolutionClient(config.evolution);
  let notified = 0;
  for (const { phone, launched } of byUser.values()) {
    if (launched.length === 0) continue;
    try {
      await evolution.sendText(phone, formatAutoLaunched(launched));
      notified++;
    } catch (err) {
      // Os lançamentos já foram feitos; só o aviso falhou (ex.: PC/ngrok desligado).
      console.error('Falha ao avisar recorrentes para', phone, err);
    }
  }
  console.log(`Cron ${today}: ${due.length} recorrentes vencidos, ${notified} avisos enviados`);
  return Response.json({ ok: true, today, due: due.length, notified });
}
