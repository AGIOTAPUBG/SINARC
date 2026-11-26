export type UserRole = 'CLIENTE' | 'CURADOR' | 'ADMIN';
export type UserRitmo = 'IMEDIATO' | 'RESUMO_DIARIO';
export type PlanType = 'FREE' | 'PRO' | 'NACIONAL';
export type PlanStatus = 'ATIVO' | 'INADIMPLENTE' | 'CANCELADO' | 'FREE';
export type BillingCycle = 'MENSAL' | 'ANUAL';
export type CompanyUfKind = 'CREDENCIADA' | 'INTERESSE';
export type MemberStatus = 'CONVIDADO' | 'ATIVO' | 'REMOVIDO';
export type ChannelType = 'APP' | 'PUSH' | 'EMAIL' | 'WHATSAPP';

export type ActTipo = 'PORTARIA' | 'EDITAL' | 'RESOLUCAO' | 'CHAMAMENTO' | 'COMUNICADO';
export type ActAssunto =
  | 'ABERTURA'
  | 'RENOVACAO'
  | 'NOVA_EXIGENCIA'
  | 'DESCREDENCIAMENTO'
  | 'SUSPENSAO'
  | 'PRORROGACAO';
export type ActNaturezaBase = 'OPORTUNIDADE' | 'OBRIGACAO' | 'AMBAS';
export type AlertNatureza = 'OPORTUNIDADE' | 'OBRIGACAO';
export type ActUrgencia = 'URGENTE' | 'IMPORTANTE' | 'INFORMATIVO';
export type ActStatus = 'RASCUNHO' | 'EM_REVISAO' | 'PUBLICADO' | 'ENCERRADO' | 'REVOGADO';
export type ActChangeType = 'PUBLICACAO' | 'ATUALIZACAO' | 'CORRECAO' | 'ENCERRAMENTO' | 'REVOGACAO';

export type AlertStatus = 'NOVO' | 'VISTO' | 'EM_ANDAMENTO' | 'RESOLVIDO';
export type DeliveryKind =
  | 'ALERTA'
  | 'LEMBRETE_30'
  | 'LEMBRETE_7'
  | 'LEMBRETE_1'
  | 'RESUMO_DIARIO'
  | 'RESUMO_SEMANAL_FREE';
export type DeliveryStatus = 'AGENDADO' | 'ENVIADO' | 'FALHOU' | 'CANCELADO';
export type WatchSuggestionStatus = 'PENDENTE' | 'VIROU_ATO' | 'DESCARTADA';
export type ConsentType = 'TERMOS' | 'PRIVACIDADE' | 'WHATSAPP' | 'EMAIL_MARKETING';
export type DataRequestType = 'EXPORTACAO' | 'EXCLUSAO';

export interface UfRecord {
  sigla: string;
  nome: string;
  orgao_nome: string;
}

export interface SegmentRecord {
  code: string;
  nome: string;
  ativo: boolean;
}

export interface ChecklistCatalogItem {
  id: string;
  codigo: string;
  titulo: string;
  descricao: string;
  bloco: string;
  base_normativa: string;
  segment_code: string | null;
  uf_sigla: string | null;
  ativo: boolean;
}

export interface UserProfile {
  user_id: string;
  email: string;
  nome: string;
  celular_e164: string;
  whatsapp_opt_in: boolean;
  whatsapp_opt_in_at: string | null;
  whatsapp_opt_in_text: string | null;
  ritmo: UserRitmo;
  email_opt_in: boolean;
  terms_version_accepted: string | null;
  terms_accepted_at: string | null;
  role: UserRole;
  mfa_required: boolean;
  mfa_enabled: boolean;
}

export interface MonitoringProfile {
  id: string;
  owner_user_id: string;
  nome: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  founder_price_locked: boolean;
  founder_number: number | null;
  billing_cycle: BillingCycle;
}

export interface CompanyAddress {
  logradouro: string;
  numero: string;
  complemento?: string;
  bairro: string;
  municipio: string;
  uf: string;
  cep: string;
}

export interface CompanyUf {
  company_id: string;
  uf_sigla: string;
  kind: CompanyUfKind;
}

export interface Company {
  id: string;
  profile_id: string;
  cnpj: string;
  razao_social: string;
  nome_fantasia: string;
  endereco: CompanyAddress;
  segment_code: string;
  plan: PlanType;
  plan_status: PlanStatus;
  stripe_subscription_item_id: string | null;
  ufs: CompanyUf[];
}

export interface ActChecklistItem {
  id?: string;
  catalog_id?: string | null;
  titulo: string;
  descricao: string;
  obrigatorio: boolean;
  ordem: number;
}

export interface ActVersion {
  id: string;
  act_id: string;
  version: number;
  change_type: ActChangeType;
  change_note: string;
  published_by: string;
  published_at: string;
}

export interface ActRecord {
  id: string;
  uf_sigla: string;
  orgao: string;
  tipo: ActTipo;
  numero: string;
  data_publicacao: string;
  assunto: ActAssunto;
  natureza_base: ActNaturezaBase;
  urgencia: ActUrgencia;
  prazo: string | null;
  sem_prazo: boolean;
  titulo: string;
  resumo: string | null;
  pdf_path: string | null;
  fonte_url: string | null;
  status: ActStatus;
  current_version: number;
  publicado_em: string | null;
  publicacao_oficial_em: string | null;
  created_by: string;
  submitted_by: string | null;
  approved_by: string | null;
  return_comment: string | null;
  segments: string[];
  checklist: ActChecklistItem[];
  versions?: ActVersion[];
}

export interface AlertItem {
  id: string;
  act_id: string;
  act_version: number;
  user_id: string;
  profile_id: string;
  natureza: AlertNatureza;
  urgencia: ActUrgencia;
  company_ids: string[];
  paid_company_ids: string[];
  free_company_ids: string[];
  company_names: string[];
  status: AlertStatus;
  status_changed_at: string;
  is_correction: boolean;
  locked_for_free: boolean;
  created_at: string;
  act: {
    id: string;
    uf_sigla: string;
    orgao: string;
    tipo: ActTipo;
    numero: string;
    data_publicacao: string;
    assunto: ActAssunto;
    urgencia: ActUrgencia;
    titulo: string;
    status: ActStatus;
    current_version: number;
    prazo: string | null;
    sem_prazo: boolean;
    resumo: string | null;
    fonte_url: string | null;
    pdf_signed_url: string | null;
    checklist: ActChecklistItem[];
    segments: string[];
    versions: ActVersion[];
    latest_change_type: ActChangeType | null;
    latest_change_note: string | null;
  };
}

export interface BillingSettings {
  pro_monthly_cents: number;
  pro_annual_cents: number;
  nacional_monthly_cents: number;
  nacional_annual_cents: number;
  discount_5_to_9_pct: number;
  discount_10_plus_pct: number;
  founder_limit: number;
  founders_taken: number;
}

export interface ExtractedActFieldConfidence {
  field: string;
  confidence: 'ALTA' | 'MEDIA' | 'BAIXA';
  reason?: string;
}

export interface ExtractedActDraft {
  uf_sigla: string;
  orgao: string;
  tipo: ActTipo;
  numero: string;
  data_publicacao: string;
  assunto: ActAssunto;
  natureza_base: ActNaturezaBase;
  urgencia: ActUrgencia;
  prazo: string | null;
  sem_prazo: boolean;
  titulo: string;
  resumo: string;
  segments: string[];
  pagina_diario_oficial?: string | null;
  checklist: ActChecklistItem[];
  confidences: ExtractedActFieldConfidence[];
  model_used: string;
  extracted_at: string;
}
