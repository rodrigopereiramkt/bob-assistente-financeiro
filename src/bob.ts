import { todayIn } from './dates.js';
import { formatList, formatRegistered, formatReport, formatUndo, HELP_TEXT } from './format.js';
import { QuotaError } from './gemini.js';
import type { AI, IncomingMessage, Store } from './types.js';

export interface BobDeps {
  store: Store;
  ai: AI;
  timezone: string;
  now?: () => Date;
}

const QUICK_HELP = /^\s*\/?(ajuda|help|menu|oi bob|start|\/start)\s*[!?.]*\s*$/i;
const QUICK_UNDO = /^\s*\/?(desfaz(er)?|desfaça|apaga o [uú]ltimo|cancela o [uú]ltimo)\s*[!.]*\s*$/i;

/**
 * Processa uma mensagem recebida e devolve o texto de resposta
 * (ou null se não deve responder, por exemplo, mensagem duplicada).
 */
export async function handleMessage(msg: IncomingMessage, deps: BobDeps): Promise<string | null> {
  const { store, ai } = deps;
  if (!(await store.markProcessed(msg.messageId))) return null;
  if (!msg.text?.trim() && !msg.media) return null;

  const user = await store.getOrCreateUser(msg.from, msg.name);
  const text = msg.text?.trim() ?? null;

  // Atalhos que não gastam cota do Gemini.
  if (text && !msg.media && QUICK_HELP.test(text)) return HELP_TEXT;
  if (text && !msg.media && QUICK_UNDO.test(text)) return formatUndo(await store.deleteLastBatch(user.id));

  const ctx = todayIn(deps.timezone, deps.now?.() ?? new Date());
  let intent;
  try {
    intent = await ai.interpret({ text, media: msg.media }, ctx);
  } catch (err) {
    if (err instanceof QuotaError) {
      return 'Ufa, tô sem fôlego de tanta conta 😮‍💨 Atingi meu limite de agora. Me manda de novo daqui a pouquinho?';
    }
    throw err;
  }

  switch (intent.kind) {
    case 'registrar': {
      const saved = await store.insertTransactions(user.id, intent.transactions, msg.messageId);
      return formatRegistered(saved, intent.reply);
    }
    case 'relatorio': {
      const r = intent.report;
      const txs = await store.listTransactions(user.id, {
        startDate: r.startDate,
        endDate: r.endDate,
        type: r.type === 'todos' ? undefined : r.type,
        category: r.category,
      });
      return formatReport(r, txs, intent.reply);
    }
    case 'listar':
      return formatList(await store.lastTransactions(user.id, intent.limit), intent.reply);
    case 'desfazer':
      return formatUndo(await store.deleteLastBatch(user.id));
    case 'ajuda':
      return HELP_TEXT;
    case 'conversa':
      return intent.reply;
  }
}
