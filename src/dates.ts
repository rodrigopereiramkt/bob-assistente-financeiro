/** Data de hoje (YYYY-MM-DD) e dia da semana no fuso informado. */
export function todayIn(timezone: string, now = new Date()): { today: string; weekday: string } {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const weekday = new Intl.DateTimeFormat('pt-BR', { timeZone: timezone, weekday: 'long' }).format(now);
  return { today, weekday };
}

export function isValidDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** DD/MM a partir de YYYY-MM-DD. */
export function shortDate(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}`;
}
