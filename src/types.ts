export type TxType = 'receita' | 'despesa';

export interface NewTransaction {
  type: TxType;
  amount: number;
  category: string;
  description: string;
  occurredOn: string; // YYYY-MM-DD
  seriesId?: string | null; // parcelas da mesma compra
  installmentNumber?: number | null;
  installmentTotal?: number | null;
  recurringId?: string | null; // lançado automaticamente por um recorrente
}

export interface Transaction extends NewTransaction {
  id: string;
  messageId: string | null;
  createdAt: string;
}

/** Pedido de compra parcelada: valor TOTAL dividido em `installments` meses. */
export interface InstallmentRequest {
  type: TxType;
  total: number;
  installments: number;
  category: string;
  description: string;
  firstDate: string;
}

export interface NewRecurring {
  type: TxType;
  amount: number;
  category: string;
  description: string;
  dayOfMonth: number;
  nextDue: string;
}

export interface Recurring extends NewRecurring {
  id: string;
  userId: string;
  active: boolean;
}

export interface User {
  id: string;
  phone: string; // número/JID da pessoa ou JID do grupo (também é para onde o Bob responde)
  name: string | null;
}

export interface ReportRequest {
  startDate: string;
  endDate: string;
  type: 'todos' | TxType;
  category: string | null;
  label: string;
}

export interface TransactionPatch {
  type?: TxType;
  amount?: number;
  category?: string;
  description?: string;
  occurredOn?: string;
}

export type Intent =
  | { kind: 'registrar'; transactions: NewTransaction[]; installments: InstallmentRequest[]; reply: string }
  | { kind: 'recorrente'; recurring: Omit<NewRecurring, 'nextDue'>; reply: string }
  | { kind: 'relatorio'; report: ReportRequest; reply: string }
  | { kind: 'listar'; limit: number; reply: string }
  | { kind: 'listar_recorrentes'; reply: string }
  | { kind: 'cancelar_recorrente'; ref: number; reply: string }
  | { kind: 'editar'; ref: number; patch: TransactionPatch; reply: string }
  | { kind: 'apagar'; ref: number; reply: string }
  | { kind: 'desfazer'; reply: string }
  | { kind: 'ajuda'; reply: string }
  | { kind: 'conversa'; reply: string };

/** Uma mensagem recebida, já normalizada (independente da Evolution). */
export interface IncomingMessage {
  messageId: string;
  from: string; // quem é o "dono" dos lançamentos (número/JID da pessoa ou do grupo)
  name: string | null;
  text: string | null;
  media: { mimeType: string; base64: string } | null;
}

export interface Store {
  getOrCreateUser(phone: string, name: string | null): Promise<User>;
  /** Retorna false se a mensagem já foi processada antes. */
  markProcessed(messageId: string): Promise<boolean>;
  insertTransactions(userId: string, txs: NewTransaction[], messageId: string | null): Promise<Transaction[]>;
  listTransactions(userId: string, filter: { startDate: string; endDate: string; type?: TxType; category?: string | null }): Promise<Transaction[]>;
  /** Últimos lançamentos já ocorridos (até `today`), mais recentes primeiro. É a lista numerada (#1, #2…). */
  recentTransactions(userId: string, today: string, limit: number): Promise<Transaction[]>;
  /** Apaga os lançamentos da última mensagem registrada e os devolve. */
  deleteLastBatch(userId: string): Promise<Transaction[]>;
  updateTransaction(userId: string, id: string, patch: TransactionPatch): Promise<Transaction | null>;
  /** Apaga um lançamento; se ele for parcela, apaga a compra inteira. */
  deleteTransaction(userId: string, id: string): Promise<Transaction[]>;

  createRecurring(userId: string, r: NewRecurring): Promise<Recurring>;
  listRecurring(userId: string): Promise<Recurring[]>;
  cancelRecurring(userId: string, id: string): Promise<void>;
  setRecurringNextDue(id: string, nextDue: string): Promise<void>;
  /** Recorrentes ativos com next_due <= today (de todos os usuários, para o cron). */
  dueRecurring(today: string): Promise<(Recurring & { user: User })[]>;
  /** Lança um recorrente numa data; devolve null se já tinha sido lançado nessa data. */
  insertRecurringOccurrence(r: Recurring, date: string): Promise<Transaction | null>;
}

export interface InterpretContext {
  today: string;
  weekday: string;
  recent: Transaction[]; // numerados #1, #2… na mesma ordem
  recurring: Recurring[]; // numerados R1, R2…
}

export interface AI {
  interpret(msg: { text: string | null; media: IncomingMessage['media'] }, ctx: InterpretContext): Promise<Intent>;
}
