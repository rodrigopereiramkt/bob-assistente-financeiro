import { categoryEmoji } from './categories.js';
import { shortDate } from './dates.js';
import type { ReportRequest, Transaction } from './types.js';

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const money = (n: number) => brl.format(n).replace(/ /g, ' ');

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

export function bar(pct: number, width = 8): string {
  const filled = Math.round((pct / 100) * width);
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

export function formatRegistered(txs: Transaction[], comment: string): string {
  const lines = txs.map((t) => {
    const sign = t.type === 'receita' ? '🟢 +' : '🔴 -';
    return `${sign}${money(t.amount)} · ${categoryEmoji(t.category)} ${t.category} · ${t.description} (${shortDate(t.occurredOn)})`;
  });
  const head = txs.length === 1 ? '✅ *Anotado!*' : `✅ *Anotei ${txs.length} lançamentos!*`;
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
  const lines = txs.map((t) => `${t.type === 'receita' ? '🟢 +' : '🔴 -'}${money(t.amount)} · ${shortDate(t.occurredOn)} · ${categoryEmoji(t.category)} ${t.description}`);
  return [intro || `🧾 *Seus últimos ${txs.length} lançamentos:*`, '', ...lines].join('\n');
}

export function formatUndo(removed: Transaction[]): string {
  if (removed.length === 0) return 'Não tem nada pra desfazer por aqui 🤷';
  const lines = removed.map((t) => `~${money(t.amount)} · ${t.description}~`);
  return ['🗑️ *Desfeito!* Apaguei:', ...lines, '\nFinge que nunca aconteceu 🤫'].join('\n');
}

export const HELP_TEXT = `Oi! Eu sou o *Bob*, seu assistente financeiro 🤖💸

*Registrar* (texto, áudio ou foto da nota):
• "gastei 45 no ifood"
• "uber 23,90 e mercado 180 ontem"
• "recebi 3500 de salário"

*Relatórios:*
• "quanto gastei esse mês?"
• "resumo da semana"
• "quanto foi de mercado em agosto?"

*Outros:*
• "mostra meus últimos gastos"
• "desfaz" (apaga o último lançamento)

Pode falar do seu jeito que eu entendo 😉`;
