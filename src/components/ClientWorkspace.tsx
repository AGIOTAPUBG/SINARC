import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  Building2,
  CheckSquare,
  Download,
  ExternalLink,
  FileText,
  Lock,
  Plus,
  Search,
  Shield,
  Square,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { formatCnpj, normalizeCnpj, validateCnpj } from '../../packages/shared/cnpj.ts';
import {
  formatCurrencyBrl,
  formatDateBr,
  validateCompanyUfsUpdate,
} from '../../packages/shared/rules.ts';
import type {
  AlertItem,
  AlertStatus,
  BillingCycle,
  BillingSettings,
  ChannelType,
  CompanyAddress,
  CompanyUfKind,
  PlanType,
  SegmentRecord,
  UfRecord,
  UserProfile,
  UserRitmo,
} from '../../packages/shared/types.ts';
import { apiFetch } from '../lib/api.ts';
import { BrazilUfMap } from './BrazilUfMap.tsx';

export type ClientTab =
  | 'feed'
  | 'history'
  | 'companies'
  | 'preferences'
  | 'plans'
  | 'account';

export interface MePayload {
  user: UserProfile;
  monitoringProfiles: Array<{
    id: string;
    nome: string;
    billing_cycle: BillingCycle;
    founder_price_locked: number;
    founder_number: number | null;
    stripe_customer_id: string | null;
  }>;
  companies: Array<{
    id: string;
    profile_id: string;
    cnpj: string;
    razao_social: string;
    nome_fantasia: string;
    endereco: CompanyAddress;
    segment_code: string;
    plan: PlanType;
    plan_status: string;
    is_owner: number;
    ufs: Array<{ company_id: string; uf_sigla: string; kind: CompanyUfKind }>;
    members: Array<{
      id: string;
      user_id: string;
      is_owner: number;
      status: string;
      nome: string;
      email: string;
    }>;
    myPrefs: Array<{ uf_sigla: string; ativo: number }>;
  }>;
  channels: Array<{ channel: ChannelType; ativo: number }>;
  consents: Array<{ id: string; tipo: string; versao: string; aceito: number; em: string; origem: string }>;
  invoices: Array<{
    id: string;
    stripe_invoice_id: string;
    nf_provider_id: string | null;
    status: string;
    pdf_url: string | null;
    created_at: string;
  }>;
}

interface ClientWorkspaceProps {
  activeTab: ClientTab;
  onChangeTab: (tab: ClientTab) => void;
  me: MePayload;
  alerts: AlertItem[];
  historyAlerts: AlertItem[];
  selectedAlertId: string | null;
  onSelectAlert: (alertId: string | null) => void;
  ufs: UfRecord[];
  segments: SegmentRecord[];
  billingSettings: BillingSettings;
  whatsappOptInText: string;
  onRefreshAll: () => Promise<void>;
  onLoggedOut: () => void;
}

function getDeadlineCountdown(prazo: string | null, semPrazo: boolean): string {
  if (semPrazo || !prazo) return 'Sem prazo definido';
  const target = new Date(`${prazo.slice(0, 10)}T23:59:59-03:00`).getTime();
  const diffDays = Math.ceil((target - Date.now()) / 86400000);
  if (diffDays < 0) return `Vencido há ${Math.abs(diffDays)} dia(s)`;
  if (diffDays === 0) return 'Vence hoje';
  if (diffDays === 1) return 'Falta 1 dia';
  return `Faltam ${diffDays} dias`;
}

function urgenciaLabel(urg: string): { text: string; cls: string } {
  if (urg === 'URGENTE') return { text: 'Urgente', cls: 'text-red-700 dark:text-red-400 font-semibold' };
  if (urg === 'IMPORTANTE') return { text: 'Importante', cls: 'text-amber-700 dark:text-amber-400 font-semibold' };
  return { text: 'Informativo', cls: 'text-slate-600 dark:text-slate-400 font-medium' };
}

function statusLabel(st: AlertStatus): string {
  const map: Record<AlertStatus, string> = {
    NOVO: 'Novo',
    VISTO: 'Visto',
    EM_ANDAMENTO: 'Em andamento',
    RESOLVIDO: 'Resolvido',
  };
  return map[st];
}

export function ClientWorkspace({
  activeTab,
  onChangeTab,
  me,
  alerts,
  historyAlerts,
  selectedAlertId,
  onSelectAlert,
  ufs,
  segments,
  billingSettings,
  whatsappOptInText,
  onRefreshAll,
  onLoggedOut,
}: ClientWorkspaceProps) {
  // Feed filters
  const [natureTab, setNatureTab] = useState<'OPORTUNIDADE' | 'OBRIGACAO'>('OPORTUNIDADE');
  const [filterUf, setFilterUf] = useState('');
  const [filterCompany, setFilterCompany] = useState('');
  const [filterUrgency, setFilterUrgency] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  // History search
  const [historySearch, setHistorySearch] = useState('');

  // Visual-only checklist state (v1 não persiste marcação do cliente)
  const [checkedChecklistIds, setCheckedChecklistIds] = useState<Record<string, boolean>>({});

  // Company management state
  const [showAddCompany, setShowAddCompany] = useState(false);
  const [newCnpj, setNewCnpj] = useState('');
  const [newRazao, setNewRazao] = useState('');
  const [newFantasia, setNewFantasia] = useState('');
  const [newSegment, setNewSegment] = useState(segments[0]?.code || 'ECV');
  const [newCred, setNewCred] = useState<string[]>([]);
  const [newInt, setNewInt] = useState<string[]>([]);
  const [newUfMode, setNewUfMode] = useState<CompanyUfKind>('CREDENCIADA');

  const [editingCompanyId, setEditingCompanyId] = useState<string | null>(null);
  const [editCred, setEditCred] = useState<string[]>([]);
  const [editInt, setEditInt] = useState<string[]>([]);
  const [editUfMode, setEditUfMode] = useState<CompanyUfKind>('CREDENCIADA');

  const [inviteCompanyId, setInviteCompanyId] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteNome, setInviteNome] = useState('');
  const [inviteFeedback, setInviteFeedback] = useState('');

  // Plans & Checkout
  const [selectedPlan, setSelectedPlan] = useState<'PRO' | 'NACIONAL'>('PRO');
  const [selectedCycle, setSelectedCycle] = useState<BillingCycle>('MENSAL');
  const [selectedPlanCompanyIds, setSelectedPlanCompanyIds] = useState<string[]>(
    me.companies.filter((c) => c.is_owner === 1).map((c) => c.id)
  );

  // Account / 2FA / LGPD
  const [mfaSetup, setMfaSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedAlert = useMemo(
    () => [...alerts, ...historyAlerts].find((a) => a.id === selectedAlertId || a.act_id === selectedAlertId) || null,
    [alerts, historyAlerts, selectedAlertId]
  );

  const filteredAlerts = useMemo(() => {
    return alerts.filter((al) => {
      if (al.natureza !== natureTab) return false;
      if (filterUf && al.act.uf_sigla !== filterUf) return false;
      if (filterCompany && !al.company_ids.includes(filterCompany)) return false;
      if (filterUrgency && al.urgencia !== filterUrgency) return false;
      if (filterStatus && al.status !== filterStatus) return false;
      return true;
    });
  }, [alerts, natureTab, filterUf, filterCompany, filterUrgency, filterStatus]);

  const filteredHistory = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return historyAlerts;
    return historyAlerts.filter(
      (al) =>
        al.act.titulo.toLowerCase().includes(q) ||
        al.act.orgao.toLowerCase().includes(q) ||
        al.act.uf_sigla.toLowerCase().includes(q) ||
        al.act.numero.toLowerCase().includes(q)
    );
  }, [historyAlerts, historySearch]);

  const openAlertDetail = async (al: AlertItem) => {
    onSelectAlert(al.id);
    if (al.status === 'NOVO') {
      await apiFetch(`/api/alerts/${al.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'VISTO' }),
      }).catch(() => undefined);
      await onRefreshAll();
    }
  };

  const handleUpdateAlertStatus = async (alertId: string, status: AlertStatus) => {
    setBusy(true);
    try {
      await apiFetch(`/api/alerts/${alertId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      await onRefreshAll();
      setFeedback({ type: 'ok', msg: `Status atualizado para ${statusLabel(status)}.` });
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao atualizar status.' });
    } finally {
      setBusy(false);
    }
  };

  const handleAddCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    const digits = normalizeCnpj(newCnpj);
    if (!validateCnpj(digits)) {
      setFeedback({ type: 'err', msg: 'CNPJ inválido pelos dígitos verificadores (RN-01).' });
      return;
    }
    setBusy(true);
    try {
      await apiFetch('/api/companies', {
        method: 'POST',
        body: JSON.stringify({
          cnpj: digits,
          razao_social: newRazao,
          nome_fantasia: newFantasia || newRazao,
          segment_code: newSegment,
          ufs: [
            ...newCred.map((u) => ({ uf_sigla: u, kind: 'CREDENCIADA' })),
            ...newInt.map((u) => ({ uf_sigla: u, kind: 'INTERESSE' })),
          ],
        }),
      });
      setShowAddCompany(false);
      setNewCnpj('');
      setNewRazao('');
      setNewFantasia('');
      setNewCred([]);
      setNewInt([]);
      await onRefreshAll();
      setFeedback({ type: 'ok', msg: 'Empresa cadastrada e alertas sincronizados.' });
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao cadastrar empresa.' });
    } finally {
      setBusy(false);
    }
  };

  const handleLookupCompanyCnpj = async () => {
    const digits = normalizeCnpj(newCnpj);
    if (!validateCnpj(digits)) {
      setFeedback({ type: 'err', msg: 'CNPJ inválido pelos dígitos verificadores.' });
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch<{
        found: boolean;
        data?: { razao_social: string; nome_fantasia: string };
      }>(`/api/cnpj/${digits}`);
      setNewCnpj(formatCnpj(digits));
      if (res.found && res.data) {
        setNewRazao(res.data.razao_social);
        setNewFantasia(res.data.nome_fantasia || res.data.razao_social);
      }
    } finally {
      setBusy(false);
    }
  };

  // Cálculo local espelhado da cotação de planos (RN-24..RN-27)
  const founderLocked = me.monitoringProfiles.some((p) => p.founder_price_locked === 1);
  const planQuote = useMemo(() => {
    const count = selectedPlanCompanyIds.length;
    const discountPct =
      count >= 10
        ? billingSettings.discount_10_plus_pct
        : count >= 5
          ? billingSettings.discount_5_to_9_pct
          : 0;
    const unitCents =
      selectedPlan === 'PRO'
        ? selectedCycle === 'MENSAL'
          ? billingSettings.pro_monthly_cents
          : billingSettings.pro_annual_cents
        : selectedCycle === 'MENSAL'
          ? billingSettings.nacional_monthly_cents
          : billingSettings.nacional_annual_cents;
    const subtotalCents = unitCents * count;
    const totalCents = Math.round(subtotalCents * (1 - discountPct / 100));
    return { count, discountPct, unitCents, subtotalCents, totalCents };
  }, [selectedPlanCompanyIds, selectedPlan, selectedCycle, billingSettings]);

  // Se houver um ato aberto em detalhe, renderiza Tela 4 (Detalhe do Ato)
  if (selectedAlert) {
    const { act } = selectedAlert;
    const urg = urgenciaLabel(act.urgencia);
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={() => onSelectAlert(null)}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white"
          >
            <ArrowLeft className="w-4 h-4" /> Voltar
          </button>

          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500 dark:text-slate-400">Status do alerta:</label>
            <select
              value={selectedAlert.status}
              disabled={busy}
              onChange={(e) => handleUpdateAlertStatus(selectedAlert.id, e.target.value as AlertStatus)}
              className="px-3 py-1.5 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900"
            >
              <option value="NOVO">Novo</option>
              <option value="VISTO">Visto</option>
              <option value="EM_ANDAMENTO">Em andamento</option>
              <option value="RESOLVIDO">Resolvido</option>
            </select>
          </div>
        </div>

        <article className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-6 sm:p-8 space-y-6">
          <header className="space-y-3 border-b border-slate-100 dark:border-slate-800 pb-5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                {act.uf_sigla}
              </span>
              <span aria-hidden="true">·</span>
              <span>{act.orgao}</span>
              <span aria-hidden="true">·</span>
              <span>
                {act.tipo} {act.numero}
              </span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">Publicado em {formatDateBr(act.data_publicacao)}</span>
              <span aria-hidden="true">·</span>
              <span className={selectedAlert.natureza === 'OPORTUNIDADE' ? 'text-emerald-700 dark:text-emerald-400 font-semibold' : 'text-red-700 dark:text-red-400 font-semibold'}>
                {selectedAlert.natureza === 'OPORTUNIDADE' ? 'Oportunidade' : 'Obrigação'}
              </span>
              <span aria-hidden="true">·</span>
              <span className={urg.cls}>{urg.text}</span>
              {act.latest_change_type === 'ATUALIZACAO' && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-semibold text-sky-700 dark:text-sky-400">Atualização</span>
                </>
              )}
              {(selectedAlert.is_correction || act.latest_change_type === 'CORRECAO') && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-semibold text-amber-700 dark:text-amber-400">Correção</span>
                </>
              )}
            </div>

            <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white text-balance">
              {act.titulo}
            </h1>

            <div className="flex flex-wrap items-center gap-6 pt-1 text-sm">
              <div>
                <span className="text-slate-500 dark:text-slate-400">Empresas afetadas: </span>
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {selectedAlert.company_names.join(', ')}
                </span>
              </div>
              {!selectedAlert.locked_for_free && (
                <div>
                  <span className="text-slate-500 dark:text-slate-400">Prazo: </span>
                  <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                    {act.sem_prazo ? 'Sem prazo definido' : `${formatDateBr(act.prazo)} (${getDeadlineCountdown(act.prazo, act.sem_prazo)})`}
                  </span>
                </div>
              )}
            </div>
          </header>

          {selectedAlert.locked_for_free ? (
            <div className="p-6 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 space-y-3">
              <div className="flex items-center gap-2 text-slate-900 dark:text-white font-semibold">
                <Lock className="w-5 h-5 text-amber-600" />
                Conteúdo completo exclusivo para planos pagos
              </div>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                No plano FREE, o resumo executivo, o prazo oficial, o checklist documental, o PDF assinado e o link da fonte permanecem bloqueados no servidor.
              </p>
              <button
                type="button"
                onClick={() => {
                  onSelectAlert(null);
                  onChangeTab('plans');
                }}
                className="px-5 py-2.5 rounded-lg bg-[#0B1F3A] text-white text-sm font-semibold"
              >
                Assinar plano PRO ou NACIONAL
              </button>
            </div>
          ) : (
            <>
              <section className="space-y-2">
                <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Resumo interpretado
                </h2>
                <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed whitespace-pre-line">
                  {act.resumo}
                </p>
              </section>

              <div className="flex flex-wrap gap-3">
                {act.pdf_signed_url && (
                  <a
                    href={act.pdf_signed_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#0B1F3A] text-white text-sm font-semibold"
                  >
                    <FileText className="w-4 h-4" /> Baixar PDF oficial
                  </a>
                )}
                {act.fonte_url && (
                  <a
                    href={act.fonte_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <ExternalLink className="w-4 h-4" /> Fonte oficial do DETRAN
                  </a>
                )}
              </div>

              <section className="space-y-3 pt-2">
                <div>
                  <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Checklist de exigências
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Você pode marcar os itens visualmente durante a sua conferência (a marcação é local nesta sessão).
                  </p>
                </div>

                {act.checklist.length === 0 ? (
                  <p className="text-sm text-slate-500">Nenhum item de checklist cadastrado para este ato.</p>
                ) : (
                  <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl">
                    {act.checklist.map((item, idx) => {
                      const key = item.id || `${act.id}-${idx}`;
                      const checked = Boolean(checkedChecklistIds[key]);
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() =>
                            setCheckedChecklistIds((prev) => ({ ...prev, [key]: !prev[key] }))
                          }
                          className="w-full text-left p-4 flex items-start gap-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors"
                        >
                          {checked ? (
                            <CheckSquare className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                          ) : (
                            <Square className="w-5 h-5 text-slate-400 shrink-0 mt-0.5" />
                          )}
                          <div className="space-y-1">
                            <p className={`text-sm font-medium ${checked ? 'line-through text-slate-400' : 'text-slate-900 dark:text-slate-100'}`}>
                              {item.titulo}
                            </p>
                            {item.descricao && (
                              <p className="text-xs text-slate-500 dark:text-slate-400">
                                {item.descricao}
                              </p>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>
            </>
          )}

          {/* Histórico de versões do ato */}
          <section className="pt-4 border-t border-slate-100 dark:border-slate-800 space-y-2">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Histórico de versões ({act.versions.length})
            </h2>
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {act.versions.map((v) => (
                <div key={v.id} className="py-2 text-xs text-slate-600 dark:text-slate-400 flex flex-wrap gap-2">
                  <span className="font-mono font-semibold text-slate-900 dark:text-slate-200">
                    v{v.version}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{v.change_type}</span>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">{formatDateBr(v.published_at)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{v.change_note}</span>
                </div>
              ))}
            </div>
          </section>
        </article>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {feedback && (
        <div
          className={`p-3.5 rounded-xl border text-sm flex items-center justify-between ${
            feedback.type === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950/40 dark:border-emerald-900 dark:text-emerald-300'
              : 'bg-red-50 border-red-200 text-red-800 dark:bg-red-950/40 dark:border-red-900 dark:text-red-300'
          }`}
        >
          <span>{feedback.msg}</span>
          <button type="button" onClick={() => setFeedback(null)} className="text-xs underline ml-4">
            Fechar
          </button>
        </div>
      )}

      {/* TELA 3: INÍCIO (FEED) */}
      {activeTab === 'feed' && (
        <div className="space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="inline-flex p-1 bg-slate-100 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 self-start">
              <button
                type="button"
                onClick={() => setNatureTab('OPORTUNIDADE')}
                className={`px-4 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  natureTab === 'OPORTUNIDADE'
                    ? 'bg-white dark:bg-slate-800 text-emerald-700 dark:text-emerald-400 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                Oportunidades ({alerts.filter((a) => a.natureza === 'OPORTUNIDADE').length})
              </button>
              <button
                type="button"
                onClick={() => setNatureTab('OBRIGACAO')}
                className={`px-4 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  natureTab === 'OBRIGACAO'
                    ? 'bg-white dark:bg-slate-800 text-red-700 dark:text-red-400 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                Obrigações ({alerts.filter((a) => a.natureza === 'OBRIGACAO').length})
              </button>
            </div>

            <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2">
              <select
                value={filterUf}
                onChange={(e) => setFilterUf(e.target.value)}
                aria-label="Filtrar por UF"
                className="px-3 py-2 text-xs border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900"
              >
                <option value="">Todas as UFs</option>
                {ufs.map((u) => (
                  <option key={u.sigla} value={u.sigla}>
                    {u.sigla} — {u.nome}
                  </option>
                ))}
              </select>

              <select
                value={filterCompany}
                onChange={(e) => setFilterCompany(e.target.value)}
                aria-label="Filtrar por empresa"
                className="px-3 py-2 text-xs border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900"
              >
                <option value="">Todas as empresas</option>
                {me.companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nome_fantasia || c.razao_social}
                  </option>
                ))}
              </select>

              <select
                value={filterUrgency}
                onChange={(e) => setFilterUrgency(e.target.value)}
                aria-label="Filtrar por urgência"
                className="px-3 py-2 text-xs border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900"
              >
                <option value="">Todas urgências</option>
                <option value="URGENTE">Urgente</option>
                <option value="IMPORTANTE">Importante</option>
                <option value="INFORMATIVO">Informativo</option>
              </select>

              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                aria-label="Filtrar por status"
                className="px-3 py-2 text-xs border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900"
              >
                <option value="">Todos status</option>
                <option value="NOVO">Novo</option>
                <option value="VISTO">Visto</option>
                <option value="EM_ANDAMENTO">Em andamento</option>
                <option value="RESOLVIDO">Resolvido</option>
              </select>
            </div>
          </div>

          {filteredAlerts.length === 0 ? (
            <div className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-10 text-center space-y-2">
              <p className="text-base font-semibold text-slate-900 dark:text-white">
                Nenhum alerta nesta aba com os filtros atuais.
              </p>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Ajuste os filtros ou revise suas UFs monitoradas em Minhas Empresas.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {filteredAlerts.map((al) => {
                const urg = urgenciaLabel(al.urgencia);
                return (
                  <button
                    key={al.id}
                    type="button"
                    onClick={() => openAlertDetail(al)}
                    className="w-full text-left border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 p-5 hover:border-slate-300 dark:hover:border-slate-700 transition-colors"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                          <span className="font-mono font-bold text-slate-900 dark:text-slate-100">
                            {al.act.uf_sigla}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{al.act.orgao}</span>
                          <span aria-hidden="true">·</span>
                          <span className={urg.cls}>{urg.text}</span>
                          <span aria-hidden="true">·</span>
                          <span>{statusLabel(al.status)}</span>
                          {al.is_correction && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-amber-700 dark:text-amber-400 font-semibold">Correção</span>
                            </>
                          )}
                          {al.act.latest_change_type === 'ATUALIZACAO' && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-sky-700 dark:text-sky-400 font-semibold">Atualização</span>
                            </>
                          )}
                        </div>

                        <h3 className="font-display text-base font-semibold text-slate-900 dark:text-white">
                          {al.act.titulo}
                        </h3>

                        <p className="text-xs text-slate-600 dark:text-slate-400">
                          Empresas: {al.company_names.join(', ')}
                          {al.paid_company_ids.length > 0 && al.free_company_ids.length > 0 && (
                            <span className="text-amber-700 dark:text-amber-400">
                              {' '}· ({al.free_company_ids.length} empresa(s) no FREE)
                            </span>
                          )}
                        </p>
                      </div>

                      <div className="shrink-0 sm:text-right">
                        {al.locked_for_free ? (
                          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
                            <Lock className="w-3.5 h-3.5" /> Conteúdo bloqueado (FREE)
                          </span>
                        ) : (
                          <div className="space-y-0.5">
                            <p className="text-xs font-semibold text-slate-900 dark:text-slate-100 tabular-nums">
                              {al.act.sem_prazo ? 'Sem prazo' : `Prazo: ${formatDateBr(al.act.prazo)}`}
                            </p>
                            {!al.act.sem_prazo && (
                              <p className="text-xs text-amber-700 dark:text-amber-400 tabular-nums">
                                {getDeadlineCountdown(al.act.prazo, al.act.sem_prazo)}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TELA 6: HISTÓRICO */}
      {activeTab === 'history' && (
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-xl font-bold">Histórico de atos encerrados e revogados</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Atos antigos permanecem preservados para auditoria e consulta histórica.
              </p>
            </div>
            <div className="relative w-full sm:w-72">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={historySearch}
                onChange={(e) => setHistorySearch(e.target.value)}
                placeholder="Buscar por UF, número ou título..."
                className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900"
              />
            </div>
          </div>

          {filteredHistory.length === 0 ? (
            <div className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 p-8 text-center text-sm text-slate-500">
              Nenhum ato encerrado ou revogado encontrado.
            </div>
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900">
              {filteredHistory.map((al) => (
                <button
                  key={al.id}
                  type="button"
                  onClick={() => openAlertDetail(al)}
                  className="w-full text-left p-5 hover:bg-slate-50 dark:hover:bg-slate-800/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div>
                    <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <span className="font-mono font-bold text-slate-900 dark:text-slate-100">{al.act.uf_sigla}</span>
                      <span aria-hidden="true">·</span>
                      <span>{al.act.orgao}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-semibold text-slate-700 dark:text-slate-300">{al.act.status}</span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">{formatDateBr(al.act.data_publicacao)}</span>
                    </div>
                    <p className="font-medium text-sm text-slate-900 dark:text-white mt-1">{al.act.titulo}</p>
                  </div>
                  <span className="text-xs text-slate-500 shrink-0">Ver detalhes</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TELA 7: MINHAS EMPRESAS */}
      {activeTab === 'companies' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-xl font-bold">Minhas empresas</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Gerencie os CNPJs monitorados, suas UFs credenciadas/de interesse e membros com acesso.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowAddCompany(!showAddCompany)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#0B1F3A] text-white text-sm font-semibold whitespace-nowrap shrink-0"
            >
              <Plus className="w-4 h-4" /> Adicionar empresa
            </button>
          </div>

          {showAddCompany && (
            <form
              onSubmit={handleAddCompany}
              className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-6 space-y-5"
            >
              <h3 className="text-base font-bold">Cadastrar nova empresa no perfil</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="flex gap-2 sm:col-span-2">
                  <input
                    type="text"
                    required
                    value={newCnpj}
                    onChange={(e) => setNewCnpj(e.target.value)}
                    placeholder="CNPJ (00.000.000/0001-00)"
                    className="flex-1 px-3 py-2 text-sm font-mono border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                  />
                  <button
                    type="button"
                    onClick={handleLookupCompanyCnpj}
                    className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-semibold whitespace-nowrap"
                  >
                    Buscar CNPJ
                  </button>
                </div>
                <select
                  value={newSegment}
                  onChange={(e) => setNewSegment(e.target.value)}
                  className="px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                >
                  {segments.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.nome}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  required
                  value={newRazao}
                  onChange={(e) => setNewRazao(e.target.value)}
                  placeholder="Razão Social"
                  className="sm:col-span-2 px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                />
                <input
                  type="text"
                  value={newFantasia}
                  onChange={(e) => setNewFantasia(e.target.value)}
                  placeholder="Nome Fantasia"
                  className="px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                />
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setNewUfMode('CREDENCIADA')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md border ${
                    newUfMode === 'CREDENCIADA'
                      ? 'bg-[#0B1F3A] text-white border-[#0B1F3A]'
                      : 'border-slate-300 dark:border-slate-700'
                  }`}
                >
                  UFs Credenciadas ({newCred.length})
                </button>
                <button
                  type="button"
                  onClick={() => setNewUfMode('INTERESSE')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md border ${
                    newUfMode === 'INTERESSE'
                      ? 'bg-emerald-700 text-white border-emerald-700'
                      : 'border-slate-300 dark:border-slate-700'
                  }`}
                >
                  UFs de Interesse ({newInt.length})
                </button>
              </div>

              <BrazilUfMap
                ufs={ufs}
                mode={newUfMode}
                selectedCredenciadas={newCred}
                selectedInteresse={newInt}
                onToggleUf={(sigla) => {
                  if (newUfMode === 'CREDENCIADA') {
                    setNewCred((p) => (p.includes(sigla) ? p.filter((x) => x !== sigla) : [...p, sigla]));
                  } else {
                    setNewInt((p) => (p.includes(sigla) ? p.filter((x) => x !== sigla) : [...p, sigla]));
                  }
                }}
              />

              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowAddCompany(false)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-sm"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="px-5 py-2 rounded-lg bg-[#0B1F3A] text-white text-sm font-semibold"
                >
                  Salvar empresa
                </button>
              </div>
            </form>
          )}

          <div className="space-y-4">
            {me.companies.map((c) => {
              const cred = c.ufs.filter((u) => u.kind === 'CREDENCIADA').map((u) => u.uf_sigla);
              const intr = c.ufs.filter((u) => u.kind === 'INTERESSE').map((u) => u.uf_sigla);
              const isEditingUfs = editingCompanyId === c.id;
              const isInviting = inviteCompanyId === c.id;

              return (
                <div
                  key={c.id}
                  className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-6 space-y-4"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                        <Building2 className="w-3.5 h-3.5" />
                        <span className="font-mono tabular-nums">{formatCnpj(c.cnpj)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{c.segment_code}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-semibold text-slate-900 dark:text-slate-100">
                          Plano {c.plan} ({c.plan_status})
                        </span>
                      </div>
                      <h3 className="font-display text-lg font-bold text-slate-900 dark:text-white mt-1">
                        {c.nome_fantasia || c.razao_social}
                      </h3>
                      <p className="text-xs text-slate-500">{c.razao_social}</p>
                    </div>

                    {c.is_owner === 1 && (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            if (isEditingUfs) {
                              setEditingCompanyId(null);
                            } else {
                              setEditingCompanyId(c.id);
                              setEditCred(cred);
                              setEditInt(intr);
                            }
                          }}
                          className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium whitespace-nowrap"
                        >
                          {isEditingUfs ? 'Fechar UFs' : 'Editar UFs'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setInviteCompanyId(isInviting ? null : c.id);
                            setInviteFeedback('');
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium whitespace-nowrap"
                        >
                          <UserPlus className="w-3.5 h-3.5" /> Membros ({c.members.length})
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="text-xs text-slate-600 dark:text-slate-300 space-y-1">
                    <p>
                      <strong className="text-red-700 dark:text-red-400">Credenciadas ({cred.length}):</strong>{' '}
                      {cred.length ? cred.join(', ') : 'Nenhuma'}
                    </p>
                    <p>
                      <strong className="text-emerald-700 dark:text-emerald-400">Interesse ({intr.length}):</strong>{' '}
                      {intr.length ? intr.join(', ') : 'Nenhuma'}
                    </p>
                  </div>

                  {isEditingUfs && (
                    <div className="pt-4 border-t border-slate-100 dark:border-slate-800 space-y-4">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setEditUfMode('CREDENCIADA')}
                          className={`px-3 py-1.5 text-xs font-medium rounded-md border ${
                            editUfMode === 'CREDENCIADA'
                              ? 'bg-[#0B1F3A] text-white border-[#0B1F3A]'
                              : 'border-slate-300 dark:border-slate-700'
                          }`}
                        >
                          Credenciadas ({editCred.length})
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditUfMode('INTERESSE')}
                          className={`px-3 py-1.5 text-xs font-medium rounded-md border ${
                            editUfMode === 'INTERESSE'
                              ? 'bg-emerald-700 text-white border-emerald-700'
                              : 'border-slate-300 dark:border-slate-700'
                          }`}
                        >
                          Interesse ({editInt.length})
                        </button>
                      </div>

                      <BrazilUfMap
                        ufs={ufs}
                        mode={editUfMode}
                        selectedCredenciadas={editCred}
                        selectedInteresse={editInt}
                        maxTotal={c.plan === 'PRO' ? 5 : undefined}
                        onToggleUf={(sigla) => {
                          if (editUfMode === 'CREDENCIADA') {
                            setEditCred((p) => (p.includes(sigla) ? p.filter((x) => x !== sigla) : [...p, sigla]));
                          } else {
                            setEditInt((p) => (p.includes(sigla) ? p.filter((x) => x !== sigla) : [...p, sigla]));
                          }
                        }}
                      />

                      <div className="flex justify-end">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={async () => {
                            const merged = [
                              ...editCred.map((u) => ({ uf_sigla: u, kind: 'CREDENCIADA' as const })),
                              ...editInt.map((u) => ({ uf_sigla: u, kind: 'INTERESSE' as const })),
                            ];
                            const check = validateCompanyUfsUpdate(c.plan, merged);
                            if (!check.ok) {
                              setFeedback({ type: 'err', msg: check.error });
                              return;
                            }
                            setBusy(true);
                            try {
                              await apiFetch(`/api/companies/${c.id}/ufs`, {
                                method: 'PUT',
                                body: JSON.stringify({ ufs: merged }),
                              });
                              setEditingCompanyId(null);
                              await onRefreshAll();
                              setFeedback({ type: 'ok', msg: 'UFs da empresa atualizadas.' });
                            } catch (err) {
                              setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao salvar UFs.' });
                            } finally {
                              setBusy(false);
                            }
                          }}
                          className="px-4 py-2 rounded-lg bg-[#0B1F3A] text-white text-xs font-semibold"
                        >
                          Salvar alterações de UFs
                        </button>
                      </div>
                    </div>
                  )}

                  {isInviting && (
                    <div className="pt-4 border-t border-slate-100 dark:border-slate-800 space-y-4">
                      <div className="flex flex-col sm:flex-row gap-2">
                        <input
                          type="text"
                          value={inviteNome}
                          onChange={(e) => setInviteNome(e.target.value)}
                          placeholder="Nome do membro"
                          className="px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                        />
                        <input
                          type="email"
                          value={inviteEmail}
                          onChange={(e) => setInviteEmail(e.target.value)}
                          placeholder="E-mail do membro"
                          className="flex-1 px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                        />
                        <button
                          type="button"
                          disabled={busy || !inviteEmail}
                          onClick={async () => {
                            setBusy(true);
                            try {
                              const res = await apiFetch<{ tempPassword: string | null }>(
                                `/api/companies/${c.id}/members`,
                                {
                                  method: 'POST',
                                  body: JSON.stringify({ email: inviteEmail, nome: inviteNome }),
                                }
                              );
                              setInviteEmail('');
                              setInviteNome('');
                              setInviteFeedback(
                                res.tempPassword
                                  ? `Membro convidado. Senha inicial provisória gerada: ${res.tempPassword}`
                                  : 'Membro vinculado com sucesso (todas as UFs ativas por padrão).'
                              );
                              await onRefreshAll();
                            } catch (err) {
                              setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao convidar.' });
                            } finally {
                              setBusy(false);
                            }
                          }}
                          className="px-4 py-2 rounded-lg bg-[#0B1F3A] text-white text-xs font-semibold whitespace-nowrap"
                        >
                          Convidar membro
                        </button>
                      </div>
                      {inviteFeedback && (
                        <p className="text-xs text-emerald-700 dark:text-emerald-400">{inviteFeedback}</p>
                      )}

                      <div className="divide-y divide-slate-100 dark:divide-slate-800">
                        {c.members.map((m) => (
                          <div key={m.id} className="py-2 flex items-center justify-between text-xs">
                            <div>
                              <span className="font-medium text-slate-900 dark:text-slate-100">{m.nome}</span>
                              <span className="text-slate-500 ml-2">{m.email}</span>
                              {m.is_owner === 1 && <span className="ml-2 text-sky-700 dark:text-sky-400 font-medium">Dono</span>}
                            </div>
                            {m.is_owner === 0 && (
                              <button
                                type="button"
                                onClick={async () => {
                                  await apiFetch(`/api/companies/${c.id}/members/${m.user_id}`, {
                                    method: 'DELETE',
                                  });
                                  await onRefreshAll();
                                }}
                                className="text-red-600 hover:underline inline-flex items-center gap-1"
                              >
                                <Trash2 className="w-3.5 h-3.5" /> Remover
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* TELA 8: PREFERÊNCIAS */}
      {activeTab === 'preferences' && (
        <div className="space-y-6 max-w-3xl">
          <div>
            <h2 className="font-display text-xl font-bold">Preferências de recebimento</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Escolha quais UFs de cada empresa você deseja receber, seus canais e seu ritmo de entrega.
            </p>
          </div>

          {/* Ritmo */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-6 space-y-3">
            <h3 className="text-sm font-semibold">Ritmo de entrega (planos pagos)</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(['IMEDIATO', 'RESUMO_DIARIO'] as UserRitmo[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={async () => {
                    await apiFetch('/api/preferences', {
                      method: 'PUT',
                      body: JSON.stringify({ ritmo: r }),
                    });
                    await onRefreshAll();
                    setFeedback({ type: 'ok', msg: 'Ritmo atualizado.' });
                  }}
                  className={`p-4 rounded-xl border text-left ${
                    me.user.ritmo === r
                      ? 'border-[#0B1F3A] bg-slate-50 dark:border-sky-500 dark:bg-slate-800'
                      : 'border-slate-200 dark:border-slate-800'
                  }`}
                >
                  <p className="text-sm font-semibold">
                    {r === 'IMEDIATO' ? 'Imediato' : 'Resumo diário às 8h'}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    {r === 'IMEDIATO'
                      ? 'Receba assim que o ato for publicado (WhatsApp respeita janela 8h–20h).'
                      : 'Um único resumo diário às 8h. Atos urgentes continuam saindo na hora.'}
                  </p>
                </button>
              ))}
            </div>
          </div>

          {/* Canais */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-6 space-y-4">
            <h3 className="text-sm font-semibold">Canais de alerta</h3>
            {(['APP', 'PUSH', 'EMAIL', 'WHATSAPP'] as ChannelType[]).map((ch) => {
              const current = me.channels.find((c) => c.channel === ch)?.ativo === 1;
              return (
                <div key={ch} className="flex items-center justify-between py-2 border-b last:border-b-0 border-slate-100 dark:border-slate-800">
                  <div>
                    <p className="text-sm font-medium">
                      {ch === 'APP'
                        ? 'App e Sino Web'
                        : ch === 'PUSH'
                          ? 'Notificações Push (iOS / Android)'
                          : ch === 'EMAIL'
                            ? 'E-mail (alertas@sinarc.com.br)'
                            : 'WhatsApp oficial SINARC (planos pagos)'}
                    </p>
                    {ch === 'WHATSAPP' && (
                      <p className="text-xs text-slate-500 max-w-xl mt-0.5">{whatsappOptInText}</p>
                    )}
                  </div>
                  <input
                    type="checkbox"
                    disabled={ch === 'APP'}
                    checked={ch === 'APP' ? true : current}
                    onChange={async (e) => {
                      const next = e.target.checked;
                      await apiFetch('/api/preferences', {
                        method: 'PUT',
                        body: JSON.stringify({
                          channels: { [ch]: next },
                          ...(ch === 'WHATSAPP' ? { whatsappOptIn: next } : {}),
                        }),
                      });
                      await onRefreshAll();
                    }}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                </div>
              );
            })}
          </div>

          {/* UFs por empresa (RN-05) */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-6 space-y-4">
            <h3 className="text-sm font-semibold">UFs que eu recebo por empresa</h3>
            {me.companies.map((c) => (
              <div key={c.id} className="space-y-2 pb-4 border-b last:border-b-0 border-slate-100 dark:border-slate-800">
                <p className="text-sm font-medium">{c.nome_fantasia || c.razao_social}</p>
                <div className="flex flex-wrap gap-2">
                  {c.ufs.map((u) => {
                    const active = c.myPrefs.find((p) => p.uf_sigla === u.uf_sigla)?.ativo !== 0;
                    return (
                      <button
                        key={u.uf_sigla}
                        type="button"
                        onClick={async () => {
                          await apiFetch('/api/preferences', {
                            method: 'PUT',
                            body: JSON.stringify({
                              companyUfPrefs: [
                                {
                                  company_id: c.id,
                                  prefs: [{ uf_sigla: u.uf_sigla, ativo: !active }],
                                },
                              ],
                            }),
                          });
                          await onRefreshAll();
                        }}
                        className={`px-3 py-1.5 rounded-md border text-xs font-mono ${
                          active
                            ? 'bg-[#0B1F3A] text-white border-[#0B1F3A]'
                            : 'border-slate-300 dark:border-slate-700 text-slate-500'
                        }`}
                      >
                        {u.uf_sigla} ({u.kind === 'CREDENCIADA' ? 'Obr.' : 'Oport.'})
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* TELA 9: PLANOS E PAGAMENTO */}
      {activeTab === 'plans' && (
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="font-display text-xl font-bold">Planos e pagamento</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Cobrança em BRL pela Bio Síntese por empresa monitorada. Anual equivale a 10 meses.
              </p>
            </div>
            <div className="inline-flex p-1 bg-slate-100 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 self-start">
              <button
                type="button"
                onClick={() => setSelectedCycle('MENSAL')}
                className={`px-3.5 py-1.5 text-xs font-medium rounded-md ${
                  selectedCycle === 'MENSAL' ? 'bg-white dark:bg-slate-800 shadow-sm' : 'text-slate-500'
                }`}
              >
                Mensal
              </button>
              <button
                type="button"
                onClick={() => setSelectedCycle('ANUAL')}
                className={`px-3.5 py-1.5 text-xs font-medium rounded-md ${
                  selectedCycle === 'ANUAL' ? 'bg-white dark:bg-slate-800 shadow-sm' : 'text-slate-500'
                }`}
              >
                Anual (10×)
              </button>
            </div>
          </div>

          {/* Matriz comparativa FREE / PRO / NACIONAL */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-6 space-y-3">
              <p className="text-xs font-semibold text-slate-500">Para conhecer a plataforma</p>
              <h3 className="font-display text-xl font-bold">FREE</h3>
              <p className="font-mono text-2xl font-bold tabular-nums">R$ 0,00</p>
              <ul className="text-sm text-slate-600 dark:text-slate-300 space-y-1.5 pt-2">
                <li>· UFs ilimitadas (visualização superficial)</li>
                <li>· Resumo semanal às segundas 8h por e-mail</li>
                <li>· Sem resumo completo, prazo, checklist ou PDF</li>
                <li>· Sem WhatsApp e sem lembretes 30/7/1</li>
              </ul>
            </div>

            <div
              onClick={() => setSelectedPlan('PRO')}
              className={`border rounded-2xl bg-white dark:bg-slate-900 p-6 space-y-3 cursor-pointer transition-colors ${
                selectedPlan === 'PRO'
                  ? 'border-[#0B1F3A] dark:border-sky-500 ring-1 ring-[#0B1F3A]'
                  : 'border-slate-200 dark:border-slate-800'
              }`}
            >
              <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                Para operação regional focada
              </p>
              <h3 className="font-display text-xl font-bold">PRO</h3>
              <p className="font-mono text-2xl font-bold tabular-nums">
                {formatCurrencyBrl(
                  selectedCycle === 'MENSAL'
                    ? billingSettings.pro_monthly_cents
                    : billingSettings.pro_annual_cents
                )}
                <span className="text-xs font-normal text-slate-500">
                  {' '}
                  / empresa / {selectedCycle === 'MENSAL' ? 'mês' : 'ano'}
                </span>
              </p>
              <ul className="text-sm text-slate-600 dark:text-slate-300 space-y-1.5 pt-2">
                <li>· Até 5 UFs por empresa (credenciadas + interesse)</li>
                <li>· Resumo completo, checklist oficial e PDF assinado</li>
                <li>· WhatsApp oficial, e-mail imediato/diário e push</li>
                <li>· Lembretes automáticos em 30, 7 e 1 dia</li>
              </ul>
            </div>

            <div
              onClick={() => setSelectedPlan('NACIONAL')}
              className={`border rounded-2xl bg-white dark:bg-slate-900 p-6 space-y-3 cursor-pointer transition-colors ${
                selectedPlan === 'NACIONAL'
                  ? 'border-[#0B1F3A] dark:border-sky-500 ring-1 ring-[#0B1F3A]'
                  : 'border-slate-200 dark:border-slate-800'
              }`}
            >
              <p className="text-xs font-semibold text-sky-700 dark:text-sky-400">
                Para cobertura completa no país
              </p>
              <h3 className="font-display text-xl font-bold">NACIONAL</h3>
              <p className="font-mono text-2xl font-bold tabular-nums">
                {formatCurrencyBrl(
                  selectedCycle === 'MENSAL'
                    ? billingSettings.nacional_monthly_cents
                    : billingSettings.nacional_annual_cents
                )}
                <span className="text-xs font-normal text-slate-500">
                  {' '}
                  / empresa / {selectedCycle === 'MENSAL' ? 'mês' : 'ano'}
                </span>
              </p>
              <ul className="text-sm text-slate-600 dark:text-slate-300 space-y-1.5 pt-2">
                <li>· Todas as 27 UFs por empresa</li>
                <li>· Todos os recursos completos, checklist e PDF</li>
                <li>· WhatsApp, e-mail, push e lembretes 30/7/1</li>
                <li>· Usuários ilimitados por empresa</li>
              </ul>
            </div>
          </div>

          {/* Simulador + Checkout */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-base font-bold">
                Empresas incluídas na assinatura ({selectedPlan} · {selectedCycle})
              </h3>
              <span className="text-xs text-slate-500 tabular-nums">
                {founderLocked
                  ? 'Preço de fundador travado neste perfil'
                  : `Vagas de fundador restantes: ${Math.max(0, billingSettings.founder_limit - billingSettings.founders_taken)}/${billingSettings.founder_limit}`}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {me.companies
                .filter((c) => c.is_owner === 1)
                .map((c) => {
                  const checked = selectedPlanCompanyIds.includes(c.id);
                  return (
                    <label
                      key={c.id}
                      className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center justify-between cursor-pointer text-sm"
                    >
                      <span>
                        {c.nome_fantasia || c.razao_social} ({c.ufs.length} UFs)
                      </span>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setSelectedPlanCompanyIds((prev) =>
                            prev.includes(c.id) ? prev.filter((id) => id !== c.id) : [...prev, c.id]
                          )
                        }
                        className="h-4 w-4 rounded border-slate-300"
                      />
                    </label>
                  );
                })}
            </div>

            <div className="pt-4 border-t border-slate-100 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-0.5 text-sm">
                <p>
                  Subtotal ({planQuote.count} empresa(s)):{' '}
                  <span className="font-mono tabular-nums">{formatCurrencyBrl(planQuote.subtotalCents)}</span>
                </p>
                {planQuote.discountPct > 0 && (
                  <p className="text-emerald-700 dark:text-emerald-400">
                    Desconto por volume ({planQuote.discountPct}% para{' '}
                    {planQuote.count >= 10 ? '10+' : '5 a 9'} empresas) aplicado!
                  </p>
                )}
                <p className="text-lg font-bold">
                  Total:{' '}
                  <span className="font-mono tabular-nums">{formatCurrencyBrl(planQuote.totalCents)}</span>
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const res = await apiFetch<{ url: string }>('/api/billing/portal', { method: 'POST' });
                      window.location.assign(res.url);
                    } catch (err) {
                      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Portal indisponível.' });
                    }
                  }}
                  className="px-4 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 text-sm font-medium"
                >
                  Portal da Stripe
                </button>
                <button
                  type="button"
                  disabled={busy || selectedPlanCompanyIds.length === 0}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const res = await apiFetch<{ checkoutUrl?: string }>('/api/billing/checkout', {
                        method: 'POST',
                        body: JSON.stringify({
                          companyIds: selectedPlanCompanyIds,
                          plan: selectedPlan,
                          cycle: selectedCycle,
                        }),
                      });
                      if (res.checkoutUrl) {
                        window.location.assign(res.checkoutUrl);
                      }
                    } catch (err) {
                      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro no checkout.' });
                    } finally {
                      setBusy(false);
                    }
                  }}
                  className="px-5 py-2.5 rounded-lg bg-[#0B1F3A] text-white text-sm font-semibold disabled:opacity-40"
                >
                  Assinar na Stripe
                </button>
              </div>
            </div>
          </div>

          {me.invoices.length > 0 && (
            <div className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-6 space-y-3">
              <h3 className="text-base font-bold">Notas Fiscais emitidas</h3>
              <div className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
                {me.invoices.map((inv) => (
                  <div key={inv.id} className="py-2.5 flex items-center justify-between">
                    <span className="font-mono text-xs">{inv.stripe_invoice_id}</span>
                    <span>{inv.status}</span>
                    <span className="tabular-nums text-xs text-slate-500">{formatDateBr(inv.created_at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TELA 10: MINHA CONTA / PRIVACIDADE (LGPD) */}
      {activeTab === 'account' && (
        <div className="space-y-6 max-w-3xl">
          <h2 className="font-display text-xl font-bold">Minha conta e privacidade (LGPD)</h2>

          <div className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-6 space-y-2 text-sm">
            <p>
              <strong>Nome:</strong> {me.user.nome}
            </p>
            <p>
              <strong>E-mail:</strong> {me.user.email}
            </p>
            <p>
              <strong>Celular:</strong> <span className="font-mono">{me.user.celular_e164}</span>
            </p>
            <p>
              <strong>Termos aceitos:</strong> versão {me.user.terms_version_accepted || '—'} em{' '}
              {formatDateBr(me.user.terms_accepted_at)}
            </p>
          </div>

          {/* 2FA opcional */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Shield className="w-5 h-5 text-[#0B1F3A] dark:text-sky-400" />
                <div>
                  <h3 className="text-sm font-semibold">Autenticação em duas etapas (2FA)</h3>
                  <p className="text-xs text-slate-500">
                    {me.user.mfa_enabled ? 'Ativada nesta conta.' : 'Opcional para clientes; obrigatória para curadores e admins.'}
                  </p>
                </div>
              </div>
              {!me.user.mfa_enabled && !mfaSetup && (
                <button
                  type="button"
                  onClick={async () => {
                    const res = await apiFetch<{ totpSecret: string; otpauthUrl: string }>(
                      '/api/auth/mfa/enable-request',
                      { method: 'POST' }
                    );
                    setMfaSetup({ secret: res.totpSecret, otpauthUrl: res.otpauthUrl });
                  }}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-semibold"
                >
                  Ativar 2FA
                </button>
              )}
            </div>

            {mfaSetup && (
              <div className="space-y-3 pt-2 border-t border-slate-100 dark:border-slate-800">
                <p className="text-xs text-slate-600 dark:text-slate-300">
                  Chave TOTP: <code className="font-mono bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded">{mfaSetup.secret}</code>
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    maxLength={6}
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value)}
                    placeholder="Código de 6 dígitos"
                    className="px-3 py-2 text-sm font-mono border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      await apiFetch('/api/auth/mfa/setup-confirm', {
                        method: 'POST',
                        body: JSON.stringify({ totpCode: mfaCode }),
                      });
                      setMfaSetup(null);
                      await onRefreshAll();
                      setFeedback({ type: 'ok', msg: '2FA ativada com sucesso.' });
                    }}
                    className="px-4 py-2 rounded-lg bg-[#0B1F3A] text-white text-xs font-semibold"
                  >
                    Confirmar
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Exportação e Exclusão LGPD */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-6 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">Exportar meus dados (LGPD)</h3>
                <p className="text-xs text-slate-500">
                  Baixe seus dados pessoais, empresas, consentimentos e alertas em JSON e CSV.
                </p>
              </div>
              <button
                type="button"
                onClick={async () => {
                  const res = await apiFetch<{ json: unknown; csv: string }>('/api/lgpd/export', {
                    method: 'POST',
                  });
                  const blob = new Blob([JSON.stringify(res.json, null, 2)], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `sinarc-dados-lgpd.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                  setFeedback({ type: 'ok', msg: 'Exportação concluída e registrada na auditoria.' });
                }}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-semibold whitespace-nowrap"
              >
                <Download className="w-4 h-4" /> Baixar JSON
              </button>
            </div>

            <div className="pt-4 border-t border-slate-100 dark:border-slate-800 space-y-3">
              <h3 className="text-sm font-semibold text-red-700 dark:text-red-400">
                Excluir minha conta
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Seus dados pessoais serão anonimizados em conformidade com a LGPD (RN-32). Atos públicos e registros fiscais obrigatórios permanecem preservados. Digite <strong>EXCLUIR</strong> para confirmar:
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={deleteConfirmText}
                  onChange={(e) => setDeleteConfirmText(e.target.value)}
                  placeholder="Digite EXCLUIR"
                  className="px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                />
                <button
                  type="button"
                  disabled={deleteConfirmText.trim().toUpperCase() !== 'EXCLUIR'}
                  onClick={async () => {
                    await apiFetch('/api/lgpd/delete-account', { method: 'POST' });
                    onLoggedOut();
                  }}
                  className="px-4 py-2 rounded-lg bg-red-700 text-white text-xs font-semibold disabled:opacity-40"
                >
                  Confirmar exclusão
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
