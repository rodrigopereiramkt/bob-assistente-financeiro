import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { NewRecurring, NewTransaction, Recurring, Store, Transaction, TransactionPatch, TxType, User } from './types.js';

function toTx(row: any): Transaction {
  return {
    id: row.id,
    type: row.type,
    amount: Number(row.amount),
    category: row.category,
    description: row.description ?? '',
    occurredOn: row.occurred_on,
    messageId: row.message_id,
    createdAt: row.created_at,
    seriesId: row.series_id ?? null,
    installmentNumber: row.installment_number ?? null,
    installmentTotal: row.installment_total ?? null,
    recurringId: row.recurring_id ?? null,
  };
}

function toRecurring(row: any): Recurring {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    amount: Number(row.amount),
    category: row.category,
    description: row.description ?? '',
    dayOfMonth: row.day_of_month,
    nextDue: row.next_due,
    active: row.active,
  };
}

function txRow(userId: string, t: NewTransaction, messageId: string | null) {
  return {
    user_id: userId,
    type: t.type,
    amount: t.amount,
    category: t.category,
    description: t.description,
    occurred_on: t.occurredOn,
    message_id: messageId,
    series_id: t.seriesId ?? null,
    installment_number: t.installmentNumber ?? null,
    installment_total: t.installmentTotal ?? null,
    recurring_id: t.recurringId ?? null,
  };
}

export class SupabaseStore implements Store {
  private db: SupabaseClient;

  constructor(url: string, serviceKey: string) {
    this.db = createClient(url, serviceKey, { auth: { persistSession: false } });
  }

  async getOrCreateUser(phone: string, name: string | null): Promise<User> {
    const { data: existing, error: selErr } = await this.db.from('users').select('id, phone, name').eq('phone', phone).maybeSingle();
    if (selErr) throw selErr;
    if (existing) return existing as User;
    const { data, error } = await this.db
      .from('users')
      .upsert({ phone, name }, { onConflict: 'phone' })
      .select('id, phone, name')
      .single();
    if (error) throw error;
    return data as User;
  }

  async markProcessed(messageId: string): Promise<boolean> {
    const { error } = await this.db.from('processed_messages').insert({ message_id: messageId });
    if (!error) return true;
    if (error.code === '23505') return false; // já processada
    throw error;
  }

  async insertTransactions(userId: string, txs: NewTransaction[], messageId: string | null): Promise<Transaction[]> {
    if (txs.length === 0) return [];
    const { data, error } = await this.db.from('transactions').insert(txs.map((t) => txRow(userId, t, messageId))).select('*');
    if (error) throw error;
    return (data ?? []).map(toTx).sort((a, b) => a.occurredOn.localeCompare(b.occurredOn));
  }

  async listTransactions(userId: string, f: { startDate: string; endDate: string; type?: TxType; category?: string | null }): Promise<Transaction[]> {
    let q = this.db
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .gte('occurred_on', f.startDate)
      .lte('occurred_on', f.endDate)
      .order('occurred_on', { ascending: false })
      .limit(5000);
    if (f.type) q = q.eq('type', f.type);
    if (f.category) q = q.eq('category', f.category);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []).map(toTx);
  }

  async recentTransactions(userId: string, today: string, limit: number): Promise<Transaction[]> {
    const { data, error } = await this.db
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .lte('occurred_on', today)
      .order('occurred_on', { ascending: false })
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).map(toTx);
  }

  async deleteLastBatch(userId: string): Promise<Transaction[]> {
    const { data: last, error: lastErr } = await this.db
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastErr) throw lastErr;
    if (!last) return [];
    let q = this.db.from('transactions').delete().eq('user_id', userId);
    q = last.message_id ? q.eq('message_id', last.message_id) : last.series_id ? q.eq('series_id', last.series_id) : q.eq('id', last.id);
    const { data, error } = await q.select('*');
    if (error) throw error;
    return (data ?? []).map(toTx);
  }

  async updateTransaction(userId: string, id: string, p: TransactionPatch): Promise<Transaction | null> {
    const row: Record<string, unknown> = {};
    if (p.type) row.type = p.type;
    if (p.amount != null) row.amount = p.amount;
    if (p.category) row.category = p.category;
    if (p.description) row.description = p.description;
    if (p.occurredOn) row.occurred_on = p.occurredOn;
    const { data, error } = await this.db.from('transactions').update(row).eq('user_id', userId).eq('id', id).select('*').maybeSingle();
    if (error) throw error;
    return data ? toTx(data) : null;
  }

  async deleteTransaction(userId: string, id: string): Promise<Transaction[]> {
    const { data: tx, error: selErr } = await this.db.from('transactions').select('*').eq('user_id', userId).eq('id', id).maybeSingle();
    if (selErr) throw selErr;
    if (!tx) return [];
    let q = this.db.from('transactions').delete().eq('user_id', userId);
    q = tx.series_id ? q.eq('series_id', tx.series_id) : q.eq('id', id);
    const { data, error } = await q.select('*');
    if (error) throw error;
    return (data ?? []).map(toTx).sort((a, b) => a.occurredOn.localeCompare(b.occurredOn));
  }

  async createRecurring(userId: string, r: NewRecurring): Promise<Recurring> {
    const { data, error } = await this.db
      .from('recurring')
      .insert({
        user_id: userId,
        type: r.type,
        amount: r.amount,
        category: r.category,
        description: r.description,
        day_of_month: r.dayOfMonth,
        next_due: r.nextDue,
      })
      .select('*')
      .single();
    if (error) throw error;
    return toRecurring(data);
  }

  async listRecurring(userId: string): Promise<Recurring[]> {
    const { data, error } = await this.db
      .from('recurring')
      .select('*')
      .eq('user_id', userId)
      .eq('active', true)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return (data ?? []).map(toRecurring);
  }

  async cancelRecurring(userId: string, id: string): Promise<void> {
    const { error } = await this.db.from('recurring').update({ active: false }).eq('user_id', userId).eq('id', id);
    if (error) throw error;
  }

  async setRecurringNextDue(id: string, nextDue: string): Promise<void> {
    const { error } = await this.db.from('recurring').update({ next_due: nextDue }).eq('id', id);
    if (error) throw error;
  }

  async dueRecurring(today: string): Promise<(Recurring & { user: User })[]> {
    const { data, error } = await this.db
      .from('recurring')
      .select('*, users(id, phone, name)')
      .eq('active', true)
      .lte('next_due', today)
      .limit(1000);
    if (error) throw error;
    return (data ?? []).map((row: any) => ({ ...toRecurring(row), user: row.users as User }));
  }

  async insertRecurringOccurrence(r: Recurring, date: string): Promise<Transaction | null> {
    const t: NewTransaction = {
      type: r.type,
      amount: r.amount,
      category: r.category,
      description: r.description,
      occurredOn: date,
      recurringId: r.id,
    };
    const { data, error } = await this.db.from('transactions').insert(txRow(r.userId, t, null)).select('*').single();
    if (error?.code === '23505') return null; // já lançado nessa data
    if (error) throw error;
    return toTx(data);
  }
}
