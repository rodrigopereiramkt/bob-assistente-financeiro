import { randomUUID } from 'node:crypto';
import type { NewRecurring, NewTransaction, Recurring, Store, Transaction, TransactionPatch, TxType, User } from './types.js';

type Row = Transaction & { userId: string };

/** Store em memória, para testes e para o simulador de terminal. */
export class MemoryStore implements Store {
  users: User[] = [];
  txs: Row[] = [];
  recurring: Recurring[] = [];
  processed = new Set<string>();
  private clock = 0;

  private stamp(): string {
    return new Date(Date.UTC(2026, 0, 1) + this.clock++).toISOString();
  }

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

  async insertTransactions(userId: string, txs: NewTransaction[], messageId: string | null): Promise<Transaction[]> {
    const createdAt = this.stamp();
    const created: Row[] = txs.map((t) => ({ ...t, id: randomUUID(), userId, messageId, createdAt }));
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

  async recentTransactions(userId: string, today: string, limit: number): Promise<Transaction[]> {
    return this.txs
      .filter((t) => t.userId === userId && t.occurredOn <= today)
      .sort((a, b) => b.occurredOn.localeCompare(a.occurredOn) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  async deleteLastBatch(userId: string): Promise<Transaction[]> {
    const last = this.txs.filter((t) => t.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!last) return [];
    const same = (t: Row) =>
      last.messageId ? t.messageId === last.messageId : last.seriesId ? t.seriesId === last.seriesId : t.id === last.id;
    const removed = this.txs.filter((t) => t.userId === userId && same(t));
    this.txs = this.txs.filter((t) => !removed.includes(t));
    return removed;
  }

  async updateTransaction(userId: string, id: string, p: TransactionPatch): Promise<Transaction | null> {
    const t = this.txs.find((x) => x.userId === userId && x.id === id);
    if (!t) return null;
    Object.assign(t, Object.fromEntries(Object.entries(p).filter(([, v]) => v != null)));
    return t;
  }

  async deleteTransaction(userId: string, id: string): Promise<Transaction[]> {
    const t = this.txs.find((x) => x.userId === userId && x.id === id);
    if (!t) return [];
    const removed = this.txs.filter((x) => x.userId === userId && (t.seriesId ? x.seriesId === t.seriesId : x.id === id));
    this.txs = this.txs.filter((x) => !removed.includes(x));
    return removed.sort((a, b) => a.occurredOn.localeCompare(b.occurredOn));
  }

  async createRecurring(userId: string, r: NewRecurring): Promise<Recurring> {
    const rec: Recurring = { ...r, id: randomUUID(), userId, active: true };
    this.recurring.push(rec);
    return rec;
  }

  async listRecurring(userId: string): Promise<Recurring[]> {
    return this.recurring.filter((r) => r.userId === userId && r.active);
  }

  async cancelRecurring(userId: string, id: string): Promise<void> {
    const r = this.recurring.find((x) => x.userId === userId && x.id === id);
    if (r) r.active = false;
  }

  async setRecurringNextDue(id: string, nextDue: string): Promise<void> {
    const r = this.recurring.find((x) => x.id === id);
    if (r) r.nextDue = nextDue;
  }

  async dueRecurring(today: string): Promise<(Recurring & { user: User })[]> {
    return this.recurring
      .filter((r) => r.active && r.nextDue <= today)
      .map((r) => ({ ...r, user: this.users.find((u) => u.id === r.userId)! }));
  }

  async insertRecurringOccurrence(r: Recurring, date: string): Promise<Transaction | null> {
    if (this.txs.some((t) => t.recurringId === r.id && t.occurredOn === date)) return null;
    const [t] = await this.insertTransactions(
      r.userId,
      [{ type: r.type, amount: r.amount, category: r.category, description: r.description, occurredOn: date, recurringId: r.id }],
      null,
    );
    return t;
  }
}
