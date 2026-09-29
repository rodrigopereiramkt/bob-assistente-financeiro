function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente ${name} não configurada`);
  return v;
}

export const config = {
  get evolution() {
    return {
      url: required('EVOLUTION_API_URL').replace(/\/+$/, ''),
      apiKey: required('EVOLUTION_API_KEY'),
      instance: required('EVOLUTION_INSTANCE'),
    };
  },
  get webhookToken() {
    return required('WEBHOOK_TOKEN');
  },
  get gemini() {
    return {
      apiKey: required('GEMINI_API_KEY'),
      model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
      fallbackModels: (process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-3.1-flash-lite').split(',').map((m) => m.trim()).filter(Boolean),
    };
  },
  get supabase() {
    return { url: required('SUPABASE_URL'), serviceKey: required('SUPABASE_SERVICE_ROLE_KEY') };
  },
  get allowedNumbers(): string[] {
    return (process.env.ALLOWED_NUMBERS || '')
      .split(',')
      .map((n) => n.replace(/\D/g, ''))
      .filter(Boolean);
  },
  get timezone() {
    return process.env.TIMEZONE || 'America/Sao_Paulo';
  },
};
