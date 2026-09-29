import { ALL_CATEGORIES, EXPENSE_CATEGORIES, INCOME_CATEGORIES, normalizeCategory } from './categories.js';
import { isValidDate, startOfMonth } from './dates.js';
import type { AI, InstallmentRequest, Intent, InterpretContext, NewTransaction, TransactionPatch, TxType } from './types.js';

/** Quantos lançamentos recentes o Bob mostra e numera (#1…#N). */
export const RECENT_LIMIT = 20;

export class QuotaError extends Error {}
/** O modelo está sobrecarregado (503/500) mesmo depois das novas tentativas. */
export class BusyError extends Error {}

const RETRY_DELAYS_MS = [1500, 4000];

const SYSTEM_PROMPT = `Você é o Bob, um assistente financeiro pessoal no WhatsApp, brasileiro, prático e bem-humorado.
Sua tarefa é interpretar a mensagem do usuário e devolver SOMENTE o JSON no schema pedido.

Intenções (campo "intent"):
- "registrar": o usuário informa um ou mais gastos ou ganhos ("gastei 50 no mercado", "recebi 3000 de salário", "uber 23,90 e ifood 45", "comprei uma TV de 2400 em 10x"). Preencha "transactions" com um item por lançamento.
- "recorrente": o usuário quer que um gasto ou ganho se repita todo mês ("aluguel 1500 todo dia 5", "netflix 55,90 todo mês", "salário 4000 todo dia 5"). Preencha "recurring".
- "listar_recorrentes": quer ver os recorrentes ("meus recorrentes", "quais contas fixas eu tenho?").
- "cancelar_recorrente": quer parar um recorrente ("cancela o recorrente da Netflix", "para de lançar o aluguel"). Preencha "ref" com o número R da lista de recorrentes.
- "relatorio": o usuário quer saber quanto gastou/recebeu, saldo, resumo, gastos por categoria em um período ("quanto gastei esse mês?", "resumo da semana", "quanto foi de ifood em agosto?"). Preencha "report".
- "listar": quer ver os últimos lançamentos ("mostra meus últimos gastos"). Preencha "limit" (padrão 10, máx 20).
- "editar": quer corrigir um lançamento já feito ("muda o #3 pra 45", "o almoço de ontem foi 30, não 25", "o mercado foi dia 20", "o uber era lazer"). Preencha "ref" com o número # da lista de últimos lançamentos e "patch" só com o que muda.
- "apagar": quer apagar um lançamento específico que não é necessariamente o último ("apaga o #2", "apaga o uber de ontem"). Preencha "ref".
- "desfazer": quer apagar/cancelar o ÚLTIMO lançamento feito ("apaga o último", "errei, desfaz").
- "ajuda": pergunta o que você faz ou como usar.
- "conversa": qualquer outra coisa (saudação, dúvida de finanças, papo). Responda em "reply".

Regras para "transactions":
- "type": "despesa" para gastos/pagamentos/compras; "receita" para ganhos/salário/recebimentos/vendas.
- "amount": número positivo em reais, ponto como separador decimal ("23,90" -> 23.9; "1.200" -> 1200; "2k" -> 2000; "cinquenta" -> 50).
- "installments": só para compras parceladas; número de parcelas ("em 10x" -> 10). Nesse caso "amount" é o valor TOTAL da compra ("TV 2400 em 10x" -> amount 2400, installments 10; "10x de 300" -> amount 3000, installments 10). À vista ou sem parcelas: null.
- "category": despesas usam uma de [${EXPENSE_CATEGORIES.join(', ')}]; receitas usam uma de [${INCOME_CATEGORIES.join(', ')}]. iFood/restaurante/lanche = Alimentação; Uber/gasolina/ônibus = Transporte; Netflix/Spotify = Assinaturas; aluguel/condomínio = Moradia; luz/água/internet/celular = Contas.
- "description": curta, usando as palavras do próprio usuário (ex.: "gastei 25 no almoço" -> "Almoço"; "45 no ifood" -> "iFood"). Nunca invente loja, marca ou aplicativo que o usuário não citou.
- "date": YYYY-MM-DD. Use a data de hoje se não for dita. Resolva "ontem", "sexta", "dia 5" em relação a hoje (nunca no futuro, exceto se o usuário disser explicitamente). Em compra parcelada, é a data da 1ª parcela.
- Se a mensagem for uma foto de nota fiscal/comprovante, registre o total como despesa (ou receita, se for um comprovante recebido).
- Se não houver valor claro, use "conversa" e pergunte o valor em "reply".

Regras para "recurring": mesmos critérios de type/amount/category/description acima; "day_of_month" é o dia do mês em que se repete (1 a 31), ou null se o usuário não disse.

Regras para "editar", "apagar" e "cancelar_recorrente":
- Use a lista de últimos lançamentos (#1, #2…) ou de recorrentes (R1, R2…) enviada junto com a mensagem. "ref" é só o número (ex.: #3 -> 3; R2 -> 2).
- Identifique o lançamento pelo número citado ou pela descrição, valor e data. Se mais de um lançamento combinar e não der para saber qual é, ou se nenhum combinar, NÃO chute: use "conversa" e pergunte qual é em "reply", listando as opções com o número (#n).
- "patch": preencha só os campos que mudam ("amount", "category", "description", "date", "type"); os outros ficam null.

Regras para "report":
- "start_date" e "end_date" inclusivos em YYYY-MM-DD. Sem período citado = mês atual (do dia 1 até hoje).
- "type": "todos", "despesa" ou "receita".
- "category": uma das categorias acima se o usuário perguntou de uma categoria específica, senão null.
- "label": nome amigável do período ("setembro de 2026", "esta semana", "hoje").

"reply": sempre em português do Brasil, curto (1 ou 2 frases), divertido e leve, sem ser forçado, pode usar 1 emoji.
- Em "registrar", "recorrente", "editar" e "apagar": um comentário espirituoso (não repita os valores, o sistema já mostra).
- Em "relatorio", "listar" e "listar_recorrentes": uma frase curta de abertura.
- Em "conversa" e "ajuda": a resposta completa. Para dúvidas de finanças dê dicas práticas e responsáveis; não recomende investimentos específicos.`;

const MONEY_ITEM = {
  type: { type: 'STRING', enum: ['receita', 'despesa'] },
  amount: { type: 'NUMBER' },
  category: { type: 'STRING', enum: ALL_CATEGORIES },
  description: { type: 'STRING' },
};

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    intent: {
      type: 'STRING',
      enum: ['registrar', 'recorrente', 'listar_recorrentes', 'cancelar_recorrente', 'relatorio', 'listar', 'editar', 'apagar', 'desfazer', 'ajuda', 'conversa'],
    },
    transactions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { ...MONEY_ITEM, date: { type: 'STRING' }, installments: { type: 'INTEGER', nullable: true } },
        required: ['type', 'amount', 'category', 'description', 'date'],
      },
    },
    recurring: {
      type: 'OBJECT',
      properties: { ...MONEY_ITEM, day_of_month: { type: 'INTEGER', nullable: true } },
      required: ['type', 'amount', 'category', 'description'],
    },
    ref: { type: 'INTEGER', nullable: true },
    patch: {
      type: 'OBJECT',
      properties: {
        type: { type: 'STRING', enum: ['receita', 'despesa'], nullable: true },
        amount: { type: 'NUMBER', nullable: true },
        category: { type: 'STRING', enum: ALL_CATEGORIES, nullable: true },
        description: { type: 'STRING', nullable: true },
        date: { type: 'STRING', nullable: true },
      },
    },
    report: {
      type: 'OBJECT',
      properties: {
        start_date: { type: 'STRING' },
        end_date: { type: 'STRING' },
        type: { type: 'STRING', enum: ['todos', 'receita', 'despesa'] },
        category: { type: 'STRING', nullable: true },
        label: { type: 'STRING' },
      },
      required: ['start_date', 'end_date', 'type', 'label'],
    },
    limit: { type: 'INTEGER' },
    reply: { type: 'STRING' },
  },
  required: ['intent', 'reply'],
};

function toAmount(v: unknown): number | null {
  const amount = Math.round(Number(v) * 100) / 100;
  return Number.isFinite(amount) && amount > 0 && amount <= 100_000_000 ? amount : null;
}

function toDescription(v: unknown): string {
  return String(v ?? '').trim().slice(0, 120) || 'Sem descrição';
}

function toRef(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** Valida e normaliza o JSON do modelo para um Intent seguro. */
export function toIntent(raw: any, today: string): Intent {
  const reply = typeof raw?.reply === 'string' ? raw.reply.trim() : '';
  switch (raw?.intent) {
    case 'registrar': {
      const transactions: NewTransaction[] = [];
      const installments: InstallmentRequest[] = [];
      for (const t of Array.isArray(raw.transactions) ? raw.transactions : []) {
        const amount = toAmount(t?.amount);
        if (amount === null) continue;
        const base = {
          type: (t?.type === 'receita' ? 'receita' : 'despesa') as TxType,
          category: normalizeCategory(t?.category),
          description: toDescription(t?.description),
        };
        const date = isValidDate(t?.date) ? t.date : today;
        const n = Number(t?.installments);
        if (Number.isInteger(n) && n >= 2 && n <= 72 && amount >= n * 0.01) {
          installments.push({ ...base, total: amount, installments: n, firstDate: date });
        } else {
          transactions.push({ ...base, amount, occurredOn: date });
        }
      }
      if (transactions.length === 0 && installments.length === 0) {
        return { kind: 'conversa', reply: reply || 'Não peguei o valor 🤔 Me manda tipo: "gastei 35 no almoço".' };
      }
      return { kind: 'registrar', transactions, installments, reply };
    }
    case 'recorrente': {
      const r = raw.recurring ?? {};
      const amount = toAmount(r.amount);
      if (amount === null) return { kind: 'conversa', reply: reply || 'Qual o valor que se repete todo mês? 🤔' };
      const day = Number(r.day_of_month);
      return {
        kind: 'recorrente',
        recurring: {
          type: r.type === 'receita' ? 'receita' : 'despesa',
          amount,
          category: normalizeCategory(r.category),
          description: toDescription(r.description),
          dayOfMonth: Number.isInteger(day) && day >= 1 && day <= 31 ? day : Number(today.slice(8, 10)),
        },
        reply,
      };
    }
    case 'listar_recorrentes':
      return { kind: 'listar_recorrentes', reply };
    case 'cancelar_recorrente':
    case 'apagar': {
      const ref = toRef(raw.ref);
      if (ref === null) return { kind: 'conversa', reply: reply || 'Qual deles? Me diz o número da lista 🙏' };
      return { kind: raw.intent, ref, reply };
    }
    case 'editar': {
      const ref = toRef(raw.ref);
      const p = raw.patch ?? {};
      const patch: TransactionPatch = {};
      if (p.type === 'receita' || p.type === 'despesa') patch.type = p.type;
      if (p.amount != null && toAmount(p.amount) !== null) patch.amount = toAmount(p.amount)!;
      if (p.category) patch.category = normalizeCategory(p.category);
      if (typeof p.description === 'string' && p.description.trim()) patch.description = toDescription(p.description);
      if (isValidDate(p.date)) patch.occurredOn = p.date;
      if (ref === null || Object.keys(patch).length === 0) {
        return { kind: 'conversa', reply: reply || 'O que eu mudo e em qual lançamento? Tipo: "muda o #2 pra 45" 🙏' };
      }
      return { kind: 'editar', ref, patch, reply };
    }
    case 'relatorio': {
      const r = raw.report ?? {};
      let startDate = isValidDate(r.start_date) ? r.start_date : startOfMonth(today);
      let endDate = isValidDate(r.end_date) ? r.end_date : today;
      if (startDate > endDate) [startDate, endDate] = [endDate, startDate];
      const type = r.type === 'receita' || r.type === 'despesa' ? r.type : 'todos';
      const category = r.category ? normalizeCategory(r.category) : null;
      return {
        kind: 'relatorio',
        report: { startDate, endDate, type, category: category === 'Outros' && r.category !== 'Outros' ? null : category, label: String(r.label || 'período') },
        reply,
      };
    }
    case 'listar': {
      const limit = Math.min(Math.max(Number.parseInt(raw.limit, 10) || 10, 1), RECENT_LIMIT);
      return { kind: 'listar', limit, reply };
    }
    case 'desfazer':
      return { kind: 'desfazer', reply };
    case 'ajuda':
      return { kind: 'ajuda', reply };
    default:
      return { kind: 'conversa', reply: reply || 'Hmm, não entendi. Manda de novo com outras palavras? 😅' };
  }
}

/** Texto com os últimos lançamentos e os recorrentes, para o modelo saber a que "#3" ou "o almoço de ontem" se refere. */
export function contextText(ctx: InterpretContext): string {
  const recent = ctx.recent.length
    ? ctx.recent
        .map((t, i) => {
          const parcela = t.installmentTotal ? ` (parcela ${t.installmentNumber}/${t.installmentTotal})` : '';
          return `#${i + 1} ${t.occurredOn} ${t.type} ${t.amount.toFixed(2)} ${t.category} "${t.description}"${parcela}`;
        })
        .join('\n')
    : '(nenhum)';
  const recurring = ctx.recurring.length
    ? ctx.recurring.map((r, i) => `R${i + 1} ${r.type} ${r.amount.toFixed(2)} ${r.category} "${r.description}" todo dia ${r.dayOfMonth}`).join('\n')
    : '(nenhum)';
  return `Últimos lançamentos:\n${recent}\n\nRecorrentes ativos:\n${recurring}`;
}

export class GeminiAI implements AI {
  constructor(
    private apiKey: string,
    private model: string,
    private fallbackModels: string[] = [],
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async interpret(msg: Parameters<AI['interpret']>[0], ctx: Parameters<AI['interpret']>[1]): Promise<Intent> {
    const parts: any[] = [{ text: `Hoje é ${ctx.weekday}, ${ctx.today}.\n\n${contextText(ctx)}\n\nMensagem do usuário: ${msg.text ?? '(sem texto, veja a mídia anexada)'}` }];
    if (msg.media) parts.push({ inlineData: { mimeType: msg.media.mimeType, data: msg.media.base64 } });

    // Sobrecarga (503/500) é comum no free tier: tenta de novo e, se configurado, cai para outro modelo.
    for (const model of [this.model, ...this.fallbackModels]) {
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        if (attempt > 0) await this.sleep(RETRY_DELAYS_MS[attempt - 1]);
        const res = await this.call(model, parts);
        if (res.status === 503 || res.status === 500) {
          console.warn(`Gemini ${model} sobrecarregado (${res.status}), tentativa ${attempt + 1}`);
          continue;
        }
        if (res.status === 429) throw new QuotaError('Cota do Gemini esgotada');
        if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 500)}`);
        return this.parse(await res.json(), ctx.today);
      }
    }
    throw new BusyError('Gemini sobrecarregado');
  }

  private call(model: string, parts: any[]): Promise<Response> {
    const generationConfig: any = {
      temperature: 0.4,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    };
    // Nos modelos 2.5, desligar o "thinking" deixa a resposta mais rápida e poupa cota.
    if (model.startsWith('gemini-2.5')) generationConfig.thinkingConfig = { thinkingBudget: 0 };

    return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts }],
        generationConfig,
      }),
    });
  }

  private parse(data: any, today: string): Intent {
    const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`Gemini devolveu JSON inválido: ${text.slice(0, 200)}`);
    }
    return toIntent(raw, today);
  }
}
