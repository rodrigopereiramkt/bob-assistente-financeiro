import { randomUUID } from 'node:crypto';
import { monthlyDate, nextMonthlyOnOrAfter, todayIn } from './dates.js';
import {
  formatAutoLaunched,
  formatDeleted,
  formatEdited,
  formatList,
  formatRecurringCancelled,
  formatRecurringCreated,
  formatRecurringList,
  formatRegistered,
  formatReport,
  formatUndo,
  HELP_TEXT,
} from './format.js';
import { BusyError, QuotaError, RECENT_LIMIT } from './gemini.js';
import type { AI, InstallmentRequest, IncomingMessage, NewTransaction, Recurring, Store, Transaction } from './types.js';

export interface BobDeps {
  store: Store;
  ai: AI;
  timezone: string;
  now?: () => Date;
}

const QUICK_HELP = /^\s*\/?(ajuda|help|menu|oi bob|start|\/start)\s*[!?.]*\s*$/i;
const QUICK_UNDO = /^\s*\/?(desfaz(er)?|desfaça|apaga o [uú]ltimo|cancela o [uú]ltimo)\s*[!.]*\s*$/i;

/** Divide o total em parcelas mensais; a 1ª parcela absorve os centavos que sobram. */
export function splitInstallments(req: InstallmentRequest): NewTransaction[] {
  const cents = Math.round(req.total * 100);
  const each = Math.floor(cents / req.installments);
  const seriesId = randomUUID();
  return Array.from({ length: req.installments }, (_, i) => ({
    type: req.type,
    amount: (i === 0 ? cents - each * (req.installments - 1) : each) / 100,
    category: req.category,
    description: req.description,
    occurredOn: monthlyDate(req.firstDate, i),
    seriesId,
    installmentNumber: i + 1,
    installmentTotal: req.installments,
  }));
}

/** Lança todas as ocorrências vencidas (até `today`) de um recorrente e avança o próximo vencimento. */
export async function materializeDue(store: Store, r: Recurring, today: string): Promise<Transaction[]> {
  const launched: Transaction[] = [];
  let due = r.nextDue;
  while (due <= today) {
    const t = await store.insertRecurringOccurrence(r, due);
    if (t) launched.push(t);
    due = monthlyDate(due, 1, r.dayOfMonth);
  }
  if (due !== r.nextDue) await store.setRecurringNextDue(r.id, due);
  return launched;
}

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

  const { today, weekday } = todayIn(deps.timezone, deps.now?.() ?? new Date());

  // Recorrentes vencidos são lançados antes (normalmente o cron diário já fez isso).
  let recurring = await store.listRecurring(user.id);
  const auto: Transaction[] = [];
  for (const r of recurring) if (r.nextDue <= today) auto.push(...(await materializeDue(store, r, today)));
  if (auto.length) recurring = await store.listRecurring(user.id);
  const withAuto = (reply: string) => (auto.length ? `${formatAutoLaunched(auto)}\n\n${reply}` : reply);

  const recent = await store.recentTransactions(user.id, today, RECENT_LIMIT);

  let intent;
  try {
    intent = await ai.interpret({ text, media: msg.media }, { today, weekday, recent, recurring });
  } catch (err) {
    if (err instanceof QuotaError) {
      return withAuto('Ufa, tô sem fôlego de tanta conta 😮‍💨 Atingi meu limite de agora. Me manda de novo daqui a pouquinho?');
    }
    if (err instanceof BusyError) {
      return withAuto('Meu cérebro de IA tá congestionado agora 🚦 Não anotei nada ainda. Me manda de novo daqui a um minutinho?');
    }
    throw err;
  }

  const notFound = 'Não achei esse número na lista 🤔 Manda "mostra meus últimos gastos" pra ver os números.';

  switch (intent.kind) {
    case 'registrar': {
      const all = [...intent.transactions, ...intent.installments.flatMap(splitInstallments)];
      const saved = await store.insertTransactions(user.id, all, msg.messageId);
      return withAuto(formatRegistered(saved, intent.reply));
    }
    case 'recorrente': {
      const r = intent.recurring;
      // Se o dia é hoje, já lança a primeira ocorrência agora.
      const created = await store.createRecurring(user.id, { ...r, nextDue: nextMonthlyOnOrAfter(today, r.dayOfMonth) });
      const launched = created.nextDue === today ? await materializeDue(store, created, today) : [];
      const next = launched.length ? monthlyDate(today, 1, r.dayOfMonth) : created.nextDue;
      return withAuto(formatRecurringCreated(created, next, launched.length > 0, intent.reply));
    }
    case 'listar_recorrentes':
      return withAuto(formatRecurringList(recurring, intent.reply));
    case 'cancelar_recorrente': {
      const r = recurring[intent.ref - 1];
      if (!r) return withAuto('Não achei esse recorrente 🤔 Manda "meus recorrentes" pra ver a lista.');
      await store.cancelRecurring(user.id, r.id);
      return withAuto(formatRecurringCancelled(r, intent.reply));
    }
    case 'editar': {
      const target = recent[intent.ref - 1];
      if (!target) return withAuto(notFound);
      const before = { ...target };
      const after = await store.updateTransaction(user.id, before.id, intent.patch);
      if (!after) return withAuto(notFound);
      return withAuto(formatEdited(before, after, intent.reply));
    }
    case 'apagar': {
      const target = recent[intent.ref - 1];
      if (!target) return withAuto(notFound);
      return withAuto(formatDeleted(await store.deleteTransaction(user.id, target.id), intent.reply));
    }
    case 'relatorio': {
      const r = intent.report;
      const txs = await store.listTransactions(user.id, {
        startDate: r.startDate,
        endDate: r.endDate,
        type: r.type === 'todos' ? undefined : r.type,
        category: r.category,
      });
      return withAuto(formatReport(r, txs, intent.reply));
    }
    case 'listar':
      return withAuto(formatList(recent.slice(0, intent.limit), intent.reply));
    case 'desfazer':
      return withAuto(formatUndo(await store.deleteLastBatch(user.id)));
    case 'ajuda':
      return withAuto(HELP_TEXT);
    case 'conversa':
      return withAuto(intent.reply);
  }
}
