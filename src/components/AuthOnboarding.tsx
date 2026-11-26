import { useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  Lock,
  Moon,
  Search,
  ShieldCheck,
  Sun,
} from 'lucide-react';
import { formatCnpj, normalizeCnpj, validateCnpj } from '../../packages/shared/cnpj.ts';
import type { CompanyAddress, SegmentRecord, UfRecord } from '../../packages/shared/types.ts';
import { apiFetch, setAuthToken } from '../lib/api.ts';
import { BrazilUfMap } from './BrazilUfMap.tsx';
import { RadarLogo } from './RadarLogo.tsx';

export interface ReferencePayload {
  ufs: UfRecord[];
  segments: SegmentRecord[];
  hasAdmin: boolean;
  legal: {
    termsVersion: string;
    privacyVersion: string;
    termsText: string;
    privacyText: string;
    whatsappOptInText: string;
  };
}

interface AuthOnboardingProps {
  reference: ReferencePayload;
  dark: boolean;
  onToggleDark: () => void;
  onAuthenticated: (initialView?: 'feed' | 'plans') => void;
  onRefreshReference: () => void;
}

export function AuthOnboarding({
  reference,
  dark,
  onToggleDark,
  onAuthenticated,
  onRefreshReference,
}: AuthOnboardingProps) {
  const [mode, setMode] = useState<'login' | 'onboarding' | 'forgot' | 'admin-bootstrap'>('login');

  // Login & MFA state
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [needsMfa, setNeedsMfa] = useState(false);
  const [mfaSetupInfo, setMfaSetupInfo] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [mfaSetupCode, setMfaSetupCode] = useState('');

  // Admin bootstrap state
  const [adminNome, setAdminNome] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminPasscode, setAdminPasscode] = useState('');
  const [adminBootstrappedSecret, setAdminBootstrappedSecret] = useState<{
    secret: string;
    otpauthUrl: string;
  } | null>(null);

  // Forgot password
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotMessage, setForgotMessage] = useState('');

  // Legal modal
  const [legalModal, setLegalModal] = useState<'terms' | 'privacy' | null>(null);

  // Onboarding 7 steps
  const [step, setStep] = useState(1);
  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [celular, setCelular] = useState('+55');
  const [password, setPassword] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);

  const [cnpjInput, setCnpjInput] = useState('');
  const [cnpjLoading, setCnpjLoading] = useState(false);
  const [cnpjStatusMsg, setCnpjStatusMsg] = useState('');
  const [razaoSocial, setRazaoSocial] = useState('');
  const [nomeFantasia, setNomeFantasia] = useState('');
  const [endereco, setEndereco] = useState<CompanyAddress>({
    logradouro: '',
    numero: '',
    bairro: '',
    municipio: '',
    uf: '',
    cep: '',
  });

  const [segmentCode, setSegmentCode] = useState<string>(reference.segments[0]?.code || 'ECV');
  const [ufsCredenciadas, setUfsCredenciadas] = useState<string[]>([]);
  const [ufsInteresse, setUfsInteresse] = useState<string[]>([]);

  const [emailChannel, setEmailChannel] = useState(true);
  const [whatsappChannel, setWhatsappChannel] = useState(false);
  const [whatsappOptInAccepted, setWhatsappOptInAccepted] = useState(false);

  const [onboardingResult, setOnboardingResult] = useState<{
    oportunidades: number;
    obrigacoes: number;
  } | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{
        token?: string;
        requiresMfa?: boolean;
        requiresMfaSetup?: boolean;
        partialToken?: string;
        totpSecret?: string;
        otpauthUrl?: string;
      }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: loginEmail,
          password: loginPassword,
          totpCode: needsMfa ? totpCode : undefined,
        }),
      });

      if (res.requiresMfaSetup && res.partialToken && res.totpSecret) {
        setAuthToken(res.partialToken);
        setMfaSetupInfo({ secret: res.totpSecret, otpauthUrl: res.otpauthUrl || '' });
        return;
      }

      if (res.requiresMfa) {
        setNeedsMfa(true);
        return;
      }

      if (res.token) {
        setAuthToken(res.token);
        onAuthenticated('feed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao entrar.');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmMfaSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{ token: string }>('/api/auth/mfa/setup-confirm', {
        method: 'POST',
        body: JSON.stringify({ totpCode: mfaSetupCode }),
      });
      setAuthToken(res.token);
      onAuthenticated('feed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Código inválido.');
    } finally {
      setLoading(false);
    }
  };

  const handleAdminBootstrap = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{
        token: string;
        totpSecret: string;
        otpauthUrl: string;
      }>('/api/auth/admin-bootstrap', {
        method: 'POST',
        body: JSON.stringify({
          nome: adminNome,
          email: adminEmail,
          password: adminPassword,
          passcode: adminPasscode || undefined,
        }),
      });
      setAuthToken(res.token);
      setAdminBootstrappedSecret({ secret: res.totpSecret, otpauthUrl: res.otpauthUrl });
      onRefreshReference();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha na configuração do administrador.');
    } finally {
      setLoading(false);
    }
  };

  const handleLookupCnpj = async () => {
    setError('');
    setCnpjStatusMsg('');
    const digits = normalizeCnpj(cnpjInput);
    if (!validateCnpj(digits)) {
      setError('CNPJ inválido pelos dígitos verificadores. Confira o número digitado.');
      return;
    }
    setCnpjLoading(true);
    try {
      const res = await apiFetch<{
        found: boolean;
        data?: {
          razao_social: string;
          nome_fantasia: string;
          endereco: CompanyAddress;
        };
        message?: string;
      }>(`/api/cnpj/${digits}`);
      setCnpjInput(formatCnpj(digits));
      if (res.found && res.data) {
        setRazaoSocial(res.data.razao_social);
        setNomeFantasia(res.data.nome_fantasia || res.data.razao_social);
        setEndereco(res.data.endereco);
        setCnpjStatusMsg('Dados preenchidos automaticamente via base pública de CNPJ.');
      } else {
        setCnpjStatusMsg(
          res.message || 'Consulta externa indisponível no momento. Preencha os dados manualmente.'
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao consultar CNPJ.');
    } finally {
      setCnpjLoading(false);
    }
  };

  const handleFinishOnboarding = async () => {
    setError('');
    setLoading(true);
    try {
      const res = await apiFetch<{
        token: string;
        summary: { oportunidades: number; obrigacoes: number };
      }>('/api/auth/register-onboarding', {
        method: 'POST',
        body: JSON.stringify({
          nome,
          email,
          celular_e164: celular.startsWith('+') ? celular.replace(/\s+/g, '') : `+55${celular.replace(/\D/g, '')}`,
          password,
          termsAccepted,
          company: {
            cnpj: cnpjInput,
            razao_social: razaoSocial,
            nome_fantasia: nomeFantasia || razaoSocial,
            endereco,
            segment_code: segmentCode,
            ufs_credenciadas: ufsCredenciadas,
            ufs_interesse: ufsInteresse,
          },
          channels: {
            email: emailChannel,
            whatsapp: whatsappChannel,
            whatsappOptInAccepted,
          },
        }),
      });
      setAuthToken(res.token);
      setOnboardingResult(res.summary);
      setStep(7);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao concluir cadastro.');
    } finally {
      setLoading(false);
    }
  };

  const canAdvanceStep = () => {
    if (step === 1) {
      return Boolean(nome.trim() && email.includes('@') && celular.length >= 10 && password.length >= 6 && termsAccepted);
    }
    if (step === 2) {
      return validateCnpj(cnpjInput) && Boolean(razaoSocial.trim());
    }
    if (step === 3) {
      return Boolean(segmentCode);
    }
    if (step === 6) {
      return !whatsappChannel || whatsappOptInAccepted;
    }
    return true;
  };

  const toggleUf = (list: string[], setList: (next: string[]) => void, sigla: string) => {
    if (list.includes(sigla)) {
      setList(list.filter((s) => s !== sigla));
    } else {
      setList([...list, sigla]);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
      {/* Cabeçalho minimalista */}
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between gap-8">
          <div className="flex items-center gap-2.5 text-[#0B1F3A] dark:text-white whitespace-nowrap shrink-0">
            <RadarLogo size={26} />
            <span className="font-display text-lg font-bold tracking-tight">SINARC</span>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {!reference.hasAdmin && mode !== 'admin-bootstrap' && (
              <button
                type="button"
                onClick={() => {
                  setError('');
                  setMode('admin-bootstrap');
                }}
                className="text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 whitespace-nowrap"
              >
                Configurar 1º Administrador
              </button>
            )}
            <button
              type="button"
              onClick={onToggleDark}
              aria-label={dark ? 'Ativar modo claro' : 'Ativar modo escuro'}
              className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-10">
        {mode === 'login' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-center">
            {/* Lado institucional */}
            <div className="lg:col-span-6 space-y-6">
              <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
                Sistema Nacional Radar de Credenciamento
              </p>
              <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-slate-900 dark:text-white text-balance">
                O seu radar de credenciamento nos DETRANs das 27 UFs.
              </h1>
              <p className="text-base text-slate-600 dark:text-slate-300 leading-relaxed max-w-xl">
                Monitore oportunidades de entrada em novos estados e obrigações de manutenção para{' '}
                <strong className="font-semibold text-slate-900 dark:text-white">registradoras de contrato</strong> e{' '}
                <strong className="font-semibold text-slate-900 dark:text-white">ECVs</strong>. Receba portarias e editais já interpretados com prazo e checklist.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                  <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                    Oportunidades
                  </p>
                  <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                    Alertas automáticos quando um DETRAN abre credenciamento nas suas UFs de interesse.
                  </p>
                </div>
                <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                  <p className="text-sm font-semibold text-red-700 dark:text-red-400">
                    Obrigações
                  </p>
                  <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                    Acompanhe renovações, novas exigências e prazos em 30, 7 e 1 dia nas UFs credenciadas.
                  </p>
                </div>
              </div>
            </div>

            {/* Cartão de Login */}
            <div className="lg:col-span-6">
              <div className="max-w-md ml-auto w-full border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-7">
                {mfaSetupInfo ? (
                  <form onSubmit={handleConfirmMfaSetup} className="space-y-4">
                    <div className="flex items-center gap-2 text-[#0B1F3A] dark:text-sky-400">
                      <ShieldCheck className="w-5 h-5" />
                      <h2 className="text-lg font-bold">Configuração obrigatória de 2FA</h2>
                    </div>
                    <p className="text-sm text-slate-600 dark:text-slate-300">
                      Adicione a chave abaixo no seu aplicativo autenticador (Google Authenticator / Authy) e informe o código de 6 dígitos para liberar o acesso:
                    </p>
                    <div className="p-3 rounded-lg bg-slate-100 dark:bg-slate-800 font-mono text-xs break-all select-all text-slate-900 dark:text-slate-100">
                      {mfaSetupInfo.secret}
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Código 2FA (6 dígitos)</label>
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        value={mfaSetupCode}
                        onChange={(e) => setMfaSetupCode(e.target.value)}
                        required
                        className="w-full px-3 py-2.5 border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950 font-mono text-center text-lg tracking-widest"
                        placeholder="000000"
                      />
                    </div>
                    {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full py-2.5 px-4 rounded-lg bg-[#0B1F3A] hover:bg-[#132E54] text-white font-semibold text-sm transition-colors"
                    >
                      {loading ? 'Verificando...' : 'Confirmar 2FA e entrar'}
                    </button>
                  </form>
                ) : (
                  <form onSubmit={handleLoginSubmit} className="space-y-4">
                    <div>
                      <h2 className="text-xl font-bold text-slate-900 dark:text-white">
                        Acesse sua conta
                      </h2>
                      <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                        Entre para acompanhar seus alertas ou gerenciar o painel.
                      </p>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                        E-mail
                      </label>
                      <input
                        type="email"
                        required
                        value={loginEmail}
                        onChange={(e) => setLoginEmail(e.target.value)}
                        placeholder="nome@empresa.com.br"
                        className="w-full px-3.5 py-2.5 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-[#0B1F3A]"
                      />
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
                          Senha
                        </label>
                        <button
                          type="button"
                          onClick={() => {
                            setError('');
                            setMode('forgot');
                          }}
                          className="text-xs text-[#0B1F3A] dark:text-sky-400 hover:underline"
                        >
                          Esqueci a senha
                        </button>
                      </div>
                      <div className="relative">
                        <input
                          type={showPassword ? 'text' : 'password'}
                          required
                          value={loginPassword}
                          onChange={(e) => setLoginPassword(e.target.value)}
                          className="w-full px-3.5 py-2.5 pr-10 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950 focus:outline-none focus:ring-2 focus:ring-[#0B1F3A]"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          aria-label="Mostrar senha"
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                        >
                          {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    {needsMfa && (
                      <div>
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                          Código 2FA (aplicativo autenticador)
                        </label>
                        <input
                          type="text"
                          inputMode="numeric"
                          maxLength={6}
                          required
                          value={totpCode}
                          onChange={(e) => setTotpCode(e.target.value)}
                          placeholder="000000"
                          className="w-full px-3.5 py-2.5 text-sm font-mono tracking-widest text-center border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                        />
                      </div>
                    )}

                    {error && (
                      <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-sm text-red-700 dark:text-red-300">
                        {error}
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={loading}
                      className="w-full py-2.5 px-4 rounded-lg bg-[#0B1F3A] hover:bg-[#132E54] text-white font-semibold text-sm transition-colors disabled:opacity-60"
                    >
                      {loading ? 'Entrando...' : 'Entrar'}
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        setError(
                          'Login com Google requer CLIENT_ID OAuth configurado no projeto Supabase/Google Cloud. Utilize e-mail e senha ou crie sua conta.'
                        )
                      }
                      className="w-full py-2.5 px-4 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-200 font-medium text-sm hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                    >
                      Entrar com Google
                    </button>

                    <div className="pt-3 border-t border-slate-100 dark:border-slate-800 text-center">
                      <span className="text-sm text-slate-600 dark:text-slate-400">
                        Primeira vez no SINARC?{' '}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setError('');
                          setStep(1);
                          setMode('onboarding');
                        }}
                        className="text-sm font-semibold text-[#0B1F3A] dark:text-sky-400 hover:underline"
                      >
                        Criar conta gratuita
                      </button>
                    </div>
                  </form>
                )}
              </div>
            </div>
          </div>
        )}

        {mode === 'forgot' && (
          <div className="max-w-md mx-auto border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-7 space-y-4">
            <button
              type="button"
              onClick={() => setMode('login')}
              className="inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900"
            >
              <ArrowLeft className="w-4 h-4" /> Voltar ao login
            </button>
            <h2 className="text-xl font-bold">Recuperar senha</h2>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Informe o e-mail cadastrado para receber o link de redefinição.
            </p>
            <input
              type="email"
              value={forgotEmail}
              onChange={(e) => setForgotEmail(e.target.value)}
              placeholder="nome@empresa.com.br"
              className="w-full px-3.5 py-2.5 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
            />
            {forgotMessage && (
              <p className="text-sm text-emerald-700 dark:text-emerald-400">{forgotMessage}</p>
            )}
            <button
              type="button"
              onClick={async () => {
                const res = await apiFetch<{ message: string }>('/api/auth/forgot-password', {
                  method: 'POST',
                  body: JSON.stringify({ email: forgotEmail }),
                });
                setForgotMessage(res.message);
              }}
              className="w-full py-2.5 px-4 rounded-lg bg-[#0B1F3A] text-white text-sm font-semibold"
            >
              Enviar instruções
            </button>
          </div>
        )}

        {mode === 'admin-bootstrap' && (
          <div className="max-w-md mx-auto border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-7 space-y-4">
            <button
              type="button"
              onClick={() => setMode('login')}
              className="inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900"
            >
              <ArrowLeft className="w-4 h-4" /> Voltar
            </button>

            {adminBootstrappedSecret ? (
              <div className="space-y-4">
                <h2 className="text-xl font-bold text-emerald-700 dark:text-emerald-400">
                  Administrador criado com 2FA ativa
                </h2>
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  Guarde esta chave secreta no seu aplicativo autenticador (Google Authenticator / Authy) para futuros logins:
                </p>
                <div className="p-3 rounded-lg bg-slate-100 dark:bg-slate-800 font-mono text-xs break-all select-all">
                  {adminBootstrappedSecret.secret}
                </div>
                <button
                  type="button"
                  onClick={() => onAuthenticated('feed')}
                  className="w-full py-2.5 px-4 rounded-lg bg-[#0B1F3A] text-white text-sm font-semibold"
                >
                  Acessar Painel Administrativo
                </button>
              </div>
            ) : (
              <form onSubmit={handleAdminBootstrap} className="space-y-4">
                <div className="flex items-center gap-2 text-[#0B1F3A] dark:text-sky-400">
                  <Lock className="w-5 h-5" />
                  <h2 className="text-lg font-bold">Configuração do 1º Administrador</h2>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Disponível apenas enquanto não houver nenhum administrador cadastrado.
                </p>
                <input
                  type="text"
                  required
                  value={adminNome}
                  onChange={(e) => setAdminNome(e.target.value)}
                  placeholder="Nome completo"
                  className="w-full px-3.5 py-2.5 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                />
                <input
                  type="email"
                  required
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="admin@sinarc.com.br"
                  className="w-full px-3.5 py-2.5 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                />
                <input
                  type="password"
                  required
                  minLength={8}
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  placeholder="Senha forte (mínimo 8 caracteres)"
                  className="w-full px-3.5 py-2.5 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                />
                <input
                  type="password"
                  value={adminPasscode}
                  onChange={(e) => setAdminPasscode(e.target.value)}
                  placeholder="Código ADMIN_BOOTSTRAP_PASSCODE (se definido no servidor)"
                  className="w-full px-3.5 py-2.5 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                />
                {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 px-4 rounded-lg bg-[#0B1F3A] text-white text-sm font-semibold"
                >
                  {loading ? 'Configurando...' : 'Criar Administrador e gerar 2FA'}
                </button>
              </form>
            )}
          </div>
        )}

        {mode === 'onboarding' && (
          <div className="max-w-4xl mx-auto">
            {/* Barra de progresso das 7 etapas */}
            <div className="mb-6">
              <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-2">
                <button
                  type="button"
                  onClick={() => setMode('login')}
                  className="inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white"
                >
                  <ArrowLeft className="w-3.5 h-3.5" /> Já tenho conta
                </button>
                <span className="font-mono tabular-nums">Etapa {step} de 7</span>
              </div>
              <div className="h-2 bg-slate-200 dark:bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#0B1F3A] dark:bg-sky-500 transition-all duration-200"
                  style={{ width: `${(step / 7) * 100}%` }}
                />
              </div>
            </div>

            <div className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-6 sm:p-8">
              {step === 1 && (
                <div className="space-y-4 max-w-lg">
                  <h2 className="text-xl font-bold">1. Seus dados pessoais</h2>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-sm font-medium mb-1">Nome completo</label>
                      <input
                        type="text"
                        value={nome}
                        onChange={(e) => setNome(e.target.value)}
                        className="w-full px-3.5 py-2.5 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">E-mail corporativo</label>
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="w-full px-3.5 py-2.5 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Celular com DDD (para alertas)</label>
                      <input
                        type="tel"
                        value={celular}
                        onChange={(e) => setCelular(e.target.value)}
                        placeholder="+5511999999999"
                        className="w-full px-3.5 py-2.5 text-sm font-mono border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Senha (mínimo 6 caracteres)</label>
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full px-3.5 py-2.5 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                      />
                    </div>
                    <label className="flex items-start gap-2.5 pt-2 text-sm text-slate-600 dark:text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={termsAccepted}
                        onChange={(e) => setTermsAccepted(e.target.checked)}
                        className="mt-1 h-4 w-4 rounded border-slate-300"
                      />
                      <span>
                        Li e aceito os{' '}
                        <button
                          type="button"
                          onClick={() => setLegalModal('terms')}
                          className="underline font-medium text-[#0B1F3A] dark:text-sky-400"
                        >
                          Termos de Uso
                        </button>{' '}
                        e a{' '}
                        <button
                          type="button"
                          onClick={() => setLegalModal('privacy')}
                          className="underline font-medium text-[#0B1F3A] dark:text-sky-400"
                        >
                          Política de Privacidade
                        </button>{' '}
                        da Bio Síntese Soluções (versão {reference.legal.termsVersion}).
                      </span>
                    </label>
                  </div>
                </div>
              )}

              {step === 2 && (
                <div className="space-y-4 max-w-xl">
                  <h2 className="text-xl font-bold">2. Empresa monitorada (CNPJ)</h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    Informe o CNPJ da empresa. Validamos os dígitos e buscamos os dados cadastrais automaticamente (ou preencha manualmente).
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={cnpjInput}
                      onChange={(e) => setCnpjInput(e.target.value)}
                      placeholder="00.000.000/0001-00"
                      className="flex-1 px-3.5 py-2.5 text-sm font-mono border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                    />
                    <button
                      type="button"
                      disabled={cnpjLoading}
                      onClick={handleLookupCnpj}
                      className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#0B1F3A] text-white text-sm font-semibold whitespace-nowrap shrink-0"
                    >
                      <Search className="w-4 h-4" />
                      {cnpjLoading ? 'Consultando...' : 'Consultar CNPJ'}
                    </button>
                  </div>
                  {cnpjStatusMsg && (
                    <p className="text-xs text-slate-600 dark:text-slate-300">{cnpjStatusMsg}</p>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                    <div className="sm:col-span-2">
                      <label className="block text-sm font-medium mb-1">Razão Social</label>
                      <input
                        type="text"
                        value={razaoSocial}
                        onChange={(e) => setRazaoSocial(e.target.value)}
                        className="w-full px-3.5 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Nome Fantasia</label>
                      <input
                        type="text"
                        value={nomeFantasia}
                        onChange={(e) => setNomeFantasia(e.target.value)}
                        className="w-full px-3.5 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Município / UF</label>
                      <input
                        type="text"
                        value={endereco.municipio}
                        onChange={(e) => setEndereco({ ...endereco, municipio: e.target.value })}
                        placeholder="Ex: Goiânia"
                        className="w-full px-3.5 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                      />
                    </div>
                  </div>
                </div>
              )}

              {step === 3 && (
                <div className="space-y-4">
                  <h2 className="text-xl font-bold">3. Segmento de atuação</h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    Escolha o segmento da empresa monitorada para receber apenas portarias e editais pertinentes.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl">
                    {reference.segments.map((seg) => {
                      const active = segmentCode === seg.code;
                      return (
                        <button
                          key={seg.code}
                          type="button"
                          onClick={() => setSegmentCode(seg.code)}
                          className={`p-5 rounded-xl border text-left transition-colors ${
                            active
                              ? 'border-[#0B1F3A] bg-slate-50 dark:border-sky-500 dark:bg-slate-800'
                              : 'border-slate-200 dark:border-slate-800 hover:border-slate-300'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-display font-semibold text-base">{seg.nome}</span>
                            {active && <Check className="w-5 h-5 text-emerald-600" />}
                          </div>
                          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">
                            {seg.code === 'REGISTRADORA'
                              ? 'Monitoramento de atos para registradoras de contratos de financiamento.'
                              : 'Monitoramento de atos para empresas credenciadas de vistoria veicular.'}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {step === 4 && (
                <div className="space-y-4">
                  <div>
                    <h2 className="text-xl font-bold">4. UFs onde a empresa já é credenciada</h2>
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                      Atos nestas UFs gerarão alertas de <strong className="text-red-700 dark:text-red-400">Obrigação</strong> (renovações, exigências e prazos).
                    </p>
                  </div>
                  <BrazilUfMap
                    ufs={reference.ufs}
                    mode="CREDENCIADA"
                    selectedCredenciadas={ufsCredenciadas}
                    selectedInteresse={ufsInteresse}
                    onToggleUf={(sigla) => toggleUf(ufsCredenciadas, setUfsCredenciadas, sigla)}
                  />
                </div>
              )}

              {step === 5 && (
                <div className="space-y-4">
                  <div>
                    <h2 className="text-xl font-bold">5. UFs de interesse para expansão</h2>
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                      Atos nestas UFs gerarão alertas de <strong className="text-emerald-700 dark:text-emerald-400">Oportunidade</strong>. UFs já marcadas como credenciadas ficam bloqueadas aqui.
                    </p>
                  </div>
                  <BrazilUfMap
                    ufs={reference.ufs}
                    mode="INTERESSE"
                    selectedCredenciadas={ufsCredenciadas}
                    selectedInteresse={ufsInteresse}
                    onToggleUf={(sigla) => toggleUf(ufsInteresse, setUfsInteresse, sigla)}
                  />
                </div>
              )}

              {step === 6 && (
                <div className="space-y-5 max-w-xl">
                  <h2 className="text-xl font-bold">6. Canais de alerta</h2>
                  <div className="space-y-3">
                    <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold">Notificações no App e Web</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          Sempre ativo para acompanhar o feed e o sino de alertas.
                        </p>
                      </div>
                      <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
                        Sempre ativo
                      </span>
                    </div>

                    <label className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 flex items-center justify-between cursor-pointer">
                      <div>
                        <p className="text-sm font-semibold">E-mail (alertas@sinarc.com.br)</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          No FREE recebe resumo semanal às segundas 8h. Nos planos pagos recebe imediato ou resumo diário.
                        </p>
                      </div>
                      <input
                        type="checkbox"
                        checked={emailChannel}
                        onChange={(e) => setEmailChannel(e.target.checked)}
                        className="h-4 w-4 rounded border-slate-300"
                      />
                    </label>

                    <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 space-y-3">
                      <label className="flex items-center justify-between cursor-pointer">
                        <div>
                          <p className="text-sm font-semibold">
                            WhatsApp oficial SINARC (recurso exclusivo de planos pagos)
                          </p>
                          <p className="text-xs text-slate-500 dark:text-slate-400">
                            Alertas imediatos e lembretes de prazo direto no número {celular}.
                          </p>
                        </div>
                        <input
                          type="checkbox"
                          checked={whatsappChannel}
                          onChange={(e) => setWhatsappChannel(e.target.checked)}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                      </label>
                      {whatsappChannel && (
                        <label className="flex items-start gap-2.5 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={whatsappOptInAccepted}
                            onChange={(e) => setWhatsappOptInAccepted(e.target.checked)}
                            className="mt-0.5 h-4 w-4 rounded border-slate-300"
                          />
                          <span>{reference.legal.whatsappOptInText}</span>
                        </label>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {step === 7 && onboardingResult && (
                <div className="space-y-6 text-center max-w-lg mx-auto py-4">
                  <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400">
                    <Check className="w-6 h-6" />
                  </div>
                  <h2 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
                    Encontramos{' '}
                    <span className="text-emerald-700 dark:text-emerald-400 tabular-nums">
                      {onboardingResult.oportunidades} oportunidade(s)
                    </span>{' '}
                    e{' '}
                    <span className="text-red-700 dark:text-red-400 tabular-nums">
                      {onboardingResult.obrigacoes} obrigação(ões)
                    </span>{' '}
                    para você.
                  </h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    No plano FREE você visualiza os títulos e estados afetados. Para desbloquear prazos, resumos completos, checklist oficial, PDFs e envio por WhatsApp, escolha um plano pago.
                  </p>
                  <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
                    <button
                      type="button"
                      onClick={() => onAuthenticated('plans')}
                      className="px-6 py-2.5 rounded-lg bg-[#0B1F3A] hover:bg-[#132E54] text-white font-semibold text-sm"
                    >
                      Ver planos
                    </button>
                    <button
                      type="button"
                      onClick={() => onAuthenticated('feed')}
                      className="px-6 py-2.5 rounded-lg border border-slate-300 dark:border-slate-700 font-medium text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      Continuar no FREE
                    </button>
                  </div>
                </div>
              )}

              {error && (
                <div className="mt-4 p-3 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-sm text-red-700 dark:text-red-300">
                  {error}
                </div>
              )}

              {step < 7 && (
                <div className="mt-8 pt-5 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
                  <button
                    type="button"
                    disabled={step === 1}
                    onClick={() => {
                      setError('');
                      setStep(step - 1);
                    }}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-sm font-medium disabled:opacity-40"
                  >
                    <ArrowLeft className="w-4 h-4" /> Voltar
                  </button>

                  {step < 6 ? (
                    <button
                      type="button"
                      disabled={!canAdvanceStep()}
                      onClick={() => {
                        setError('');
                        setStep(step + 1);
                      }}
                      className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-lg bg-[#0B1F3A] text-white text-sm font-semibold disabled:opacity-40"
                    >
                      Avançar <ArrowRight className="w-4 h-4" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={loading || !canAdvanceStep()}
                      onClick={handleFinishOnboarding}
                      className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-semibold disabled:opacity-40"
                    >
                      {loading ? 'Finalizando...' : 'Concluir cadastro'}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Modal de leitura de Termos / Privacidade */}
      {legalModal && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl max-w-xl w-full p-6 space-y-4">
            <h3 className="text-lg font-bold">
              {legalModal === 'terms' ? 'Termos de Uso — SINARC' : 'Política de Privacidade (LGPD) — SINARC'}
            </h3>
            <pre className="whitespace-pre-wrap font-sans text-sm text-slate-600 dark:text-slate-300 leading-relaxed max-h-80 overflow-y-auto">
              {legalModal === 'terms' ? reference.legal.termsText : reference.legal.privacyText}
            </pre>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setLegalModal(null)}
                className="px-4 py-2 rounded-lg bg-[#0B1F3A] text-white text-sm font-semibold"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
