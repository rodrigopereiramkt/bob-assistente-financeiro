import { ALL_CATEGORIES, EXPENSE_CATEGORIES, INCOME_CATEGORIES, normalizeCategory } from './categories.js';
import { isValidDate, startOfMonth } from './dates.js';
import type { AI, Intent, NewTransaction } from './types.js';

export class QuotaError extends Error {}

const SYSTEM_PROMPT = `Você é o Bob, um assistente financeiro pessoal no WhatsApp, brasileiro, prático e bem-humorado.
Sua tarefa é interpretar a mensagem do usuário e devolver SOMENTE o JSON no schema pedido.

Intenções (campo "intent"):
- "registrar": o usuário informa um ou mais gastos ou ganhos ("gastei 50 no mercado", "recebi 3000 de salário", "uber 23,90 e ifood 45"). Preencha "transactions" com um item por lançamento.
- "relatorio": o usuário quer saber quanto gastou/recebeu, saldo, resumo, gastos por categoria em um período ("quanto gastei esse mês?", "resumo da semana", "quanto foi de ifood em agosto?"). Preencha "report".
- "listar": quer ver os últimos lançamentos ("mostra meus últimos gastos"). Preencha "limit" (padrão 10, máx 30).
- "desfazer": quer apagar/cancelar o último lançamento ("apaga o último", "errei, desfaz").
- "ajuda": pergunta o que você faz ou como usar.
- "conversa": qualquer outra coisa (saudação, dúvida de finanças, papo). Responda em "reply".

Regras para "transactions":
- "type": "despesa" para gastos/pagamentos/compras; "receita" para ganhos/salário/recebimentos/vendas.
- "amount": número positivo em reais, ponto como separador decimal ("23,90" -> 23.9; "1.200" -> 1200; "2k" -> 2000; "cinquenta" -> 50).
- "category": despesas usam uma de [${EXPENSE_CATEGORIES.join(', ')}]; receitas usam uma de [${INCOME_CATEGORIES.join(', ')}]. iFood/restaurante/lanche = Alimentação; Uber/gasolina/ônibus = Transporte; Netflix/Spotify = Assinaturas; aluguel/condomínio = Moradia; luz/água/internet/celular = Contas.
- "description": curta, com a primeira letra maiúscula (ex.: "iFood", "Mercado", "Salário").
- "date": YYYY-MM-DD. Use a data de hoje se não for dita. Resolva "ontem", "sexta", "dia 5" em relação a hoje (nunca no futuro, exceto se o usuário disser explicitamente).
- Se a mensagem for uma foto de nota fiscal/comprovante, registre o total como despesa (ou receita, se for um comprovante recebido).
- Se não houver valor claro, use "conversa" e pergunte o valor em "reply".

Regras para "report":
- "start_date" e "end_date" inclusivos em YYYY-MM-DD. Sem período citado = mês atual (do dia 1 até hoje).
- "type": "todos", "despesa" ou "receita".
- "category": uma das categorias acima se o usuário perguntou de uma categoria específica, senão null.
- "label": nome amigável do período ("setembro de 2026", "esta semana", "hoje").

"reply": sempre em português do Brasil, curto (1 ou 2 frases), divertido e leve, sem ser forçado, pode usar 1 emoji.
- Em "registrar": um comentário espirituoso sobre o lançamento (não repita os valores, o sistema já mostra).
- Em "relatorio" e "listar": uma frase curta de abertura.
- Em "conversa" e "ajuda": a resposta completa. Para dúvidas de finanças dê dicas práticas e responsáveis; não recomende investimentos específicos.`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    intent: { type: 'STRING', enum: ['registrar', 'relatorio', 'listar', 'desfazer', 'ajuda', 'conversa'] },
    transactions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          type: { type: 'STRING', enum: ['receita', 'despesa'] },
          amount: { type: 'NUMBER' },
          category: { type: 'STRING', enum: ALL_CATEGORIES },
          description: { type: 'STRING' },
          date: { type: 'STRING' },
        },
        required: ['type', 'amount', 'category', 'description', 'date'],
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

/** Valida e normaliza o JSON do modelo para um Intent seguro. */
export function toIntent(raw: any, today: string): Intent {
  const reply = typeof raw?.reply === 'string' ? raw.reply.trim() : '';
  switch (raw?.intent) {
    case 'registrar': {
      const txs: NewTransaction[] = (Array.isArray(raw.transactions) ? raw.transactions : [])
        .map((t: any): NewTransaction | null => {
          const amount = Math.round(Number(t?.amount) * 100) / 100;
          if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) return null;
          return {
            type: t?.type === 'receita' ? 'receita' : 'despesa',
            amount,
            category: normalizeCategory(t?.category),
            description: String(t?.description ?? '').trim().slice(0, 120) || 'Sem descrição',
            occurredOn: isValidDate(t?.date) ? t.date : today,
          };
        })
        .filter(Boolean) as NewTransaction[];
      if (txs.length === 0) {
        return { kind: 'conversa', reply: reply || 'Não peguei o valor 🤔 Me manda tipo: "gastei 35 no almoço".' };
      }
      return { kind: 'registrar', transactions: txs, reply };
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
      const limit = Math.min(Math.max(Number.parseInt(raw.limit, 10) || 10, 1), 30);
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

export class GeminiAI implements AI {
  constructor(private apiKey: string, private model: string) {}

  async interpret(msg: Parameters<AI['interpret']>[0], ctx: Parameters<AI['interpret']>[1]): Promise<Intent> {
    const parts: any[] = [{ text: `Hoje é ${ctx.weekday}, ${ctx.today}.\nMensagem do usuário: ${msg.text ?? '(sem texto, veja a mídia anexada)'}` }];
    if (msg.media) parts.push({ inlineData: { mimeType: msg.media.mimeType, data: msg.media.base64 } });

    const generationConfig: any = {
      temperature: 0.4,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    };
    // Nos modelos 2.5, desligar o "thinking" deixa a resposta mais rápida e poupa cota.
    if (this.model.startsWith('gemini-2.5')) generationConfig.thinkingConfig = { thinkingBudget: 0 };

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts }],
        generationConfig,
      }),
    });

    if (res.status === 429) throw new QuotaError('Cota do Gemini esgotada');
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 500)}`);

    const data: any = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? '';
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new Error(`Gemini devolveu JSON inválido: ${text.slice(0, 200)}`);
    }
    return toIntent(raw, ctx.today);
  }
}
