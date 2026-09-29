import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleMessage } from '../src/bob.js';
import { isAllowed, isAllowedGroup, parseWebhook } from '../src/evolution.js';
import { BusyError, GeminiAI, QuotaError, toIntent } from '../src/gemini.js';
import { MemoryStore } from '../src/store-memory.js';
import type { AI, Intent } from '../src/types.js';

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
      ] },
      'recebi 1000': { kind: 'registrar', reply: '', transactions: [
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
  const ctx = { today: '2026-09-28', weekday: 'segunda-feira' };
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
