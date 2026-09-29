export type TxType = 'receita' | 'despesa';

export interface NewTransaction {
  type: TxType;
  amount: number;
  category: string;
  description: string;
  occurredOn: string; // YYYY-MM-DD
}

export interface Transaction extends NewTransaction {
  id: string;
  messageId: string | null;
  createdAt: string;
}

export interface User {
  id: string;
  phone: string;
  name: string | null;
}

export interface ReportRequest {
  startDate: string;
  endDate: string;
  type: 'todos' | TxType;
  category: string | null;
  label: string;
}

export type Intent =
  | { kind: 'registrar'; transactions: NewTransaction[]; reply: string }
  | { kind: 'relatorio'; report: ReportRequest; reply: string }
  | { kind: 'listar'; limit: number; reply: string }
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
  insertTransactions(userId: string, txs: NewTransaction[], messageId: string): Promise<Transaction[]>;
  listTransactions(userId: string, filter: { startDate: string; endDate: string; type?: TxType; category?: string | null }): Promise<Transaction[]>;
  lastTransactions(userId: string, limit: number): Promise<Transaction[]>;
  /** Apaga os lançamentos da última mensagem registrada e os devolve. */
  deleteLastBatch(userId: string): Promise<Transaction[]>;
}

export interface AI {
  interpret(msg: { text: string | null; media: IncomingMessage['media'] }, ctx: { today: string; weekday: string }): Promise<Intent>;
}
