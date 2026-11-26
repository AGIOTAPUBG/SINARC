import { useEffect, useMemo, useState } from 'react';
import { Play, Plus, Search, Trash2 } from 'lucide-react';
import { formatCnpj } from '../../packages/shared/cnpj.ts';
import { formatCurrencyBrl, formatDateBr } from '../../packages/shared/rules.ts';
import type {
  BillingSettings,
  ChecklistCatalogItem,
  SegmentRecord,
  UfRecord,
} from '../../packages/shared/types.ts';
import { apiFetch } from '../lib/api.ts';

interface AdminOverviewPayload {
  metrics: {
    profilesTotal: number;
    companiesFree: number;
    companiesPaid: number;
    conversionRatePct: number;
    mrrCents: number;
    canceledCompanies: number;
    avgSlaHours: number;
    deliveriesByChannel: Array<{ channel: string; status: string; count: number }>;
  };
  clients: Array<{
    profile_id: string;
    profile_nome: string;
    owner_nome: string;
    owner_email: string;
    founder_price_locked: number;
    founder_number: number | null;
    companies: Array<{
      id: string;
      cnpj: string;
      razao_social: string;
      segment_code: string;
      plan: string;
      plan_status: string;
    }>;
  }>;
  curators: Array<{
    user_id: string;
    email: string;
    nome: string;
    role: string;
    mfa_required: number;
    mfa_enabled: number;
  }>;
  watchTargets: Array<{
    id: string;
    uf_sigla: string;
    url: string;
    descricao: string;
    ativo: number;
    ultima_verificacao: string | null;
  }>;
  catalog: ChecklistCatalogItem[];
  auditLogs: Array<{
    id: string;
    actor_email: string | null;
    actor_nome: string | null;
    acao: string;
    entidade: string;
    entidade_id: string;
    em: string;
  }>;
  settings: BillingSettings;
}

interface AdminWorkspaceProps {
  ufs: UfRecord[];
  segments: SegmentRecord[];
}

export function AdminWorkspace({ ufs, segments }: AdminWorkspaceProps) {
  const [tab, setTab] = useState<'metrics' | 'clients' | 'curators' | 'targets' | 'catalog' | 'audit' | 'settings'>('metrics');
  const [data, setData] = useState<AdminOverviewPayload | null>(null);
  const [clientQuery, setClientQuery] = useState('');
  const [auditQuery, setAuditQuery] = useState('');
  const [feedback, setFeedback] = useState('');

  // Forms
  const [curNome, setCurNome] = useState('');
  const [curEmail, setCurEmail] = useState('');
  const [curPassword, setCurPassword] = useState('');

  const [wtUf, setWtUf] = useState('GO');
  const [wtUrl, setWtUrl] = useState('');
  const [wtDesc, setWtDesc] = useState('');

  const [catCode, setCatCode] = useState('');
  const [catTitle, setCatTitle] = useState('');
  const [catDesc, setCatDesc] = useState('');
  const [catBloco, setCatBloco] = useState('Habilitação Jurídica');
  const [catNorma, setCatNorma] = useState('CONTRAN 807');
  const [catSeg, setCatSeg] = useState('');
  const [catUf, setCatUf] = useState('');

  const [proMonthly, setProMonthly] = useState(29700);
  const [nacMonthly, setNacMonthly] = useState(59700);
  const [disc5, setDisc5] = useState(15);
  const [disc10, setDisc10] = useState(25);
  const [founderLimit, setFounderLimit] = useState(30);

  const loadData = async () => {
    const res = await apiFetch<AdminOverviewPayload>('/api/admin/overview');
    setData(res);
    setProMonthly(res.settings.pro_monthly_cents);
    setNacMonthly(res.settings.nacional_monthly_cents);
    setDisc5(res.settings.discount_5_to_9_pct);
    setDisc10(res.settings.discount_10_plus_pct);
    setFounderLimit(res.settings.founder_limit);
  };

  useEffect(() => {
    void loadData();
  }, []);

  const filteredClients = useMemo(() => {
    if (!data) return [];
    const q = clientQuery.trim().toLowerCase();
    if (!q) return data.clients;
    return data.clients.filter(
      (c) =>
        c.owner_nome.toLowerCase().includes(q) ||
        c.owner_email.toLowerCase().includes(q) ||
        c.companies.some((co) => co.cnpj.includes(q.replace(/\D/g, '')) || co.razao_social.toLowerCase().includes(q))
    );
  }, [data, clientQuery]);

  const filteredLogs = useMemo(() => {
    if (!data) return [];
    const q = auditQuery.trim().toLowerCase();
    if (!q) return data.auditLogs;
    return data.auditLogs.filter(
      (l) =>
        l.acao.toLowerCase().includes(q) ||
        l.entidade.toLowerCase().includes(q) ||
        (l.actor_email || '').toLowerCase().includes(q)
    );
  }, [data, auditQuery]);

  if (!data) {
    return (
      <div className="p-8 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 text-sm text-slate-500">
        Carregando painel administrativo...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold">Administração SINARC</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Métricas executivas, clientes, equipe de curadoria, alvos de vigilância, catálogo e auditoria imutável.
        </p>
      </div>

      <div className="flex flex-wrap gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 w-fit">
        {(
          [
            ['metrics', 'Métricas'],
            ['clients', 'Clientes'],
            ['curators', 'Curadores'],
            ['targets', 'Vigilância'],
            ['catalog', 'Catálogo'],
            ['audit', 'Auditoria'],
            ['settings', 'Configurações'],
          ] as const
        ).map(([k, lbl]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
              tab === k ? 'bg-white dark:bg-slate-800 shadow-sm text-slate-900 dark:text-white' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            {lbl}
          </button>
        ))}
      </div>

      {feedback && (
        <div className="p-3 rounded-xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/40 dark:border-emerald-900 text-sm text-emerald-800 dark:text-emerald-300">
          {feedback}
        </div>
      )}

      {tab === 'metrics' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 p-4">
              <p className="text-xs text-slate-500">Perfis / Empresas FREE / Pagas</p>
              <p className="font-mono text-xl font-bold tabular-nums mt-1">
                {data.metrics.profilesTotal} / {data.metrics.companiesFree} / {data.metrics.companiesPaid}
              </p>
            </div>
            <div className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 p-4">
              <p className="text-xs text-slate-500">MRR · Conversão FREE→Pago</p>
              <p className="font-mono text-xl font-bold tabular-nums mt-1">
                {formatCurrencyBrl(data.metrics.mrrCents)} · {data.metrics.conversionRatePct}%
              </p>
            </div>
            <div className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 p-4">
              <p className="text-xs text-slate-500">SLA médio publicação (meta 24h úteis)</p>
              <p className="font-mono text-xl font-bold tabular-nums mt-1">{data.metrics.avgSlaHours}h</p>
            </div>
            <div className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 p-4">
              <p className="text-xs text-slate-500">Cancelamentos</p>
              <p className="font-mono text-xl font-bold tabular-nums mt-1">{data.metrics.canceledCompanies}</p>
            </div>
          </div>

          <div className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold">Entregas por canal</h2>
              <button
                type="button"
                onClick={async () => {
                  const res = await apiFetch<{ processed: number; sent: number }>('/api/admin/deliveries/process-now', {
                    method: 'POST',
                  });
                  setFeedback(`Fila processada: ${res.sent} envio(s) de ${res.processed} pendente(s).`);
                  await loadData();
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#0B1F3A] text-white text-xs font-semibold"
              >
                <Play className="w-3.5 h-3.5" /> Processar fila agora
              </button>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
              {data.metrics.deliveriesByChannel.length === 0 ? (
                <p className="py-3 text-slate-500">Nenhuma entrega registrada ainda.</p>
              ) : (
                data.metrics.deliveriesByChannel.map((row, i) => (
                  <div key={i} className="py-2 flex items-center justify-between">
                    <span className="font-mono font-semibold">{row.channel}</span>
                    <span>{row.status}</span>
                    <span className="font-mono tabular-nums font-bold">{row.count}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'clients' && (
        <div className="space-y-4">
          <div className="relative max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={clientQuery}
              onChange={(e) => setClientQuery(e.target.value)}
              placeholder="Buscar por CNPJ, razão social, nome ou e-mail..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900"
            />
          </div>
          <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900">
            {filteredClients.map((cl) => (
              <div key={cl.profile_id} className="p-4 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <div>
                    <span className="font-semibold">{cl.owner_nome}</span>
                    <span className="text-slate-500 ml-2">{cl.owner_email}</span>
                  </div>
                  {cl.founder_price_locked === 1 && (
                    <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                      Fundador #{cl.founder_number}
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-600 dark:text-slate-400 space-y-1">
                  {cl.companies.map((co) => (
                    <p key={co.id}>
                      <span className="font-mono tabular-nums">{formatCnpj(co.cnpj)}</span> · {co.razao_social} ·{' '}
                      {co.segment_code} · <strong>{co.plan}</strong> ({co.plan_status})
                    </p>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'curators' && (
        <div className="space-y-5 max-w-2xl">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/admin/curators', {
                method: 'POST',
                body: JSON.stringify({ nome: curNome, email: curEmail, password: curPassword }),
              });
              setCurNome('');
              setCurEmail('');
              setCurPassword('');
              setFeedback('Curador criado com exigência obrigatória de 2FA no primeiro login.');
              await loadData();
            }}
            className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 p-5 space-y-3"
          >
            <h2 className="text-sm font-bold">Adicionar curador (2FA obrigatória)</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input
                type="text"
                required
                value={curNome}
                onChange={(e) => setCurNome(e.target.value)}
                placeholder="Nome"
                className="px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
              />
              <input
                type="email"
                required
                value={curEmail}
                onChange={(e) => setCurEmail(e.target.value)}
                placeholder="E-mail"
                className="px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
              />
              <input
                type="password"
                required
                minLength={8}
                value={curPassword}
                onChange={(e) => setCurPassword(e.target.value)}
                placeholder="Senha inicial (min 8)"
                className="px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
              />
            </div>
            <button type="submit" className="px-4 py-2 rounded-lg bg-[#0B1F3A] text-white text-xs font-semibold">
              Criar curador
            </button>
          </form>

          <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900">
            {data.curators.map((cu) => (
              <div key={cu.user_id} className="p-4 flex items-center justify-between text-sm">
                <div>
                  <p className="font-semibold">{cu.nome}</p>
                  <p className="text-xs text-slate-500">
                    {cu.email} · {cu.role} · 2FA {cu.mfa_enabled ? 'Ativa' : 'Pendente'}
                  </p>
                </div>
                {cu.role === 'CURADOR' && (
                  <button
                    type="button"
                    onClick={async () => {
                      await apiFetch(`/api/admin/curators/${cu.user_id}`, { method: 'DELETE' });
                      await loadData();
                    }}
                    className="text-xs text-red-600 hover:underline inline-flex items-center gap-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Remover
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'targets' && (
        <div className="space-y-5">
          <div className="flex justify-between items-center">
            <h2 className="text-sm font-bold">Páginas monitoradas pelo robô de vigilância</h2>
            <button
              type="button"
              onClick={async () => {
                const res = await apiFetch<{ checked: number; suggestionsCreated: number }>(
                  '/api/admin/watch-targets/run-now',
                  { method: 'POST' }
                );
                setFeedback(`Ciclo executado: ${res.checked} página(s) verificada(s), ${res.suggestionsCreated} nova(s) sugestão(ões).`);
                await loadData();
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#0B1F3A] text-white text-xs font-semibold"
            >
              <Play className="w-3.5 h-3.5" /> Rodar vigilância agora
            </button>
          </div>

          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/admin/watch-targets', {
                method: 'POST',
                body: JSON.stringify({ uf_sigla: wtUf, url: wtUrl, descricao: wtDesc }),
              });
              setWtUrl('');
              setWtDesc('');
              await loadData();
            }}
            className="grid grid-cols-1 sm:grid-cols-4 gap-2 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 p-4"
          >
            <select
              value={wtUf}
              onChange={(e) => setWtUf(e.target.value)}
              className="px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
            >
              {ufs.map((u) => (
                <option key={u.sigla} value={u.sigla}>
                  {u.sigla}
                </option>
              ))}
            </select>
            <input
              type="url"
              required
              value={wtUrl}
              onChange={(e) => setWtUrl(e.target.value)}
              placeholder="https://..."
              className="px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
            />
            <input
              type="text"
              required
              value={wtDesc}
              onChange={(e) => setWtDesc(e.target.value)}
              placeholder="Descrição do alvo"
              className="px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
            />
            <button type="submit" className="px-4 py-2 rounded-lg bg-[#0B1F3A] text-white text-xs font-semibold">
              Adicionar alvo
            </button>
          </form>

          <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 text-xs">
            {data.watchTargets.map((wt) => (
              <div key={wt.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <span className="font-mono font-bold text-slate-900 dark:text-white">{wt.uf_sigla}</span> ·{' '}
                  <span className="font-medium">{wt.descricao}</span>
                  <p className="text-slate-500 truncate max-w-xl">{wt.url}</p>
                </div>
                <span className="text-slate-500 tabular-nums">
                  Última verificação: {wt.ultima_verificacao ? formatDateBr(wt.ultima_verificacao) : 'Nunca'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'catalog' && (
        <div className="space-y-5">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await apiFetch('/api/admin/catalog', {
                method: 'POST',
                body: JSON.stringify({
                  codigo: catCode,
                  titulo: catTitle,
                  descricao: catDesc,
                  bloco: catBloco,
                  base_normativa: catNorma,
                  segment_code: catSeg || null,
                  uf_sigla: catUf || null,
                }),
              });
              setCatCode('');
              setCatTitle('');
              setCatDesc('');
              await loadData();
            }}
            className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 p-4 space-y-3"
          >
            <h2 className="text-sm font-bold">Novo item no catálogo de checklist</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <input
                type="text"
                required
                value={catCode}
                onChange={(e) => setCatCode(e.target.value)}
                placeholder="Código (ex: CONTRAN807-EXT-01)"
                className="px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
              />
              <input
                type="text"
                required
                value={catBloco}
                onChange={(e) => setCatBloco(e.target.value)}
                placeholder="Bloco"
                className="px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
              />
              <input
                type="text"
                required
                value={catNorma}
                onChange={(e) => setCatNorma(e.target.value)}
                placeholder="Base normativa"
                className="px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
              />
              <input
                type="text"
                required
                value={catTitle}
                onChange={(e) => setCatTitle(e.target.value)}
                placeholder="Título do documento/exigência"
                className="sm:col-span-2 px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
              />
              <select
                value={catSeg}
                onChange={(e) => setCatSeg(e.target.value)}
                className="px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
              >
                <option value="">Todos os segmentos</option>
                {segments.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                required
                value={catDesc}
                onChange={(e) => setCatDesc(e.target.value)}
                placeholder="Descrição detalhada"
                className="flex-1 px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
              />
              <select
                value={catUf}
                onChange={(e) => setCatUf(e.target.value)}
                className="px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
              >
                <option value="">Nacional (todas UFs)</option>
                {ufs.map((u) => (
                  <option key={u.sigla} value={u.sigla}>
                    {u.sigla}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="inline-flex items-center gap-1 px-4 py-2 rounded-lg bg-[#0B1F3A] text-white text-xs font-semibold"
              >
                <Plus className="w-3.5 h-3.5" /> Adicionar
              </button>
            </div>
          </form>

          <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 text-xs">
            {data.catalog.map((c) => (
              <div key={c.id} className="p-3.5">
                <p className="font-semibold text-slate-900 dark:text-white">
                  <span className="font-mono">{c.codigo}</span> · {c.titulo}
                </p>
                <p className="text-slate-500 mt-0.5">
                  {c.bloco} · {c.base_normativa} · {c.segment_code || 'Todos'} · {c.uf_sigla || 'Nacional'}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'audit' && (
        <div className="space-y-4">
          <div className="relative max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={auditQuery}
              onChange={(e) => setAuditQuery(e.target.value)}
              placeholder="Filtrar por pessoa, ação ou entidade..."
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900"
            />
          </div>
          <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 text-xs">
            {filteredLogs.map((l) => (
              <div key={l.id} className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <span className="font-mono font-semibold text-slate-900 dark:text-white">{l.acao}</span> ·{' '}
                  <span>{l.entidade}</span> ({l.entidade_id.slice(0, 12)})
                  <p className="text-slate-500">Ator: {l.actor_email || 'Sistema / Cron'}</p>
                </div>
                <span className="font-mono tabular-nums text-slate-500">{formatDateBr(l.em)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'settings' && (
        <div className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-6 space-y-4 max-w-xl">
          <h2 className="text-base font-bold">Preços, descontos e vagas de fundador</h2>
          <p className="text-xs text-slate-500 tabular-nums">
            Vagas de fundador ocupadas: {data.settings.founders_taken} / {data.settings.founder_limit}
          </p>

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <label className="block text-xs font-medium mb-1">PRO Mensal (centavos BRL)</label>
              <input
                type="number"
                value={proMonthly}
                onChange={(e) => setProMonthly(Number(e.target.value))}
                className="w-full px-3 py-2 font-mono border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">NACIONAL Mensal (centavos BRL)</label>
              <input
                type="number"
                value={nacMonthly}
                onChange={(e) => setNacMonthly(Number(e.target.value))}
                className="w-full px-3 py-2 font-mono border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Desconto 5–9 empresas (%)</label>
              <input
                type="number"
                value={disc5}
                onChange={(e) => setDisc5(Number(e.target.value))}
                className="w-full px-3 py-2 font-mono border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Desconto 10+ empresas (%)</label>
              <input
                type="number"
                value={disc10}
                onChange={(e) => setDisc10(Number(e.target.value))}
                className="w-full px-3 py-2 font-mono border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Limite vagas fundador</label>
              <input
                type="number"
                value={founderLimit}
                onChange={(e) => setFounderLimit(Number(e.target.value))}
                className="w-full px-3 py-2 font-mono border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={async () => {
              await apiFetch('/api/admin/settings', {
                method: 'PUT',
                body: JSON.stringify({
                  pro_monthly_cents: proMonthly,
                  pro_annual_cents: proMonthly * 10,
                  nacional_monthly_cents: nacMonthly,
                  nacional_annual_cents: nacMonthly * 10,
                  discount_5_to_9_pct: disc5,
                  discount_10_plus_pct: disc10,
                  founder_limit: founderLimit,
                }),
              });
              setFeedback('Configurações salvas (anual recalculado em 10× mensal conforme RN-26).');
              await loadData();
            }}
            className="px-5 py-2 rounded-lg bg-[#0B1F3A] text-white text-sm font-semibold"
          >
            Salvar configurações
          </button>
        </div>
      )}
    </div>
  );
}
