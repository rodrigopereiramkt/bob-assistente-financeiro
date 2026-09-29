import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { NewTransaction, Store, Transaction, TxType, User } from './types.js';

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

  async insertTransactions(userId: string, txs: NewTransaction[], messageId: string): Promise<Transaction[]> {
    const rows = txs.map((t) => ({
      user_id: userId,
      type: t.type,
      amount: t.amount,
      category: t.category,
      description: t.description,
      occurred_on: t.occurredOn,
      message_id: messageId,
    }));
    const { data, error } = await this.db.from('transactions').insert(rows).select('*');
    if (error) throw error;
    return (data ?? []).map(toTx);
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

  async lastTransactions(userId: string, limit: number): Promise<Transaction[]> {
    const { data, error } = await this.db
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).map(toTx);
  }

  async deleteLastBatch(userId: string): Promise<Transaction[]> {
    const [last] = await this.lastTransactions(userId, 1);
    if (!last) return [];
    let q = this.db.from('transactions').delete().eq('user_id', userId);
    q = last.messageId ? q.eq('message_id', last.messageId) : q.eq('id', last.id);
    const { data, error } = await q.select('*');
    if (error) throw error;
    return (data ?? []).map(toTx);
  }
}
