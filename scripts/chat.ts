/**
 * Converse com o Bob no terminal, sem WhatsApp.
 * Usa o Gemini de verdade (GEMINI_API_KEY) e guarda os lançamentos em memória
 * (ou no Supabase, se SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY estiverem definidos).
 *
 *   GEMINI_API_KEY=... npm run chat
 */
import { createInterface } from 'node:readline/promises';
import { handleMessage } from '../src/bob.js';
import { GeminiAI } from '../src/gemini.js';
import { MemoryStore } from '../src/store-memory.js';
import { SupabaseStore } from '../src/store-supabase.js';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('Defina GEMINI_API_KEY (pegue em https://aistudio.google.com/apikey).');
  process.exit(1);
}

const store =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? new SupabaseStore(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : new MemoryStore();
const ai = new GeminiAI(apiKey, process.env.GEMINI_MODEL || 'gemini-3.8-flash');
const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log(`Bob no terminal (${store instanceof MemoryStore ? 'memória' : 'Supabase'}). Digite "sair" para encerrar.\n`);
let n = 0;
for (;;) {
  const text = await rl.question('você> ');
  if (text.trim().toLowerCase() === 'sair') break;
  try {
    const reply = await handleMessage(
      { messageId: `local-${Date.now()}-${n++}`, from: 'terminal', name: 'Você', text, media: null },
      { store, ai, timezone: process.env.TIMEZONE || 'America/Sao_Paulo' },
    );
    console.log(`\nbob> ${reply ?? '(sem resposta)'}\n`);
  } catch (err) {
    console.error('erro:', err);
  }
}
rl.close();
