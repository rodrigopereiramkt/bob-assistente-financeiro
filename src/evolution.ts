import type { IncomingMessage } from './types.js';

export interface EvolutionConfig {
  url: string;
  apiKey: string;
  instance: string;
}

/** Mensagem crua que a Evolution API v2 manda no evento messages.upsert. */
interface RawMessage {
  key?: { remoteJid?: string; remoteJidAlt?: string; senderPn?: string; fromMe?: boolean; id?: string };
  pushName?: string;
  message?: Record<string, any> & { base64?: string };
  messageType?: string;
}

export interface ParsedWebhook {
  message: Omit<IncomingMessage, 'media'>;
  /** Mídia a baixar (áudio/imagem). O base64 vem no payload se "Webhook Base64" estiver ligado. */
  mediaKind: 'audio' | 'image' | null;
  mimeType: string | null;
  inlineBase64: string | null;
  raw: RawMessage;
}

/** Só dígitos do número (sem @s.whatsapp.net). */
export function phoneOf(jid: string): string {
  return jid.split('@')[0].split(':')[0].replace(/\D/g, '');
}

/**
 * Variações de um número brasileiro com e sem o 9º dígito do celular.
 * O WhatsApp costuma identificar celulares antigos sem o 9 (ex.: 551188887777
 * em vez de 5511988887777), então comparamos as duas formas.
 */
export function phoneVariants(phone: string): string[] {
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') return [d, d.slice(0, 4) + d.slice(5)];
  if (d.startsWith('55') && d.length === 12) return [d, d.slice(0, 4) + '9' + d.slice(4)];
  return [d];
}

export function isAllowed(from: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const mine = new Set(phoneVariants(phoneOf(from)));
  return allowed.some((a) => phoneVariants(a).some((v) => mine.has(v)));
}

/**
 * Extrai a mensagem do payload do webhook.
 * Retorna null para eventos que o Bob ignora (grupos, status, mensagens enviadas por ele mesmo etc.).
 */
export function parseWebhook(body: any): ParsedWebhook | null {
  const event = String(body?.event ?? '').toLowerCase().replace('_', '.');
  if (event !== 'messages.upsert') return null;

  const data: RawMessage = Array.isArray(body.data) ? body.data[0] : body.data;
  const key = data?.key;
  if (!key?.id || !key.remoteJid || key.fromMe) return null;
  if (key.remoteJid.endsWith('@g.us') || key.remoteJid.endsWith('@broadcast') || key.remoteJid.endsWith('@newsletter')) return null;

  // Contas novas do WhatsApp podem chegar como @lid; o número real vem em remoteJidAlt/senderPn.
  let from = key.remoteJid;
  if (from.endsWith('@lid')) from = key.remoteJidAlt || key.senderPn || from;

  const m = data.message ?? {};
  const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m;
  let text: string | null = inner.conversation ?? inner.extendedTextMessage?.text ?? null;
  let mediaKind: ParsedWebhook['mediaKind'] = null;
  let mimeType: string | null = null;

  if (inner.audioMessage) {
    mediaKind = 'audio';
    mimeType = inner.audioMessage.mimetype ?? 'audio/ogg';
  } else if (inner.imageMessage) {
    mediaKind = 'image';
    mimeType = inner.imageMessage.mimetype ?? 'image/jpeg';
    text = inner.imageMessage.caption ?? null;
  } else if (inner.documentMessage?.mimetype?.startsWith('image/') || inner.documentMessage?.mimetype === 'application/pdf') {
    mediaKind = 'image';
    mimeType = inner.documentMessage.mimetype;
    text = inner.documentMessage.caption ?? null;
  }

  if (!text && !mediaKind) return null;

  return {
    message: { messageId: key.id, from, name: data.pushName ?? null, text },
    mediaKind,
    mimeType,
    inlineBase64: m.base64 ?? null,
    raw: data,
  };
}

export class EvolutionClient {
  constructor(private cfg: EvolutionConfig) {}

  private async call(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.cfg.url}${path}/${encodeURIComponent(this.cfg.instance)}`, {
      method: 'POST',
      // ngrok-skip-browser-warning: evita a página de aviso do ngrok free quando a Evolution está atrás de um túnel.
      headers: { 'Content-Type': 'application/json', apikey: this.cfg.apiKey, 'ngrok-skip-browser-warning': 'true' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Evolution ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json().catch(() => ({}));
  }

  async sendText(to: string, text: string): Promise<void> {
    const number = to.endsWith('@s.whatsapp.net') ? phoneOf(to) : to;
    await this.call('/message/sendText', { number, text });
  }

  /** Mostra "digitando..." enquanto o Bob pensa. Falhas aqui são ignoradas. */
  async typing(to: string): Promise<void> {
    const number = to.endsWith('@s.whatsapp.net') ? phoneOf(to) : to;
    await this.call('/chat/sendPresence', { number, presence: 'composing', delay: 3000 }).catch(() => {});
  }

  async getMediaBase64(raw: RawMessage): Promise<{ base64: string; mimeType: string | null }> {
    const res = await this.call('/chat/getBase64FromMediaMessage', { message: { key: { id: raw.key?.id } }, convertToMp4: false });
    if (!res?.base64) throw new Error('Evolution não devolveu a mídia');
    return { base64: res.base64, mimeType: res.mimetype ?? null };
  }
}
