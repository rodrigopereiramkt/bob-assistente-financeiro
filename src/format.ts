import { categoryEmoji } from './categories.js';
import { shortDate } from './dates.js';
import type { Recurring, ReportRequest, Transaction, TransactionPatch } from './types.js';

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const money = (n: number) => brl.format(n).replace(/ /g, ' ');

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

export function bar(pct: number, width = 8): string {
  const filled = Math.round((pct / 100) * width);
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

const sign = (t: { type: string }) => (t.type === 'receita' ? '🟢 +' : '🔴 -');

function txLine(t: Transaction): string {
  const parcela = t.installmentTotal ? ` (${t.installmentNumber}/${t.installmentTotal})` : '';
  return `${sign(t)}${money(t.amount)} · ${categoryEmoji(t.category)} ${t.category} · ${t.description}${parcela} (${shortDate(t.occurredOn)})`;
}

export function formatRegistered(txs: Transaction[], comment: string): string {
  const single = txs.filter((t) => !t.seriesId);
  const series = new Map<string, Transaction[]>();
  for (const t of txs) if (t.seriesId) series.set(t.seriesId, [...(series.get(t.seriesId) ?? []), t]);

  const lines = single.map(txLine);
  for (const parts of series.values()) {
    parts.sort((a, b) => a.occurredOn.localeCompare(b.occurredOn));
    const [first, last] = [parts[0], parts[parts.length - 1]];
    const total = parts.reduce((s, t) => s + t.amount, 0);
    const each = parts.length > 1 ? parts[1].amount : first.amount;
    lines.push(
      `${sign(first)}${money(total)} · ${categoryEmoji(first.category)} ${first.category} · ${first.description}`,
      `   💳 em ${parts.length}x de ${money(each)}, de ${shortDate(first.occurredOn)} a ${shortDate(last.occurredOn)}/${last.occurredOn.slice(2, 4)}`,
    );
  }
  const count = single.length + series.size;
  const head = count === 1 ? '✅ *Anotado!*' : `✅ *Anotei ${count} lançamentos!*`;
  return [head, ...lines, comment ? `\n${comment}` : '', '\n_Errou? É só dizer "desfaz"._'].filter(Boolean).join('\n');
}

export function formatReport(req: ReportRequest, txs: Transaction[], intro: string): string {
  const title = `📊 *Relatório: ${req.label}*${req.category ? ` · ${categoryEmoji(req.category)} ${req.category}` : ''}`;
  const period = `_${shortDate(req.startDate)} a ${shortDate(req.endDate)}_`;
  if (txs.length === 0) {
    return `${title}\n${period}\n\nNada registrado nesse período. Ou você é um monge, ou esqueceu de me contar 👀`;
  }

  const income = txs.filter((t) => t.type === 'receita').reduce((s, t) => s + t.amount, 0);
  const expense = txs.filter((t) => t.type === 'despesa').reduce((s, t) => s + t.amount, 0);
  const out: string[] = [title, period, ''];
  if (intro) out.push(intro, '');

  if (req.type !== 'despesa') out.push(`💰 Receitas: *${money(income)}*`);
  if (req.type !== 'receita') out.push(`💸 Despesas: *${money(expense)}*`);
  if (req.type === 'todos') out.push(`🧮 Saldo: *${money(income - expense)}*`);

  const breakdownType = req.type === 'receita' ? 'receita' : 'despesa';
  const base = breakdownType === 'receita' ? income : expense;
  if (!req.category && base > 0) {
    const byCat = new Map<string, number>();
    for (const t of txs) if (t.type === breakdownType) byCat.set(t.category, (byCat.get(t.category) ?? 0) + t.amount);
    const sorted = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
    out.push('', breakdownType === 'receita' ? '*De onde veio:*' : '*Para onde foi:*');
    for (const [cat, total] of sorted.slice(0, 8)) {
      const pct = (total / base) * 100;
      out.push(`${categoryEmoji(cat)} ${cat}: ${money(total)} (${pct.toFixed(0)}%) ${bar(pct)}`);
    }
    if (sorted.length > 8) out.push(`… e mais ${sorted.length - 8} categorias`);
  }

  if (req.category) {
    out.push('', '*Lançamentos:*');
    for (const t of txs.slice(0, 10)) out.push(`• ${shortDate(t.occurredOn)} ${t.description}: ${money(t.amount)}`);
    if (txs.length > 10) out.push(`… e mais ${txs.length - 10}`);
  }

  if (req.type === 'todos') {
    const balance = income - expense;
    out.push(
      '',
      balance > 0
        ? pick(['Fechando no azul! Seu eu do futuro agradece 💙', 'Saldo positivo, tá podendo 😎', 'Azul-piscina. Continue assim 🏊'])
        : balance < 0
          ? pick(['Saiu mais do que entrou... bora apertar o cinto? 🫣', 'Vermelho não é só a cor do amor 😬 Vamos revisar os gastos?', 'O saldo tá chorando baixinho. Que tal um desafio de 7 dias sem delivery? 🍳'])
          : 'Zero a zero. Empate técnico com o boleto ⚖️',
    );
  }
  return out.join('\n');
}

export function formatList(txs: Transaction[], intro: string): string {
  if (txs.length === 0) return 'Ainda não tem nada anotado. Me conta seu primeiro gasto, tipo "gastei 20 no café" ☕';
  const lines = txs.map((t, i) => {
    const parcela = t.installmentTotal ? ` (${t.installmentNumber}/${t.installmentTotal})` : '';
    const auto = t.recurringId ? ' 🔁' : '';
    return `*#${i + 1}* ${sign(t)}${money(t.amount)} · ${shortDate(t.occurredOn)} · ${categoryEmoji(t.category)} ${t.description}${parcela}${auto}`;
  });
  return [
    intro || `🧾 *Seus últimos ${txs.length} lançamentos:*`,
    '',
    ...lines,
    '',
    '_Pra corrigir: "muda o #2 pra 45" · pra apagar: "apaga o #3"_',
  ].join('\n');
}

export function formatUndo(removed: Transaction[]): string {
  if (removed.length === 0) return 'Não tem nada pra desfazer por aqui 🤷';
  const lines = removed.map((t) => `~${money(t.amount)} · ${t.description}~`);
  return ['🗑️ *Desfeito!* Apaguei:', ...lines, '\nFinge que nunca aconteceu 🤫'].join('\n');
}

export function formatDeleted(removed: Transaction[], comment: string): string {
  if (removed.length === 0) return 'Não achei esse lançamento, acho que já tinha sumido 🤷';
  const t = removed[0];
  const head =
    removed.length > 1
      ? `🗑️ *Apaguei a compra parcelada inteira* (${removed.length} parcelas):`
      : '🗑️ *Apagado!*';
  return [head, `~${money(removed.length > 1 ? removed.reduce((s, x) => s + x.amount, 0) : t.amount)} · ${t.description} (${shortDate(t.occurredOn)})~`, comment ? `\n${comment}` : '']
    .filter(Boolean)
    .join('\n');
}

export function formatEdited(before: Transaction, after: Transaction, comment: string): string {
  const changes: string[] = [];
  const fields: [keyof TransactionPatch, string, (v: any) => string][] = [
    ['amount', 'Valor', money],
    ['description', 'Descrição', String],
    ['category', 'Categoria', (c) => `${categoryEmoji(c)} ${c}`],
    ['occurredOn', 'Data', shortDate],
    ['type', 'Tipo', String],
  ];
  for (const [key, label, fmt] of fields) {
    if (before[key] !== after[key]) changes.push(`${label}: ~${fmt(before[key])}~ → *${fmt(after[key])}*`);
  }
  const parcela = after.installmentTotal ? `\n_Mudei só a parcela ${after.installmentNumber}/${after.installmentTotal}._` : '';
  return ['✏️ *Corrigido!*', txLine(after), ...(changes.length ? ['', ...changes] : []), parcela, comment ? `\n${comment}` : '']
    .filter(Boolean)
    .join('\n');
}

export function formatAutoLaunched(txs: Transaction[]): string {
  return ['🔁 *Lancei os recorrentes do dia:*', ...txs.map(txLine)].join('\n');
}

export function formatRecurringCreated(r: Recurring, next: string, launchedToday: boolean, comment: string): string {
  return [
    '🔁 *Recorrente criado!*',
    `${sign(r)}${money(r.amount)} · ${categoryEmoji(r.category)} ${r.category} · ${r.description}`,
    `Todo dia ${r.dayOfMonth} eu lanço sozinho e aviso aqui.${launchedToday ? ' Já lancei o de hoje.' : ''} Próximo: ${shortDate(next)}.`,
    comment ? `\n${comment}` : '',
    '\n_Pra parar: "cancela o recorrente de ' + r.description.toLowerCase() + '"_',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatRecurringList(list: Recurring[], intro: string): string {
  if (list.length === 0) return 'Nenhum recorrente por aqui. Cria um assim: "aluguel 1500 todo dia 5" 🔁';
  const lines = list.map(
    (r, i) => `*R${i + 1}* ${sign(r)}${money(r.amount)} · ${categoryEmoji(r.category)} ${r.description} · todo dia ${r.dayOfMonth} · próximo ${shortDate(r.nextDue)}`,
  );
  const expense = list.filter((r) => r.type === 'despesa').reduce((s, r) => s + r.amount, 0);
  const income = list.filter((r) => r.type === 'receita').reduce((s, r) => s + r.amount, 0);
  const totals = [income ? `💰 ${money(income)} entrando` : '', expense ? `💸 ${money(expense)} saindo` : ''].filter(Boolean).join(' · ');
  return [intro || '🔁 *Seus recorrentes:*', '', ...lines, '', `Por mês: ${totals}`, '_Pra parar um: "cancela o R2"_'].join('\n');
}

export function formatRecurringCancelled(r: Recurring, comment: string): string {
  return [`🛑 *Recorrente cancelado:* ${r.description} (${money(r.amount)}, todo dia ${r.dayOfMonth})`, 'Os lançamentos que já fiz continuam lá.', comment ? `\n${comment}` : '']
    .filter(Boolean)
    .join('\n');
}

export const HELP_TEXT = `Oi! Eu sou o *Bob*, seu assistente financeiro 🤖💸

*Registrar* (texto, áudio ou foto da nota):
• "gastei 45 no ifood"
• "uber 23,90 e mercado 180 ontem"
• "recebi 3500 de salário"
• "TV 2400 em 10x" (parcelado)

*Recorrentes* (lanço sozinho todo mês):
• "aluguel 1500 todo dia 5"
• "meus recorrentes"
• "cancela o recorrente da Netflix"

*Relatórios:*
• "quanto gastei esse mês?"
• "resumo da semana"
• "quanto foi de mercado em agosto?"

*Corrigir:*
• "mostra meus últimos gastos" (lista numerada)
• "muda o #3 pra 45" ou "o almoço de ontem foi 30"
• "apaga o #2"
• "desfaz" (apaga o último lançamento)

Pode falar do seu jeito que eu entendo 😉`;
