import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { normalizeCnpj, validateCnpj } from './packages/shared/cnpj.ts';
import {
  PRIVACY_TEXT_SUMMARY,
  PRIVACY_VERSION,
  TERMS_TEXT_SUMMARY,
  TERMS_VERSION,
  WHATSAPP_OPT_IN_TEXT,
} from './packages/shared/constants.ts';
import {
  calculateSubscriptionPricing,
  canApproveAct,
  classifyWhatsAppInbound,
  computeBusinessHoursSla,
  filterValidMemberPreferences,
  redactActForFree,
  validateCompanyUfsUpdate,
} from './packages/shared/rules.ts';
import type {
  ActAssunto,
  ActChangeType,
  ActChecklistItem,
  ActNaturezaBase,
  ActTipo,
  ActUrgencia,
  AlertStatus,
  BillingCycle,
  BillingSettings,
  ChannelType,
  ChecklistCatalogItem,
  CompanyAddress,
  CompanyUfKind,
  PlanType,
  UserRitmo,
  UserRole,
} from './packages/shared/types.ts';
import { createDatabase, ensureStorageDirs, EXPORT_STORAGE_DIR, PDF_STORAGE_DIR } from './server/db.ts';
import {
  cancelPendingRemindersForAct,
  cancelPendingRemindersForAlert,
  createActVersionSnapshot,
  fanoutAct,
  processScheduledDeliveries,
  recalculateActReminders,
  runAutoCloseExpiredActs,
  runWatcherCycle,
  writeAuditLog,
} from './server/engine.ts';
import {
  BrasilApiCnpjProvider,
  ConfigurableInvoiceProvider,
  ExpoPushProvider,
  GeminiActExtractor,
  getStripeClient,
  MetaWhatsAppProvider,
  ResendEmailProvider,
} from './server/providers.ts';
import {
  createRateLimiter,
  generateTotpSecret,
  hashPassword,
  resolveConfinedPath,
  signPdfAccessToken,
  signSessionToken,
  verifyPassword,
  verifyPdfAccessToken,
  verifySessionToken,
  verifyTotpCode,
  type SessionPayload,
} from './server/security.ts';

interface AuthedRequest extends Request {
  session?: SessionPayload;
}

export function createSinarcApp(dbPath?: string) {
  const db = createDatabase(dbPath);
  const app = express();
  app.set('trust proxy', 1);

  const cnpjProvider = new BrasilApiCnpjProvider();
  const actExtractor = new GeminiActExtractor();
  const whatsappProvider = new MetaWhatsAppProvider();
  const emailProvider = new ResendEmailProvider();
  const pushProvider = new ExpoPushProvider();
  const invoiceProvider = new ConfigurableInvoiceProvider();

  // Webhook da Stripe precisa de rawBody antes do express.json()
  app.post(
    '/api/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    async (req: Request, res: Response) => {
      try {
        const stripe = getStripeClient();
        const sig = req.headers['stripe-signature'];
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
        let event: { id: string; type: string; data: { object: Record<string, unknown> } };

        if (stripe && webhookSecret && typeof sig === 'string') {
          event = stripe.webhooks.constructEvent(req.body as Buffer, sig, webhookSecret) as unknown as {
            id: string;
            type: string;
            data: { object: Record<string, unknown> };
          };
        } else {
          const rawStr = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
          event = JSON.parse(rawStr);
        }

        if (!event?.id || !event?.type) {
          res.status(400).json({ error: 'Evento Stripe inválido.' });
          return;
        }

        // Idempotência por event_id (Seção 10)
        const existing = db
          .prepare(`SELECT id FROM billing_events WHERE event_id = ?`)
          .get(event.id);
        if (existing) {
          res.json({ received: true, idempotent: true });
          return;
        }

        await handleStripeEvent(event);

        db.prepare(`
          INSERT INTO billing_events (id, event_id, event_type, payload, processed_at, status)
          VALUES (?, ?, ?, ?, ?, 'PROCESSADO')
        `).run(
          crypto.randomUUID(),
          event.id,
          event.type,
          JSON.stringify(event),
          new Date().toISOString()
        );

        res.json({ received: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro no webhook Stripe';
        res.status(400).json({ error: msg });
      }
    }
  );

  app.use(express.json({ limit: '15mb' }));

  async function handleStripeEvent(event: {
    id: string;
    type: string;
    data: { object: Record<string, unknown> };
  }) {
    const obj = event.data.object;
    const customerId = String(obj.customer || '');

    if (event.type === 'checkout.session.completed') {
      const metadata = (obj.metadata || {}) as Record<string, string>;
      const profileId = metadata.profile_id;
      const plan = (metadata.plan || 'PRO') as PlanType;
      const cycle = (metadata.cycle || 'MENSAL') as BillingCycle;
      const companyIds = metadata.company_ids ? (JSON.parse(metadata.company_ids) as string[]) : [];
      const subscriptionId = String(obj.subscription || '');

      if (profileId) {
        activateProfileCompaniesPlan(profileId, companyIds, plan, cycle, customerId || null, subscriptionId || null);
      }
      return;
    }

    if (
      event.type === 'customer.subscription.created' ||
      event.type === 'customer.subscription.updated'
    ) {
      const subId = String(obj.id || '');
      const status = String(obj.status || '');
      const profile = db
        .prepare(`SELECT id FROM monitoring_profiles WHERE stripe_subscription_id = ? OR stripe_customer_id = ?`)
        .get(subId, customerId) as { id: string } | undefined;
      if (!profile) return;

      if (status === 'active' || status === 'trialing') {
        db.prepare(`
          UPDATE companies
          SET plan_status = 'ATIVO', updated_at = datetime('now')
          WHERE profile_id = ? AND plan != 'FREE' AND deleted_at IS NULL
        `).run(profile.id);
      } else if (status === 'past_due' || status === 'unpaid') {
        // RN-28: inadimplente volta ao FREE sem apagar dados
        db.prepare(`
          UPDATE companies
          SET plan = 'FREE', plan_status = 'INADIMPLENTE', updated_at = datetime('now')
          WHERE profile_id = ? AND plan != 'FREE' AND deleted_at IS NULL
        `).run(profile.id);
      }
      return;
    }

    if (event.type === 'customer.subscription.deleted') {
      const subId = String(obj.id || '');
      const profile = db
        .prepare(`SELECT id FROM monitoring_profiles WHERE stripe_subscription_id = ? OR stripe_customer_id = ?`)
        .get(subId, customerId) as { id: string } | undefined;
      if (!profile) return;

      // RN-28: cancelamento volta empresas ao FREE sem apagar dados
      db.prepare(`
        UPDATE companies
        SET plan = 'FREE', plan_status = 'CANCELADO', updated_at = datetime('now')
        WHERE profile_id = ? AND deleted_at IS NULL
      `).run(profile.id);
      writeAuditLog(db, {
        actorUserId: null,
        acao: 'ASSINATURA_CANCELADA_DOWNGRADE_FREE',
        entidade: 'monitoring_profiles',
        entidadeId: profile.id,
      });
      return;
    }

    if (event.type === 'invoice.payment_failed') {
      const profile = db
        .prepare(`SELECT id FROM monitoring_profiles WHERE stripe_customer_id = ?`)
        .get(customerId) as { id: string } | undefined;
      if (!profile) return;

      db.prepare(`
        UPDATE companies
        SET plan = 'FREE', plan_status = 'INADIMPLENTE', updated_at = datetime('now')
        WHERE profile_id = ? AND plan != 'FREE' AND deleted_at IS NULL
      `).run(profile.id);
      return;
    }

    if (event.type === 'invoice.paid') {
      const stripeInvoiceId = String(obj.id || '');
      const amountPaid = Number(obj.amount_paid || 0);
      const profile = db
        .prepare(`
          SELECT mp.id, mp.owner_user_id, up.nome, up.email
          FROM monitoring_profiles mp
          JOIN users_profile up ON up.user_id = mp.owner_user_id
          WHERE mp.stripe_customer_id = ?
        `)
        .get(customerId) as { id: string; owner_user_id: string; nome: string; email: string } | undefined;

      if (!profile || !stripeInvoiceId) return;

      const existingNf = db
        .prepare(`SELECT id FROM invoices_nf WHERE stripe_invoice_id = ?`)
        .get(stripeInvoiceId);
      if (existingNf) return;

      const firstCompany = db
        .prepare(`SELECT cnpj, razao_social FROM companies WHERE profile_id = ? AND deleted_at IS NULL LIMIT 1`)
        .get(profile.id) as { cnpj: string; razao_social: string } | undefined;

      try {
        const issued = await invoiceProvider.issue({
          stripeInvoiceId,
          amountCents: amountPaid,
          customerName: firstCompany?.razao_social || profile.nome,
          customerEmail: profile.email,
          customerCnpj: firstCompany?.cnpj,
          description: 'Assinatura SINARC — Monitoramento de Credenciamento',
        });

        db.prepare(`
          INSERT INTO invoices_nf (id, profile_id, stripe_invoice_id, nf_provider_id, status, pdf_url, xml_url)
          VALUES (?, ?, ?, ?, 'EMITIDA', ?, ?)
        `).run(crypto.randomUUID(), profile.id, stripeInvoiceId, issued.providerId, issued.pdfUrl, issued.xmlUrl);

        await emailProvider.send({
          to: profile.email,
          subject: 'SINARC | Pagamento confirmado e Nota Fiscal emitida',
          html: `<p>Olá, ${profile.nome}.</p><p>Seu pagamento foi confirmado e a Nota Fiscal foi emitida pela Bio Síntese.</p><p>PDF: ${issued.pdfUrl}</p>`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro NF';
        db.prepare(`
          INSERT INTO invoices_nf (id, profile_id, stripe_invoice_id, status, error)
          VALUES (?, ?, ?, 'ERRO', ?)
        `).run(crypto.randomUUID(), profile.id, stripeInvoiceId, msg);
      }
    }
  }

  function activateProfileCompaniesPlan(
    profileId: string,
    companyIds: string[],
    plan: PlanType,
    cycle: BillingCycle,
    stripeCustomerId: string | null,
    stripeSubscriptionId: string | null
  ) {
    const settings = getBillingSettings();
    const profile = db
      .prepare(`SELECT * FROM monitoring_profiles WHERE id = ?`)
      .get(profileId) as { founder_price_locked: number; founder_number: number | null };

    // RN-27: Primeiros 30 perfis ganham trava de fundador
    let founderLocked = profile.founder_price_locked === 1;
    let founderNumber = profile.founder_number;
    if (!founderLocked) {
      const countRow = db
        .prepare(`SELECT COUNT(*) as cnt FROM monitoring_profiles WHERE founder_price_locked = 1`)
        .get() as { cnt: number };
      if (countRow.cnt < settings.founder_limit) {
        founderLocked = true;
        founderNumber = countRow.cnt + 1;
      }
    }

    db.prepare(`
      UPDATE monitoring_profiles
      SET stripe_customer_id = COALESCE(?, stripe_customer_id),
          stripe_subscription_id = COALESCE(?, stripe_subscription_id),
          billing_cycle = ?,
          founder_price_locked = ?,
          founder_number = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(stripeCustomerId, stripeSubscriptionId, cycle, founderLocked ? 1 : 0, founderNumber, profileId);

    if (companyIds.length > 0) {
      const stmt = db.prepare(`
        UPDATE companies
        SET plan = ?, plan_status = 'ATIVO', updated_at = datetime('now')
        WHERE id = ? AND profile_id = ? AND deleted_at IS NULL
      `);
      for (const cid of companyIds) {
        stmt.run(plan, cid, profileId);
      }
    }

    // Reavalia alertas existentes que estavam locked_for_free para esse perfil
    const alerts = db
      .prepare(`SELECT id, company_ids FROM alerts WHERE profile_id = ? AND locked_for_free = 1`)
      .all(profileId) as Array<{ id: string; company_ids: string }>;
    for (const al of alerts) {
      const ids = JSON.parse(al.company_ids || '[]') as string[];
      if (ids.some((id) => companyIds.includes(id))) {
        db.prepare(`UPDATE alerts SET locked_for_free = 0, updated_at = datetime('now') WHERE id = ?`).run(al.id);
      }
    }
  }

  function getBillingSettings(): BillingSettings {
    const row = db.prepare(`SELECT * FROM billing_settings WHERE id = 'default'`).get() as {
      pro_monthly_cents: number;
      pro_annual_cents: number;
      nacional_monthly_cents: number;
      nacional_annual_cents: number;
      discount_5_to_9_pct: number;
      discount_10_plus_pct: number;
      founder_limit: number;
    };
    const founders = db
      .prepare(`SELECT COUNT(*) as cnt FROM monitoring_profiles WHERE founder_price_locked = 1`)
      .get() as { cnt: number };
    return {
      ...row,
      founders_taken: founders.cnt,
    };
  }

  // Middleware de autenticação
  function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!token) {
      res.status(401).json({ error: 'Autenticação necessária.' });
      return;
    }
    const session = verifySessionToken(token);
    if (!session) {
      res.status(401).json({ error: 'Sessão expirada ou inválida.' });
      return;
    }
    const userExists = db
      .prepare(`SELECT user_id, role, mfa_required, mfa_enabled FROM users_profile WHERE user_id = ? AND deleted_at IS NULL`)
      .get(session.userId) as
      | { user_id: string; role: UserRole; mfa_required: number; mfa_enabled: number }
      | undefined;
    if (!userExists) {
      res.status(401).json({ error: 'Usuário não encontrado.' });
      return;
    }
    req.session = { ...session, role: userExists.role };
    next();
  }

  function requireCuratorOrAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
    if (!req.session) {
      res.status(401).json({ error: 'Autenticação necessária.' });
      return;
    }
    if (req.session.role !== 'CURADOR' && req.session.role !== 'ADMIN') {
      res.status(403).json({ error: 'Acesso restrito à curadoria ou administração.' });
      return;
    }
    if (!req.session.mfaVerified) {
      res.status(403).json({ error: 'Verificação em duas etapas (2FA) obrigatória para este papel.' });
      return;
    }
    next();
  }

  function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
    if (!req.session || req.session.role !== 'ADMIN') {
      res.status(403).json({ error: 'Acesso restrito ao administrador.' });
      return;
    }
    if (!req.session.mfaVerified) {
      res.status(403).json({ error: 'Verificação em duas etapas (2FA) obrigatória para administrador.' });
      return;
    }
    next();
  }

  const authRateLimit = createRateLimiter('auth', 30, 60_000);
  const cnpjRateLimit = createRateLimiter('cnpj', 20, 60_000);

  // ==========================================
  // ROTAS PÚBLICAS DE REFERÊNCIA E CONSULTA
  // ==========================================
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/api/reference', (_req, res) => {
    const ufs = db.prepare(`SELECT sigla, nome, orgao_nome FROM ufs ORDER BY sigla`).all();
    const segments = db.prepare(`SELECT code, nome, ativo FROM segments WHERE ativo = 1`).all();
    const hasAdmin =
      (db.prepare(`SELECT COUNT(*) as cnt FROM users_profile WHERE role = 'ADMIN' AND deleted_at IS NULL`).get() as {
        cnt: number;
      }).cnt > 0;
    const settings = getBillingSettings();
    res.json({
      ufs,
      segments,
      hasAdmin,
      billingSettings: settings,
      legal: {
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION,
        termsText: TERMS_TEXT_SUMMARY,
        privacyText: PRIVACY_TEXT_SUMMARY,
        whatsappOptInText: WHATSAPP_OPT_IN_TEXT,
      },
    });
  });

  // RN-01: Consulta de CNPJ com validação prévia de dígitos verificadores
  app.get('/api/cnpj/:cnpj', cnpjRateLimit, async (req, res) => {
    const cnpj = normalizeCnpj(String(req.params.cnpj || ''));
    if (!validateCnpj(cnpj)) {
      res.status(400).json({ error: 'CNPJ inválido pelos dígitos verificadores (RN-01).' });
      return;
    }
    try {
      const data = await cnpjProvider.lookup(cnpj);
      res.json({ found: true, data });
    } catch (err) {
      res.json({
        found: false,
        cnpj,
        message: 'Não foi possível consultar a base pública agora. Preencha os dados manualmente.',
        detail: err instanceof Error ? err.message : undefined,
      });
    }
  });

  // ==========================================
  // AUTENTICAÇÃO, CADASTRO EM ETAPAS & 2FA
  // ==========================================
  app.post('/api/auth/admin-bootstrap', authRateLimit, (req, res) => {
    const existingAdmin = db
      .prepare(`SELECT user_id FROM users_profile WHERE role = 'ADMIN' AND deleted_at IS NULL LIMIT 1`)
      .get();
    if (existingAdmin) {
      res.status(409).json({ error: 'Administrador principal já configurado.' });
      return;
    }

    const { nome, email, password, celular_e164, passcode } = req.body as Record<string, string>;
    const envPasscode = process.env.ADMIN_BOOTSTRAP_PASSCODE;
    if (envPasscode && passcode !== envPasscode) {
      res.status(403).json({ error: 'Código de ativação inválido.' });
      return;
    }
    if (!nome || !email || !password || password.length < 8) {
      res.status(400).json({ error: 'Informe nome, e-mail válido e senha com pelo menos 8 caracteres.' });
      return;
    }

    const userId = crypto.randomUUID();
    const totpSecret = generateTotpSecret();
    const cleanEmail = email.trim().toLowerCase();

    db.prepare(`
      INSERT INTO users_profile (
        id, user_id, email, password_hash, nome, celular_e164,
        whatsapp_opt_in, ritmo, email_opt_in, terms_version_accepted,
        terms_accepted_at, role, mfa_required, mfa_secret, mfa_enabled
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 'IMEDIATO', 1, ?, ?, 'ADMIN', 1, ?, 1)
    `).run(
      crypto.randomUUID(),
      userId,
      cleanEmail,
      hashPassword(password),
      nome.trim(),
      celular_e164 || '+5511999999999',
      TERMS_VERSION,
      new Date().toISOString(),
      totpSecret
    );

    const profileId = crypto.randomUUID();
    db.prepare(`INSERT INTO monitoring_profiles (id, owner_user_id, nome) VALUES (?, ?, ?)`).run(
      profileId,
      userId,
      `Perfil Administrativo — ${nome.trim()}`
    );

    writeAuditLog(db, {
      actorUserId: userId,
      acao: 'BOOTSTRAP_ADMIN',
      entidade: 'users_profile',
      entidadeId: userId,
      ip: req.ip,
    });

    const token = signSessionToken({ userId, email: cleanEmail, role: 'ADMIN', mfaVerified: true });
    res.status(201).json({
      token,
      totpSecret,
      otpauthUrl: `otpauth://totp/SINARC:${encodeURIComponent(cleanEmail)}?secret=${totpSecret}&issuer=SINARC`,
      user: { user_id: userId, email: cleanEmail, nome: nome.trim(), role: 'ADMIN', mfa_enabled: true },
    });
  });

  // Cadastro em 7 etapas (Seção 7.1 item 2)
  app.post('/api/auth/register-onboarding', authRateLimit, async (req, res) => {
    try {
      const {
        nome,
        email,
        celular_e164,
        password,
        termsAccepted,
        company,
        channels,
      } = req.body as {
        nome: string;
        email: string;
        celular_e164: string;
        password: string;
        termsAccepted: boolean;
        company: {
          cnpj: string;
          razao_social: string;
          nome_fantasia: string;
          endereco: CompanyAddress;
          segment_code: string;
          ufs_credenciadas: string[];
          ufs_interesse: string[];
        };
        channels: { email: boolean; whatsapp: boolean; whatsappOptInAccepted: boolean };
      };

      if (!nome || !email || !celular_e164 || !password || password.length < 6) {
        res.status(400).json({ error: 'Preencha todos os dados pessoais e senha (mínimo 6 caracteres).' });
        return;
      }
      if (!termsAccepted) {
        res.status(400).json({ error: 'O aceite dos Termos de Uso e Política de Privacidade é obrigatório.' });
        return;
      }
      const cleanCnpj = normalizeCnpj(company?.cnpj || '');
      if (!validateCnpj(cleanCnpj)) {
        res.status(400).json({ error: 'CNPJ inválido pelos dígitos verificadores (RN-01).' });
        return;
      }

      const cleanEmail = email.trim().toLowerCase();
      const existingEmail = db
        .prepare(`SELECT user_id FROM users_profile WHERE email = ? AND deleted_at IS NULL`)
        .get(cleanEmail);
      if (existingEmail) {
        res.status(409).json({ error: 'Já existe uma conta cadastrada com este e-mail.' });
        return;
      }

      const ufItems: Array<{ uf_sigla: string; kind: CompanyUfKind }> = [
        ...(company.ufs_credenciadas || []).map((uf) => ({ uf_sigla: uf.toUpperCase(), kind: 'CREDENCIADA' as const })),
        ...(company.ufs_interesse || []).map((uf) => ({ uf_sigla: uf.toUpperCase(), kind: 'INTERESSE' as const })),
      ];
      const ufCheck = validateCompanyUfsUpdate('FREE', ufItems);
      if (!ufCheck.ok) {
        res.status(400).json({ error: ufCheck.error });
        return;
      }

      const userId = crypto.randomUUID();
      const profileId = crypto.randomUUID();
      const companyId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      const ip = req.ip || '0.0.0.0';

      const waOptIn = Boolean(channels?.whatsapp && channels?.whatsappOptInAccepted);

      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO users_profile (
            id, user_id, email, password_hash, nome, celular_e164,
            whatsapp_opt_in, whatsapp_opt_in_at, whatsapp_opt_in_text,
            ritmo, email_opt_in, terms_version_accepted, terms_accepted_at,
            role, mfa_required, mfa_enabled
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'IMEDIATO', ?, ?, ?, 'CLIENTE', 0, 0)
        `).run(
          crypto.randomUUID(),
          userId,
          cleanEmail,
          hashPassword(password),
          nome.trim(),
          celular_e164.trim(),
          waOptIn ? 1 : 0,
          waOptIn ? nowIso : null,
          waOptIn ? WHATSAPP_OPT_IN_TEXT : null,
          channels?.email !== false ? 1 : 0,
          TERMS_VERSION,
          nowIso
        );

        db.prepare(`INSERT INTO monitoring_profiles (id, owner_user_id, nome) VALUES (?, ?, ?)`).run(
          profileId,
          userId,
          `Perfil de ${nome.trim()}`
        );

        db.prepare(`
          INSERT INTO companies (
            id, profile_id, cnpj, razao_social, nome_fantasia, endereco, segment_code, plan, plan_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'FREE', 'FREE')
        `).run(
          companyId,
          profileId,
          cleanCnpj,
          company.razao_social.trim(),
          (company.nome_fantasia || company.razao_social).trim(),
          JSON.stringify(company.endereco || {}),
          company.segment_code
        );

        const insUf = db.prepare(`INSERT INTO company_ufs (id, company_id, uf_sigla, kind) VALUES (?, ?, ?, ?)`);
        const insPref = db.prepare(`
          INSERT INTO member_preferences (id, company_id, user_id, uf_sigla, ativo) VALUES (?, ?, ?, ?, 1)
        `);
        for (const u of ufItems) {
          insUf.run(crypto.randomUUID(), companyId, u.uf_sigla, u.kind);
          insPref.run(crypto.randomUUID(), companyId, userId, u.uf_sigla);
        }

        db.prepare(`
          INSERT INTO company_members (id, company_id, user_id, is_owner, status)
          VALUES (?, ?, ?, 1, 'ATIVO')
        `).run(crypto.randomUUID(), companyId, userId);

        const insChan = db.prepare(`INSERT INTO member_channels (id, user_id, channel, ativo) VALUES (?, ?, ?, ?)`);
        insChan.run(crypto.randomUUID(), userId, 'APP', 1);
        insChan.run(crypto.randomUUID(), userId, 'PUSH', 1);
        insChan.run(crypto.randomUUID(), userId, 'EMAIL', channels?.email !== false ? 1 : 0);
        insChan.run(crypto.randomUUID(), userId, 'WHATSAPP', waOptIn ? 1 : 0);

        const insConsent = db.prepare(`
          INSERT INTO consents (id, user_id, tipo, versao, texto, aceito, em, ip, origem)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'WEB_ONBOARDING')
        `);
        insConsent.run(crypto.randomUUID(), userId, 'TERMOS', TERMS_VERSION, TERMS_TEXT_SUMMARY, 1, nowIso, ip);
        insConsent.run(crypto.randomUUID(), userId, 'PRIVACIDADE', PRIVACY_VERSION, PRIVACY_TEXT_SUMMARY, 1, nowIso, ip);
        if (waOptIn) {
          insConsent.run(crypto.randomUUID(), userId, 'WHATSAPP', TERMS_VERSION, WHATSAPP_OPT_IN_TEXT, 1, nowIso, ip);
        }
      });

      tx();

      // Gera alertas retroativos iniciais para os atos PUBLICADOS que dão match (para o usuário já ver oportunidades/obrigações reais no Step 7 e no Feed!)
      const publishedActs = db
        .prepare(`SELECT id, current_version FROM acts WHERE status = 'PUBLICADO' AND deleted_at IS NULL`)
        .all() as Array<{ id: string; current_version: number }>;
      for (const pa of publishedActs) {
        fanoutAct(db, pa.id, pa.current_version);
      }

      const oppCount = (
        db
          .prepare(`SELECT COUNT(*) as cnt FROM alerts WHERE user_id = ? AND natureza = 'OPORTUNIDADE'`)
          .get(userId) as { cnt: number }
      ).cnt;
      const obrCount = (
        db
          .prepare(`SELECT COUNT(*) as cnt FROM alerts WHERE user_id = ? AND natureza = 'OBRIGACAO'`)
          .get(userId) as { cnt: number }
      ).cnt;

      if (waOptIn) {
        await whatsappProvider.sendTemplate({
          toE164: celular_e164.trim(),
          templateName: process.env.WHATSAPP_TPL_OPTIN || 'sinarc_confirmacao_optin',
          bodyText: `Olá, ${nome.trim()}! Você ativou os alertas do SINARC no WhatsApp. Para parar de receber, responda SAIR.`,
        });
      }

      await emailProvider.send({
        to: cleanEmail,
        subject: 'Bem-vindo ao SINARC — O seu radar de credenciamento',
        html: `<p>Olá, ${nome.trim()}.</p><p>Sua conta e empresa foram cadastradas. Encontramos ${oppCount} oportunidade(s) e ${obrCount} obrigação(ões) nas suas UFs.</p>`,
      });

      const token = signSessionToken({ userId, email: cleanEmail, role: 'CLIENTE', mfaVerified: true });
      res.status(201).json({
        token,
        summary: { oportunidades: oppCount, obrigacoes: obrCount },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Erro no cadastro.' });
    }
  });

  app.post('/api/auth/login', authRateLimit, (req, res) => {
    const { email, password, totpCode } = req.body as {
      email: string;
      password: string;
      totpCode?: string;
    };
    const cleanEmail = (email || '').trim().toLowerCase();
    const user = db
      .prepare(`SELECT * FROM users_profile WHERE email = ? AND deleted_at IS NULL`)
      .get(cleanEmail) as
      | {
          user_id: string;
          email: string;
          password_hash: string;
          nome: string;
          role: UserRole;
          mfa_required: number;
          mfa_secret: string | null;
          mfa_enabled: number;
        }
      | undefined;

    if (!user || !verifyPassword(password || '', user.password_hash)) {
      res.status(401).json({ error: 'E-mail ou senha inválidos.' });
      return;
    }

    const needsMfa = user.mfa_required === 1 || user.mfa_enabled === 1;
    if (needsMfa) {
      if (!user.mfa_secret) {
        // Primeiro acesso de Curador/Admin sem secret ainda configurado: emite token parcial para concluir setup 2FA
        const pendingSecret = generateTotpSecret();
        db.prepare(`UPDATE users_profile SET mfa_secret = ? WHERE user_id = ?`).run(pendingSecret, user.user_id);
        const partialToken = signSessionToken(
          { userId: user.user_id, email: user.email, role: user.role, mfaVerified: false },
          600
        );
        res.json({
          requiresMfaSetup: true,
          partialToken,
          totpSecret: pendingSecret,
          otpauthUrl: `otpauth://totp/SINARC:${encodeURIComponent(user.email)}?secret=${pendingSecret}&issuer=SINARC`,
        });
        return;
      }

      if (!totpCode) {
        res.status(200).json({ requiresMfa: true });
        return;
      }

      if (!verifyTotpCode(user.mfa_secret, totpCode)) {
        res.status(401).json({ error: 'Código 2FA inválido ou expirado.' });
        return;
      }
    }

    if (user.role === 'CURADOR' || user.role === 'ADMIN') {
      writeAuditLog(db, {
        actorUserId: user.user_id,
        acao: 'LOGIN_EQUIPE',
        entidade: 'users_profile',
        entidadeId: user.user_id,
        ip: req.ip,
      });
    }

    const token = signSessionToken({
      userId: user.user_id,
      email: user.email,
      role: user.role,
      mfaVerified: true,
    });
    res.json({
      token,
      user: { user_id: user.user_id, email: user.email, nome: user.nome, role: user.role },
    });
  });

  app.post('/api/auth/mfa/setup-confirm', requireAuth, (req: AuthedRequest, res) => {
    const { totpCode } = req.body as { totpCode: string };
    const userId = req.session!.userId;
    const user = db
      .prepare(`SELECT email, role, mfa_secret FROM users_profile WHERE user_id = ?`)
      .get(userId) as { email: string; role: UserRole; mfa_secret: string | null } | undefined;
    if (!user?.mfa_secret || !verifyTotpCode(user.mfa_secret, totpCode)) {
      res.status(400).json({ error: 'Código 2FA inválido.' });
      return;
    }
    db.prepare(`UPDATE users_profile SET mfa_enabled = 1, updated_at = datetime('now') WHERE user_id = ?`).run(userId);
    const token = signSessionToken({ userId, email: user.email, role: user.role, mfaVerified: true });
    res.json({ token, mfaEnabled: true });
  });

  app.post('/api/auth/mfa/enable-request', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.session!.userId;
    const user = db.prepare(`SELECT email FROM users_profile WHERE user_id = ?`).get(userId) as { email: string };
    const secret = generateTotpSecret();
    db.prepare(`UPDATE users_profile SET mfa_secret = ? WHERE user_id = ?`).run(secret, userId);
    res.json({
      totpSecret: secret,
      otpauthUrl: `otpauth://totp/SINARC:${encodeURIComponent(user.email)}?secret=${secret}&issuer=SINARC`,
    });
  });

  app.post('/api/auth/forgot-password', authRateLimit, async (req, res) => {
    const { email } = req.body as { email?: string };
    if (email) {
      await emailProvider.send({
        to: email,
        subject: 'SINARC | Recuperação de senha',
        html: '<p>Recebemos uma solicitação de redefinição de senha para sua conta no SINARC.</p>',
      });
    }
    res.json({ ok: true, message: 'Se o e-mail existir, enviamos as instruções de recuperação.' });
  });

  // ==========================================
  // PERFIL, EMPRESAS, MEMBROS E PREFERÊNCIAS
  // ==========================================
  app.get('/api/me', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.session!.userId;
    const profileRow = db
      .prepare(
        `SELECT user_id, email, nome, celular_e164, whatsapp_opt_in, whatsapp_opt_in_at, whatsapp_opt_in_text,
                ritmo, email_opt_in, terms_version_accepted, terms_accepted_at, role, mfa_required, mfa_enabled
         FROM users_profile WHERE user_id = ?`
      )
      .get(userId);

    const monitoringProfiles = db
      .prepare(`SELECT * FROM monitoring_profiles WHERE owner_user_id = ? AND deleted_at IS NULL`)
      .all(userId);

    const companies = db
      .prepare(
        `SELECT c.*, cm.is_owner, mp.owner_user_id
         FROM companies c
         JOIN company_members cm ON cm.company_id = c.id
         JOIN monitoring_profiles mp ON mp.id = c.profile_id
         WHERE cm.user_id = ? AND cm.status = 'ATIVO' AND cm.deleted_at IS NULL AND c.deleted_at IS NULL
         ORDER BY c.created_at ASC`
      )
      .all(userId) as Array<Record<string, unknown>>;

    const enrichedCompanies = companies.map((c) => {
      const ufs = db
        .prepare(`SELECT company_id, uf_sigla, kind FROM company_ufs WHERE company_id = ? ORDER BY uf_sigla`)
        .all(String(c.id));
      const members = db
        .prepare(
          `SELECT cm.id, cm.user_id, cm.is_owner, cm.status, up.nome, up.email
           FROM company_members cm
           JOIN users_profile up ON up.user_id = cm.user_id
           WHERE cm.company_id = ? AND cm.deleted_at IS NULL`
        )
        .all(String(c.id));
      const myPrefs = db
        .prepare(`SELECT uf_sigla, ativo FROM member_preferences WHERE company_id = ? AND user_id = ?`)
        .all(String(c.id), userId);
      return {
        ...c,
        endereco: JSON.parse(String(c.endereco || '{}')),
        ufs,
        members,
        myPrefs,
      };
    });

    const channels = db
      .prepare(`SELECT channel, ativo FROM member_channels WHERE user_id = ?`)
      .all(userId);

    const consents = db
      .prepare(`SELECT id, tipo, versao, aceito, em, origem FROM consents WHERE user_id = ? ORDER BY em DESC`)
      .all(userId);

    const invoices = db
      .prepare(
        `SELECT i.* FROM invoices_nf i
         JOIN monitoring_profiles mp ON mp.id = i.profile_id
         WHERE mp.owner_user_id = ?
         ORDER BY i.created_at DESC`
      )
      .all(userId);

    res.json({
      user: profileRow,
      monitoringProfiles,
      companies: enrichedCompanies,
      channels,
      consents,
      invoices,
    });
  });

  // Adicionar nova empresa ao perfil do dono (RN-01, RN-02, RN-03, RN-04)
  app.post('/api/companies', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.session!.userId;
    const {
      profile_id,
      cnpj,
      razao_social,
      nome_fantasia,
      endereco,
      segment_code,
      ufs,
    } = req.body as {
      profile_id?: string;
      cnpj: string;
      razao_social: string;
      nome_fantasia?: string;
      endereco?: CompanyAddress;
      segment_code: string;
      ufs: Array<{ uf_sigla: string; kind: CompanyUfKind }>;
    };

    const cleanCnpj = normalizeCnpj(cnpj);
    if (!validateCnpj(cleanCnpj)) {
      res.status(400).json({ error: 'CNPJ inválido pelos dígitos verificadores (RN-01).' });
      return;
    }

    const profile = (
      profile_id
        ? db.prepare(`SELECT * FROM monitoring_profiles WHERE id = ? AND owner_user_id = ? AND deleted_at IS NULL`).get(profile_id, userId)
        : db.prepare(`SELECT * FROM monitoring_profiles WHERE owner_user_id = ? AND deleted_at IS NULL LIMIT 1`).get(userId)
    ) as { id: string } | undefined;

    if (!profile) {
      res.status(403).json({ error: 'Perfil de monitoramento não encontrado ou sem permissão de dono.' });
      return;
    }

    // RN-02: CNPJ único por perfil
    const duplicate = db
      .prepare(`SELECT id FROM companies WHERE profile_id = ? AND cnpj = ? AND deleted_at IS NULL`)
      .get(profile.id, cleanCnpj);
    if (duplicate) {
      res.status(409).json({ error: 'Este CNPJ já está cadastrado neste perfil (RN-02).' });
      return;
    }

    const ufCheck = validateCompanyUfsUpdate('FREE', ufs || []);
    if (!ufCheck.ok) {
      res.status(400).json({ error: ufCheck.error });
      return;
    }

    const companyId = crypto.randomUUID();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO companies (id, profile_id, cnpj, razao_social, nome_fantasia, endereco, segment_code, plan, plan_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'FREE', 'FREE')
      `).run(
        companyId,
        profile.id,
        cleanCnpj,
        razao_social.trim(),
        (nome_fantasia || razao_social).trim(),
        JSON.stringify(endereco || {}),
        segment_code
      );

      const insUf = db.prepare(`INSERT INTO company_ufs (id, company_id, uf_sigla, kind) VALUES (?, ?, ?, ?)`);
      const insPref = db.prepare(`INSERT INTO member_preferences (id, company_id, user_id, uf_sigla, ativo) VALUES (?, ?, ?, ?, 1)`);
      for (const u of ufs || []) {
        const sigla = u.uf_sigla.toUpperCase();
        insUf.run(crypto.randomUUID(), companyId, sigla, u.kind);
        insPref.run(crypto.randomUUID(), companyId, userId, sigla);
      }

      db.prepare(`INSERT INTO company_members (id, company_id, user_id, is_owner, status) VALUES (?, ?, ?, 1, 'ATIVO')`).run(
        crypto.randomUUID(),
        companyId,
        userId
      );
    })();

    const publishedActs = db
      .prepare(`SELECT id, current_version FROM acts WHERE status = 'PUBLICADO' AND deleted_at IS NULL`)
      .all() as Array<{ id: string; current_version: number }>;
    for (const pa of publishedActs) {
      fanoutAct(db, pa.id, pa.current_version);
    }

    res.status(201).json({ id: companyId });
  });

  // Editar UFs da empresa (somente Dono ou Admin, respeitando RN-03, RN-04, RN-05)
  app.put('/api/companies/:companyId/ufs', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.session!.userId;
    const companyId = String(req.params.companyId);
    const { ufs } = req.body as { ufs: Array<{ uf_sigla: string; kind: CompanyUfKind }> };

    const company = db
      .prepare(
        `SELECT c.*, mp.owner_user_id
         FROM companies c JOIN monitoring_profiles mp ON mp.id = c.profile_id
         WHERE c.id = ? AND c.deleted_at IS NULL`
      )
      .get(companyId) as { id: string; plan: PlanType; owner_user_id: string } | undefined;

    if (!company) {
      res.status(404).json({ error: 'Empresa não encontrada.' });
      return;
    }
    if (company.owner_user_id !== userId && req.session!.role !== 'ADMIN') {
      res.status(403).json({ error: 'Apenas o dono da conta pode alterar as UFs da empresa.' });
      return;
    }

    const ufCheck = validateCompanyUfsUpdate(company.plan, ufs || []);
    if (!ufCheck.ok) {
      res.status(400).json({ error: ufCheck.error });
      return;
    }

    db.transaction(() => {
      db.prepare(`DELETE FROM company_ufs WHERE company_id = ?`).run(companyId);
      const insUf = db.prepare(`INSERT INTO company_ufs (id, company_id, uf_sigla, kind) VALUES (?, ?, ?, ?)`);
      for (const u of ufs || []) {
        insUf.run(crypto.randomUUID(), companyId, u.uf_sigla.toUpperCase(), u.kind);
      }

      // Sincroniza member_preferences removendo UFs que saíram e ativando novas UFs para membros ativos
      const validSet = (ufs || []).map((u) => u.uf_sigla.toUpperCase());
      if (validSet.length > 0) {
        db.prepare(
          `DELETE FROM member_preferences WHERE company_id = ? AND uf_sigla NOT IN (${validSet.map(() => '?').join(',')})`
        ).run(companyId, ...validSet);
      } else {
        db.prepare(`DELETE FROM member_preferences WHERE company_id = ?`).run(companyId);
      }

      const activeMembers = db
        .prepare(`SELECT user_id FROM company_members WHERE company_id = ? AND status = 'ATIVO' AND deleted_at IS NULL`)
        .all(companyId) as Array<{ user_id: string }>;
      const insPref = db.prepare(`
        INSERT OR IGNORE INTO member_preferences (id, company_id, user_id, uf_sigla, ativo) VALUES (?, ?, ?, ?, 1)
      `);
      for (const m of activeMembers) {
        for (const sigla of validSet) {
          insPref.run(crypto.randomUUID(), companyId, m.user_id, sigla);
        }
      }
    })();

    const publishedActs = db
      .prepare(`SELECT id, current_version FROM acts WHERE status = 'PUBLICADO' AND deleted_at IS NULL`)
      .all() as Array<{ id: string; current_version: number }>;
    for (const pa of publishedActs) {
      fanoutAct(db, pa.id, pa.current_version);
    }

    res.json({ ok: true });
  });

  // Convidar membro para empresa (somente dono) — RN-05
  app.post('/api/companies/:companyId/members', requireAuth, async (req: AuthedRequest, res) => {
    const actorId = req.session!.userId;
    const companyId = String(req.params.companyId);
    const { email, nome } = req.body as { email: string; nome?: string };

    const company = db
      .prepare(
        `SELECT c.id, c.razao_social, mp.owner_user_id
         FROM companies c JOIN monitoring_profiles mp ON mp.id = c.profile_id
         WHERE c.id = ? AND c.deleted_at IS NULL`
      )
      .get(companyId) as { id: string; razao_social: string; owner_user_id: string } | undefined;

    if (!company || (company.owner_user_id !== actorId && req.session!.role !== 'ADMIN')) {
      res.status(403).json({ error: 'Apenas o dono da conta pode convidar membros.' });
      return;
    }

    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanEmail) {
      res.status(400).json({ error: 'Informe o e-mail do membro.' });
      return;
    }

    let targetUser = db
      .prepare(`SELECT user_id, nome FROM users_profile WHERE email = ? AND deleted_at IS NULL`)
      .get(cleanEmail) as { user_id: string; nome: string } | undefined;

    let tempPassword: string | null = null;
    if (!targetUser) {
      const newUserId = crypto.randomUUID();
      tempPassword = crypto.randomBytes(6).toString('base64url');
      db.prepare(`
        INSERT INTO users_profile (id, user_id, email, password_hash, nome, celular_e164, ritmo, email_opt_in, role)
        VALUES (?, ?, ?, ?, ?, '+5511999999999', 'IMEDIATO', 1, 'CLIENTE')
      `).run(crypto.randomUUID(), newUserId, cleanEmail, hashPassword(tempPassword), (nome || cleanEmail.split('@')[0]).trim());
      db.prepare(`INSERT INTO member_channels (id, user_id, channel, ativo) VALUES (?, ?, 'APP', 1)`).run(
        crypto.randomUUID(),
        newUserId
      );
      db.prepare(`INSERT INTO member_channels (id, user_id, channel, ativo) VALUES (?, ?, 'EMAIL', 1)`).run(
        crypto.randomUUID(),
        newUserId
      );
      targetUser = { user_id: newUserId, nome: nome || cleanEmail };
    }

    db.prepare(`
      INSERT INTO company_members (id, company_id, user_id, is_owner, invited_by, status)
      VALUES (?, ?, ?, 0, ?, 'ATIVO')
      ON CONFLICT (company_id, user_id) DO UPDATE SET status = 'ATIVO', deleted_at = NULL, updated_at = datetime('now')
    `).run(crypto.randomUUID(), companyId, targetUser.user_id, actorId);

    // RN-05: Ao ser adicionado, membro recebe TODAS as UFs da empresa ativas em member_preferences
    const compUfs = db.prepare(`SELECT uf_sigla FROM company_ufs WHERE company_id = ?`).all(companyId) as Array<{
      uf_sigla: string;
    }>;
    const insPref = db.prepare(`
      INSERT OR IGNORE INTO member_preferences (id, company_id, user_id, uf_sigla, ativo) VALUES (?, ?, ?, ?, 1)
    `);
    for (const u of compUfs) {
      insPref.run(crypto.randomUUID(), companyId, targetUser.user_id, u.uf_sigla);
    }

    writeAuditLog(db, {
      actorUserId: actorId,
      acao: 'CONVIDAR_MEMBRO',
      entidade: 'company_members',
      entidadeId: companyId,
      depois: { invited_user_id: targetUser.user_id, email: cleanEmail },
      ip: req.ip,
    });

    await emailProvider.send({
      to: cleanEmail,
      subject: `SINARC | Convite para acompanhar ${company.razao_social}`,
      html: `<p>Você foi adicionado como membro da empresa <strong>${company.razao_social}</strong> no SINARC.</p>`,
    });

    res.status(201).json({ ok: true, userId: targetUser.user_id, tempPassword });
  });

  app.delete('/api/companies/:companyId/members/:memberUserId', requireAuth, (req: AuthedRequest, res) => {
    const actorId = req.session!.userId;
    const companyId = String(req.params.companyId);
    const memberUserId = String(req.params.memberUserId);

    const company = db
      .prepare(
        `SELECT mp.owner_user_id FROM companies c JOIN monitoring_profiles mp ON mp.id = c.profile_id WHERE c.id = ?`
      )
      .get(companyId) as { owner_user_id: string } | undefined;

    if (!company || (company.owner_user_id !== actorId && req.session!.role !== 'ADMIN')) {
      res.status(403).json({ error: 'Apenas o dono da conta pode remover membros.' });
      return;
    }
    if (memberUserId === company.owner_user_id) {
      res.status(400).json({ error: 'O dono da conta não pode ser removido.' });
      return;
    }

    db.prepare(`
      UPDATE company_members
      SET status = 'REMOVIDO', deleted_at = ?, updated_at = datetime('now')
      WHERE company_id = ? AND user_id = ?
    `).run(new Date().toISOString(), companyId, memberUserId);

    writeAuditLog(db, {
      actorUserId: actorId,
      acao: 'REMOVER_MEMBRO',
      entidade: 'company_members',
      entidadeId: companyId,
      depois: { removed_user_id: memberUserId },
      ip: req.ip,
    });
    res.json({ ok: true });
  });

  // Preferências do próprio usuário (UFs por empresa, canais, ritmo, WhatsApp opt-in) — RN-05, RN-14, RN-30
  app.put('/api/preferences', requireAuth, async (req: AuthedRequest, res) => {
    const userId = req.session!.userId;
    const {
      ritmo,
      channels,
      whatsappOptIn,
      companyUfPrefs,
    } = req.body as {
      ritmo?: UserRitmo;
      channels?: Partial<Record<ChannelType, boolean>>;
      whatsappOptIn?: boolean;
      companyUfPrefs?: Array<{ company_id: string; prefs: Array<{ uf_sigla: string; ativo: boolean }> }>;
    };

    if (companyUfPrefs) {
      for (const item of companyUfPrefs) {
        const companyUfs = db
          .prepare(`SELECT company_id, uf_sigla, kind FROM company_ufs WHERE company_id = ?`)
          .all(item.company_id) as Array<{ company_id: string; uf_sigla: string; kind: CompanyUfKind }>;
        const check = filterValidMemberPreferences(companyUfs, item.prefs);
        if (!check.ok) {
          res.status(400).json({ error: check.error });
          return;
        }
        const upsert = db.prepare(`
          INSERT INTO member_preferences (id, company_id, user_id, uf_sigla, ativo)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (company_id, user_id, uf_sigla) DO UPDATE SET ativo = excluded.ativo, updated_at = datetime('now')
        `);
        for (const p of check.valid) {
          upsert.run(crypto.randomUUID(), item.company_id, userId, p.uf_sigla, p.ativo ? 1 : 0);
        }
      }
    }

    if (ritmo === 'IMEDIATO' || ritmo === 'RESUMO_DIARIO') {
      db.prepare(`UPDATE users_profile SET ritmo = ?, updated_at = datetime('now') WHERE user_id = ?`).run(ritmo, userId);
    }

    if (channels) {
      const upsertChan = db.prepare(`
        INSERT INTO member_channels (id, user_id, channel, ativo)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (user_id, channel) DO UPDATE SET ativo = excluded.ativo, updated_at = datetime('now')
      `);
      for (const ch of ['APP', 'PUSH', 'EMAIL', 'WHATSAPP'] as ChannelType[]) {
        if (typeof channels[ch] === 'boolean') {
          const val = ch === 'APP' ? true : channels[ch]!;
          upsertChan.run(crypto.randomUUID(), userId, ch, val ? 1 : 0);
        }
      }
      if (typeof channels.EMAIL === 'boolean') {
        db.prepare(`UPDATE users_profile SET email_opt_in = ? WHERE user_id = ?`).run(channels.EMAIL ? 1 : 0, userId);
      }
    }

    if (typeof whatsappOptIn === 'boolean') {
      const nowIso = new Date().toISOString();
      const user = db.prepare(`SELECT nome, celular_e164 FROM users_profile WHERE user_id = ?`).get(userId) as {
        nome: string;
        celular_e164: string;
      };
      db.prepare(`
        UPDATE users_profile
        SET whatsapp_opt_in = ?, whatsapp_opt_in_at = ?, whatsapp_opt_in_text = ?, updated_at = datetime('now')
        WHERE user_id = ?
      `).run(whatsappOptIn ? 1 : 0, nowIso, whatsappOptIn ? WHATSAPP_OPT_IN_TEXT : null, userId);

      db.prepare(`
        INSERT INTO consents (id, user_id, tipo, versao, texto, aceito, em, ip, origem)
        VALUES (?, ?, 'WHATSAPP', ?, ?, ?, ?, ?, 'PREFERENCIAS')
      `).run(crypto.randomUUID(), userId, TERMS_VERSION, WHATSAPP_OPT_IN_TEXT, whatsappOptIn ? 1 : 0, nowIso, req.ip || '0.0.0.0');

      if (whatsappOptIn) {
        await whatsappProvider.sendTemplate({
          toE164: user.celular_e164,
          templateName: process.env.WHATSAPP_TPL_OPTIN || 'sinarc_confirmacao_optin',
          bodyText: `Olá, ${user.nome}! Você ativou os alertas do SINARC no WhatsApp. Para parar de receber, responda SAIR.`,
        });
      }
    }

    res.json({ ok: true });
  });

  // ==========================================
  // FEED, DETALHE DO ATO, HISTÓRICO E STATUS (RN-11, RN-12, RN-19, RN-20)
  // ==========================================
  function getUserAlertsFormatted(userId: string, scope: 'feed' | 'history') {
    const statusFilter =
      scope === 'history' ? `act.status IN ('ENCERRADO', 'REVOGADO')` : `act.status = 'PUBLICADO'`;

    const rows = db
      .prepare(
        `SELECT
          al.*,
          act.id as a_id, act.uf_sigla as a_uf, act.orgao as a_orgao, act.tipo as a_tipo,
          act.numero as a_numero, act.data_publicacao as a_data_pub, act.assunto as a_assunto,
          act.urgencia as a_urgencia, act.titulo as a_titulo, act.status as a_status,
          act.current_version as a_version, act.prazo as a_prazo, act.sem_prazo as a_sem_prazo,
          act.resumo as a_resumo, act.pdf_path as a_pdf_path, act.fonte_url as a_fonte_url
         FROM alerts al
         JOIN acts act ON act.id = al.act_id
         WHERE al.user_id = ? AND ${statusFilter} AND act.deleted_at IS NULL
         ORDER BY
           CASE act.urgencia WHEN 'URGENTE' THEN 1 WHEN 'IMPORTANTE' THEN 2 ELSE 3 END,
           al.created_at DESC`
      )
      .all(userId) as Array<Record<string, unknown>>;

    return rows.map((r) => {
      const companyIds = JSON.parse(String(r.company_ids || '[]')) as string[];
      const companies = companyIds.length
        ? (db
            .prepare(
              `SELECT id, nome_fantasia, razao_social, plan, plan_status
               FROM companies WHERE id IN (${companyIds.map(() => '?').join(',')})`
            )
            .all(...companyIds) as Array<{
            id: string;
            nome_fantasia: string;
            razao_social: string;
            plan: PlanType;
            plan_status: string;
          }>)
        : [];

      const paidCompanyIds = companies
        .filter((c) => (c.plan === 'PRO' || c.plan === 'NACIONAL') && c.plan_status === 'ATIVO')
        .map((c) => c.id);
      const freeCompanyIds = companies.filter((c) => !paidCompanyIds.includes(c.id)).map((c) => c.id);
      const lockedForFree = paidCompanyIds.length === 0;

      const checklistRaw = lockedForFree
        ? []
        : (db
            .prepare(`SELECT id, catalog_id, titulo, descricao, obrigatorio, ordem FROM act_checklist_items WHERE act_id = ? AND deleted_at IS NULL ORDER BY ordem`)
            .all(String(r.act_id)) as ActChecklistItem[]);

      const versions = db
        .prepare(`SELECT id, act_id, version, change_type, change_note, published_by, published_at FROM act_versions WHERE act_id = ? ORDER BY version DESC`)
        .all(String(r.act_id)) as Array<{
        id: string;
        act_id: string;
        version: number;
        change_type: ActChangeType;
        change_note: string;
        published_by: string;
        published_at: string;
      }>;

      const segments = (
        db.prepare(`SELECT segment_code FROM act_segments WHERE act_id = ?`).all(String(r.act_id)) as Array<{
          segment_code: string;
        }>
      ).map((s) => s.segment_code);

      let pdfSignedUrl: string | null = null;
      if (!lockedForFree && r.a_pdf_path) {
        const sig = signPdfAccessToken(String(r.act_id), userId, 600);
        pdfSignedUrl = `/api/acts/${r.act_id}/pdf?uid=${encodeURIComponent(userId)}&exp=${sig.exp}&sig=${encodeURIComponent(sig.sig)}`;
      }

      // RN-12: Redação rigorosa no servidor para FREE
      const redactedAct = redactActForFree(
        {
          id: String(r.a_id),
          uf_sigla: String(r.a_uf),
          orgao: String(r.a_orgao),
          tipo: r.a_tipo as ActTipo,
          numero: String(r.a_numero),
          data_publicacao: String(r.a_data_pub),
          assunto: r.a_assunto as ActAssunto,
          urgencia: r.a_urgencia as ActUrgencia,
          titulo: String(r.a_titulo),
          status: r.a_status as 'PUBLICADO' | 'ENCERRADO' | 'REVOGADO',
          current_version: Number(r.a_version),
          prazo: r.a_prazo ? String(r.a_prazo) : null,
          sem_prazo: Number(r.a_sem_prazo) === 1,
          resumo: r.a_resumo ? String(r.a_resumo) : null,
          pdf_path: r.a_pdf_path ? String(r.a_pdf_path) : null,
          fonte_url: r.a_fonte_url ? String(r.a_fonte_url) : null,
          checklist: checklistRaw,
        },
        lockedForFree
      );

      const latestVersion = versions[0];
      return {
        id: String(r.id),
        act_id: String(r.act_id),
        act_version: Number(r.act_version),
        user_id: String(r.user_id),
        profile_id: String(r.profile_id),
        natureza: r.natureza,
        urgencia: r.urgencia,
        company_ids: companyIds,
        paid_company_ids: paidCompanyIds,
        free_company_ids: freeCompanyIds,
        company_names: companies.map((c) => c.nome_fantasia || c.razao_social),
        status: r.status,
        status_changed_at: String(r.status_changed_at),
        is_correction: Number(r.is_correction) === 1,
        locked_for_free: lockedForFree,
        created_at: String(r.created_at),
        act: {
          ...redactedAct,
          pdf_signed_url: pdfSignedUrl,
          segments,
          versions,
          latest_change_type: latestVersion?.change_type ?? null,
          latest_change_note: latestVersion?.change_note ?? null,
        },
      };
    });
  }

  app.get('/api/alerts', requireAuth, (req: AuthedRequest, res) => {
    const scope = req.query.scope === 'history' ? 'history' : 'feed';
    const items = getUserAlertsFormatted(req.session!.userId, scope);
    res.json({ alerts: items });
  });

  // Deep link /a/:actId — resolve alerta do usuário ou resumo público controlado
  app.get('/api/acts/:actId/detail', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.session!.userId;
    const actId = String(req.params.actId);
    const items = [...getUserAlertsFormatted(userId, 'feed'), ...getUserAlertsFormatted(userId, 'history')];
    const matched = items.find((i) => i.act_id === actId);
    if (!matched) {
      res.status(404).json({ error: 'Ato não encontrado para as empresas do seu perfil.' });
      return;
    }
    res.json({ alert: matched });
  });

  // RN-20 & RN-16: Mudança de status do alerta (cancelando lembretes ao marcar RESOLVIDO)
  app.patch('/api/alerts/:alertId/status', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.session!.userId;
    const alertId = String(req.params.alertId);
    const { status } = req.body as { status: AlertStatus };
    const allowed: AlertStatus[] = ['NOVO', 'VISTO', 'EM_ANDAMENTO', 'RESOLVIDO'];
    if (!allowed.includes(status)) {
      res.status(400).json({ error: 'Status de alerta inválido.' });
      return;
    }

    const alert = db.prepare(`SELECT id FROM alerts WHERE id = ? AND user_id = ?`).get(alertId, userId);
    if (!alert) {
      res.status(404).json({ error: 'Alerta não encontrado.' });
      return;
    }

    db.prepare(`
      UPDATE alerts SET status = ?, status_changed_at = ?, updated_at = datetime('now') WHERE id = ?
    `).run(status, new Date().toISOString(), alertId);

    if (status === 'RESOLVIDO') {
      cancelPendingRemindersForAlert(db, alertId);
    }

    res.json({ ok: true, status });
  });

  // Download seguro de PDF via URL assinada (Seção 12 — só para plano pago ou Curador/Admin)
  app.get('/api/acts/:actId/pdf', (req, res) => {
    const actId = String(req.params.actId);
    const uid = String(req.query.uid || '');
    const exp = Number(req.query.exp || 0);
    const sig = String(req.query.sig || '');

    if (!uid || !exp || !sig || !verifyPdfAccessToken(actId, uid, exp, sig)) {
      res.status(403).json({ error: 'Link assinado inválido ou expirado.' });
      return;
    }

    const user = db.prepare(`SELECT role FROM users_profile WHERE user_id = ?`).get(uid) as
      | { role: UserRole }
      | undefined;
    if (!user) {
      res.status(403).json({ error: 'Usuário não autorizado.' });
      return;
    }

    if (user.role === 'CLIENTE') {
      const alert = db
        .prepare(`SELECT locked_for_free FROM alerts WHERE act_id = ? AND user_id = ? AND locked_for_free = 0 LIMIT 1`)
        .get(actId, uid);
      if (!alert) {
        res.status(403).json({ error: 'Acesso ao PDF oficial exclusivo para planos pagos.' });
        return;
      }
    }

    const act = db.prepare(`SELECT pdf_path, numero FROM acts WHERE id = ?`).get(actId) as
      | { pdf_path: string | null; numero: string }
      | undefined;
    if (!act?.pdf_path) {
      res.status(404).json({ error: 'PDF não anexado a este ato.' });
      return;
    }

    const safePath = resolveConfinedPath(PDF_STORAGE_DIR, act.pdf_path);
    if (!safePath || !fs.existsSync(safePath)) {
      res.status(404).json({ error: 'Arquivo PDF não encontrado no armazenamento.' });
      return;
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="sinarc-${act.numero.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf"`);
    fs.createReadStream(safePath).pipe(res);
  });

  // ==========================================
  // PLANOS E COBRANÇA (STRIPE + COTAÇÃO)
  // ==========================================
  app.post('/api/billing/quote', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.session!.userId;
    const { items, cycle } = req.body as {
      items: Array<{ companyId: string; plan: 'PRO' | 'NACIONAL' }>;
      cycle: BillingCycle;
    };

    const profile = db
      .prepare(`SELECT founder_price_locked FROM monitoring_profiles WHERE owner_user_id = ? AND deleted_at IS NULL LIMIT 1`)
      .get(userId) as { founder_price_locked: number } | undefined;

    const settings = getBillingSettings();
    const quote = calculateSubscriptionPricing({
      items: items || [],
      cycle: cycle || 'MENSAL',
      settings,
      founderPriceLocked: profile?.founder_price_locked === 1,
    });
    res.json({ quote, settings });
  });

  app.post('/api/billing/checkout', requireAuth, async (req: AuthedRequest, res) => {
    const userId = req.session!.userId;
    const { companyIds, plan, cycle } = req.body as {
      companyIds: string[];
      plan: 'PRO' | 'NACIONAL';
      cycle: BillingCycle;
    };

    if (!companyIds?.length || (plan !== 'PRO' && plan !== 'NACIONAL')) {
      res.status(400).json({ error: 'Selecione pelo menos uma empresa e um plano pago válido.' });
      return;
    }

    const profile = db
      .prepare(`SELECT * FROM monitoring_profiles WHERE owner_user_id = ? AND deleted_at IS NULL LIMIT 1`)
      .get(userId) as
      | { id: string; stripe_customer_id: string | null; founder_price_locked: number }
      | undefined;
    if (!profile) {
      res.status(403).json({ error: 'Apenas o dono da conta pode assinar planos.' });
      return;
    }

    // Valida limite RN-04 caso escolha plano PRO
    if (plan === 'PRO') {
      for (const cid of companyIds) {
        const ufs = db.prepare(`SELECT uf_sigla, kind FROM company_ufs WHERE company_id = ?`).all(cid) as Array<{
          uf_sigla: string;
          kind: CompanyUfKind;
        }>;
        const check = validateCompanyUfsUpdate('PRO', ufs);
        if (!check.ok) {
          res.status(400).json({ error: `${check.error} Ajuste as UFs da empresa antes de assinar o PRO.` });
          return;
        }
      }
    }

    const stripe = getStripeClient();
    const priceId =
      plan === 'PRO'
        ? cycle === 'ANUAL'
          ? process.env.STRIPE_PRICE_PRO_ANNUAL
          : process.env.STRIPE_PRICE_PRO_MONTHLY
        : cycle === 'ANUAL'
          ? process.env.STRIPE_PRICE_NACIONAL_ANNUAL
          : process.env.STRIPE_PRICE_NACIONAL_MONTHLY;

    const settings = getBillingSettings();
    const quote = calculateSubscriptionPricing({
      items: companyIds.map((companyId) => ({ companyId, plan })),
      cycle,
      settings,
      founderPriceLocked: profile.founder_price_locked === 1,
    });

    if (stripe && priceId) {
      const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: companyIds.length }],
        success_url: `${appUrl}/?checkout=sucesso`,
        cancel_url: `${appUrl}/?checkout=cancelado`,
        customer: profile.stripe_customer_id || undefined,
        metadata: {
          profile_id: profile.id,
          plan,
          cycle,
          company_ids: JSON.stringify(companyIds),
        },
      });
      res.json({ checkoutUrl: session.url, quote, mode: 'stripe' });
      return;
    }

    // Sem chaves Stripe configuradas no ambiente: orienta o administrador sem burlar webhook
    res.status(503).json({
      error: 'Stripe não configurada neste ambiente (defina STRIPE_SECRET_KEY e os IDs de preço para abrir o Checkout oficial).',
      quote,
    });
  });

  app.post('/api/billing/portal', requireAuth, async (req: AuthedRequest, res) => {
    const userId = req.session!.userId;
    const profile = db
      .prepare(`SELECT stripe_customer_id FROM monitoring_profiles WHERE owner_user_id = ? AND deleted_at IS NULL`)
      .get(userId) as { stripe_customer_id: string | null } | undefined;

    const stripe = getStripeClient();
    if (!stripe || !profile?.stripe_customer_id) {
      res.status(400).json({ error: 'Portal da Stripe disponível após assinatura ativa via Stripe Checkout.' });
      return;
    }
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    const portal = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: appUrl,
    });
    res.json({ url: portal.url });
  });

  // ==========================================
  // WHATSAPP CLOUD API WEBHOOK (RN-31)
  // ==========================================
  app.get('/api/webhooks/whatsapp', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      res.status(200).send(challenge);
      return;
    }
    res.sendStatus(403);
  });

  app.post('/api/webhooks/whatsapp', async (req, res) => {
    try {
      const payload = req.body as {
        fromE164?: string;
        messageId?: string;
        text?: string;
        entry?: Array<{
          changes?: Array<{
            value?: {
              messages?: Array<{ id: string; from: string; text?: { body: string } }>;
            };
          }>;
        }>;
      };

      const messages: Array<{ id: string; from: string; body: string }> = [];
      if (payload.fromE164 && payload.text) {
        messages.push({
          id: payload.messageId || crypto.randomUUID(),
          from: payload.fromE164.startsWith('+') ? payload.fromE164 : `+${payload.fromE164}`,
          body: payload.text,
        });
      }
      for (const entry of payload.entry || []) {
        for (const ch of entry.changes || []) {
          for (const msg of ch.value?.messages || []) {
            messages.push({
              id: msg.id,
              from: msg.from.startsWith('+') ? msg.from : `+${msg.from}`,
              body: msg.text?.body || '',
            });
          }
        }
      }

      for (const m of messages) {
        const exists = db
          .prepare(`SELECT id FROM whatsapp_inbound WHERE provider_message_id = ?`)
          .get(m.id);
        if (exists) continue;

        const user = db
          .prepare(`SELECT user_id, nome FROM users_profile WHERE celular_e164 = ? AND deleted_at IS NULL`)
          .get(m.from) as { user_id: string; nome: string } | undefined;

        const command = classifyWhatsAppInbound(m.body);
        let actionTaken = 'AUTO_REPLY';

        if (user && command === 'SAIR') {
          actionTaken = 'OPT_OUT_SAIR';
          const nowIso = new Date().toISOString();
          db.prepare(`UPDATE users_profile SET whatsapp_opt_in = 0, updated_at = datetime('now') WHERE user_id = ?`).run(
            user.user_id
          );
          db.prepare(`
            INSERT INTO member_channels (id, user_id, channel, ativo) VALUES (?, ?, 'WHATSAPP', 0)
            ON CONFLICT (user_id, channel) DO UPDATE SET ativo = 0, updated_at = datetime('now')
          `).run(crypto.randomUUID(), user.user_id);
          db.prepare(`
            INSERT INTO consents (id, user_id, tipo, versao, texto, aceito, em, ip, origem)
            VALUES (?, ?, 'WHATSAPP', ?, 'Descadastro via resposta SAIR no WhatsApp', 0, ?, 'whatsapp-webhook', 'WHATSAPP_INBOUND')
          `).run(crypto.randomUUID(), user.user_id, TERMS_VERSION, nowIso);
          db.prepare(`
            UPDATE deliveries SET status = 'CANCELADO', updated_at = datetime('now')
            WHERE channel = 'WHATSAPP' AND status = 'AGENDADO'
              AND alert_id IN (SELECT id FROM alerts WHERE user_id = ?)
          `).run(user.user_id);
        } else if (user && command === 'VISTO_1') {
          actionTaken = 'VISTO_1';
          const lastAlert = db
            .prepare(
              `SELECT a.id FROM alerts a
               JOIN deliveries d ON d.alert_id = a.id
               WHERE a.user_id = ? AND d.channel = 'WHATSAPP'
               ORDER BY COALESCE(d.sent_at, a.created_at) DESC LIMIT 1`
            )
            .get(user.user_id) as { id: string } | undefined;
          if (lastAlert) {
            db.prepare(`
              UPDATE alerts SET status = 'VISTO', status_changed_at = ?, updated_at = datetime('now')
              WHERE id = ? AND status = 'NOVO'
            `).run(new Date().toISOString(), lastAlert.id);
          }
        } else {
          await whatsappProvider.sendText(
            m.from,
            'Este canal é só para alertas. Acesse sinarc.com.br para mais detalhes.'
          );
        }

        db.prepare(`
          INSERT INTO whatsapp_inbound (id, user_id, from_e164, provider_message_id, message_text, action_taken, received_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), user?.user_id ?? null, m.from, m.id, m.body, actionTaken, new Date().toISOString());
      }

      res.json({ ok: true, processed: messages.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Erro WhatsApp inbound' });
    }
  });

  // ==========================================
  // LGPD — EXPORTAÇÃO E EXCLUSÃO (RN-32)
  // ==========================================
  app.post('/api/lgpd/export', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.session!.userId;
    const profile = db.prepare(`SELECT * FROM users_profile WHERE user_id = ?`).get(userId) as Record<string, unknown>;
    const monitoringProfiles = db
      .prepare(`SELECT * FROM monitoring_profiles WHERE owner_user_id = ?`)
      .all(userId);
    const companies = db
      .prepare(
        `SELECT c.* FROM companies c JOIN monitoring_profiles mp ON mp.id = c.profile_id WHERE mp.owner_user_id = ?`
      )
      .all(userId);
    const consents = db.prepare(`SELECT * FROM consents WHERE user_id = ?`).all(userId);
    const alerts = db.prepare(`SELECT id, act_id, natureza, status, created_at FROM alerts WHERE user_id = ?`).all(userId);

    const safeProfile = { ...profile };
    delete safeProfile.password_hash;
    delete safeProfile.mfa_secret;

    const exportJson = {
      exported_at: new Date().toISOString(),
      controller: 'Bio Síntese Soluções em Ciência e Tecnologia Ltda',
      user: safeProfile,
      monitoring_profiles: monitoringProfiles,
      companies,
      consents,
      alerts,
    };

    const csvRows = [
      'campo,valor',
      `nome,"${String(safeProfile.nome || '').replace(/"/g, '""')}"`,
      `email,"${String(safeProfile.email || '').replace(/"/g, '""')}"`,
      `celular_e164,"${String(safeProfile.celular_e164 || '').replace(/"/g, '""')}"`,
      `whatsapp_opt_in,"${safeProfile.whatsapp_opt_in}"`,
      `terms_version_accepted,"${safeProfile.terms_version_accepted || ''}"`,
    ].join('\n');

    const fileName = `export-${userId.slice(0, 8)}-${Date.now()}.json`;
    ensureStorageDirs();
    const filePath = resolveConfinedPath(EXPORT_STORAGE_DIR, fileName);
    if (filePath) {
      fs.writeFileSync(filePath, JSON.stringify(exportJson, null, 2), 'utf8');
    }

    db.prepare(`
      INSERT INTO data_requests (id, user_id, tipo, status, solicitado_em, concluido_em, arquivo_path)
      VALUES (?, ?, 'EXPORTACAO', 'CONCLUIDO', ?, ?, ?)
    `).run(crypto.randomUUID(), userId, new Date().toISOString(), new Date().toISOString(), fileName);

    writeAuditLog(db, {
      actorUserId: userId,
      acao: 'LGPD_EXPORTACAO',
      entidade: 'users_profile',
      entidadeId: userId,
      ip: req.ip,
    });

    res.json({ json: exportJson, csv: csvRows });
  });

  // RN-32: Exclusão anonimiza dados pessoais preservando atos públicos e registros fiscais
  app.post('/api/lgpd/delete-account', requireAuth, (req: AuthedRequest, res) => {
    const userId = req.session!.userId;
    const nowIso = new Date().toISOString();
    const anonSuffix = crypto.randomUUID().slice(0, 8);

    db.transaction(() => {
      db.prepare(`
        UPDATE users_profile
        SET nome = 'Titular Anonimizado',
            email = ?,
            celular_e164 = '+5500000000000',
            password_hash = 'ANONYMIZED',
            whatsapp_opt_in = 0,
            email_opt_in = 0,
            mfa_secret = NULL,
            deleted_at = ?,
            updated_at = datetime('now')
        WHERE user_id = ?
      `).run(`anon-${anonSuffix}@anonimizado.sinarc.local`, nowIso, userId);

      db.prepare(`UPDATE push_tokens SET ativo = 0, deleted_at = ? WHERE user_id = ?`).run(nowIso, userId);
      db.prepare(`UPDATE member_channels SET ativo = 0 WHERE user_id = ?`).run(userId);
      db.prepare(`
        UPDATE company_members SET status = 'REMOVIDO', deleted_at = ? WHERE user_id = ?
      `).run(nowIso, userId);

      db.prepare(`
        INSERT INTO data_requests (id, user_id, tipo, status, solicitado_em, concluido_em)
        VALUES (?, ?, 'EXCLUSAO', 'CONCLUIDO', ?, ?)
      `).run(crypto.randomUUID(), userId, nowIso, nowIso);
    })();

    writeAuditLog(db, {
      actorUserId: userId,
      acao: 'LGPD_EXCLUSAO_ANONIMIZACAO',
      entidade: 'users_profile',
      entidadeId: userId,
      ip: req.ip,
    });

    res.json({ ok: true, message: 'Dados pessoais anonimizados conforme LGPD. Registros fiscais obrigatórios preservados.' });
  });

  // ==========================================
  // PAINEL DO CURADOR (Seção 7.2 — RBAC + 2FA)
  // ==========================================
  app.get('/api/curator/workspace', requireAuth, requireCuratorOrAdmin, (_req, res) => {
    const acts = db
      .prepare(`SELECT * FROM acts WHERE deleted_at IS NULL ORDER BY updated_at DESC`)
      .all() as Array<Record<string, unknown>>;

    const enrichedActs = acts.map((a) => {
      const segments = (
        db.prepare(`SELECT segment_code FROM act_segments WHERE act_id = ?`).all(String(a.id)) as Array<{
          segment_code: string;
        }>
      ).map((s) => s.segment_code);
      const checklist = db
        .prepare(`SELECT * FROM act_checklist_items WHERE act_id = ? AND deleted_at IS NULL ORDER BY ordem`)
        .all(String(a.id));
      const versions = db
        .prepare(`SELECT * FROM act_versions WHERE act_id = ? ORDER BY version DESC`)
        .all(String(a.id));
      return {
        ...a,
        sem_prazo: Number(a.sem_prazo) === 1,
        segments,
        checklist,
        versions,
      };
    });

    const suggestions = db
      .prepare(
        `SELECT ws.*, wt.uf_sigla, wt.url, wt.descricao as target_descricao
         FROM watch_suggestions ws
         JOIN watch_targets wt ON wt.id = ws.target_id
         ORDER BY ws.detectado_em DESC`
      )
      .all();

    const catalog = db
      .prepare(`SELECT * FROM checklist_catalog WHERE ativo = 1 AND deleted_at IS NULL ORDER BY bloco, codigo`)
      .all();

    res.json({ acts: enrichedActs, suggestions, catalog });
  });

  // Seção 11: IA extrai e pré-preenche campos do ato (sempre RASCUNHO)
  app.post('/api/curator/extract-ai', requireAuth, requireCuratorOrAdmin, async (req: AuthedRequest, res) => {
    try {
      const { rawText, pdfBase64, sourceUrl } = req.body as {
        rawText?: string;
        pdfBase64?: string;
        sourceUrl?: string;
      };
      if (!rawText && !pdfBase64 && !sourceUrl) {
        res.status(400).json({ error: 'Envie um PDF, cole o texto do ato ou informe a URL oficial.' });
        return;
      }

      const catalogItems = db
        .prepare(`SELECT * FROM checklist_catalog WHERE ativo = 1 AND deleted_at IS NULL`)
        .all() as ChecklistCatalogItem[];

      const extracted = await actExtractor.extract({
        rawText,
        pdfBase64,
        sourceUrl,
        catalogItems,
      });

      writeAuditLog(db, {
        actorUserId: req.session!.userId,
        acao: 'IA_EXTRACAO_ATO',
        entidade: 'acts',
        entidadeId: 'draft',
        depois: { model_used: extracted.model_used, extracted_at: extracted.extracted_at },
        ip: req.ip,
      });

      res.json({ draft: extracted });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Erro na extração por IA.' });
    }
  });

  // Criar ou salvar rascunho de ato
  app.post('/api/curator/acts', requireAuth, requireCuratorOrAdmin, (req: AuthedRequest, res) => {
    const actorId = req.session!.userId;
    const body = req.body as {
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
      fonte_url?: string | null;
      publicacao_oficial_em?: string | null;
      pdfBase64?: string | null;
      segments: string[];
      checklist: ActChecklistItem[];
      ai_metadata?: unknown;
      from_suggestion_id?: string;
    };

    if (!body.uf_sigla || !body.titulo || !body.segments?.length) {
      res.status(400).json({ error: 'UF, título e pelo menos um segmento são obrigatórios.' });
      return;
    }

    const actId = crypto.randomUUID();
    let pdfFileName: string | null = null;
    if (body.pdfBase64) {
      ensureStorageDirs();
      const candidateName = `${actId}.pdf`;
      const confined = resolveConfinedPath(PDF_STORAGE_DIR, candidateName);
      if (confined) {
        const cleanB64 = body.pdfBase64.replace(/^data:application\/pdf;base64,/, '');
        fs.writeFileSync(confined, Buffer.from(cleanB64, 'base64'));
        pdfFileName = candidateName;
      }
    }

    db.transaction(() => {
      db.prepare(`
        INSERT INTO acts (
          id, uf_sigla, orgao, tipo, numero, data_publicacao, assunto, natureza_base,
          urgencia, prazo, sem_prazo, titulo, resumo, pdf_path, fonte_url, status,
          current_version, publicacao_oficial_em, created_by, ai_metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RASCUNHO', 1, ?, ?, ?)
      `).run(
        actId,
        body.uf_sigla.toUpperCase(),
        body.orgao || `DETRAN-${body.uf_sigla.toUpperCase()}`,
        body.tipo,
        body.numero,
        body.data_publicacao,
        body.assunto,
        body.natureza_base,
        body.urgencia,
        body.sem_prazo ? null : body.prazo || null,
        body.sem_prazo ? 1 : 0,
        body.titulo,
        body.resumo || '',
        pdfFileName,
        body.fonte_url || null,
        body.publicacao_oficial_em || new Date().toISOString(),
        actorId,
        body.ai_metadata ? JSON.stringify(body.ai_metadata) : null
      );

      const insSeg = db.prepare(`INSERT INTO act_segments (id, act_id, segment_code) VALUES (?, ?, ?)`);
      for (const s of body.segments) {
        insSeg.run(crypto.randomUUID(), actId, s);
      }

      const insItem = db.prepare(`
        INSERT INTO act_checklist_items (id, act_id, catalog_id, titulo, descricao, obrigatorio, ordem)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      (body.checklist || []).forEach((item, idx) => {
        insItem.run(
          crypto.randomUUID(),
          actId,
          item.catalog_id || null,
          item.titulo,
          item.descricao || '',
          item.obrigatorio ? 1 : 0,
          item.ordem || idx + 1
        );
      });

      if (body.from_suggestion_id) {
        db.prepare(`
          UPDATE watch_suggestions SET status = 'VIROU_ATO', act_id = ?, tratado_por = ?, updated_at = datetime('now') WHERE id = ?
        `).run(actId, actorId, body.from_suggestion_id);
      }
    })();

    writeAuditLog(db, {
      actorUserId: actorId,
      acao: 'CRIAR_RASCUNHO_ATO',
      entidade: 'acts',
      entidadeId: actId,
      depois: { titulo: body.titulo, uf: body.uf_sigla },
      ip: req.ip,
    });

    res.status(201).json({ id: actId });
  });

  // Enviar rascunho para revisão (RN-21)
  app.post('/api/curator/acts/:actId/submit', requireAuth, requireCuratorOrAdmin, (req: AuthedRequest, res) => {
    const actorId = req.session!.userId;
    const actId = String(req.params.actId);
    const act = db.prepare(`SELECT status FROM acts WHERE id = ? AND deleted_at IS NULL`).get(actId) as
      | { status: string }
      | undefined;
    if (!act) {
      res.status(404).json({ error: 'Ato não encontrado.' });
      return;
    }
    if (act.status !== 'RASCUNHO') {
      res.status(400).json({ error: 'Apenas atos em RASCUNHO podem ser enviados para revisão.' });
      return;
    }

    db.prepare(`
      UPDATE acts
      SET status = 'EM_REVISAO', submitted_by = ?, return_comment = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(actorId, actId);

    writeAuditLog(db, {
      actorUserId: actorId,
      acao: 'ENVIAR_ATO_REVISAO',
      entidade: 'acts',
      entidadeId: actId,
      ip: req.ip,
    });

    res.json({ ok: true });
  });

  // Devolver para rascunho com comentário obrigatório (RN-21)
  app.post('/api/curator/acts/:actId/return', requireAuth, requireCuratorOrAdmin, (req: AuthedRequest, res) => {
    const actorId = req.session!.userId;
    const actId = String(req.params.actId);
    const { comment } = req.body as { comment: string };
    if (!comment?.trim()) {
      res.status(400).json({ error: 'Comentário obrigatório ao devolver ato para rascunho (RN-21).' });
      return;
    }

    db.prepare(`
      UPDATE acts SET status = 'RASCUNHO', return_comment = ?, updated_at = datetime('now') WHERE id = ?
    `).run(comment.trim(), actId);

    writeAuditLog(db, {
      actorUserId: actorId,
      acao: 'DEVOLVER_ATO_RASCUNHO',
      entidade: 'acts',
      entidadeId: actId,
      depois: { comment: comment.trim() },
      ip: req.ip,
    });

    res.json({ ok: true });
  });

  // Aprovar e publicar ato (RN-21 bloqueia autoaprovação no servidor + RN-22 dispara fanout)
  app.post('/api/curator/acts/:actId/approve', requireAuth, requireCuratorOrAdmin, (req: AuthedRequest, res) => {
    const actorId = req.session!.userId;
    const actId = String(req.params.actId);
    const { change_note } = req.body as { change_note?: string };

    const act = db.prepare(`SELECT * FROM acts WHERE id = ? AND deleted_at IS NULL`).get(actId) as
      | { status: string; submitted_by: string | null; current_version: number }
      | undefined;

    if (!act) {
      res.status(404).json({ error: 'Ato não encontrado.' });
      return;
    }
    if (act.status !== 'EM_REVISAO') {
      res.status(400).json({ error: 'Apenas atos EM_REVISAO podem ser aprovados.' });
      return;
    }
    if (!canApproveAct(act.submitted_by, actorId)) {
      res.status(403).json({
        error: 'Quem enviou o ato para revisão não pode aprová-lo (dupla checagem RN-21).',
      });
      return;
    }

    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE acts
      SET status = 'PUBLICADO', approved_by = ?, publicado_em = COALESCE(publicado_em, ?), updated_at = datetime('now')
      WHERE id = ?
    `).run(actorId, nowIso, actId);

    createActVersionSnapshot(
      db,
      actId,
      act.current_version,
      'PUBLICACAO',
      change_note || 'Publicação inicial aprovada em dupla checagem.',
      actorId
    );

    const fanoutResult = fanoutAct(db, actId, act.current_version);
    writeAuditLog(db, {
      actorUserId: actorId,
      acao: 'APROVAR_PUBLICAR_ATO',
      entidade: 'acts',
      entidadeId: actId,
      depois: { version: act.current_version, fanoutResult },
      ip: req.ip,
    });

    res.json({ ok: true, fanoutResult });
  });

  // Atualizar, corrigir, encerrar ou revogar ato publicado (RN-17, RN-18, RN-19)
  app.post('/api/curator/acts/:actId/revise', requireAuth, requireCuratorOrAdmin, (req: AuthedRequest, res) => {
    const actorId = req.session!.userId;
    const actId = String(req.params.actId);
    const { change_type, change_note, prazo, sem_prazo, urgencia, titulo, resumo } = req.body as {
      change_type: ActChangeType;
      change_note: string;
      prazo?: string | null;
      sem_prazo?: boolean;
      urgencia?: ActUrgencia;
      titulo?: string;
      resumo?: string;
    };

    if (!change_note?.trim()) {
      res.status(400).json({ error: 'Nota de mudança obrigatória para alterar ato publicado (Seção 7.2).' });
      return;
    }

    const existing = db.prepare(`SELECT * FROM acts WHERE id = ? AND deleted_at IS NULL`).get(actId) as
      | { current_version: number; status: string; prazo: string | null; sem_prazo: number; urgencia: ActUrgencia; titulo: string; resumo: string }
      | undefined;

    if (!existing) {
      res.status(404).json({ error: 'Ato não encontrado.' });
      return;
    }

    const nextVersion = existing.current_version + 1;
    const nextStatus =
      change_type === 'ENCERRAMENTO'
        ? 'ENCERRADO'
        : change_type === 'REVOGACAO'
          ? 'REVOGADO'
          : 'PUBLICADO';

    db.prepare(`
      UPDATE acts
      SET status = ?,
          current_version = ?,
          prazo = ?,
          sem_prazo = ?,
          urgencia = ?,
          titulo = ?,
          resumo = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      nextStatus,
      nextVersion,
      sem_prazo ? null : (prazo !== undefined ? prazo : existing.prazo),
      sem_prazo !== undefined ? (sem_prazo ? 1 : 0) : existing.sem_prazo,
      urgencia || existing.urgencia,
      titulo || existing.titulo,
      resumo || existing.resumo,
      actId
    );

    createActVersionSnapshot(db, actId, nextVersion, change_type, change_note.trim(), actorId);

    if (nextStatus === 'ENCERRADO' || nextStatus === 'REVOGADO') {
      cancelPendingRemindersForAct(db, actId);
    } else {
      // RN-17 & RN-18: Nova versão gera alertas de Atualização/Correção e recalcula lembretes
      fanoutAct(db, actId, nextVersion, { isCorrection: change_type === 'CORRECAO' });
      recalculateActReminders(db, actId);
    }

    writeAuditLog(db, {
      actorUserId: actorId,
      acao: `REVISAR_ATO_${change_type}`,
      entidade: 'acts',
      entidadeId: actId,
      depois: { version: nextVersion, status: nextStatus, change_note: change_note.trim() },
      ip: req.ip,
    });

    res.json({ ok: true, version: nextVersion, status: nextStatus });
  });

  // Sugestões do robô: descartar
  app.post('/api/curator/suggestions/:id/discard', requireAuth, requireCuratorOrAdmin, (req: AuthedRequest, res) => {
    db.prepare(`
      UPDATE watch_suggestions SET status = 'DESCARTADA', tratado_por = ?, updated_at = datetime('now') WHERE id = ?
    `).run(req.session!.userId, String(req.params.id));
    res.json({ ok: true });
  });

  // Importação inicial em lote (CSV simples -> todos entram como RASCUNHO)
  app.post('/api/curator/import-csv', requireAuth, requireCuratorOrAdmin, (req: AuthedRequest, res) => {
    const actorId = req.session!.userId;
    const { rows } = req.body as {
      rows: Array<{
        uf_sigla: string;
        orgao: string;
        tipo: ActTipo;
        numero: string;
        data_publicacao: string;
        assunto: ActAssunto;
        natureza_base: ActNaturezaBase;
        urgencia: ActUrgencia;
        prazo?: string | null;
        titulo: string;
        resumo: string;
        segments: string[];
      }>;
    };
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ error: 'Envie ao menos uma linha para importação.' });
      return;
    }

    let imported = 0;
    db.transaction(() => {
      const insAct = db.prepare(`
        INSERT INTO acts (
          id, uf_sigla, orgao, tipo, numero, data_publicacao, assunto, natureza_base,
          urgencia, prazo, sem_prazo, titulo, resumo, status, current_version, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RASCUNHO', 1, ?)
      `);
      const insSeg = db.prepare(`INSERT INTO act_segments (id, act_id, segment_code) VALUES (?, ?, ?)`);
      for (const r of rows) {
        const id = crypto.randomUUID();
        insAct.run(
          id,
          r.uf_sigla.toUpperCase(),
          r.orgao,
          r.tipo || 'PORTARIA',
          r.numero || 'S/N',
          r.data_publicacao || new Date().toISOString().slice(0, 10),
          r.assunto || 'ABERTURA',
          r.natureza_base || 'AMBAS',
          r.urgencia || 'IMPORTANTE',
          r.prazo || null,
          r.prazo ? 0 : 1,
          r.titulo,
          r.resumo || '',
          actorId
        );
        for (const s of r.segments || ['ECV']) {
          insSeg.run(crypto.randomUUID(), id, s);
        }
        imported++;
      }
    })();

    writeAuditLog(db, {
      actorUserId: actorId,
      acao: 'IMPORTACAO_INICIAL_RASCUNHOS',
      entidade: 'acts',
      entidadeId: 'batch',
      depois: { imported },
      ip: req.ip,
    });
    res.status(201).json({ imported });
  });

  // ==========================================
  // PAINEL DO ADMIN (Seção 7.3 — RBAC + 2FA)
  // ==========================================
  app.get('/api/admin/overview', requireAuth, requireAdmin, (_req, res) => {
    const profilesTotal = (
      db.prepare(`SELECT COUNT(*) as cnt FROM monitoring_profiles WHERE deleted_at IS NULL`).get() as { cnt: number }
    ).cnt;
    const companiesFree = (
      db.prepare(`SELECT COUNT(*) as cnt FROM companies WHERE plan = 'FREE' AND deleted_at IS NULL`).get() as { cnt: number }
    ).cnt;
    const companiesPaid = (
      db.prepare(`SELECT COUNT(*) as cnt FROM companies WHERE plan != 'FREE' AND plan_status = 'ATIVO' AND deleted_at IS NULL`).get() as {
        cnt: number;
      }
    ).cnt;
    const canceledCompanies = (
      db.prepare(`SELECT COUNT(*) as cnt FROM companies WHERE plan_status = 'CANCELADO' AND deleted_at IS NULL`).get() as {
        cnt: number;
      }
    ).cnt;

    const settings = getBillingSettings();
    const paidRows = db
      .prepare(`SELECT c.plan, mp.billing_cycle FROM companies c JOIN monitoring_profiles mp ON mp.id = c.profile_id WHERE c.plan != 'FREE' AND c.plan_status = 'ATIVO' AND c.deleted_at IS NULL`)
      .all() as Array<{ plan: 'PRO' | 'NACIONAL'; billing_cycle: BillingCycle }>;
    let mrrCents = 0;
    for (const r of paidRows) {
      mrrCents += r.plan === 'PRO' ? settings.pro_monthly_cents : settings.nacional_monthly_cents;
    }

    const deliveriesByChannel = db
      .prepare(`SELECT channel, status, COUNT(*) as count FROM deliveries GROUP BY channel, status`)
      .all();

    // RN-23: SLA médio em horas úteis
    const publishedActs = db
      .prepare(
        `SELECT publicacao_oficial_em, publicado_em FROM acts
         WHERE status IN ('PUBLICADO', 'ENCERRADO', 'REVOGADO')
           AND publicacao_oficial_em IS NOT NULL AND publicado_em IS NOT NULL`
      )
      .all() as Array<{ publicacao_oficial_em: string; publicado_em: string }>;
    const slaHours = publishedActs.map((a) => computeBusinessHoursSla(a.publicacao_oficial_em, a.publicado_em));
    const avgSlaHours = slaHours.length
      ? Math.round((slaHours.reduce((acc, v) => acc + v, 0) / slaHours.length) * 100) / 100
      : 0;

    const clients = db
      .prepare(
        `SELECT mp.id as profile_id, mp.nome as profile_nome, mp.founder_price_locked, mp.founder_number,
                up.user_id, up.nome as owner_nome, up.email as owner_email
         FROM monitoring_profiles mp
         JOIN users_profile up ON up.user_id = mp.owner_user_id
         WHERE mp.deleted_at IS NULL`
      )
      .all() as Array<Record<string, unknown>>;

    const enrichedClients = clients.map((cl) => {
      const companies = db
        .prepare(`SELECT id, cnpj, razao_social, segment_code, plan, plan_status FROM companies WHERE profile_id = ? AND deleted_at IS NULL`)
        .all(String(cl.profile_id));
      const invoices = db
        .prepare(`SELECT * FROM invoices_nf WHERE profile_id = ? ORDER BY created_at DESC`)
        .all(String(cl.profile_id));
      return { ...cl, companies, invoices };
    });

    const curators = db
      .prepare(
        `SELECT user_id, email, nome, role, mfa_required, mfa_enabled, created_at
         FROM users_profile WHERE role IN ('CURADOR', 'ADMIN') AND deleted_at IS NULL`
      )
      .all();

    const watchTargets = db
      .prepare(`SELECT * FROM watch_targets WHERE deleted_at IS NULL ORDER BY uf_sigla`)
      .all();

    const catalog = db
      .prepare(`SELECT * FROM checklist_catalog WHERE deleted_at IS NULL ORDER BY bloco, codigo`)
      .all();

    const auditLogs = db
      .prepare(
        `SELECT al.*, up.email as actor_email, up.nome as actor_nome
         FROM audit_log al
         LEFT JOIN users_profile up ON up.user_id = al.actor_user_id
         ORDER BY al.em DESC LIMIT 100`
      )
      .all();

    res.json({
      metrics: {
        profilesTotal,
        companiesFree,
        companiesPaid,
        conversionRatePct:
          companiesFree + companiesPaid > 0
            ? Math.round((companiesPaid / (companiesFree + companiesPaid)) * 1000) / 10
            : 0,
        mrrCents,
        canceledCompanies,
        avgSlaHours,
        deliveriesByChannel,
      },
      clients: enrichedClients,
      curators,
      watchTargets,
      catalog,
      auditLogs,
      settings,
    });
  });

  app.post('/api/admin/curators', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const { nome, email, password } = req.body as { nome: string; email: string; password: string };
    if (!nome || !email || !password || password.length < 8) {
      res.status(400).json({ error: 'Nome, e-mail e senha (mínimo 8 caracteres) são obrigatórios.' });
      return;
    }
    const cleanEmail = email.trim().toLowerCase();
    const exists = db.prepare(`SELECT user_id FROM users_profile WHERE email = ?`).get(cleanEmail);
    if (exists) {
      res.status(409).json({ error: 'E-mail já cadastrado.' });
      return;
    }

    const userId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO users_profile (
        id, user_id, email, password_hash, nome, celular_e164, role, mfa_required, mfa_enabled
      ) VALUES (?, ?, ?, ?, ?, '+5511999999999', 'CURADOR', 1, 0)
    `).run(crypto.randomUUID(), userId, cleanEmail, hashPassword(password), nome.trim());

    writeAuditLog(db, {
      actorUserId: req.session!.userId,
      acao: 'CRIAR_CURADOR',
      entidade: 'users_profile',
      entidadeId: userId,
      depois: { email: cleanEmail, role: 'CURADOR', mfa_required: true },
      ip: req.ip,
    });
    res.status(201).json({ userId });
  });

  app.delete('/api/admin/curators/:userId', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const targetId = String(req.params.userId);
    if (targetId === req.session!.userId) {
      res.status(400).json({ error: 'Não é possível remover sua própria conta de administrador.' });
      return;
    }
    db.prepare(`UPDATE users_profile SET deleted_at = ?, updated_at = datetime('now') WHERE user_id = ? AND role = 'CURADOR'`).run(
      new Date().toISOString(),
      targetId
    );
    writeAuditLog(db, {
      actorUserId: req.session!.userId,
      acao: 'REMOVER_CURADOR',
      entidade: 'users_profile',
      entidadeId: targetId,
      ip: req.ip,
    });
    res.json({ ok: true });
  });

  app.post('/api/admin/watch-targets', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const { uf_sigla, url, descricao } = req.body as { uf_sigla: string; url: string; descricao: string };
    if (!uf_sigla || !url || !descricao) {
      res.status(400).json({ error: 'UF, URL e descrição são obrigatórios.' });
      return;
    }
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO watch_targets (id, uf_sigla, url, descricao, ativo) VALUES (?, ?, ?, ?, 1)`).run(
      id,
      uf_sigla.toUpperCase(),
      url.trim(),
      descricao.trim()
    );
    res.status(201).json({ id });
  });

  app.post('/api/admin/watch-targets/run-now', requireAuth, requireAdmin, async (_req, res) => {
    const result = await runWatcherCycle(db);
    res.json(result);
  });

  app.post('/api/admin/catalog', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const { codigo, titulo, descricao, bloco, base_normativa, segment_code, uf_sigla } = req.body as {
      codigo: string;
      titulo: string;
      descricao: string;
      bloco: string;
      base_normativa: string;
      segment_code?: string | null;
      uf_sigla?: string | null;
    };
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO checklist_catalog (id, codigo, titulo, descricao, bloco, base_normativa, segment_code, uf_sigla, ativo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(id, codigo.trim(), titulo.trim(), descricao.trim(), bloco.trim(), base_normativa.trim(), segment_code || null, uf_sigla || null);
    res.status(201).json({ id });
  });

  app.put('/api/admin/settings', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const {
      pro_monthly_cents,
      pro_annual_cents,
      nacional_monthly_cents,
      nacional_annual_cents,
      discount_5_to_9_pct,
      discount_10_plus_pct,
      founder_limit,
    } = req.body as Partial<BillingSettings>;

    db.prepare(`
      UPDATE billing_settings
      SET pro_monthly_cents = COALESCE(?, pro_monthly_cents),
          pro_annual_cents = COALESCE(?, pro_annual_cents),
          nacional_monthly_cents = COALESCE(?, nacional_monthly_cents),
          nacional_annual_cents = COALESCE(?, nacional_annual_cents),
          discount_5_to_9_pct = COALESCE(?, discount_5_to_9_pct),
          discount_10_plus_pct = COALESCE(?, discount_10_plus_pct),
          founder_limit = COALESCE(?, founder_limit),
          updated_by = ?,
          updated_at = datetime('now')
      WHERE id = 'default'
    `).run(
      pro_monthly_cents ?? null,
      pro_annual_cents ?? null,
      nacional_monthly_cents ?? null,
      nacional_annual_cents ?? null,
      discount_5_to_9_pct ?? null,
      discount_10_plus_pct ?? null,
      founder_limit ?? null,
      req.session!.userId
    );
    res.json({ ok: true, settings: getBillingSettings() });
  });

  app.post('/api/admin/deliveries/process-now', requireAuth, requireAdmin, async (_req, res) => {
    const result = await processScheduledDeliveries(db, {
      whatsapp: whatsappProvider,
      email: emailProvider,
      push: pushProvider,
    });
    res.json(result);
  });

  // Cron em background (processamento de entregas a cada 60s + limpeza às 02h + vigilância 6h)
  const intervals: NodeJS.Timeout[] = [];
  if (process.env.NODE_ENV !== 'test') {
    intervals.push(
      setInterval(() => {
        void processScheduledDeliveries(db, {
          whatsapp: whatsappProvider,
          email: emailProvider,
          push: pushProvider,
        });
      }, 60_000)
    );
    intervals.push(
      setInterval(() => {
        runAutoCloseExpiredActs(db);
      }, 6 * 60 * 60_000)
    );
    intervals.push(
      setInterval(() => {
        void runWatcherCycle(db);
      }, 6 * 60 * 60_000)
    );
  }

  return { app, db, stopTimers: () => intervals.forEach(clearInterval) };
}

async function startServer() {
  const { app } = createSinarcApp();
  const PORT = Number(process.env.PORT || 3000);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SINARC servidor rodando em http://0.0.0.0:${PORT}`);
  });
}

const isDirectMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectMain) {
  void startServer();
}
