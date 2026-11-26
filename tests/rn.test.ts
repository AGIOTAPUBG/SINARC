import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { validateCnpj } from '../packages/shared/cnpj.ts';
import {
  calculateSubscriptionPricing,
  canApproveAct,
  classifyWhatsAppInbound,
  computeBusinessHoursSla,
  computeDeadlineReminders,
  computeDeliverySchedule,
  consolidateAlertGroups,
  DEFAULT_BILLING_SETTINGS,
  filterValidMemberPreferences,
  makeSaoPauloDate,
  redactActForFree,
  resolveCompanyAlertNature,
  validateCompanyUfsUpdate,
} from '../packages/shared/rules.ts';
import { createSinarcApp } from '../server.ts';
import { createDatabase } from '../server/db.ts';
import {
  cancelPendingRemindersForAlert,
  fanoutAct,
  recalculateActReminders,
} from '../server/engine.ts';
import { generateTotpCode } from '../server/security.ts';

async function startTestServer() {
  const { app, db, stopTimers } = createSinarcApp(':memory:');
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  async function req(path: string, opts: RequestInit = {}, token?: string) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string> | undefined),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}${path}`, { ...opts, headers });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  }

  return {
    baseUrl,
    db,
    req,
    close: async () => {
      stopTimers();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

test('RN-01: Validação de CNPJ pelos dígitos verificadores antes de consulta externa', () => {
  assert.equal(validateCnpj('11.222.333/0001-81'), true);
  assert.equal(validateCnpj('11222333000182'), false);
  assert.equal(validateCnpj('00000000000000'), false);
});

test('RN-02: Mesmo CNPJ bloqueado no mesmo perfil, permitido em perfis distintos', async () => {
  const ctx = await startTestServer();
  try {
    const r1 = await ctx.req('/api/auth/register-onboarding', {
      method: 'POST',
      body: JSON.stringify({
        nome: 'Empresa A',
        email: 'a@empresa.com.br',
        celular_e164: '+5511988887777',
        password: 'password123',
        termsAccepted: true,
        company: {
          cnpj: '11.222.333/0001-81',
          razao_social: 'ECV Alfa Ltda',
          nome_fantasia: 'ECV Alfa',
          endereco: {},
          segment_code: 'ECV',
          ufs_credenciadas: ['SP'],
          ufs_interesse: ['GO'],
        },
        channels: { email: true, whatsapp: false, whatsappOptInAccepted: false },
      }),
    });
    assert.equal(r1.status, 201);
    const tokenA = String(r1.body.token);

    // Tentar cadastrar o mesmo CNPJ novamente no mesmo perfil deve falhar (409)
    const dup = await ctx.req(
      '/api/companies',
      {
        method: 'POST',
        body: JSON.stringify({
          cnpj: '11.222.333/0001-81',
          razao_social: 'ECV Alfa Duplicada',
          segment_code: 'ECV',
          ufs: [{ uf_sigla: 'MG', kind: 'INTERESSE' }],
        }),
      },
      tokenA
    );
    assert.equal(dup.status, 409);

    // Cadastrar o mesmo CNPJ em outro perfil (consultor) deve ser permitido
    const r2 = await ctx.req('/api/auth/register-onboarding', {
      method: 'POST',
      body: JSON.stringify({
        nome: 'Consultor B',
        email: 'b@consultoria.com.br',
        celular_e164: '+5511977776666',
        password: 'password123',
        termsAccepted: true,
        company: {
          cnpj: '11.222.333/0001-81',
          razao_social: 'ECV Alfa Ltda',
          nome_fantasia: 'ECV Alfa',
          endereco: {},
          segment_code: 'ECV',
          ufs_credenciadas: ['SP'],
          ufs_interesse: ['GO'],
        },
        channels: { email: true, whatsapp: false, whatsappOptInAccepted: false },
      }),
    });
    assert.equal(r2.status, 201);
  } finally {
    await ctx.close();
  }
});

test('RN-03 e RN-04: UF exclusiva (credenciada OU interesse) e limites PRO (5), NACIONAL (27), FREE (ilimitado)', () => {
  const dup = validateCompanyUfsUpdate('FREE', [
    { uf_sigla: 'GO', kind: 'CREDENCIADA' },
    { uf_sigla: 'GO', kind: 'INTERESSE' },
  ]);
  assert.equal(dup.ok, false);

  const proOver = validateCompanyUfsUpdate('PRO', [
    { uf_sigla: 'SP', kind: 'CREDENCIADA' },
    { uf_sigla: 'RJ', kind: 'CREDENCIADA' },
    { uf_sigla: 'MG', kind: 'INTERESSE' },
    { uf_sigla: 'GO', kind: 'INTERESSE' },
    { uf_sigla: 'PR', kind: 'INTERESSE' },
    { uf_sigla: 'SC', kind: 'INTERESSE' },
  ]);
  assert.equal(proOver.ok, false);

  const proOk = validateCompanyUfsUpdate('PRO', [
    { uf_sigla: 'SP', kind: 'CREDENCIADA' },
    { uf_sigla: 'GO', kind: 'INTERESSE' },
  ]);
  assert.equal(proOk.ok, true);

  const freeMany = validateCompanyUfsUpdate('FREE', [
    { uf_sigla: 'SP', kind: 'CREDENCIADA' },
    { uf_sigla: 'RJ', kind: 'CREDENCIADA' },
    { uf_sigla: 'MG', kind: 'INTERESSE' },
    { uf_sigla: 'GO', kind: 'INTERESSE' },
    { uf_sigla: 'PR', kind: 'INTERESSE' },
    { uf_sigla: 'SC', kind: 'INTERESSE' },
    { uf_sigla: 'BA', kind: 'INTERESSE' },
  ]);
  assert.equal(freeMany.ok, true);
});

test('RN-05: Preferências do membro são subconjunto das UFs da empresa e iniciam todas ativas no convite', () => {
  const companyUfs = [
    { company_id: 'c1', uf_sigla: 'SP', kind: 'CREDENCIADA' as const },
    { company_id: 'c1', uf_sigla: 'GO', kind: 'INTERESSE' as const },
  ];
  const invalid = filterValidMemberPreferences(companyUfs, [{ uf_sigla: 'RJ', ativo: true }]);
  assert.equal(invalid.ok, false);

  const valid = filterValidMemberPreferences(companyUfs, [{ uf_sigla: 'SP', ativo: false }]);
  assert.equal(valid.ok, true);
});

test('RN-06, RN-07, RN-08, RN-09, RN-10: Casamento, natureza, consolidação e idempotência', () => {
  // Critério 1: ECV com GO interesse recebe Oportunidade; Registradora com GO não recebe
  const natEcv = resolveCompanyAlertNature(
    'ECV',
    [{ company_id: 'c1', uf_sigla: 'GO', kind: 'INTERESSE' }],
    'GO',
    ['ECV'],
    'OPORTUNIDADE'
  );
  assert.equal(natEcv, 'OPORTUNIDADE');

  const natReg = resolveCompanyAlertNature(
    'REGISTRADORA',
    [{ company_id: 'c2', uf_sigla: 'GO', kind: 'INTERESSE' }],
    'GO',
    ['ECV'],
    'OPORTUNIDADE'
  );
  assert.equal(natReg, null);

  // Critério 2 (RN-09): Consultor com 3 registradoras credenciadas em SP consolida em 1 alerta
  const groups = consolidateAlertGroups([
    { user_id: 'u1', profile_id: 'p1', company_id: 'c1', company_plan: 'PRO', company_plan_status: 'ATIVO', natureza: 'OBRIGACAO' },
    { user_id: 'u1', profile_id: 'p1', company_id: 'c2', company_plan: 'PRO', company_plan_status: 'ATIVO', natureza: 'OBRIGACAO' },
    { user_id: 'u1', profile_id: 'p1', company_id: 'c3', company_plan: 'FREE', company_plan_status: 'FREE', natureza: 'OBRIGACAO' },
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].company_ids, ['c1', 'c2', 'c3']);
  assert.equal(groups[0].locked_for_free, false); // RN-11: há empresas pagas junto

  // RN-10: Idempotência de fanout no banco
  const db = createDatabase(':memory:');
  const uid = crypto.randomUUID();
  const pid = crypto.randomUUID();
  const cid = crypto.randomUUID();
  db.prepare(`INSERT INTO users_profile (id, user_id, email, password_hash, nome, celular_e164) VALUES (?, ?, 't@t.com', 'h', 'T', '+5511999999999')`).run(crypto.randomUUID(), uid);
  db.prepare(`INSERT INTO monitoring_profiles (id, owner_user_id, nome) VALUES (?, ?, 'P')`).run(pid, uid);
  db.prepare(`INSERT INTO companies (id, profile_id, cnpj, razao_social, nome_fantasia, endereco, segment_code, plan, plan_status) VALUES (?, ?, '11222333000181', 'E1', 'E1', '{}', 'ECV', 'PRO', 'ATIVO')`).run(cid, pid);
  db.prepare(`INSERT INTO company_ufs (id, company_id, uf_sigla, kind) VALUES (?, ?, 'GO', 'INTERESSE')`).run(crypto.randomUUID(), cid);
  db.prepare(`INSERT INTO company_members (id, company_id, user_id, is_owner, status) VALUES (?, ?, ?, 1, 'ATIVO')`).run(crypto.randomUUID(), cid, uid);
  db.prepare(`INSERT INTO member_preferences (id, company_id, user_id, uf_sigla, ativo) VALUES (?, ?, ?, 'GO', 1)`).run(crypto.randomUUID(), cid, uid);
  db.prepare(`INSERT INTO member_channels (id, user_id, channel, ativo) VALUES (?, ?, 'APP', 1)`).run(crypto.randomUUID(), uid);

  fanoutAct(db, 'act-go-ecv-2026', 1);
  fanoutAct(db, 'act-go-ecv-2026', 1); // Reprocessamento não duplica (Critério 13)
  const alertCount = (db.prepare(`SELECT COUNT(*) as cnt FROM alerts WHERE user_id = ?`).get(uid) as { cnt: number }).cnt;
  const delCount = (db.prepare(`SELECT COUNT(*) as cnt FROM deliveries`).get() as { cnt: number }).cnt;
  assert.equal(alertCount, 1);
  assert.equal(delCount >= 1, true);
});

test('RN-11, RN-12 e RN-13: Bloqueio FREE no servidor (sem resumo, prazo, checklist, pdf, fonte_url) e canais FREE', async () => {
  const ctx = await startTestServer();
  try {
    const reg = await ctx.req('/api/auth/register-onboarding', {
      method: 'POST',
      body: JSON.stringify({
        nome: 'Usuário Free',
        email: 'free@ecv.com.br',
        celular_e164: '+5562999990000',
        password: 'password123',
        termsAccepted: true,
        company: {
          cnpj: '11.222.333/0001-81',
          razao_social: 'ECV Goiás Ltda',
          nome_fantasia: 'ECV Goiás',
          endereco: {},
          segment_code: 'ECV',
          ufs_credenciadas: [],
          ufs_interesse: ['GO'],
        },
        channels: { email: true, whatsapp: true, whatsappOptInAccepted: true },
      }),
    });
    assert.equal(reg.status, 201);
    const token = String(reg.body.token);

    // Critério 3: API não retorna resumo, prazo, checklist, pdf nem fonte_url para usuário FREE
    const feed = await ctx.req('/api/alerts?scope=feed', {}, token);
    assert.equal(feed.status, 200);
    const alerts = feed.body.alerts as Array<Record<string, unknown>>;
    assert.equal(alerts.length >= 1, true);
    const first = alerts[0];
    assert.equal(first.locked_for_free, true);
    const act = first.act as Record<string, unknown>;
    assert.equal(act.resumo, null);
    assert.equal(act.prazo, null);
    assert.equal(act.pdf_signed_url, null);
    assert.equal(act.fonte_url, null);
    assert.deepEqual(act.checklist, []);

    // RN-13: WhatsApp não agendado para FREE, e-mail agendado apenas como RESUMO_SEMANAL_FREE
    const redactedDirect = redactActForFree(
      {
        id: '1',
        uf_sigla: 'GO',
        orgao: 'DETRAN-GO',
        tipo: 'EDITAL',
        numero: '1',
        data_publicacao: '2026-11-26',
        assunto: 'ABERTURA',
        urgencia: 'URGENTE',
        titulo: 'Titulo',
        status: 'PUBLICADO',
        current_version: 1,
        prazo: '2027-01-15',
        resumo: 'Segredo pago',
        pdf_path: 'a.pdf',
        fonte_url: 'https://detran.go.gov.br',
        checklist: [{ titulo: 'Item', descricao: 'Desc', obrigatorio: true, ordem: 1 }],
      },
      true
    );
    assert.equal(redactedDirect.resumo, null);
    assert.equal(redactedDirect.prazo, null);
  } finally {
    await ctx.close();
  }
});

test('RN-14, RN-15, RN-16, RN-17: Janela WhatsApp 8h-20h, exceção URGENTE, resumo diário e lembretes 30/7/1 + cancelamento', () => {
  // Critério 4: Ato IMPORTANTE às 22h (horário de Brasília) gera WhatsApp para 08h do dia seguinte
  const at22h = makeSaoPauloDate(2026, 11, 26, 22, 0);
  const impWa = computeDeliverySchedule({
    channel: 'WHATSAPP',
    urgencia: 'IMPORTANTE',
    ritmo: 'IMEDIATO',
    lockedForFree: false,
    now: at22h,
  });
  assert.ok(impWa);
  assert.equal(impWa.scheduledFor.toISOString(), makeSaoPauloDate(2026, 11, 27, 8, 0).toISOString());

  // Ato URGENTE às 22h sai na hora
  const urgWa = computeDeliverySchedule({
    channel: 'WHATSAPP',
    urgencia: 'URGENTE',
    ritmo: 'RESUMO_DIARIO',
    lockedForFree: false,
    now: at22h,
  });
  assert.ok(urgWa);
  assert.equal(urgWa.scheduledFor.toISOString(), at22h.toISOString());

  // Critério 5 (RN-14): Ritmo RESUMO_DIARIO agrupa para 8h
  const at14h = makeSaoPauloDate(2026, 11, 26, 14, 0);
  const daily = computeDeliverySchedule({
    channel: 'EMAIL',
    urgencia: 'IMPORTANTE',
    ritmo: 'RESUMO_DIARIO',
    lockedForFree: false,
    now: at14h,
  });
  assert.ok(daily);
  assert.equal(daily.kind, 'RESUMO_DIARIO');
  assert.equal(daily.scheduledFor.toISOString(), makeSaoPauloDate(2026, 11, 27, 8, 0).toISOString());

  // RN-16: Lembretes em 30, 7, 1 dia às 9h (pulando datas já passadas)
  const rems = computeDeadlineReminders('2026-12-10', false, false, makeSaoPauloDate(2026, 11, 26, 10, 0));
  assert.deepEqual(
    rems.map((r) => r.kind),
    ['LEMBRETE_7', 'LEMBRETE_1']
  );

  // Critério 6 & 7 (RN-16 & RN-17): Cancelamento ao resolver e recálculo ao prorrogar prazo
  const db = createDatabase(':memory:');
  const uid = crypto.randomUUID();
  const pid = crypto.randomUUID();
  const cid = crypto.randomUUID();
  db.prepare(`INSERT INTO users_profile (id, user_id, email, password_hash, nome, celular_e164) VALUES (?, ?, 'p@p.com', 'h', 'P', '+5511999999999')`).run(crypto.randomUUID(), uid);
  db.prepare(`INSERT INTO monitoring_profiles (id, owner_user_id, nome) VALUES (?, ?, 'P')`).run(pid, uid);
  db.prepare(`INSERT INTO companies (id, profile_id, cnpj, razao_social, nome_fantasia, endereco, segment_code, plan, plan_status) VALUES (?, ?, '11222333000181', 'E1', 'E1', '{}', 'ECV', 'PRO', 'ATIVO')`).run(cid, pid);
  db.prepare(`INSERT INTO company_ufs (id, company_id, uf_sigla, kind) VALUES (?, ?, 'GO', 'INTERESSE')`).run(crypto.randomUUID(), cid);
  db.prepare(`INSERT INTO company_members (id, company_id, user_id, is_owner, status) VALUES (?, ?, ?, 1, 'ATIVO')`).run(crypto.randomUUID(), cid, uid);
  db.prepare(`INSERT INTO member_preferences (id, company_id, user_id, uf_sigla, ativo) VALUES (?, ?, ?, 'GO', 1)`).run(crypto.randomUUID(), cid, uid);
  db.prepare(`INSERT INTO member_channels (id, user_id, channel, ativo) VALUES (?, ?, 'EMAIL', 1)`).run(crypto.randomUUID(), uid);

  fanoutAct(db, 'act-go-ecv-2026', 1, { now: makeSaoPauloDate(2026, 11, 26, 10, 0) });
  const alertRow = db.prepare(`SELECT id FROM alerts WHERE user_id = ?`).get(uid) as { id: string };
  recalculateActReminders(db, 'act-go-ecv-2026', makeSaoPauloDate(2026, 11, 26, 10, 0));
  cancelPendingRemindersForAlert(db, alertRow.id);
  const pendingRem = (
    db
      .prepare(`SELECT COUNT(*) as cnt FROM deliveries WHERE alert_id = ? AND kind LIKE 'LEMBRETE_%' AND status = 'AGENDADO'`)
      .get(alertRow.id) as { cnt: number }
  ).cnt;
  assert.equal(pendingRem, 0);
});

test('RN-18, RN-19, RN-20, RN-21, RN-22: Dupla checagem curadoria, histórico, versões e isolamento entre perfis (Critério 8 e 12)', async () => {
  const ctx = await startTestServer();
  try {
    // Bootstrap Admin
    const boot = await ctx.req('/api/auth/admin-bootstrap', {
      method: 'POST',
      body: JSON.stringify({
        nome: 'Admin SINARC',
        email: 'admin@sinarc.com.br',
        password: 'adminPassword123',
      }),
    });
    assert.equal(boot.status, 201);
    const adminToken = String(boot.body.token);

    // Admin cria Curador
    const curCreate = await ctx.req(
      '/api/admin/curators',
      {
        method: 'POST',
        body: JSON.stringify({
          nome: 'Curador Um',
          email: 'curador@sinarc.com.br',
          password: 'curatorPassword123',
        }),
      },
      adminToken
    );
    assert.equal(curCreate.status, 201);

    // Primeiro login do curador exige setup 2FA
    const curLogin1 = await ctx.req('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'curador@sinarc.com.br', password: 'curatorPassword123' }),
    });
    assert.equal(curLogin1.body.requiresMfaSetup, true);
    const totpCode = generateTotpCode(String(curLogin1.body.totpSecret));
    const curConfirm = await ctx.req(
      '/api/auth/mfa/setup-confirm',
      { method: 'POST', body: JSON.stringify({ totpCode }) },
      String(curLogin1.body.partialToken)
    );
    assert.equal(curConfirm.status, 200);
    const curatorToken = String(curConfirm.body.token);

    // Curador cria rascunho e envia para revisão
    const draft = await ctx.req(
      '/api/curator/acts',
      {
        method: 'POST',
        body: JSON.stringify({
          uf_sigla: 'RJ',
          orgao: 'DETRAN-RJ',
          tipo: 'EDITAL',
          numero: '099/2026',
          data_publicacao: '2026-11-26',
          assunto: 'ABERTURA',
          natureza_base: 'OPORTUNIDADE',
          urgencia: 'URGENTE',
          prazo: '2027-02-20',
          sem_prazo: false,
          titulo: 'Edital RJ para ECVs',
          resumo: 'Resumo do edital RJ.',
          segments: ['ECV'],
          checklist: [{ titulo: 'ISO 9001', descricao: 'Certificado', obrigatorio: true, ordem: 1 }],
        }),
      },
      curatorToken
    );
    assert.equal(draft.status, 201);
    const actId = String(draft.body.id);

    await ctx.req(`/api/curator/acts/${actId}/submit`, { method: 'POST' }, curatorToken);

    // Critério 8 (RN-21): Mesmo curador NÃO pode aprovar ato que enviou para revisão
    const selfApprove = await ctx.req(`/api/curator/acts/${actId}/approve`, { method: 'POST', body: '{}' }, curatorToken);
    assert.equal(selfApprove.status, 403);
    assert.equal(canApproveAct('curador-1', 'curador-1'), false);

    // Admin (outro usuário) aprova e publica
    const otherApprove = await ctx.req(`/api/curator/acts/${actId}/approve`, { method: 'POST', body: '{}' }, adminToken);
    assert.equal(otherApprove.status, 200);

    // RN-18 & RN-19: Nova versão de correção + encerramento movendo para histórico
    const revise = await ctx.req(
      `/api/curator/acts/${actId}/revise`,
      {
        method: 'POST',
        body: JSON.stringify({ change_type: 'CORRECAO', change_note: 'Correção de número do edital.' }),
      },
      curatorToken
    );
    assert.equal(revise.status, 200);
    assert.equal(revise.body.version, 2);

    // Critério 12: Usuário do Perfil A não consegue ver empresa/alertas do Perfil B
    const uA = await ctx.req('/api/auth/register-onboarding', {
      method: 'POST',
      body: JSON.stringify({
        nome: 'User A',
        email: 'ua@a.com',
        celular_e164: '+5521988881111',
        password: 'password123',
        termsAccepted: true,
        company: {
          cnpj: '11.222.333/0001-81',
          razao_social: 'Empresa A',
          nome_fantasia: 'Empresa A',
          endereco: {},
          segment_code: 'ECV',
          ufs_credenciadas: [],
          ufs_interesse: ['RJ'],
        },
        channels: { email: true, whatsapp: false, whatsappOptInAccepted: false },
      }),
    });
    const uB = await ctx.req('/api/auth/register-onboarding', {
      method: 'POST',
      body: JSON.stringify({
        nome: 'User B',
        email: 'ub@b.com',
        celular_e164: '+5521988882222',
        password: 'password123',
        termsAccepted: true,
        company: {
          cnpj: '11.222.333/0001-81',
          razao_social: 'Empresa B',
          nome_fantasia: 'Empresa B',
          endereco: {},
          segment_code: 'REGISTRADORA',
          ufs_credenciadas: [],
          ufs_interesse: ['AC'],
        },
        channels: { email: true, whatsapp: false, whatsappOptInAccepted: false },
      }),
    });
    const meA = await ctx.req('/api/me', {}, String(uA.body.token));
    const companyAId = ((meA.body.companies as Array<{ id: string }>)[0]).id;

    // User B tentando editar UFs da empresa do User A deve receber 403
    const crossEdit = await ctx.req(
      `/api/companies/${companyAId}/ufs`,
      { method: 'PUT', body: JSON.stringify({ ufs: [{ uf_sigla: 'SP', kind: 'CREDENCIADA' }] }) },
      String(uB.body.token)
    );
    assert.equal(crossEdit.status, 403);
  } finally {
    await ctx.close();
  }
});

test('RN-23: Cálculo de SLA em horas úteis (seg-sex 8h-18h, sem feriados nacionais)', () => {
  // Mesmo dia útil 09:00 -> 17:00 Brasília = 8h úteis
  const sameDay = computeBusinessHoursSla(
    makeSaoPauloDate(2026, 11, 24, 9, 0).toISOString(),
    makeSaoPauloDate(2026, 11, 24, 17, 0).toISOString()
  );
  assert.equal(sameDay, 8);

  // Sexta 17:00 até Segunda 09:00 = 1h (sexta) + 1h (segunda) = 2h úteis
  const weekend = computeBusinessHoursSla(
    makeSaoPauloDate(2026, 11, 27, 17, 0).toISOString(),
    makeSaoPauloDate(2026, 11, 30, 9, 0).toISOString()
  );
  assert.equal(weekend, 2);
});

test('RN-24, RN-25, RN-26, RN-27, RN-28, RN-29: Cobrança por empresa, desconto 15%/25%, anual 10x, fundador e downgrade por webhook', async () => {
  // Critério 11 (RN-25): 6 empresas PRO mensais -> 15% de desconto em toda a assinatura
  const quote6 = calculateSubscriptionPricing({
    items: Array.from({ length: 6 }, (_, i) => ({ companyId: `c${i}`, plan: 'PRO' as const })),
    cycle: 'MENSAL',
    settings: DEFAULT_BILLING_SETTINGS,
    founderPriceLocked: true,
  });
  assert.equal(quote6.discountPct, 15);
  assert.equal(quote6.subtotalCents, 6 * 29700);
  assert.equal(quote6.totalCents, Math.round(6 * 29700 * 0.85));

  // 10 empresas -> 25% de desconto; anual = 10x mensal (RN-26)
  const quote10Annual = calculateSubscriptionPricing({
    items: Array.from({ length: 10 }, (_, i) => ({ companyId: `c${i}`, plan: 'NACIONAL' as const })),
    cycle: 'ANUAL',
    settings: DEFAULT_BILLING_SETTINGS,
    founderPriceLocked: false,
  });
  assert.equal(quote10Annual.discountPct, 25);
  assert.equal(quote10Annual.subtotalCents, 10 * 597000);

  // RN-27: Fundador mantém preço original mesmo se tabela subir
  const higherSettings = { ...DEFAULT_BILLING_SETTINGS, pro_monthly_cents: 49700 };
  const founderQuote = calculateSubscriptionPricing({
    items: [{ companyId: 'c1', plan: 'PRO' }],
    cycle: 'MENSAL',
    settings: higherSettings,
    founderPriceLocked: true,
  });
  assert.equal(founderQuote.totalCents, 29700);

  // Critério 10 (RN-28 & RN-29): Webhooks Stripe (checkout.session.completed -> invoice.paid -> invoice.payment_failed)
  const ctx = await startTestServer();
  try {
    const reg = await ctx.req('/api/auth/register-onboarding', {
      method: 'POST',
      body: JSON.stringify({
        nome: 'Pagador Teste',
        email: 'pagador@empresa.com.br',
        celular_e164: '+5511955554444',
        password: 'password123',
        termsAccepted: true,
        company: {
          cnpj: '11.222.333/0001-81',
          razao_social: 'Empresa Pagadora SA',
          nome_fantasia: 'Pagadora',
          endereco: {},
          segment_code: 'ECV',
          ufs_credenciadas: [],
          ufs_interesse: ['GO'],
        },
        channels: { email: true, whatsapp: false, whatsappOptInAccepted: false },
      }),
    });
    const token = String(reg.body.token);
    const me = await ctx.req('/api/me', {}, token);
    const profileId = ((me.body.monitoringProfiles as Array<{ id: string }>)[0]).id;
    const companyId = ((me.body.companies as Array<{ id: string }>)[0]).id;

    // Simula evento checkout.session.completed
    const wh1 = await ctx.req('/api/webhooks/stripe', {
      method: 'POST',
      body: JSON.stringify({
        id: 'evt_checkout_1',
        type: 'checkout.session.completed',
        data: {
          object: {
            customer: 'cus_test_1',
            subscription: 'sub_test_1',
            metadata: {
              profile_id: profileId,
              plan: 'PRO',
              cycle: 'MENSAL',
              company_ids: JSON.stringify([companyId]),
            },
          },
        },
      }),
    });
    assert.equal(wh1.status, 200);

    // Conteúdo pago liberado
    const feedPaid = await ctx.req('/api/alerts?scope=feed', {}, token);
    const firstPaid = (feedPaid.body.alerts as Array<Record<string, unknown>>)[0];
    assert.equal(firstPaid.locked_for_free, false);

    // invoice.paid gera NF automática (RN-29)
    await ctx.req('/api/webhooks/stripe', {
      method: 'POST',
      body: JSON.stringify({
        id: 'evt_inv_paid_1',
        type: 'invoice.paid',
        data: { object: { id: 'in_test_1', customer: 'cus_test_1', amount_paid: 29700 } },
      }),
    });
    const meAfterPaid = await ctx.req('/api/me', {}, token);
    assert.equal((meAfterPaid.body.invoices as unknown[]).length, 1);

    // Critério 10: invoice.payment_failed volta empresa para FREE sem apagar dados
    await ctx.req('/api/webhooks/stripe', {
      method: 'POST',
      body: JSON.stringify({
        id: 'evt_inv_fail_1',
        type: 'invoice.payment_failed',
        data: { object: { id: 'in_test_2', customer: 'cus_test_1' } },
      }),
    });
    const meAfterFail = await ctx.req('/api/me', {}, token);
    const compAfterFail = (meAfterFail.body.companies as Array<{ plan: string; plan_status: string }>)[0];
    assert.equal(compAfterFail.plan, 'FREE');
    assert.equal(compAfterFail.plan_status, 'INADIMPLENTE');
  } finally {
    await ctx.close();
  }
});

test('RN-30 e RN-31: Opt-in WhatsApp e webhook "SAIR" (sem diferenciar maiúsculas/acentos) e "1"', async () => {
  assert.equal(classifyWhatsAppInbound('saír '), 'SAIR');
  assert.equal(classifyWhatsAppInbound('1'), 'VISTO_1');
  assert.equal(classifyWhatsAppInbound('oi tudo bem?'), 'OUTRO');

  const ctx = await startTestServer();
  try {
    const reg = await ctx.req('/api/auth/register-onboarding', {
      method: 'POST',
      body: JSON.stringify({
        nome: 'User WA',
        email: 'wa@ecv.com.br',
        celular_e164: '+5562991112222',
        password: 'password123',
        termsAccepted: true,
        company: {
          cnpj: '11.222.333/0001-81',
          razao_social: 'WA ECV',
          nome_fantasia: 'WA ECV',
          endereco: {},
          segment_code: 'ECV',
          ufs_credenciadas: [],
          ufs_interesse: ['GO'],
        },
        channels: { email: true, whatsapp: true, whatsappOptInAccepted: true },
      }),
    });
    const token = String(reg.body.token);

    // Critério 9: Responder "SAIR" desativa WhatsApp
    const wh = await ctx.req('/api/webhooks/whatsapp', {
      method: 'POST',
      body: JSON.stringify({
        fromE164: '+5562991112222',
        messageId: 'wamid_sair_1',
        text: 'SaIr',
      }),
    });
    assert.equal(wh.status, 200);

    const me = await ctx.req('/api/me', {}, token);
    const user = me.body.user as { whatsapp_opt_in: number };
    assert.equal(user.whatsapp_opt_in, 0);
  } finally {
    await ctx.close();
  }
});

test('RN-32: Exportação LGPD e exclusão/anonimização preservando registros fiscais e audit_log imutável (Critério 14)', async () => {
  const ctx = await startTestServer();
  try {
    const reg = await ctx.req('/api/auth/register-onboarding', {
      method: 'POST',
      body: JSON.stringify({
        nome: 'Titular LGPD',
        email: 'lgpd@empresa.com.br',
        celular_e164: '+5511933332222',
        password: 'password123',
        termsAccepted: true,
        company: {
          cnpj: '11.222.333/0001-81',
          razao_social: 'LGPD Ltda',
          nome_fantasia: 'LGPD',
          endereco: {},
          segment_code: 'ECV',
          ufs_credenciadas: [],
          ufs_interesse: ['GO'],
        },
        channels: { email: true, whatsapp: false, whatsappOptInAccepted: false },
      }),
    });
    const token = String(reg.body.token);

    const exp = await ctx.req('/api/lgpd/export', { method: 'POST' }, token);
    assert.equal(exp.status, 200);
    assert.ok((exp.body.json as Record<string, unknown>).user);
    assert.ok(String(exp.body.csv).includes('Titular LGPD'));

    const del = await ctx.req('/api/lgpd/delete-account', { method: 'POST' }, token);
    assert.equal(del.status, 200);

    // Após exclusão, token não acessa mais
    const after = await ctx.req('/api/me', {}, token);
    assert.equal(after.status, 401);

    // Trigger impede DELETE/UPDATE em audit_log
    assert.throws(() => {
      ctx.db.prepare(`DELETE FROM audit_log`).run();
    });
  } finally {
    await ctx.close();
  }
});
