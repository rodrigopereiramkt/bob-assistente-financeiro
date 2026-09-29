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

function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Data no mês `offset` meses depois de `date`, no dia `day` (limitado ao último dia do mês). */
export function monthlyDate(date: string, offset: number, day = Number(date.slice(8, 10))): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1 + offset;
  const year = y + Math.floor(m / 12);
  const month1 = (((m % 12) + 12) % 12) + 1;
  const d = Math.min(day, daysInMonth(year, month1));
  return `${year}-${String(month1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Primeira data com o dia `day` que seja >= `today`. */
export function nextMonthlyOnOrAfter(today: string, day: number): string {
  const thisMonth = monthlyDate(today, 0, day);
  return thisMonth >= today ? thisMonth : monthlyDate(today, 1, day);
}
