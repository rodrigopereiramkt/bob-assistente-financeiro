import { randomUUID } from 'node:crypto';
import type { NewTransaction, Store, Transaction, TxType, User } from './types.js';

/** Store em memória, para testes e para o simulador de terminal. */
export class MemoryStore implements Store {
  users: User[] = [];
  txs: (Transaction & { userId: string })[] = [];
  processed = new Set<string>();
  private clock = 0;

  async getOrCreateUser(phone: string, name: string | null): Promise<User> {
    let u = this.users.find((x) => x.phone === phone);
    if (!u) this.users.push((u = { id: randomUUID(), phone, name }));
    return u;
  }

  async markProcessed(messageId: string): Promise<boolean> {
    if (this.processed.has(messageId)) return false;
    this.processed.add(messageId);
    return true;
  }

  async insertTransactions(userId: string, txs: NewTransaction[], messageId: string): Promise<Transaction[]> {
    const created = txs.map((t) => ({ ...t, id: randomUUID(), userId, messageId, createdAt: new Date(Date.now() + this.clock++).toISOString() }));
    this.txs.push(...created);
    return created;
  }

  async listTransactions(userId: string, f: { startDate: string; endDate: string; type?: TxType; category?: string | null }): Promise<Transaction[]> {
    return this.txs
      .filter((t) => t.userId === userId && t.occurredOn >= f.startDate && t.occurredOn <= f.endDate)
      .filter((t) => !f.type || t.type === f.type)
      .filter((t) => !f.category || t.category === f.category)
      .sort((a, b) => b.occurredOn.localeCompare(a.occurredOn));
  }

  async lastTransactions(userId: string, limit: number): Promise<Transaction[]> {
    return this.txs
      .filter((t) => t.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async deleteLastBatch(userId: string): Promise<Transaction[]> {
    const [last] = await this.lastTransactions(userId, 1);
    if (!last) return [];
    const removed = this.txs.filter((t) => t.userId === userId && t.messageId === last.messageId);
    this.txs = this.txs.filter((t) => !removed.includes(t));
    return removed;
  }
}
