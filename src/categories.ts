export const EXPENSE_CATEGORIES = [
  'Alimentação', 'Mercado', 'Transporte', 'Moradia', 'Contas', 'Saúde', 'Educação',
  'Lazer', 'Compras', 'Assinaturas', 'Pets', 'Viagem', 'Cuidados pessoais', 'Outros',
] as const;

export const INCOME_CATEGORIES = ['Salário', 'Freelance', 'Investimentos', 'Presente', 'Reembolso', 'Vendas', 'Outros'] as const;

export const ALL_CATEGORIES = Array.from(new Set<string>([...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES]));

const EMOJI: Record<string, string> = {
  'Alimentação': '🍔', 'Mercado': '🛒', 'Transporte': '🚗', 'Moradia': '🏠', 'Contas': '🧾',
  'Saúde': '💊', 'Educação': '📚', 'Lazer': '🎉', 'Compras': '🛍️', 'Assinaturas': '📺',
  'Pets': '🐶', 'Viagem': '✈️', 'Cuidados pessoais': '💇', 'Salário': '💼', 'Freelance': '💻',
  'Investimentos': '📈', 'Presente': '🎁', 'Reembolso': '↩️', 'Vendas': '🏷️', 'Outros': '📦',
};

export function categoryEmoji(category: string): string {
  return EMOJI[category] ?? '📦';
}

export function normalizeCategory(raw: unknown): string {
  if (typeof raw !== 'string') return 'Outros';
  const found = ALL_CATEGORIES.find((c) => c.toLowerCase() === raw.trim().toLowerCase());
  return found ?? 'Outros';
}
