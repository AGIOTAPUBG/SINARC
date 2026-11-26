import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  BRAZIL_UFS,
  CONTRAN_807_BASE_CATALOG,
  INITIAL_SEGMENTS,
} from '../packages/shared/constants.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
export const PDF_STORAGE_DIR = path.resolve(DATA_DIR, 'pdfs');
export const EXPORT_STORAGE_DIR = path.resolve(DATA_DIR, 'exports');

export function ensureStorageDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PDF_STORAGE_DIR, { recursive: true });
  fs.mkdirSync(EXPORT_STORAGE_DIR, { recursive: true });
}

export function createDatabase(dbPath?: string): Database.Database {
  const targetPath = dbPath ?? path.resolve(DATA_DIR, 'sinarc.db');
  if (targetPath !== ':memory:') {
    ensureStorageDirs();
  }
  const db = new Database(targetPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS ufs (
      sigla TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      orgao_nome TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS segments (
      code TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      ativo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS checklist_catalog (
      id TEXT PRIMARY KEY,
      codigo TEXT NOT NULL UNIQUE,
      titulo TEXT NOT NULL,
      descricao TEXT NOT NULL,
      bloco TEXT NOT NULL,
      base_normativa TEXT NOT NULL,
      segment_code TEXT NULL REFERENCES segments(code),
      uf_sigla TEXT NULL REFERENCES ufs(sigla),
      ativo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS users_profile (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      nome TEXT NOT NULL,
      celular_e164 TEXT NOT NULL,
      whatsapp_opt_in INTEGER NOT NULL DEFAULT 0,
      whatsapp_opt_in_at TEXT NULL,
      whatsapp_opt_in_text TEXT NULL,
      ritmo TEXT NOT NULL DEFAULT 'IMEDIATO' CHECK (ritmo IN ('IMEDIATO', 'RESUMO_DIARIO')),
      email_opt_in INTEGER NOT NULL DEFAULT 1,
      terms_version_accepted TEXT NULL,
      terms_accepted_at TEXT NULL,
      role TEXT NOT NULL DEFAULT 'CLIENTE' CHECK (role IN ('CLIENTE', 'CURADOR', 'ADMIN')),
      mfa_required INTEGER NOT NULL DEFAULT 0,
      mfa_secret TEXT NULL,
      mfa_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS push_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users_profile(user_id),
      token TEXT NOT NULL,
      platform TEXT NOT NULL CHECK (platform IN ('IOS', 'ANDROID', 'WEB')),
      ativo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT NULL,
      UNIQUE (user_id, token)
    );

    CREATE TABLE IF NOT EXISTS monitoring_profiles (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL REFERENCES users_profile(user_id),
      nome TEXT NOT NULL,
      stripe_customer_id TEXT NULL,
      stripe_subscription_id TEXT NULL,
      billing_cycle TEXT NOT NULL DEFAULT 'MENSAL' CHECK (billing_cycle IN ('MENSAL', 'ANUAL')),
      founder_price_locked INTEGER NOT NULL DEFAULT 0,
      founder_number INTEGER NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES monitoring_profiles(id),
      cnpj TEXT NOT NULL,
      razao_social TEXT NOT NULL,
      nome_fantasia TEXT NOT NULL,
      endereco TEXT NOT NULL,
      segment_code TEXT NOT NULL REFERENCES segments(code),
      plan TEXT NOT NULL DEFAULT 'FREE' CHECK (plan IN ('FREE', 'PRO', 'NACIONAL')),
      plan_status TEXT NOT NULL DEFAULT 'FREE' CHECK (plan_status IN ('ATIVO', 'INADIMPLENTE', 'CANCELADO', 'FREE')),
      stripe_subscription_item_id TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_profile_cnpj_active
      ON companies(profile_id, cnpj) WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS company_ufs (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id),
      uf_sigla TEXT NOT NULL REFERENCES ufs(sigla),
      kind TEXT NOT NULL CHECK (kind IN ('CREDENCIADA', 'INTERESSE')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (company_id, uf_sigla)
    );

    CREATE TABLE IF NOT EXISTS company_members (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id),
      user_id TEXT NOT NULL REFERENCES users_profile(user_id),
      is_owner INTEGER NOT NULL DEFAULT 0,
      invited_by TEXT NULL,
      status TEXT NOT NULL DEFAULT 'ATIVO' CHECK (status IN ('CONVIDADO', 'ATIVO', 'REMOVIDO')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT NULL,
      UNIQUE (company_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS member_preferences (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id),
      user_id TEXT NOT NULL REFERENCES users_profile(user_id),
      uf_sigla TEXT NOT NULL REFERENCES ufs(sigla),
      ativo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (company_id, user_id, uf_sigla)
    );

    CREATE TABLE IF NOT EXISTS member_channels (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users_profile(user_id),
      channel TEXT NOT NULL CHECK (channel IN ('APP', 'PUSH', 'EMAIL', 'WHATSAPP')),
      ativo INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (user_id, channel)
    );

    CREATE TABLE IF NOT EXISTS acts (
      id TEXT PRIMARY KEY,
      uf_sigla TEXT NOT NULL REFERENCES ufs(sigla),
      orgao TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK (tipo IN ('PORTARIA', 'EDITAL', 'RESOLUCAO', 'CHAMAMENTO', 'COMUNICADO')),
      numero TEXT NOT NULL,
      data_publicacao TEXT NOT NULL,
      assunto TEXT NOT NULL CHECK (assunto IN ('ABERTURA', 'RENOVACAO', 'NOVA_EXIGENCIA', 'DESCREDENCIAMENTO', 'SUSPENSAO', 'PRORROGACAO')),
      natureza_base TEXT NOT NULL CHECK (natureza_base IN ('OPORTUNIDADE', 'OBRIGACAO', 'AMBAS')),
      urgencia TEXT NOT NULL CHECK (urgencia IN ('URGENTE', 'IMPORTANTE', 'INFORMATIVO')),
      prazo TEXT NULL,
      sem_prazo INTEGER NOT NULL DEFAULT 0,
      titulo TEXT NOT NULL,
      resumo TEXT NOT NULL,
      pdf_path TEXT NULL,
      fonte_url TEXT NULL,
      status TEXT NOT NULL DEFAULT 'RASCUNHO' CHECK (status IN ('RASCUNHO', 'EM_REVISAO', 'PUBLICADO', 'ENCERRADO', 'REVOGADO')),
      current_version INTEGER NOT NULL DEFAULT 1,
      publicado_em TEXT NULL,
      publicacao_oficial_em TEXT NULL,
      created_by TEXT NOT NULL,
      submitted_by TEXT NULL,
      approved_by TEXT NULL,
      return_comment TEXT NULL,
      ai_metadata TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS act_segments (
      id TEXT PRIMARY KEY,
      act_id TEXT NOT NULL REFERENCES acts(id),
      segment_code TEXT NOT NULL REFERENCES segments(code),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (act_id, segment_code)
    );

    CREATE TABLE IF NOT EXISTS act_checklist_items (
      id TEXT PRIMARY KEY,
      act_id TEXT NOT NULL REFERENCES acts(id),
      catalog_id TEXT NULL REFERENCES checklist_catalog(id),
      titulo TEXT NOT NULL,
      descricao TEXT NOT NULL,
      obrigatorio INTEGER NOT NULL DEFAULT 1,
      ordem INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS act_versions (
      id TEXT PRIMARY KEY,
      act_id TEXT NOT NULL REFERENCES acts(id),
      version INTEGER NOT NULL,
      snapshot TEXT NOT NULL,
      change_type TEXT NOT NULL CHECK (change_type IN ('PUBLICACAO', 'ATUALIZACAO', 'CORRECAO', 'ENCERRAMENTO', 'REVOGACAO')),
      change_note TEXT NOT NULL,
      published_by TEXT NOT NULL,
      published_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (act_id, version)
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      act_id TEXT NOT NULL REFERENCES acts(id),
      act_version INTEGER NOT NULL,
      user_id TEXT NOT NULL REFERENCES users_profile(user_id),
      profile_id TEXT NOT NULL REFERENCES monitoring_profiles(id),
      natureza TEXT NOT NULL CHECK (natureza IN ('OPORTUNIDADE', 'OBRIGACAO')),
      urgencia TEXT NOT NULL CHECK (urgencia IN ('URGENTE', 'IMPORTANTE', 'INFORMATIVO')),
      company_ids TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'NOVO' CHECK (status IN ('NOVO', 'VISTO', 'EM_ANDAMENTO', 'RESOLVIDO')),
      status_changed_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_correction INTEGER NOT NULL DEFAULT 0,
      locked_for_free INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (act_id, act_version, user_id, natureza)
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY,
      alert_id TEXT NOT NULL REFERENCES alerts(id),
      channel TEXT NOT NULL CHECK (channel IN ('APP', 'PUSH', 'EMAIL', 'WHATSAPP')),
      kind TEXT NOT NULL CHECK (kind IN ('ALERTA', 'LEMBRETE_30', 'LEMBRETE_7', 'LEMBRETE_1', 'RESUMO_DIARIO', 'RESUMO_SEMANAL_FREE')),
      scheduled_for TEXT NOT NULL,
      sent_at TEXT NULL,
      status TEXT NOT NULL DEFAULT 'AGENDADO' CHECK (status IN ('AGENDADO', 'ENVIADO', 'FALHOU', 'CANCELADO')),
      attempts INTEGER NOT NULL DEFAULT 0,
      provider_message_id TEXT NULL,
      error TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (alert_id, channel, kind)
    );

    CREATE TABLE IF NOT EXISTS whatsapp_inbound (
      id TEXT PRIMARY KEY,
      user_id TEXT NULL,
      from_e164 TEXT NOT NULL,
      provider_message_id TEXT NOT NULL UNIQUE,
      message_text TEXT NOT NULL,
      action_taken TEXT NOT NULL,
      received_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS watch_targets (
      id TEXT PRIMARY KEY,
      uf_sigla TEXT NOT NULL REFERENCES ufs(sigla),
      url TEXT NOT NULL,
      descricao TEXT NOT NULL,
      ativo INTEGER NOT NULL DEFAULT 1,
      ultima_hash TEXT NULL,
      ultima_verificacao TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS watch_suggestions (
      id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL REFERENCES watch_targets(id),
      detectado_em TEXT NOT NULL,
      diff_resumo TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE', 'VIROU_ATO', 'DESCARTADA')),
      act_id TEXT NULL REFERENCES acts(id),
      tratado_por TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS billing_events (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      processed_at TEXT NULL,
      status TEXT NOT NULL DEFAULT 'PROCESSADO',
      error TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS invoices_nf (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES monitoring_profiles(id),
      stripe_invoice_id TEXT NOT NULL UNIQUE,
      nf_provider_id TEXT NULL,
      status TEXT NOT NULL DEFAULT 'PENDENTE' CHECK (status IN ('PENDENTE', 'EMITIDA', 'ERRO')),
      pdf_url TEXT NULL,
      xml_url TEXT NULL,
      error TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS consents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users_profile(user_id),
      tipo TEXT NOT NULL CHECK (tipo IN ('TERMOS', 'PRIVACIDADE', 'WHATSAPP', 'EMAIL_MARKETING')),
      versao TEXT NOT NULL,
      texto TEXT NOT NULL,
      aceito INTEGER NOT NULL,
      em TEXT NOT NULL,
      ip TEXT NOT NULL,
      origem TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT NULL,
      acao TEXT NOT NULL,
      entidade TEXT NOT NULL,
      entidade_id TEXT NOT NULL,
      antes TEXT NULL,
      depois TEXT NULL,
      ip TEXT NULL,
      em TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TRIGGER IF NOT EXISTS prevent_audit_log_update
    BEFORE UPDATE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log é imutável (somente inserção)');
    END;

    CREATE TRIGGER IF NOT EXISTS prevent_audit_log_delete
    BEFORE DELETE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log é imutável (exclusão proibida)');
    END;

    CREATE TABLE IF NOT EXISTS data_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users_profile(user_id),
      tipo TEXT NOT NULL CHECK (tipo IN ('EXPORTACAO', 'EXCLUSAO')),
      status TEXT NOT NULL DEFAULT 'CONCLUIDO',
      solicitado_em TEXT NOT NULL,
      concluido_em TEXT NULL,
      arquivo_path TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS billing_settings (
      id TEXT PRIMARY KEY,
      pro_monthly_cents INTEGER NOT NULL DEFAULT 29700,
      pro_annual_cents INTEGER NOT NULL DEFAULT 297000,
      nacional_monthly_cents INTEGER NOT NULL DEFAULT 59700,
      nacional_annual_cents INTEGER NOT NULL DEFAULT 597000,
      discount_5_to_9_pct INTEGER NOT NULL DEFAULT 15,
      discount_10_plus_pct INTEGER NOT NULL DEFAULT 25,
      founder_limit INTEGER NOT NULL DEFAULT 30,
      updated_by TEXT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  seedReferenceData(db);
  return db;
}

function seedReferenceData(db: Database.Database) {
  const insertUf = db.prepare(
    `INSERT OR IGNORE INTO ufs (sigla, nome, orgao_nome) VALUES (?, ?, ?)`
  );
  for (const uf of BRAZIL_UFS) {
    insertUf.run(uf.sigla, uf.nome, uf.orgao_nome);
  }

  const insertSeg = db.prepare(
    `INSERT OR IGNORE INTO segments (code, nome, ativo) VALUES (?, ?, ?)`
  );
  for (const seg of INITIAL_SEGMENTS) {
    insertSeg.run(seg.code, seg.nome, seg.ativo ? 1 : 0);
  }

  const insertCat = db.prepare(`
    INSERT OR IGNORE INTO checklist_catalog
      (id, codigo, titulo, descricao, bloco, base_normativa, segment_code, uf_sigla, ativo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const item of CONTRAN_807_BASE_CATALOG) {
    insertCat.run(
      crypto.createHash('sha1').update(item.codigo).digest('hex').slice(0, 32),
      item.codigo,
      item.titulo,
      item.descricao,
      item.bloco,
      item.base_normativa,
      item.segment_code,
      item.uf_sigla,
      item.ativo ? 1 : 0
    );
  }

  db.prepare(`
    INSERT OR IGNORE INTO billing_settings
      (id, pro_monthly_cents, pro_annual_cents, nacional_monthly_cents, nacional_annual_cents, discount_5_to_9_pct, discount_10_plus_pct, founder_limit)
    VALUES ('default', 29700, 297000, 59700, 597000, 15, 25, 30)
  `).run();

  const existingTargets = db.prepare(`SELECT COUNT(*) as cnt FROM watch_targets`).get() as { cnt: number };
  if (existingTargets.cnt === 0) {
    const insertTarget = db.prepare(
      `INSERT INTO watch_targets (id, uf_sigla, url, descricao, ativo) VALUES (?, ?, ?, ?, 1)`
    );
    insertTarget.run(crypto.randomUUID(), 'GO', 'https://www.detran.go.gov.br/paginas/credenciamento', 'Portal de Credenciamento DETRAN-GO');
    insertTarget.run(crypto.randomUUID(), 'SP', 'https://www.detran.sp.gov.br/wps/portal/portaldetran/parceiros', 'Portal de Parceiros e Credenciados DETRAN-SP');
    insertTarget.run(crypto.randomUUID(), 'MG', 'https://transito.mg.gov.br/credenciamento', 'Credenciamento CET-MG');
    insertTarget.run(crypto.randomUUID(), 'PR', 'https://www.detran.pr.gov.br/Credenciados', 'Comunicados e Portarias DETRAN-PR');
  }

  // Atos normativos iniciais publicados apenas se não houver atos no banco (para que Step 7 do onboarding e feed funcionem de imediato)
  const existingActs = db.prepare(`SELECT COUNT(*) as cnt FROM acts`).get() as { cnt: number };
  if (existingActs.cnt === 0) {
    const sampleActs = [
      {
        id: 'act-go-ecv-2026',
        uf_sigla: 'GO',
        orgao: 'DETRAN-GO',
        tipo: 'EDITAL',
        numero: '014/2026',
        data_publicacao: '2026-11-24',
        assunto: 'ABERTURA',
        natureza_base: 'OPORTUNIDADE',
        urgencia: 'URGENTE',
        prazo: '2027-01-15',
        sem_prazo: 0,
        titulo: 'Edital de Chamamento Público para credenciamento de novas ECVs em Goiás',
        resumo: 'O DETRAN-GO abriu janela de credenciamento para Empresas Credenciadas de Vistoria Veicular (ECV) em todos os municípios goianos. Protocolo exclusivamente digital com apresentação de ISO 9001, certidões negativas e vistoria técnica de pátio.',
        fonte_url: 'https://www.detran.go.gov.br/edital-014-2026',
        status: 'PUBLICADO',
        segments: ['ECV'],
      },
      {
        id: 'act-sp-reg-2026',
        uf_sigla: 'SP',
        orgao: 'DETRAN-SP',
        tipo: 'PORTARIA',
        numero: '412/2026',
        data_publicacao: '2026-11-23',
        assunto: 'NOVA_EXIGENCIA',
        natureza_base: 'OBRIGACAO',
        urgencia: 'IMPORTANTE',
        prazo: '2026-12-28',
        sem_prazo: 0,
        titulo: 'Portaria DETRAN-SP exige recadastramento de certificado digital e prova de conceito de registradoras',
        resumo: 'Registradoras de contrato atualmente credenciadas no Estado de São Paulo devem atualizar o protocolo de integração v3.2 e renovar as certidões federais, estaduais e CNDT até 28/12/2026 sob pena de suspensão preventiva.',
        fonte_url: 'https://www.detran.sp.gov.br/portaria-412-2026',
        status: 'PUBLICADO',
        segments: ['REGISTRADORA'],
      },
      {
        id: 'act-mg-ambas-2026',
        uf_sigla: 'MG',
        orgao: 'CET-MG',
        tipo: 'PORTARIA',
        numero: '198/2026',
        data_publicacao: '2026-11-21',
        assunto: 'RENOVACAO',
        natureza_base: 'AMBAS',
        urgencia: 'IMPORTANTE',
        prazo: '2027-01-30',
        sem_prazo: 0,
        titulo: 'CET-MG publica calendário anual de renovação e novas adesões para ECVs e Registradoras',
        resumo: 'Define o cronograma de renovação anual para empresas já credenciadas em Minas Gerais e abre protocolo contínuo para novas habilitações de registradoras e ECVs.',
        fonte_url: 'https://transito.mg.gov.br/portaria-198-2026',
        status: 'PUBLICADO',
        segments: ['REGISTRADORA', 'ECV'],
      },
      {
        id: 'act-pr-ecv-encerrado-2026',
        uf_sigla: 'PR',
        orgao: 'DETRAN-PR',
        tipo: 'COMUNICADO',
        numero: '088/2026',
        data_publicacao: '2026-09-10',
        assunto: 'PRORROGACAO',
        natureza_base: 'AMBAS',
        urgencia: 'INFORMATIVO',
        prazo: '2026-10-15',
        sem_prazo: 0,
        titulo: 'Comunicado DETRAN-PR encerra prazo de adequação sistêmica de ECVs — ciclo 2026',
        resumo: 'Ciclo de adequação encerrado após prorrogação de 15 dias concedida pela Diretoria Técnica.',
        fonte_url: 'https://www.detran.pr.gov.br/comunicado-088-2026',
        status: 'ENCERRADO',
        segments: ['ECV'],
      },
    ];

    const insertAct = db.prepare(`
      INSERT INTO acts (
        id, uf_sigla, orgao, tipo, numero, data_publicacao, assunto, natureza_base,
        urgencia, prazo, sem_prazo, titulo, resumo, pdf_path, fonte_url, status,
        current_version, publicado_em, publicacao_oficial_em, created_by, submitted_by, approved_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1, ?, ?, 'system-seed', 'system-seed-sub', 'system-seed-app')
    `);
    const insertActSeg = db.prepare(`INSERT INTO act_segments (id, act_id, segment_code) VALUES (?, ?, ?)`);
    const insertActItem = db.prepare(`
      INSERT INTO act_checklist_items (id, act_id, catalog_id, titulo, descricao, obrigatorio, ordem)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertActVer = db.prepare(`
      INSERT INTO act_versions (id, act_id, version, snapshot, change_type, change_note, published_by, published_at)
      VALUES (?, ?, 1, ?, ?, ?, 'system-seed-app', ?)
    `);

    const catalogRows = db.prepare(`SELECT id, titulo, descricao, segment_code FROM checklist_catalog WHERE ativo = 1`).all() as Array<{
      id: string;
      titulo: string;
      descricao: string;
      segment_code: string | null;
    }>;

    for (const act of sampleActs) {
      const pubTime = `${act.data_publicacao}T12:00:00.000Z`;
      const officialTime = `${act.data_publicacao}T09:00:00.000Z`;
      insertAct.run(
        act.id,
        act.uf_sigla,
        act.orgao,
        act.tipo,
        act.numero,
        act.data_publicacao,
        act.assunto,
        act.natureza_base,
        act.urgencia,
        act.prazo,
        act.sem_prazo,
        act.titulo,
        act.resumo,
        act.fonte_url,
        act.status,
        pubTime,
        officialTime
      );

      for (const seg of act.segments) {
        insertActSeg.run(crypto.randomUUID(), act.id, seg);
      }

      const matchingCatalog = catalogRows.filter(
        (c) => c.segment_code === null || act.segments.includes(c.segment_code)
      );
      matchingCatalog.slice(0, 5).forEach((c, idx) => {
        insertActItem.run(crypto.randomUUID(), act.id, c.id, c.titulo, c.descricao, 1, idx + 1);
      });

      insertActVer.run(
        crypto.randomUUID(),
        act.id,
        JSON.stringify(act),
        act.status === 'ENCERRADO' ? 'ENCERRAMENTO' : 'PUBLICACAO',
        act.status === 'ENCERRADO' ? 'Encerramento automático do ciclo 2026.' : 'Publicação inicial curada.',
        pubTime
      );
    }
  }
}
