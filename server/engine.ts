import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import {
  computeDeadlineReminders,
  computeDeliverySchedule,
  consolidateAlertGroups,
  formatDateBr,
  resolveCompanyAlertNature,
} from '../packages/shared/rules.ts';
import type {
  ActChangeType,
  ActNaturezaBase,
  ActUrgencia,
  ChannelType,
  CompanyUf,
  PlanType,
  UserRitmo,
} from '../packages/shared/types.ts';
import {
  formatWhatsAppAlertMessage,
  type EmailProvider,
  type PushProvider,
  type WhatsAppProvider,
} from './providers.ts';
import { assertSafePublicUrl } from './security.ts';

export function writeAuditLog(
  db: Database.Database,
  params: {
    actorUserId: string | null;
    acao: string;
    entidade: string;
    entidadeId: string;
    antes?: unknown;
    depois?: unknown;
    ip?: string | null;
  }
) {
  db.prepare(`
    INSERT INTO audit_log (id, actor_user_id, acao, entidade, entidade_id, antes, depois, ip, em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    params.actorUserId,
    params.acao,
    params.entidade,
    params.entidadeId,
    params.antes !== undefined ? JSON.stringify(params.antes) : null,
    params.depois !== undefined ? JSON.stringify(params.depois) : null,
    params.ip ?? null,
    new Date().toISOString()
  );
}

/**
 * Motor de alertas (Seção 8) — RN-06, RN-07, RN-08, RN-09, RN-10, RN-11, RN-13, RN-14, RN-15, RN-16, RN-18, RN-30.
 */
export function fanoutAct(
  db: Database.Database,
  actId: string,
  version: number,
  options?: { isCorrection?: boolean; now?: Date }
): { alertsCreatedOrUpdated: number; deliveriesScheduled: number } {
  const now = options?.now ?? new Date();
  const isCorrection = options?.isCorrection ? 1 : 0;

  const act = db
    .prepare(`SELECT * FROM acts WHERE id = ? AND deleted_at IS NULL`)
    .get(actId) as
    | {
        id: string;
        uf_sigla: string;
        orgao: string;
        natureza_base: ActNaturezaBase;
        urgencia: ActUrgencia;
        prazo: string | null;
        sem_prazo: number;
        titulo: string;
        status: string;
      }
    | undefined;

  if (!act || act.status !== 'PUBLICADO') {
    return { alertsCreatedOrUpdated: 0, deliveriesScheduled: 0 };
  }

  const actSegments = (
    db.prepare(`SELECT segment_code FROM act_segments WHERE act_id = ?`).all(actId) as Array<{
      segment_code: string;
    }>
  ).map((r) => r.segment_code);

  if (actSegments.length === 0) {
    return { alertsCreatedOrUpdated: 0, deliveriesScheduled: 0 };
  }

  const candidateRows = db
    .prepare(
      `SELECT
        c.id as company_id,
        c.profile_id as profile_id,
        c.segment_code as segment_code,
        c.plan as company_plan,
        c.plan_status as company_plan_status,
        cu.uf_sigla as uf_sigla,
        cu.kind as uf_kind,
        cm.user_id as user_id
       FROM companies c
       JOIN company_ufs cu ON cu.company_id = c.id AND cu.uf_sigla = ?
       JOIN company_members cm ON cm.company_id = c.id AND cm.status = 'ATIVO' AND cm.deleted_at IS NULL
       JOIN member_preferences mp ON mp.company_id = c.id AND mp.user_id = cm.user_id AND mp.uf_sigla = cu.uf_sigla AND mp.ativo = 1
       JOIN users_profile up ON up.user_id = cm.user_id AND up.deleted_at IS NULL
       WHERE c.deleted_at IS NULL`
    )
    .all(act.uf_sigla) as Array<{
    company_id: string;
    profile_id: string;
    segment_code: string;
    company_plan: PlanType;
    company_plan_status: string;
    uf_sigla: string;
    uf_kind: 'CREDENCIADA' | 'INTERESSE';
    user_id: string;
  }>;

  const matchedRows = [];
  for (const row of candidateRows) {
    const companyUfs: CompanyUf[] = [
      { company_id: row.company_id, uf_sigla: row.uf_sigla, kind: row.uf_kind },
    ];
    const nat = resolveCompanyAlertNature(
      row.segment_code,
      companyUfs,
      act.uf_sigla,
      actSegments,
      act.natureza_base
    );
    if (!nat) continue;
    matchedRows.push({
      user_id: row.user_id,
      profile_id: row.profile_id,
      company_id: row.company_id,
      company_plan: row.company_plan,
      company_plan_status: row.company_plan_status,
      natureza: nat,
    });
  }

  const groups = consolidateAlertGroups(matchedRows);
  let alertsCount = 0;
  let deliveriesCount = 0;

  const upsertAlert = db.prepare(`
    INSERT INTO alerts (
      id, act_id, act_version, user_id, profile_id, natureza, urgencia,
      company_ids, status, status_changed_at, is_correction, locked_for_free
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'NOVO', ?, ?, ?)
    ON CONFLICT (act_id, act_version, user_id, natureza) DO UPDATE SET
      company_ids = excluded.company_ids,
      urgencia = excluded.urgencia,
      locked_for_free = excluded.locked_for_free,
      is_correction = excluded.is_correction,
      updated_at = datetime('now')
    RETURNING id
  `);

  const insertDeliveryIgnore = db.prepare(`
    INSERT OR IGNORE INTO deliveries (
      id, alert_id, channel, kind, scheduled_for, status, attempts
    ) VALUES (?, ?, ?, ?, ?, 'AGENDADO', 0)
  `);

  for (const group of groups) {
    const alertRow = upsertAlert.get(
      crypto.randomUUID(),
      act.id,
      version,
      group.user_id,
      group.profile_id,
      group.natureza,
      act.urgencia,
      JSON.stringify(group.company_ids),
      now.toISOString(),
      isCorrection,
      group.locked_for_free ? 1 : 0
    ) as { id: string };
    alertsCount++;

    const userPrefs = db
      .prepare(`SELECT ritmo, whatsapp_opt_in, email_opt_in FROM users_profile WHERE user_id = ?`)
      .get(group.user_id) as { ritmo: UserRitmo; whatsapp_opt_in: number; email_opt_in: number } | undefined;

    const channels = db
      .prepare(`SELECT channel FROM member_channels WHERE user_id = ? AND ativo = 1`)
      .all(group.user_id) as Array<{ channel: ChannelType }>;

    const activeChannels = new Set<ChannelType>(channels.map((c) => c.channel));
    activeChannels.add('APP'); // App sempre ativo

    for (const channel of activeChannels) {
      if (channel === 'WHATSAPP' && (!userPrefs || userPrefs.whatsapp_opt_in !== 1)) {
        continue; // RN-30
      }
      if (channel === 'EMAIL' && userPrefs && userPrefs.email_opt_in !== 1) {
        continue;
      }

      const schedule = computeDeliverySchedule({
        channel,
        urgencia: act.urgencia,
        ritmo: userPrefs?.ritmo ?? 'IMEDIATO',
        lockedForFree: group.locked_for_free,
        now,
      });

      if (!schedule) continue;

      const res = insertDeliveryIgnore.run(
        crypto.randomUUID(),
        alertRow.id,
        channel,
        schedule.kind,
        schedule.scheduledFor.toISOString()
      );
      if (res.changes > 0) deliveriesCount++;
    }

    // Lembretes 30, 7 e 1 dia (RN-16)
    const reminders = computeDeadlineReminders(
      act.prazo,
      act.sem_prazo === 1,
      group.locked_for_free,
      now
    );
    for (const rem of reminders) {
      for (const ch of activeChannels) {
        if (ch === 'WHATSAPP' && (!userPrefs || userPrefs.whatsapp_opt_in !== 1)) continue;
        if (ch === 'EMAIL' && userPrefs && userPrefs.email_opt_in !== 1) continue;
        const res = insertDeliveryIgnore.run(
          crypto.randomUUID(),
          alertRow.id,
          ch,
          rem.kind,
          rem.scheduledFor.toISOString()
        );
        if (res.changes > 0) deliveriesCount++;
      }
    }
  }

  return { alertsCreatedOrUpdated: alertsCount, deliveriesScheduled: deliveriesCount };
}

/**
 * RN-16: Cancela lembretes pendentes quando usuário marca alerta como RESOLVIDO.
 */
export function cancelPendingRemindersForAlert(db: Database.Database, alertId: string) {
  db.prepare(`
    UPDATE deliveries
    SET status = 'CANCELADO', updated_at = datetime('now')
    WHERE alert_id = ?
      AND kind IN ('LEMBRETE_30', 'LEMBRETE_7', 'LEMBRETE_1')
      AND status = 'AGENDADO'
  `).run(alertId);
}

/**
 * RN-16: Cancela lembretes pendentes quando ato é encerrado/revogado.
 */
export function cancelPendingRemindersForAct(db: Database.Database, actId: string) {
  db.prepare(`
    UPDATE deliveries
    SET status = 'CANCELADO', updated_at = datetime('now')
    WHERE alert_id IN (SELECT id FROM alerts WHERE act_id = ?)
      AND kind IN ('LEMBRETE_30', 'LEMBRETE_7', 'LEMBRETE_1')
      AND status = 'AGENDADO'
  `).run(actId);
}

/**
 * RN-17: Recalcula lembretes pendentes de um ato quando nova versão altera prazo.
 */
export function recalculateActReminders(db: Database.Database, actId: string, now = new Date()) {
  cancelPendingRemindersForAct(db, actId);
  const act = db
    .prepare(`SELECT prazo, sem_prazo FROM acts WHERE id = ?`)
    .get(actId) as { prazo: string | null; sem_prazo: number } | undefined;
  if (!act) return;

  const alerts = db
    .prepare(`SELECT id, user_id, locked_for_free, status FROM alerts WHERE act_id = ? AND status != 'RESOLVIDO'`)
    .all(actId) as Array<{ id: string; user_id: string; locked_for_free: number; status: string }>;

  const insertRem = db.prepare(`
    INSERT OR IGNORE INTO deliveries (id, alert_id, channel, kind, scheduled_for, status, attempts)
    VALUES (?, ?, ?, ?, ?, 'AGENDADO', 0)
  `);

  for (const al of alerts) {
    const reminders = computeDeadlineReminders(act.prazo, act.sem_prazo === 1, al.locked_for_free === 1, now);
    const channels = db
      .prepare(`SELECT channel FROM member_channels WHERE user_id = ? AND ativo = 1`)
      .all(al.user_id) as Array<{ channel: ChannelType }>;
    for (const rem of reminders) {
      for (const ch of channels) {
        insertRem.run(crypto.randomUUID(), al.id, ch.channel, rem.kind, rem.scheduledFor.toISOString());
      }
    }
  }
}

/**
 * Processa entregas agendadas com retry exponencial (máx. 5 tentativas - Seção 8).
 */
export async function processScheduledDeliveries(
  db: Database.Database,
  providers: {
    whatsapp: WhatsAppProvider;
    email: EmailProvider;
    push: PushProvider;
  },
  now = new Date()
): Promise<{ processed: number; sent: number; failed: number }> {
  const dueRows = db
    .prepare(
      `SELECT
        d.id as delivery_id, d.alert_id, d.channel, d.kind, d.attempts,
        a.act_id, a.user_id, a.natureza, a.urgencia, a.company_ids, a.is_correction, a.locked_for_free,
        act.orgao, act.titulo, act.prazo, act.uf_sigla,
        up.email, up.nome, up.celular_e164, up.whatsapp_opt_in
       FROM deliveries d
       JOIN alerts a ON a.id = d.alert_id
       JOIN acts act ON act.id = a.act_id
       JOIN users_profile up ON up.user_id = a.user_id
       WHERE d.status = 'AGENDADO' AND d.scheduled_for <= ?
       LIMIT 100`
    )
    .all(now.toISOString()) as Array<{
    delivery_id: string;
    alert_id: string;
    channel: ChannelType;
    kind: string;
    attempts: number;
    act_id: string;
    user_id: string;
    natureza: 'OPORTUNIDADE' | 'OBRIGACAO';
    urgencia: ActUrgencia;
    company_ids: string;
    is_correction: number;
    locked_for_free: number;
    orgao: string;
    titulo: string;
    prazo: string | null;
    uf_sigla: string;
    email: string;
    nome: string;
    celular_e164: string;
    whatsapp_opt_in: number;
  }>;

  let sent = 0;
  let failed = 0;

  for (const row of dueRows) {
    try {
      const companyIds = JSON.parse(row.company_ids || '[]') as string[];
      const companies = companyIds.length
        ? (db
            .prepare(
              `SELECT nome_fantasia, razao_social FROM companies WHERE id IN (${companyIds.map(() => '?').join(',')})`
            )
            .all(...companyIds) as Array<{ nome_fantasia: string; razao_social: string }>)
        : [];
      const companyNames = companies.map((c) => c.nome_fantasia || c.razao_social);
      const baseUrl = process.env.SHORT_LINK_BASE_URL || `${process.env.APP_URL || 'https://sinarc.com.br'}/a`;
      const shortUrl = `${baseUrl}/${row.act_id}`;

      let messageId = `app_${crypto.randomUUID().slice(0, 10)}`;

      if (row.channel === 'WHATSAPP') {
        if (row.whatsapp_opt_in !== 1 || row.locked_for_free === 1) {
          db.prepare(`UPDATE deliveries SET status = 'CANCELADO', updated_at = datetime('now') WHERE id = ?`).run(
            row.delivery_id
          );
          continue;
        }
        const bodyText =
          row.kind.startsWith('LEMBRETE_')
            ? `⏰ SINARC | Faltam ${row.kind.replace('LEMBRETE_', '')} dia(s) para o prazo: ${row.titulo} (${row.orgao}). Ver: ${shortUrl}`
            : formatWhatsAppAlertMessage({
                natureza: row.natureza,
                urgencia: row.urgencia,
                orgao: row.orgao,
                titulo: row.titulo,
                prazo: row.prazo,
                companyNames,
                shortUrl,
                isCorrection: row.is_correction === 1,
              });
        const res = await providers.whatsapp.sendTemplate({
          toE164: row.celular_e164,
          templateName:
            row.is_correction === 1
              ? process.env.WHATSAPP_TPL_CORRECAO || 'sinarc_correcao'
              : row.kind.startsWith('LEMBRETE_')
                ? process.env.WHATSAPP_TPL_LEMBRETE || 'sinarc_lembrete_prazo'
                : process.env.WHATSAPP_TPL_ALERTA || 'sinarc_alerta',
          bodyText,
        });
        messageId = res.messageId;
      } else if (row.channel === 'EMAIL') {
        const subject =
          row.kind === 'RESUMO_SEMANAL_FREE'
            ? `SINARC | Resumo semanal de novidades nas suas UFs`
            : row.is_correction === 1
              ? `SINARC | Correção: ${row.orgao} — ${row.titulo}`
              : `SINARC | ${row.natureza === 'OPORTUNIDADE' ? 'Oportunidade' : 'Obrigação'}: ${row.orgao}`;
        const html =
          row.locked_for_free === 1
            ? `<p>Olá, ${row.nome}.</p><p>Há novidades nas suas UFs monitoradas: <strong>${row.titulo}</strong> (${row.orgao}).</p><p><a href="${shortUrl}">Assine um plano pago no SINARC para ver prazo, resumo e checklist completo.</a></p>`
            : `<p>Olá, ${row.nome}.</p><p><strong>${row.orgao}</strong> — ${row.titulo}</p><p>Prazo: ${formatDateBr(row.prazo)}<br/>Empresas: ${companyNames.join(', ')}</p><p><a href="${shortUrl}">Abrir ato e checklist no SINARC</a></p>`;
        const res = await providers.email.send({ to: row.email, subject, html });
        messageId = res.id;
      } else if (row.channel === 'PUSH') {
        const tokens = (
          db
            .prepare(`SELECT token FROM push_tokens WHERE user_id = ? AND ativo = 1 AND deleted_at IS NULL`)
            .all(row.user_id) as Array<{ token: string }>
        ).map((t) => t.token);
        const res = await providers.push.send(
          tokens,
          row.locked_for_free === 1 ? 'SINARC — Novidade nas suas UFs' : `${row.orgao} — ${row.natureza}`,
          row.titulo,
          { actId: row.act_id }
        );
        messageId = res.ticketId;
      }

      db.prepare(`
        UPDATE deliveries
        SET status = 'ENVIADO', sent_at = ?, provider_message_id = ?, attempts = attempts + 1, updated_at = datetime('now')
        WHERE id = ?
      `).run(now.toISOString(), messageId, row.delivery_id);
      sent++;
    } catch (err) {
      const nextAttempts = row.attempts + 1;
      const errMsg = err instanceof Error ? err.message : 'Erro desconhecido';
      if (nextAttempts >= 5) {
        db.prepare(`
          UPDATE deliveries
          SET status = 'FALHOU', attempts = ?, error = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(nextAttempts, errMsg, row.delivery_id);
      } else {
        const backoffMs = Math.pow(2, nextAttempts) * 60_000;
        const nextSchedule = new Date(now.getTime() + backoffMs).toISOString();
        db.prepare(`
          UPDATE deliveries
          SET attempts = ?, scheduled_for = ?, error = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(nextAttempts, nextSchedule, errMsg, row.delivery_id);
      }
      failed++;
    }
  }

  return { processed: dueRows.length, sent, failed };
}

/**
 * Seção 8 cron 02:00: Encerrar automaticamente atos ABERTURA com prazo vencido há mais de 30 dias, sem gerar alerta.
 */
export function runAutoCloseExpiredActs(db: Database.Database, now = new Date()): number {
  const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const expired = db
    .prepare(
      `SELECT * FROM acts
       WHERE status = 'PUBLICADO'
         AND assunto = 'ABERTURA'
         AND sem_prazo = 0
         AND prazo IS NOT NULL
         AND prazo < ?
         AND deleted_at IS NULL`
    )
    .all(cutoff) as Array<{ id: string; current_version: number; [key: string]: unknown }>;

  for (const act of expired) {
    const nextVersion = act.current_version + 1;
    db.prepare(`
      UPDATE acts
      SET status = 'ENCERRADO', current_version = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(nextVersion, act.id);

    db.prepare(`
      INSERT INTO act_versions (id, act_id, version, snapshot, change_type, change_note, published_by, published_at)
      VALUES (?, ?, ?, ?, 'ENCERRAMENTO', 'Encerramento automático: prazo de abertura vencido há mais de 30 dias.', 'system-cron', ?)
    `).run(crypto.randomUUID(), act.id, nextVersion, JSON.stringify(act), now.toISOString());

    cancelPendingRemindersForAct(db, act.id);
    writeAuditLog(db, {
      actorUserId: null,
      acao: 'AUTO_ENCERRAMENTO_ATO',
      entidade: 'acts',
      entidadeId: act.id,
      depois: { status: 'ENCERRADO', version: nextVersion },
    });
  }

  return expired.length;
}

/**
 * Seção 8 & RN-22: Robô de vigilância (apenas cria watch_suggestions, nunca publica atos).
 */
export async function runWatcherCycle(db: Database.Database, now = new Date()): Promise<{
  checked: number;
  suggestionsCreated: number;
}> {
  const targets = db
    .prepare(`SELECT * FROM watch_targets WHERE ativo = 1 AND deleted_at IS NULL`)
    .all() as Array<{
    id: string;
    uf_sigla: string;
    url: string;
    descricao: string;
    ultima_hash: string | null;
  }>;

  let checked = 0;
  let suggestionsCreated = 0;

  for (const target of targets) {
    checked++;
    try {
      const safeUrl = assertSafePublicUrl(target.url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      let textContent = '';
      try {
        const resp = await fetch(safeUrl.toString(), {
          signal: controller.signal,
          headers: { 'User-Agent': 'SINARC-Vigilancia/1.0' },
        });
        if (!resp.ok) continue;
        const html = await resp.text();
        textContent = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 50000);
      } finally {
        clearTimeout(timer);
      }

      const nextHash = crypto.createHash('sha256').update(textContent).digest('hex');
      if (target.ultima_hash && target.ultima_hash !== nextHash) {
        db.prepare(`
          INSERT INTO watch_suggestions (id, target_id, detectado_em, diff_resumo, status)
          VALUES (?, ?, ?, ?, 'PENDENTE')
        `).run(
          crypto.randomUUID(),
          target.id,
          now.toISOString(),
          `Alteração de conteúdo detectada em ${target.descricao} (${target.uf_sigla}). Trecho inicial: ${textContent.slice(0, 240)}`
        );
        suggestionsCreated++;
      }

      db.prepare(`
        UPDATE watch_targets SET ultima_hash = ?, ultima_verificacao = ?, updated_at = datetime('now') WHERE id = ?
      `).run(nextHash, now.toISOString(), target.id);
    } catch {
      // Falha pontual de rede/timeout em site de DETRAN apenas atualiza timestamp de tentativa
      db.prepare(`
        UPDATE watch_targets SET ultima_verificacao = ?, updated_at = datetime('now') WHERE id = ?
      `).run(now.toISOString(), target.id);
    }
  }

  return { checked, suggestionsCreated };
}

export function createActVersionSnapshot(
  db: Database.Database,
  actId: string,
  version: number,
  changeType: ActChangeType,
  changeNote: string,
  publishedBy: string
) {
  const act = db.prepare(`SELECT * FROM acts WHERE id = ?`).get(actId);
  const segs = db.prepare(`SELECT segment_code FROM act_segments WHERE act_id = ?`).all(actId);
  const items = db
    .prepare(`SELECT * FROM act_checklist_items WHERE act_id = ? AND deleted_at IS NULL ORDER BY ordem`)
    .all(actId);

  db.prepare(`
    INSERT INTO act_versions (id, act_id, version, snapshot, change_type, change_note, published_by, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    actId,
    version,
    JSON.stringify({ act, segments: segs, checklist: items }),
    changeType,
    changeNote,
    publishedBy,
    new Date().toISOString()
  );
}
