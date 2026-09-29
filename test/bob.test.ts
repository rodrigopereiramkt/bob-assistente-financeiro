import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleMessage, materializeDue, splitInstallments } from '../src/bob.js';
import { monthlyDate, nextMonthlyOnOrAfter } from '../src/dates.js';
import { isAllowed, isAllowedGroup, parseWebhook } from '../src/evolution.js';
import { BusyError, GeminiAI, QuotaError, toIntent } from '../src/gemini.js';
import { MemoryStore } from '../src/store-memory.js';
import type { AI, Intent, InterpretContext } from '../src/types.js';

const NOW = () => new Date('2026-09-28T15:00:00Z');
const tz = 'America/Sao_Paulo';

function fakeAI(map: Record<string, Intent>): AI & { calls: number } {
  return {
    calls: 0,
    async interpret(msg) {
      this.calls++;
      const intent = map[msg.text ?? ''];
      if (!intent) throw new Error(`sem resposta fake para ${msg.text}`);
      return intent;
    },
  };
}

const msg = (id: string, text: string) => ({ messageId: id, from: '5511999999999@s.whatsapp.net', name: 'Mi', text, media: null });

describe('toIntent (validação da saída do Gemini)', () => {
  it('normaliza valores, categorias e datas', () => {
    const i = toIntent(
      { intent: 'registrar', reply: 'ok', transactions: [
        { type: 'despesa', amount: '23.905', category: 'alimentação', description: 'iFood', date: '2026-09-27' },
        { type: 'receita', amount: 3000, category: 'Inventada', description: '', date: 'ontem' },
        { type: 'despesa', amount: -5, category: 'Lazer', description: 'x', date: '2026-09-27' },
      ] },
      '2026-09-28',
    );
    expect(i.kind).toBe('registrar');
    if (i.kind !== 'registrar') return;
    expect(i.transactions).toHaveLength(2);
    expect(i.transactions[0]).toMatchObject({ amount: 23.91, category: 'Alimentação', occurredOn: '2026-09-27' });
    expect(i.transactions[1]).toMatchObject({ type: 'receita', category: 'Outros', occurredOn: '2026-09-28', description: 'Sem descrição' });
  });

  it('registrar sem valor vira conversa', () => {
    expect(toIntent({ intent: 'registrar', transactions: [], reply: '' }, '2026-09-28').kind).toBe('conversa');
  });

  it('relatório sem datas usa o mês atual', () => {
    const i = toIntent({ intent: 'relatorio', reply: '', report: { type: 'despesa', label: 'este mês' } }, '2026-09-28');
    expect(i).toMatchObject({ kind: 'relatorio', report: { startDate: '2026-09-01', endDate: '2026-09-28', type: 'despesa', category: null } });
  });
});

describe('handleMessage', () => {
  it('registra, gera relatório e desfaz', async () => {
    const store = new MemoryStore();
    const ai = fakeAI({
      'uber 20 e mercado 80': { kind: 'registrar', reply: 'Anotado, chefe!', transactions: [
        { type: 'despesa', amount: 20, category: 'Transporte', description: 'Uber', occurredOn: '2026-09-28' },
        { type: 'despesa', amount: 80, category: 'Mercado', description: 'Mercado', occurredOn: '2026-09-27' },
      ], installments: [] },
      'recebi 1000': { kind: 'registrar', reply: '', installments: [], transactions: [
        { type: 'receita', amount: 1000, category: 'Freelance', description: 'Freela', occurredOn: '2026-09-10' },
      ] },
      'resumo do mês': { kind: 'relatorio', reply: '', report: { startDate: '2026-09-01', endDate: '2026-09-28', type: 'todos', category: null, label: 'setembro de 2026' } },
    });
    const deps = { store, ai, timezone: tz, now: NOW };

    const r1 = await handleMessage(msg('1', 'uber 20 e mercado 80'), deps);
    expect(r1).toContain('Anotei 2 lançamentos');
    expect(r1).toContain('R$ 20,00');
    await handleMessage(msg('2', 'recebi 1000'), deps);

    const report = await handleMessage(msg('3', 'resumo do mês'), deps);
    expect(report).toContain('Receitas: *R$ 1.000,00*');
    expect(report).toContain('Despesas: *R$ 100,00*');
    expect(report).toContain('Saldo: *R$ 900,00*');
    expect(report).toContain('🛒 Mercado: R$ 80,00 (80%)');

    const undo = await handleMessage(msg('4', 'desfaz'), deps);
    expect(undo).toContain('R$ 1.000,00');
    expect(store.txs).toHaveLength(2);
    expect(ai.calls).toBe(3); // "desfaz" não gastou cota
  });

  it('ignora mensagem duplicada', async () => {
    const store = new MemoryStore();
    const ai = fakeAI({ oi: { kind: 'conversa', reply: 'Olá!' } });
    const deps = { store, ai, timezone: tz, now: NOW };
    expect(await handleMessage(msg('x', 'oi'), deps)).toBe('Olá!');
    expect(await handleMessage(msg('x', 'oi'), deps)).toBeNull();
  });

  it('responde com bom humor quando a cota do Gemini acaba', async () => {
    const ai: AI = { interpret: async () => { throw new QuotaError('429'); } };
    const r = await handleMessage(msg('q', 'gastei 10'), { store: new MemoryStore(), ai, timezone: tz, now: NOW });
    expect(r).toContain('limite');
  });

  it('ajuda não chama o Gemini', async () => {
    const ai = fakeAI({});
    const r = await handleMessage(msg('h', 'ajuda'), { store: new MemoryStore(), ai, timezone: tz, now: NOW });
    expect(r).toContain('Bob');
    expect(ai.calls).toBe(0);
  });
});

describe('parseWebhook (Evolution v2)', () => {
  const base = { event: 'messages.upsert', instance: 'bob' };

  it('extrai texto', () => {
    const p = parseWebhook({ ...base, data: { key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false, id: 'ABC' }, pushName: 'Mi', message: { conversation: 'gastei 10' } } });
    expect(p?.message).toEqual({ messageId: 'ABC', from: '5511999999999@s.whatsapp.net', name: 'Mi', text: 'gastei 10' });
  });

  it('aceita MESSAGES_UPSERT e extendedTextMessage', () => {
    const p = parseWebhook({ event: 'MESSAGES_UPSERT', data: { key: { remoteJid: '55@s.whatsapp.net', id: '1' }, message: { extendedTextMessage: { text: 'oi' } } } });
    expect(p?.message.text).toBe('oi');
  });

  it('detecta áudio e imagem com legenda', () => {
    const a = parseWebhook({ ...base, data: { key: { remoteJid: '55@s.whatsapp.net', id: '1' }, message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus' }, base64: 'AAA' } } });
    expect(a).toMatchObject({ mediaKind: 'audio', inlineBase64: 'AAA' });
    const i = parseWebhook({ ...base, data: { key: { remoteJid: '55@s.whatsapp.net', id: '2' }, message: { imageMessage: { caption: 'almoço' } } } });
    expect(i).toMatchObject({ mediaKind: 'image', message: { text: 'almoço' } });
  });

  it('usa o número real quando vem @lid', () => {
    const p = parseWebhook({ ...base, data: { key: { remoteJid: '123@lid', remoteJidAlt: '5511888888888@s.whatsapp.net', id: '1' }, message: { conversation: 'oi' } } });
    expect(p?.message.from).toBe('5511888888888@s.whatsapp.net');
  });

  it('lê mensagens de grupo com o participante como autor', () => {
    const p = parseWebhook({ ...base, data: { key: { remoteJid: '120363@g.us', participant: '123@lid', participantAlt: '553899565367@s.whatsapp.net', id: 'g1' }, pushName: 'Mi', message: { conversation: 'gastei 10' } } });
    expect(p).toMatchObject({ chatId: '120363@g.us', groupId: '120363@g.us', message: { from: '553899565367@s.whatsapp.net', text: 'gastei 10' } });
    expect(isAllowedGroup('120363@g.us', ['120363'])).toBe(true);
    expect(isAllowedGroup('120363@g.us', ['999@g.us'])).toBe(false);
  });

  it('ignora mensagens próprias e outros eventos', () => {
    expect(parseWebhook({ ...base, data: { key: { remoteJid: '55@s.whatsapp.net', fromMe: true, id: '1' }, message: { conversation: 'x' } } })).toBeNull();
    expect(parseWebhook({ event: 'connection.update', data: {} })).toBeNull();
  });
});

describe('isAllowed', () => {
  it('aceita número com ou sem o 9º dígito', () => {
    expect(isAllowed('551188887777@s.whatsapp.net', ['5511988887777'])).toBe(true);
    expect(isAllowed('5511988887777@s.whatsapp.net', ['551188887777'])).toBe(true);
    expect(isAllowed('5511988887777@s.whatsapp.net', ['5511988887777'])).toBe(true);
    expect(isAllowed('5511977776666@s.whatsapp.net', ['5511988887777'])).toBe(false);
    expect(isAllowed('qualquer@s.whatsapp.net', [])).toBe(true);
  });
});

describe('GeminiAI (novas tentativas)', () => {
  afterEach(() => vi.unstubAllGlobals());
  const ok = { candidates: [{ content: { parts: [{ text: JSON.stringify({ intent: 'conversa', reply: 'Oi!' }) }] } }] };
  const ctx = { today: '2026-09-28', weekday: 'segunda-feira', recent: [], recurring: [] };
  const noSleep = async () => {};

  it('tenta de novo quando o modelo está sobrecarregado', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(ok), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await new GeminiAI('k', 'm1', [], noSleep).interpret({ text: 'oi', media: null }, ctx);
    expect(r).toEqual({ kind: 'conversa', reply: 'Oi!' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cai para o modelo reserva e depois desiste com BusyError', async () => {
    const fetchMock = vi.fn(async () => new Response('busy', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(new GeminiAI('k', 'm1', ['m2'], noSleep).interpret({ text: 'oi', media: null }, ctx)).rejects.toBeInstanceOf(BusyError);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(String((fetchMock.mock.calls as any[])[5][0])).toContain('/models/m2:');
  });
});

it('avisa com bom humor quando o Gemini está sobrecarregado', async () => {
  const ai: AI = { interpret: async () => { throw new BusyError('503'); } };
  const r = await handleMessage(msg('b', 'gastei 10'), { store: new MemoryStore(), ai, timezone: tz, now: NOW });
  expect(r).toContain('congestionado');
});

describe('datas mensais', () => {
  it('avança meses e respeita o fim do mês', () => {
    expect(monthlyDate('2026-09-29', 1)).toBe('2026-10-29');
    expect(monthlyDate('2026-01-31', 1)).toBe('2026-02-28');
    expect(monthlyDate('2026-02-28', 1, 31)).toBe('2026-03-31');
    expect(monthlyDate('2026-11-15', 3)).toBe('2027-02-15');
    expect(nextMonthlyOnOrAfter('2026-09-29', 5)).toBe('2026-10-05');
    expect(nextMonthlyOnOrAfter('2026-09-29', 30)).toBe('2026-09-30');
    expect(nextMonthlyOnOrAfter('2026-09-29', 29)).toBe('2026-09-29');
  });
});

describe('toIntent (novas funções)', () => {
  it('separa compra parcelada', () => {
    const i = toIntent({ intent: 'registrar', reply: '', transactions: [
      { type: 'despesa', amount: 2400, category: 'Casa', description: 'TV', date: '2026-09-28', installments: 10 },
      { type: 'despesa', amount: 30, category: 'Alimentação', description: 'Almoço', date: '2026-09-28', installments: 1 },
    ] }, '2026-09-28');
    expect(i).toMatchObject({ kind: 'registrar', transactions: [{ description: 'Almoço' }], installments: [{ total: 2400, installments: 10, firstDate: '2026-09-28' }] });
  });

  it('recorrente sem dia usa o dia de hoje', () => {
    const i = toIntent({ intent: 'recorrente', reply: '', recurring: { type: 'despesa', amount: 55.9, category: 'Assinaturas', description: 'Netflix', day_of_month: null } }, '2026-09-28');
    expect(i).toMatchObject({ kind: 'recorrente', recurring: { dayOfMonth: 28, amount: 55.9 } });
  });

  it('editar sem nada para mudar vira pergunta', () => {
    expect(toIntent({ intent: 'editar', ref: 2, patch: { amount: null }, reply: '' }, '2026-09-28').kind).toBe('conversa');
    expect(toIntent({ intent: 'editar', ref: 2, patch: { amount: 45, date: 'ontem' }, reply: '' }, '2026-09-28')).toMatchObject({ kind: 'editar', ref: 2, patch: { amount: 45 } });
  });
});

describe('parcelados, recorrentes e edição', () => {
  const noopAI = (map: Record<string, Intent>, seen: InterpretContext[] = []): AI => ({
    async interpret(m, ctx) {
      seen.push(ctx);
      const intent = map[m.text ?? ''];
      if (!intent) throw new Error(`sem resposta fake para ${m.text}`);
      return intent;
    },
  });

  it('divide o parcelado em meses, com os centavos na 1ª parcela', () => {
    const parts = splitInstallments({ type: 'despesa', total: 100, installments: 3, category: 'Casa', description: 'Cadeira', firstDate: '2026-01-31' });
    expect(parts.map((p) => p.amount)).toEqual([33.34, 33.33, 33.33]);
    expect(parts.map((p) => p.occurredOn)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(new Set(parts.map((p) => p.seriesId)).size).toBe(1);
  });

  it('registra parcelado e "desfaz" apaga todas as parcelas', async () => {
    const store = new MemoryStore();
    const ai = noopAI({ 'tv 2400 em 10x': { kind: 'registrar', reply: '', transactions: [], installments: [
      { type: 'despesa', total: 2400, installments: 10, category: 'Casa', description: 'TV', firstDate: '2026-09-28' },
    ] } });
    const deps = { store, ai, timezone: tz, now: NOW };
    const r = await handleMessage(msg('p1', 'tv 2400 em 10x'), deps);
    expect(r).toContain('em 10x de R$ 240,00, de 28/09 a 28/06/27');
    expect(store.txs).toHaveLength(10);
    await handleMessage(msg('p2', 'desfaz'), deps);
    expect(store.txs).toHaveLength(0);
  });

  it('recorrente no dia de hoje já lança; os vencidos são lançados uma vez só', async () => {
    const store = new MemoryStore();
    const ai = noopAI({
      'aluguel 1500 todo dia 28': { kind: 'recorrente', reply: '', recurring: { type: 'despesa', amount: 1500, category: 'Moradia', description: 'Aluguel', dayOfMonth: 28 } },
      oi: { kind: 'conversa', reply: 'Oi!' },
    });
    const r = await handleMessage(msg('r1', 'aluguel 1500 todo dia 28'), { store, ai, timezone: tz, now: NOW });
    expect(r).toContain('Já lancei o de hoje');
    expect(r).toContain('Próximo: 28/10');
    expect(store.txs).toHaveLength(1);

    // Dois meses depois, sem cron: lança outubro e novembro na próxima mensagem.
    const later = () => new Date('2026-11-29T15:00:00Z');
    const r2 = await handleMessage(msg('r2', 'oi'), { store, ai, timezone: tz, now: later });
    expect(r2).toContain('Lancei os recorrentes do dia');
    expect(store.txs.map((t) => t.occurredOn).sort()).toEqual(['2026-09-28', '2026-10-28', '2026-11-28']);
    expect(store.recurring[0].nextDue).toBe('2026-12-28');

    // Idempotente: rodar de novo (ex.: cron e mensagem juntos) não duplica.
    await materializeDue(store, { ...store.recurring[0], nextDue: '2026-10-28' }, '2026-11-29');
    expect(store.txs).toHaveLength(3);
  });

  it('recorrente de outro dia fica para depois; dá pra listar e cancelar', async () => {
    const store = new MemoryStore();
    const ai = noopAI({
      'netflix todo dia 5': { kind: 'recorrente', reply: '', recurring: { type: 'despesa', amount: 55.9, category: 'Assinaturas', description: 'Netflix', dayOfMonth: 5 } },
      'meus recorrentes': { kind: 'listar_recorrentes', reply: '' },
      'cancela a netflix': { kind: 'cancelar_recorrente', ref: 1, reply: '' },
    });
    const deps = { store, ai, timezone: tz, now: NOW };
    expect(await handleMessage(msg('n1', 'netflix todo dia 5'), deps)).toContain('Próximo: 05/10');
    expect(store.txs).toHaveLength(0);
    expect(await handleMessage(msg('n2', 'meus recorrentes'), deps)).toContain('*R1* 🔴 -R$ 55,90');
    expect(await handleMessage(msg('n3', 'cancela a netflix'), deps)).toContain('Recorrente cancelado');
    expect(await store.listRecurring(store.users[0].id)).toHaveLength(0);
  });

  it('lista numerada, edita e apaga pelo número', async () => {
    const store = new MemoryStore();
    const seen: InterpretContext[] = [];
    const ai = noopAI({
      'almoço 25 e uber 20': { kind: 'registrar', reply: '', installments: [], transactions: [
        { type: 'despesa', amount: 25, category: 'Alimentação', description: 'Almoço', occurredOn: '2026-09-27' },
        { type: 'despesa', amount: 20, category: 'Transporte', description: 'Uber', occurredOn: '2026-09-28' },
      ] },
      lista: { kind: 'listar', limit: 10, reply: '' },
      'o almoço foi 30': { kind: 'editar', ref: 2, patch: { amount: 30 }, reply: '' },
      'apaga o #1': { kind: 'apagar', ref: 1, reply: '' },
      'apaga o #9': { kind: 'apagar', ref: 9, reply: '' },
    }, seen);
    const deps = { store, ai, timezone: tz, now: NOW };
    await handleMessage(msg('e1', 'almoço 25 e uber 20'), deps);

    const list = await handleMessage(msg('e2', 'lista'), deps);
    expect(list).toContain('*#1* 🔴 -R$ 20,00 · 28/09');
    expect(list).toContain('*#2* 🔴 -R$ 25,00 · 27/09');
    expect(seen.at(-1)!.recent.map((t) => t.description)).toEqual(['Uber', 'Almoço']);

    const edited = await handleMessage(msg('e3', 'o almoço foi 30'), deps);
    expect(edited).toContain('Valor: ~R$ 25,00~ → *R$ 30,00*');
    expect(store.txs.find((t) => t.description === 'Almoço')!.amount).toBe(30);

    expect(await handleMessage(msg('e4', 'apaga o #1'), deps)).toContain('Apagado');
    expect(store.txs.map((t) => t.description)).toEqual(['Almoço']);
    expect(await handleMessage(msg('e5', 'apaga o #9'), deps)).toContain('Não achei');
  });

  it('apagar uma parcela apaga a compra inteira', async () => {
    const store = new MemoryStore();
    const ai = noopAI({
      'sofá 3000 em 3x': { kind: 'registrar', reply: '', transactions: [], installments: [
        { type: 'despesa', total: 3000, installments: 3, category: 'Casa', description: 'Sofá', firstDate: '2026-09-28' },
      ] },
      'apaga o sofá': { kind: 'apagar', ref: 1, reply: '' },
    });
    const deps = { store, ai, timezone: tz, now: NOW };
    await handleMessage(msg('s1', 'sofá 3000 em 3x'), deps);
    expect(await handleMessage(msg('s2', 'apaga o sofá'), deps)).toContain('compra parcelada inteira');
    expect(store.txs).toHaveLength(0);
  });
});
