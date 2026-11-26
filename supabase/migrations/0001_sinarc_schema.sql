-- SINARC v1 — Schema Postgres / Supabase (sa-east-1)
-- Inclui RLS em todas as tabelas, índices únicos, trigger imutável de audit_log e agendamentos.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Referência
CREATE TABLE IF NOT EXISTS ufs (
  sigla CHAR(2) PRIMARY KEY,
  nome TEXT NOT NULL,
  orgao_nome TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS segments (
  code TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS checklist_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo TEXT NOT NULL UNIQUE,
  titulo TEXT NOT NULL,
  descricao TEXT NOT NULL,
  bloco TEXT NOT NULL,
  base_normativa TEXT NOT NULL,
  segment_code TEXT REFERENCES segments(code),
  uf_sigla CHAR(2) REFERENCES ufs(sigla),
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- Pessoas e empresas
CREATE TABLE IF NOT EXISTS users_profile (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id),
  nome TEXT NOT NULL,
  celular_e164 TEXT NOT NULL,
  whatsapp_opt_in BOOLEAN NOT NULL DEFAULT false,
  whatsapp_opt_in_at TIMESTAMPTZ,
  whatsapp_opt_in_text TEXT,
  ritmo TEXT NOT NULL DEFAULT 'IMEDIATO' CHECK (ritmo IN ('IMEDIATO', 'RESUMO_DIARIO')),
  email_opt_in BOOLEAN NOT NULL DEFAULT true,
  terms_version_accepted TEXT,
  terms_accepted_at TIMESTAMPTZ,
  role TEXT NOT NULL DEFAULT 'CLIENTE' CHECK (role IN ('CLIENTE', 'CURADOR', 'ADMIN')),
  mfa_required BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS push_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users_profile(user_id),
  token TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('IOS', 'ANDROID', 'WEB')),
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (user_id, token)
);

CREATE TABLE IF NOT EXISTS monitoring_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES users_profile(user_id),
  nome TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  billing_cycle TEXT NOT NULL DEFAULT 'MENSAL' CHECK (billing_cycle IN ('MENSAL', 'ANUAL')),
  founder_price_locked BOOLEAN NOT NULL DEFAULT false,
  founder_number INT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES monitoring_profiles(id),
  cnpj CHAR(14) NOT NULL,
  razao_social TEXT NOT NULL,
  nome_fantasia TEXT NOT NULL,
  endereco JSONB NOT NULL DEFAULT '{}'::jsonb,
  segment_code TEXT NOT NULL REFERENCES segments(code),
  plan TEXT NOT NULL DEFAULT 'FREE' CHECK (plan IN ('FREE', 'PRO', 'NACIONAL')),
  plan_status TEXT NOT NULL DEFAULT 'FREE' CHECK (plan_status IN ('ATIVO', 'INADIMPLENTE', 'CANCELADO', 'FREE')),
  stripe_subscription_item_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_profile_cnpj_active
  ON companies(profile_id, cnpj) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS company_ufs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  uf_sigla CHAR(2) NOT NULL REFERENCES ufs(sigla),
  kind TEXT NOT NULL CHECK (kind IN ('CREDENCIADA', 'INTERESSE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, uf_sigla)
);

CREATE TABLE IF NOT EXISTS company_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  user_id UUID NOT NULL REFERENCES users_profile(user_id),
  is_owner BOOLEAN NOT NULL DEFAULT false,
  invited_by UUID REFERENCES users_profile(user_id),
  status TEXT NOT NULL DEFAULT 'ATIVO' CHECK (status IN ('CONVIDADO', 'ATIVO', 'REMOVIDO')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (company_id, user_id)
);

CREATE TABLE IF NOT EXISTS member_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  user_id UUID NOT NULL REFERENCES users_profile(user_id),
  uf_sigla CHAR(2) NOT NULL REFERENCES ufs(sigla),
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, user_id, uf_sigla),
  FOREIGN KEY (company_id, uf_sigla) REFERENCES company_ufs(company_id, uf_sigla) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS member_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users_profile(user_id),
  channel TEXT NOT NULL CHECK (channel IN ('APP', 'PUSH', 'EMAIL', 'WHATSAPP')),
  ativo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, channel)
);

-- Conteúdo
CREATE TABLE IF NOT EXISTS acts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uf_sigla CHAR(2) NOT NULL REFERENCES ufs(sigla),
  orgao TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('PORTARIA', 'EDITAL', 'RESOLUCAO', 'CHAMAMENTO', 'COMUNICADO')),
  numero TEXT NOT NULL,
  data_publicacao DATE NOT NULL,
  assunto TEXT NOT NULL CHECK (assunto IN ('ABERTURA', 'RENOVACAO', 'NOVA_EXIGENCIA', 'DESCREDENCIAMENTO', 'SUSPENSAO', 'PRORROGACAO')),
  natureza_base TEXT NOT NULL CHECK (natureza_base IN ('OPORTUNIDADE', 'OBRIGACAO', 'AMBAS')),
  urgencia TEXT NOT NULL CHECK (urgencia IN ('URGENTE', 'IMPORTANTE', 'INFORMATIVO')),
  prazo DATE,
  sem_prazo BOOLEAN NOT NULL DEFAULT false,
  titulo TEXT NOT NULL,
  resumo TEXT NOT NULL,
  pdf_path TEXT,
  fonte_url TEXT,
  status TEXT NOT NULL DEFAULT 'RASCUNHO' CHECK (status IN ('RASCUNHO', 'EM_REVISAO', 'PUBLICADO', 'ENCERRADO', 'REVOGADO')),
  current_version INT NOT NULL DEFAULT 1,
  publicado_em TIMESTAMPTZ,
  publicacao_oficial_em TIMESTAMPTZ,
  created_by UUID NOT NULL,
  submitted_by UUID,
  approved_by UUID,
  return_comment TEXT,
  ai_metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT chk_double_review CHECK (approved_by IS NULL OR submitted_by IS NULL OR approved_by <> submitted_by)
);

CREATE TABLE IF NOT EXISTS act_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  act_id UUID NOT NULL REFERENCES acts(id),
  segment_code TEXT NOT NULL REFERENCES segments(code),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (act_id, segment_code)
);

CREATE TABLE IF NOT EXISTS act_checklist_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  act_id UUID NOT NULL REFERENCES acts(id),
  catalog_id UUID REFERENCES checklist_catalog(id),
  titulo TEXT NOT NULL,
  descricao TEXT NOT NULL,
  obrigatorio BOOLEAN NOT NULL DEFAULT true,
  ordem INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS act_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  act_id UUID NOT NULL REFERENCES acts(id),
  version INT NOT NULL,
  snapshot JSONB NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('PUBLICACAO', 'ATUALIZACAO', 'CORRECAO', 'ENCERRAMENTO', 'REVOGACAO')),
  change_note TEXT NOT NULL,
  published_by UUID NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (act_id, version)
);

-- Alertas e entregas
CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  act_id UUID NOT NULL REFERENCES acts(id),
  act_version INT NOT NULL,
  user_id UUID NOT NULL REFERENCES users_profile(user_id),
  profile_id UUID NOT NULL REFERENCES monitoring_profiles(id),
  natureza TEXT NOT NULL CHECK (natureza IN ('OPORTUNIDADE', 'OBRIGACAO')),
  urgencia TEXT NOT NULL CHECK (urgencia IN ('URGENTE', 'IMPORTANTE', 'INFORMATIVO')),
  company_ids UUID[] NOT NULL,
  status TEXT NOT NULL DEFAULT 'NOVO' CHECK (status IN ('NOVO', 'VISTO', 'EM_ANDAMENTO', 'RESOLVIDO')),
  status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_correction BOOLEAN NOT NULL DEFAULT false,
  locked_for_free BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (act_id, act_version, user_id, natureza)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id UUID NOT NULL REFERENCES alerts(id),
  channel TEXT NOT NULL CHECK (channel IN ('APP', 'PUSH', 'EMAIL', 'WHATSAPP')),
  kind TEXT NOT NULL CHECK (kind IN ('ALERTA', 'LEMBRETE_30', 'LEMBRETE_7', 'LEMBRETE_1', 'RESUMO_DIARIO', 'RESUMO_SEMANAL_FREE')),
  scheduled_for TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'AGENDADO' CHECK (status IN ('AGENDADO', 'ENVIADO', 'FALHOU', 'CANCELADO')),
  attempts INT NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (alert_id, channel, kind)
);

CREATE TABLE IF NOT EXISTS whatsapp_inbound (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  from_e164 TEXT NOT NULL,
  provider_message_id TEXT NOT NULL UNIQUE,
  message_text TEXT NOT NULL,
  action_taken TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Curadoria e vigilância
CREATE TABLE IF NOT EXISTS watch_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  uf_sigla CHAR(2) NOT NULL REFERENCES ufs(sigla),
  url TEXT NOT NULL,
  descricao TEXT NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT true,
  ultima_hash TEXT,
  ultima_verificacao TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS watch_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id UUID NOT NULL REFERENCES watch_targets(id),
  detectado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  diff_resumo TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE', 'VIROU_ATO', 'DESCARTADA')),
  act_id UUID REFERENCES acts(id),
  tratado_por UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cobrança, LGPD e auditoria
CREATE TABLE IF NOT EXISTS billing_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'PROCESSADO',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invoices_nf (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES monitoring_profiles(id),
  stripe_invoice_id TEXT NOT NULL UNIQUE,
  nf_provider_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE', 'EMITIDA', 'ERRO')),
  pdf_url TEXT,
  xml_url TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users_profile(user_id),
  tipo TEXT NOT NULL CHECK (tipo IN ('TERMOS', 'PRIVACIDADE', 'WHATSAPP', 'EMAIL_MARKETING')),
  versao TEXT NOT NULL,
  texto TEXT NOT NULL,
  aceito BOOLEAN NOT NULL,
  em TIMESTAMPTZ NOT NULL,
  ip INET NOT NULL,
  origem TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID,
  acao TEXT NOT NULL,
  entidade TEXT NOT NULL,
  entidade_id TEXT NOT NULL,
  antes JSONB,
  depois JSONB,
  ip INET,
  em TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log é imutável: UPDATE e DELETE são proibidos';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_immutable ON audit_log;
CREATE TRIGGER trg_audit_log_immutable
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();

REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;

CREATE TABLE IF NOT EXISTS data_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users_profile(user_id),
  tipo TEXT NOT NULL CHECK (tipo IN ('EXPORTACAO', 'EXCLUSAO')),
  status TEXT NOT NULL DEFAULT 'CONCLUIDO',
  solicitado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em TIMESTAMPTZ,
  arquivo_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS em todas as tabelas
ALTER TABLE ufs ENABLE ROW LEVEL SECURITY;
ALTER TABLE segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE users_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_ufs ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE acts ENABLE ROW LEVEL SECURITY;
ALTER TABLE act_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE act_checklist_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE act_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_inbound ENABLE ROW LEVEL SECURITY;
ALTER TABLE watch_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE watch_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices_nf ENABLE ROW LEVEL SECURITY;
ALTER TABLE consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_requests ENABLE ROW LEVEL SECURITY;

-- Helpers de papel
CREATE OR REPLACE FUNCTION current_user_role()
RETURNS TEXT AS $$
  SELECT role FROM users_profile WHERE user_id = auth.uid() AND deleted_at IS NULL LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Políticas principais
CREATE POLICY "read_reference_all" ON ufs FOR SELECT USING (true);
CREATE POLICY "read_segments_all" ON segments FOR SELECT USING (true);
CREATE POLICY "own_profile_rw" ON users_profile FOR ALL USING (user_id = auth.uid() OR current_user_role() = 'ADMIN');
CREATE POLICY "member_companies_select" ON companies FOR SELECT USING (
  deleted_at IS NULL AND (
    current_user_role() = 'ADMIN'
    OR EXISTS (SELECT 1 FROM company_members cm WHERE cm.company_id = companies.id AND cm.user_id = auth.uid() AND cm.status = 'ATIVO' AND cm.deleted_at IS NULL)
  )
);
CREATE POLICY "own_alerts_select" ON alerts FOR SELECT USING (user_id = auth.uid() OR current_user_role() = 'ADMIN');
CREATE POLICY "curator_acts_rw" ON acts FOR ALL USING (current_user_role() IN ('CURADOR', 'ADMIN'));
CREATE POLICY "admin_audit_select" ON audit_log FOR SELECT USING (current_user_role() = 'ADMIN');
