import { FIXED_NATIONAL_HOLIDAYS_MMDD } from './constants.ts';
import type {
  ActNaturezaBase,
  ActRecord,
  ActUrgencia,
  AlertNatureza,
  BillingCycle,
  BillingSettings,
  CompanyUf,
  CompanyUfKind,
  DeliveryKind,
  PlanType,
  UserRitmo,
} from './types.ts';

export const DEFAULT_BILLING_SETTINGS: BillingSettings = {
  pro_monthly_cents: 29700,
  pro_annual_cents: 297000, // RN-26: 10x mensal
  nacional_monthly_cents: 59700,
  nacional_annual_cents: 597000, // RN-26: 10x mensal
  discount_5_to_9_pct: 15,
  discount_10_plus_pct: 25,
  founder_limit: 30,
  founders_taken: 0,
};

/**
 * Formatação oficial em português do Brasil (Seção 0 item 9).
 */
export function formatDateBr(isoOrDate: string | null | undefined): string {
  if (!isoOrDate) return 'Sem prazo';
  const datePart = isoOrDate.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (!match) return isoOrDate;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

export function formatCurrencyBrl(cents: number): string {
  const value = cents / 100;
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * RN-03 & RN-04: Valida exclusividade CREDENCIADA/INTERESSE e limites de UFs por plano.
 */
export function validateCompanyUfsUpdate(
  plan: PlanType,
  ufs: Array<{ uf_sigla: string; kind: CompanyUfKind }>
): { ok: true } | { ok: false; error: string } {
  const seen = new Set<string>();
  for (const item of ufs) {
    const sigla = item.uf_sigla.toUpperCase();
    if (seen.has(sigla)) {
      return {
        ok: false,
        error: `A UF ${sigla} não pode ser credenciada e de interesse ao mesmo tempo (RN-03).`,
      };
    }
    seen.add(sigla);
  }

  if (plan === 'PRO' && seen.size > 5) {
    return {
      ok: false,
      error: 'No plano PRO, a soma de UFs credenciadas e de interesse é no máximo 5 (RN-04).',
    };
  }

  if (plan === 'NACIONAL' && seen.size > 27) {
    return {
      ok: false,
      error: 'No plano NACIONAL, o limite máximo é de 27 UFs (RN-04).',
    };
  }

  return { ok: true };
}

/**
 * RN-05: Preferências do membro devem ser sempre um subconjunto das UFs da empresa.
 */
export function filterValidMemberPreferences(
  companyUfs: CompanyUf[],
  requestedUfs: Array<{ uf_sigla: string; ativo: boolean }>
): { ok: true; valid: Array<{ uf_sigla: string; ativo: boolean }> } | { ok: false; error: string } {
  const allowed = new Set(companyUfs.map((u) => u.uf_sigla.toUpperCase()));
  for (const pref of requestedUfs) {
    if (pref.ativo && !allowed.has(pref.uf_sigla.toUpperCase())) {
      return {
        ok: false,
        error: `A UF ${pref.uf_sigla} não pertence às UFs monitoradas pela empresa (RN-05).`,
      };
    }
  }
  return {
    ok: true,
    valid: requestedUfs.map((u) => ({ uf_sigla: u.uf_sigla.toUpperCase(), ativo: u.ativo })),
  };
}

/**
 * RN-06 & RN-07: Determina se uma empresa dá match e qual a natureza do alerta gerado.
 */
export function resolveCompanyAlertNature(
  companySegment: string,
  companyUfs: CompanyUf[],
  actUf: string,
  actSegments: string[],
  actNaturezaBase: ActNaturezaBase
): AlertNatureza | null {
  if (!actSegments.includes(companySegment)) return null;
  const matchUf = companyUfs.find((u) => u.uf_sigla.toUpperCase() === actUf.toUpperCase());
  if (!matchUf) return null;

  const companyNature: AlertNatureza =
    matchUf.kind === 'CREDENCIADA' ? 'OBRIGACAO' : 'OPORTUNIDADE';

  if (actNaturezaBase === 'AMBAS') return companyNature;
  if (actNaturezaBase === companyNature) return companyNature;
  return null;
}

export interface FanoutInputRow {
  user_id: string;
  profile_id: string;
  company_id: string;
  company_plan: PlanType;
  company_plan_status: string;
  natureza: AlertNatureza;
}

export interface ConsolidatedAlertGroup {
  user_id: string;
  profile_id: string;
  natureza: AlertNatureza;
  company_ids: string[];
  paid_company_ids: string[];
  free_company_ids: string[];
  locked_for_free: boolean;
}

/**
 * RN-09 & RN-11: Consolida empresas afetadas por (user_id, natureza) e calcula locked_for_free.
 */
export function consolidateAlertGroups(rows: FanoutInputRow[]): ConsolidatedAlertGroup[] {
  const map = new Map<string, ConsolidatedAlertGroup>();

  for (const row of rows) {
    const key = `${row.user_id}::${row.natureza}`;
    let group = map.get(key);
    if (!group) {
      group = {
        user_id: row.user_id,
        profile_id: row.profile_id,
        natureza: row.natureza,
        company_ids: [],
        paid_company_ids: [],
        free_company_ids: [],
        locked_for_free: true,
      };
      map.set(key, group);
    }

    if (!group.company_ids.includes(row.company_id)) {
      group.company_ids.push(row.company_id);
      const isPaid =
        (row.company_plan === 'PRO' || row.company_plan === 'NACIONAL') &&
        row.company_plan_status === 'ATIVO';
      if (isPaid) {
        group.paid_company_ids.push(row.company_id);
      } else {
        group.free_company_ids.push(row.company_id);
      }
    }
    group.locked_for_free = group.paid_company_ids.length === 0;
  }

  return Array.from(map.values());
}

/**
 * RN-12: Redação estrita no servidor para conteúdo bloqueado (plano FREE).
 */
export function redactActForFree<
  T extends Pick<
    ActRecord,
    'id' | 'uf_sigla' | 'orgao' | 'tipo' | 'numero' | 'data_publicacao' | 'assunto' | 'urgencia' | 'titulo' | 'status' | 'current_version'
  > & {
    prazo?: string | null;
    sem_prazo?: boolean;
    resumo?: string | null;
    pdf_path?: string | null;
    fonte_url?: string | null;
    checklist?: unknown[];
  }
>(act: T, lockedForFree: boolean) {
  if (!lockedForFree) {
    return act;
  }
  return {
    ...act,
    prazo: null,
    resumo: null,
    pdf_path: null,
    fonte_url: null,
    checklist: [],
  };
}

/**
 * Utilitário para calcular componentes de data/hora no fuso America/Sao_Paulo.
 */
export function getSaoPauloParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0=Dom..6=Sab
} {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const wkMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const hourRaw = Number(get('hour'));
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: hourRaw === 24 ? 0 : hourRaw,
    minute: Number(get('minute')),
    weekday: wkMap[get('weekday')] ?? 0,
  };
}

/**
 * Constrói Date UTC equivalente a um horário local de Brasília (UTC-3 fixo no Brasil desde 2019).
 */
export function makeSaoPauloDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0
): Date {
  // America/Sao_Paulo está em UTC-03:00 (sem horário de verão desde 2019).
  return new Date(Date.UTC(year, month - 1, day, hour + 3, minute, 0, 0));
}

/**
 * RN-14 & RN-15: Calcula horário agendado de envio para WhatsApp e E-mail/Push.
 */
export function computeDeliverySchedule(params: {
  channel: 'APP' | 'PUSH' | 'EMAIL' | 'WHATSAPP';
  urgencia: ActUrgencia;
  ritmo: UserRitmo;
  lockedForFree: boolean;
  now: Date;
}): { scheduledFor: Date; kind: DeliveryKind } | null {
  const { channel, urgencia, ritmo, lockedForFree, now } = params;

  // RN-13: FREE não tem WhatsApp nem e-mail imediato; tem notificação app e resumo semanal seg 8h
  if (lockedForFree) {
    if (channel === 'WHATSAPP') return null;
    if (channel === 'EMAIL') {
      const sp = getSaoPauloParts(now);
      const daysUntilMonday = sp.weekday === 1 && sp.hour < 8 ? 0 : ((8 - sp.weekday) % 7 || 7);
      const target = new Date(Date.UTC(sp.year, sp.month - 1, sp.day + daysUntilMonday, 8 + 3, 0, 0, 0));
      return { scheduledFor: target, kind: 'RESUMO_SEMANAL_FREE' };
    }
    return { scheduledFor: now, kind: 'ALERTA' };
  }

  // RN-14: URGENTE sempre sai imediatamente (inclusive WhatsApp fora da janela — RN-15)
  if (urgencia === 'URGENTE') {
    return { scheduledFor: now, kind: 'ALERTA' };
  }

  // RN-14: RESUMO_DIARIO agrupa para 8h
  if (ritmo === 'RESUMO_DIARIO' && (channel === 'EMAIL' || channel === 'WHATSAPP' || channel === 'PUSH')) {
    const sp = getSaoPauloParts(now);
    const addDay = sp.hour >= 8 ? 1 : 0;
    const target = makeSaoPauloDate(sp.year, sp.month, sp.day + addDay, 8, 0);
    return { scheduledFor: target, kind: 'RESUMO_DIARIO' };
  }

  // RN-15: WhatsApp apenas entre 08:00 e 20:00 (America/Sao_Paulo), exceto URGENTE
  if (channel === 'WHATSAPP') {
    const sp = getSaoPauloParts(now);
    if (sp.hour < 8) {
      return { scheduledFor: makeSaoPauloDate(sp.year, sp.month, sp.day, 8, 0), kind: 'ALERTA' };
    }
    if (sp.hour >= 20) {
      return { scheduledFor: makeSaoPauloDate(sp.year, sp.month, sp.day + 1, 8, 0), kind: 'ALERTA' };
    }
  }

  return { scheduledFor: now, kind: 'ALERTA' };
}

/**
 * RN-16: Gera lembretes em 30, 7 e 1 dia antes do prazo às 9h (America/Sao_Paulo), pulando datas passadas.
 */
export function computeDeadlineReminders(
  prazoIso: string | null,
  semPrazo: boolean,
  lockedForFree: boolean,
  now: Date
): Array<{ kind: 'LEMBRETE_30' | 'LEMBRETE_7' | 'LEMBRETE_1'; scheduledFor: Date }> {
  if (lockedForFree || semPrazo || !prazoIso) return [];
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(prazoIso);
  if (!match) return [];

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const offsets: Array<{ days: number; kind: 'LEMBRETE_30' | 'LEMBRETE_7' | 'LEMBRETE_1' }> = [
    { days: 30, kind: 'LEMBRETE_30' },
    { days: 7, kind: 'LEMBRETE_7' },
    { days: 1, kind: 'LEMBRETE_1' },
  ];

  const reminders: Array<{ kind: 'LEMBRETE_30' | 'LEMBRETE_7' | 'LEMBRETE_1'; scheduledFor: Date }> = [];
  for (const off of offsets) {
    const scheduledFor = makeSaoPauloDate(year, month, day - off.days, 9, 0);
    if (scheduledFor.getTime() > now.getTime()) {
      reminders.push({ kind: off.kind, scheduledFor });
    }
  }
  return reminders;
}

/**
 * RN-21: Verifica se o curador/admin pode aprovar o ato (não pode aprovar o que enviou para revisão).
 */
export function canApproveAct(submittedBy: string | null, actorUserId: string): boolean {
  if (!submittedBy) return false;
  return submittedBy !== actorUserId;
}

/**
 * Cálculo da Páscoa (Algoritmo de Meeus/Jones/Butcher) para feriados móveis nacionais.
 */
function getEasterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

export function isBrazilianNationalHoliday(year: number, month: number, day: number): boolean {
  const mmdd = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (FIXED_NATIONAL_HOLIDAYS_MMDD.includes(mmdd)) return true;

  const easter = getEasterSunday(year);
  const addDays = (base: Date, days: number) => {
    const d = new Date(base.getTime() + days * 86400000);
    return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  };
  // Sexta-feira Santa (-2), Corpus Christi (+60)
  return mmdd === addDays(easter, -2) || mmdd === addDays(easter, 60);
}

/**
 * RN-23: SLA em horas úteis (seg a sex, 8h às 18h America/Sao_Paulo, sem feriados nacionais).
 */
export function computeBusinessHoursSla(startIso: string, endIso: string): number {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return 0;
  }

  let totalMinutes = 0;
  const spStart = getSaoPauloParts(start);
  const spEnd = getSaoPauloParts(end);

  let cursor = new Date(Date.UTC(spStart.year, spStart.month - 1, spStart.day));
  const endDay = new Date(Date.UTC(spEnd.year, spEnd.month - 1, spEnd.day));

  while (cursor <= endDay) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    const d = cursor.getUTCDate();
    const weekday = cursor.getUTCDay();

    if (weekday >= 1 && weekday <= 5 && !isBrazilianNationalHoliday(y, m, d)) {
      const workStart = makeSaoPauloDate(y, m, d, 8, 0).getTime();
      const workEnd = makeSaoPauloDate(y, m, d, 18, 0).getTime();
      const overlapStart = Math.max(start.getTime(), workStart);
      const overlapEnd = Math.min(end.getTime(), workEnd);
      if (overlapEnd > overlapStart) {
        totalMinutes += (overlapEnd - overlapStart) / 60000;
      }
    }
    cursor = new Date(cursor.getTime() + 86400000);
  }

  return Math.round((totalMinutes / 60) * 100) / 100;
}

/**
 * RN-24, RN-25, RN-26, RN-27: Cálculo de cobrança por empresa com desconto por volume e trava de fundador.
 */
export interface PricingQuote {
  paidCompaniesCount: number;
  discountPct: number;
  founderApplied: boolean;
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  perCompanyItems: Array<{
    companyId: string;
    plan: 'PRO' | 'NACIONAL';
    unitCents: number;
    finalCents: number;
  }>;
}

export function calculateSubscriptionPricing(params: {
  items: Array<{ companyId: string; plan: 'PRO' | 'NACIONAL' }>;
  cycle: BillingCycle;
  settings: BillingSettings;
  founderPriceLocked: boolean;
}): PricingQuote {
  const { items, cycle, settings, founderPriceLocked } = params;
  const count = items.length;
  let discountPct = 0;
  if (count >= 10) {
    discountPct = settings.discount_10_plus_pct;
  } else if (count >= 5) {
    discountPct = settings.discount_5_to_9_pct;
  }

  // Preço de tabela inicial do fundador (RN-27) garantido se founderPriceLocked
  const baseRates = founderPriceLocked
    ? {
        PRO_MENSAL: Math.min(settings.pro_monthly_cents, 29700),
        PRO_ANUAL: Math.min(settings.pro_annual_cents, 297000),
        NACIONAL_MENSAL: Math.min(settings.nacional_monthly_cents, 59700),
        NACIONAL_ANUAL: Math.min(settings.nacional_annual_cents, 597000),
      }
    : {
        PRO_MENSAL: settings.pro_monthly_cents,
        PRO_ANUAL: settings.pro_annual_cents,
        NACIONAL_MENSAL: settings.nacional_monthly_cents,
        NACIONAL_ANUAL: settings.nacional_annual_cents,
      };

  const perCompanyItems = items.map((item) => {
    const unitCents =
      item.plan === 'PRO'
        ? cycle === 'MENSAL'
          ? baseRates.PRO_MENSAL
          : baseRates.PRO_ANUAL
        : cycle === 'MENSAL'
          ? baseRates.NACIONAL_MENSAL
          : baseRates.NACIONAL_ANUAL;
    const finalCents = Math.round(unitCents * (1 - discountPct / 100));
    return {
      companyId: item.companyId,
      plan: item.plan,
      unitCents,
      finalCents,
    };
  });

  const subtotalCents = perCompanyItems.reduce((acc, it) => acc + it.unitCents, 0);
  const totalCents = perCompanyItems.reduce((acc, it) => acc + it.finalCents, 0);
  const discountCents = subtotalCents - totalCents;

  return {
    paidCompaniesCount: count,
    discountPct,
    founderApplied: founderPriceLocked,
    subtotalCents,
    discountCents,
    totalCents,
    perCompanyItems,
  };
}

/**
 * RN-31: Normalização da resposta do WhatsApp ("SAIR" sem acento/case, "1", ou outra mensagem).
 */
export function classifyWhatsAppInbound(rawBody: string): 'SAIR' | 'VISTO_1' | 'OUTRO' {
  const normalized = (rawBody || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();

  if (normalized === 'SAIR') return 'SAIR';
  if (normalized === '1') return 'VISTO_1';
  return 'OUTRO';
}
