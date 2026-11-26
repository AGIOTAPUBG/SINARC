import { useCallback, useEffect, useState } from 'react';
import { Bell, LogOut, Moon, Sun } from 'lucide-react';
import type { AlertItem, BillingSettings } from '../packages/shared/types.ts';
import { DEFAULT_BILLING_SETTINGS, formatDateBr } from '../packages/shared/rules.ts';
import { AdminWorkspace } from './components/AdminWorkspace.tsx';
import { AuthOnboarding, type ReferencePayload } from './components/AuthOnboarding.tsx';
import { ClientWorkspace, type ClientTab, type MePayload } from './components/ClientWorkspace.tsx';
import { CuratorWorkspace } from './components/CuratorWorkspace.tsx';
import { RadarLogo } from './components/RadarLogo.tsx';
import { apiFetch, getAuthToken, setAuthToken } from './lib/api.ts';

interface FullReferenceResponse extends ReferencePayload {
  billingSettings: BillingSettings;
}

export default function App() {
  const [dark, setDark] = useState(false);
  const [reference, setReference] = useState<FullReferenceResponse | null>(null);
  const [me, setMe] = useState<MePayload | null>(null);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [historyAlerts, setHistoryAlerts] = useState<AlertItem[]>([]);

  const [workspaceMode, setWorkspaceMode] = useState<'client' | 'curator' | 'admin'>('client');
  const [clientTab, setClientTab] = useState<ClientTab>('feed');
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null);
  const [pendingDeepLinkActId, setPendingDeepLinkActId] = useState<string | null>(() => {
    const m = /^\/a\/([^/]+)$/.exec(window.location.pathname);
    return m ? m[1] : null;
  });
  const [showBell, setShowBell] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);

  const loadReference = useCallback(async () => {
    const ref = await apiFetch<FullReferenceResponse>('/api/reference');
    setReference(ref);
  }, []);

  const refreshAll = useCallback(async () => {
    if (!getAuthToken()) return;
    const [meRes, feedRes, histRes] = await Promise.all([
      apiFetch<MePayload>('/api/me'),
      apiFetch<{ alerts: AlertItem[] }>('/api/alerts?scope=feed'),
      apiFetch<{ alerts: AlertItem[] }>('/api/alerts?scope=history'),
    ]);
    setMe(meRes);
    setAlerts(feedRes.alerts);
    setHistoryAlerts(histRes.alerts);
    await loadReference();
  }, [loadReference]);

  useEffect(() => {
    void (async () => {
      try {
        await loadReference();
      } finally {
        setLoading(false);
      }
    })();
  }, [loadReference]);

  // Polling periódico de notificações para o sino em tempo real na web
  useEffect(() => {
    if (!me) return;
    const timer = setInterval(() => {
      void apiFetch<{ alerts: AlertItem[] }>('/api/alerts?scope=feed')
        .then((res) => setAlerts(res.alerts))
        .catch(() => undefined);
    }, 25_000);
    return () => clearInterval(timer);
  }, [me]);

  const handleAuthenticated = async (initialView?: 'feed' | 'plans') => {
    await refreshAll();
    const freshMe = await apiFetch<MePayload>('/api/me');
    setMe(freshMe);

    if (freshMe.user.role === 'ADMIN') {
      setWorkspaceMode('admin');
    } else if (freshMe.user.role === 'CURADOR') {
      setWorkspaceMode('curator');
    } else {
      setWorkspaceMode('client');
      setClientTab(initialView === 'plans' ? 'plans' : 'feed');
    }

    if (pendingDeepLinkActId) {
      setSelectedAlertId(pendingDeepLinkActId);
      setPendingDeepLinkActId(null);
      window.history.replaceState({}, '', '/');
    }
  };

  const handleLogout = () => {
    setAuthToken(null);
    setMe(null);
    setAlerts([]);
    setHistoryAlerts([]);
    setSelectedAlertId(null);
    setWorkspaceMode('client');
    setClientTab('feed');
  };

  if (loading || !reference) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 text-sm text-slate-500">
        Carregando SINARC...
      </div>
    );
  }

  if (!me) {
    return (
      <AuthOnboarding
        reference={reference}
        dark={dark}
        onToggleDark={() => setDark((d) => !d)}
        onAuthenticated={handleAuthenticated}
        onRefreshReference={() => void loadReference()}
      />
    );
  }

  const unreadAlerts = alerts.filter((a) => a.status === 'NOVO');
  const isTeam = me.user.role === 'CURADOR' || me.user.role === 'ADMIN';

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
      {/* Top Bar Contract: 3 zonas — Wordmark | Links de navegação em linha única | Ação primária */}
      <header className="sticky top-0 z-30 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
          {/* Zona 1: Brand title */}
          <button
            type="button"
            onClick={() => {
              setSelectedAlertId(null);
              if (workspaceMode === 'client') setClientTab('feed');
            }}
            className="flex items-center gap-2.5 text-[#0B1F3A] dark:text-white whitespace-nowrap shrink-0"
          >
            <RadarLogo size={24} />
            <span className="font-display text-lg font-bold tracking-tight">SINARC</span>
          </button>

          {/* Zona 2: Nav links */}
          {workspaceMode === 'client' ? (
            <nav className="hidden md:flex items-center gap-6 text-sm font-medium">
              {(
                [
                  ['feed', 'Início'],
                  ['history', 'Histórico'],
                  ['companies', 'Empresas'],
                  ['preferences', 'Preferências'],
                  ['plans', 'Planos'],
                ] as Array<[ClientTab, string]>
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setSelectedAlertId(null);
                    setClientTab(key);
                  }}
                  className={`whitespace-nowrap shrink-0 transition-colors ${
                    clientTab === key && !selectedAlertId
                      ? 'text-[#0B1F3A] dark:text-white underline underline-offset-8 decoration-2'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>
          ) : (
            <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-300">
              {me.user.role === 'ADMIN' && (
                <button
                  type="button"
                  onClick={() => setWorkspaceMode('admin')}
                  className={`whitespace-nowrap shrink-0 ${
                    workspaceMode === 'admin' ? 'text-[#0B1F3A] dark:text-white underline underline-offset-8 decoration-2' : ''
                  }`}
                >
                  Administração
                </button>
              )}
              {isTeam && (
                <button
                  type="button"
                  onClick={() => setWorkspaceMode('curator')}
                  className={`whitespace-nowrap shrink-0 ${
                    workspaceMode === 'curator' ? 'text-[#0B1F3A] dark:text-white underline underline-offset-8 decoration-2' : ''
                  }`}
                >
                  Curadoria
                </button>
              )}
              <button
                type="button"
                onClick={() => setWorkspaceMode('client')}
                className="whitespace-nowrap shrink-0"
              >
                Visão Cliente
              </button>
            </nav>
          )}

          {/* Zona 3: Ação / Sino / Conta */}
          <div className="flex items-center gap-2.5 shrink-0">
            {isTeam && workspaceMode === 'client' && (
              <button
                type="button"
                onClick={() => setWorkspaceMode(me.user.role === 'ADMIN' ? 'admin' : 'curator')}
                className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-semibold whitespace-nowrap shrink-0"
              >
                {me.user.role === 'ADMIN' ? 'Admin' : 'Curadoria'}
              </button>
            )}

            <div className="relative">
              <button
                type="button"
                onClick={() => setShowBell((s) => !s)}
                aria-label="Notificações"
                className="relative p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <Bell className="w-4 h-4" />
                {unreadAlerts.length > 0 && (
                  <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-red-600 text-white text-[10px] font-mono font-bold flex items-center justify-center tabular-nums">
                    {unreadAlerts.length}
                  </span>
                )}
              </button>

              {showBell && (
                <div className="absolute right-0 mt-2 w-80 sm:w-96 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 shadow-lg p-3 z-40">
                  <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-100 dark:border-slate-800">
                    <span className="text-xs font-semibold">Notificações ({unreadAlerts.length} não lidas)</span>
                    <button
                      type="button"
                      onClick={() => setShowBell(false)}
                      className="text-xs text-slate-500 hover:text-slate-900"
                    >
                      Fechar
                    </button>
                  </div>
                  <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
                    {alerts.length === 0 ? (
                      <p className="py-4 text-xs text-slate-500 text-center">Sem notificações no momento.</p>
                    ) : (
                      alerts.slice(0, 12).map((al) => (
                        <button
                          key={al.id}
                          type="button"
                          onClick={() => {
                            setShowBell(false);
                            setWorkspaceMode('client');
                            setClientTab('feed');
                            setSelectedAlertId(al.id);
                          }}
                          className={`w-full text-left py-2.5 px-2 rounded hover:bg-slate-50 dark:hover:bg-slate-800/50 ${
                            al.status === 'NOVO' ? 'bg-sky-50/50 dark:bg-sky-950/20' : ''
                          }`}
                        >
                          <div className="flex items-center justify-between text-[11px] text-slate-500">
                            <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                              {al.act.uf_sigla} · {al.natureza}
                            </span>
                            <span className="tabular-nums">{formatDateBr(al.created_at)}</span>
                          </div>
                          <p className="text-xs font-medium text-slate-800 dark:text-slate-200 line-clamp-2 mt-0.5">
                            {al.act.titulo}
                          </p>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => {
                setWorkspaceMode('client');
                setSelectedAlertId(null);
                setClientTab('account');
              }}
              className="hidden sm:inline-flex px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium whitespace-nowrap shrink-0"
            >
              Minha conta
            </button>

            <button
              type="button"
              onClick={() => setDark((d) => !d)}
              aria-label="Alternar tema"
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300"
            >
              {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>

            <button
              type="button"
              onClick={handleLogout}
              aria-label="Sair"
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:text-red-600"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Navegação mobile compacta */}
        {workspaceMode === 'client' && (
          <div className="md:hidden border-t border-slate-100 dark:border-slate-800 px-4 py-2 flex items-center gap-4 overflow-x-auto text-xs font-medium">
            {(
              [
                ['feed', 'Início'],
                ['history', 'Histórico'],
                ['companies', 'Empresas'],
                ['preferences', 'Preferências'],
                ['plans', 'Planos'],
                ['account', 'Conta'],
              ] as Array<[ClientTab, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setSelectedAlertId(null);
                  setClientTab(key);
                }}
                className={`whitespace-nowrap shrink-0 ${
                  clientTab === key ? 'text-[#0B1F3A] dark:text-white font-bold' : 'text-slate-500'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-8">
        {workspaceMode === 'admin' && me.user.role === 'ADMIN' ? (
          <AdminWorkspace ufs={reference.ufs} segments={reference.segments} />
        ) : workspaceMode === 'curator' && isTeam ? (
          <CuratorWorkspace
            currentUserId={me.user.user_id}
            ufs={reference.ufs}
            segments={reference.segments}
          />
        ) : (
          <ClientWorkspace
            activeTab={clientTab}
            onChangeTab={setClientTab}
            me={me}
            alerts={alerts}
            historyAlerts={historyAlerts}
            selectedAlertId={selectedAlertId}
            onSelectAlert={setSelectedAlertId}
            ufs={reference.ufs}
            segments={reference.segments}
            billingSettings={reference.billingSettings || DEFAULT_BILLING_SETTINGS}
            whatsappOptInText={reference.legal.whatsappOptInText}
            onRefreshAll={refreshAll}
            onLoggedOut={handleLogout}
          />
        )}
      </main>
    </div>
  );
}
