import { GoogleGenAI, Type } from '@google/genai';
import crypto from 'node:crypto';
import Stripe from 'stripe';
import { formatCnpj, normalizeCnpj, validateCnpj } from '../packages/shared/cnpj.ts';
import { formatDateBr } from '../packages/shared/rules.ts';
import type {
  ChecklistCatalogItem,
  CompanyAddress,
  ExtractedActDraft,
} from '../packages/shared/types.ts';
import { assertSafePublicUrl } from './security.ts';

// 1. Provedor de CNPJ (RN-01)
export interface CnpjLookupResult {
  cnpj: string;
  razao_social: string;
  nome_fantasia: string;
  endereco: CompanyAddress;
  provider: string;
}

export interface CnpjProvider {
  lookup(cnpj: string): Promise<CnpjLookupResult>;
}

export class BrasilApiCnpjProvider implements CnpjProvider {
  async lookup(rawCnpj: string): Promise<CnpjLookupResult> {
    const cnpj = normalizeCnpj(rawCnpj);
    if (!validateCnpj(cnpj)) {
      throw new Error('CNPJ inválido pelos dígitos verificadores.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const resp = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'SINARC/1.0' },
      });
      if (!resp.ok) {
        throw new Error(`Consulta CNPJ retornou HTTP ${resp.status}.`);
      }
      const data = (await resp.json()) as Record<string, unknown>;
      return {
        cnpj,
        razao_social: String(data.razao_social || ''),
        nome_fantasia: String(data.nome_fantasia || data.razao_social || ''),
        endereco: {
          logradouro: String(data.logradouro || ''),
          numero: String(data.numero || 'S/N'),
          complemento: String(data.complemento || ''),
          bairro: String(data.bairro || ''),
          municipio: String(data.municipio || ''),
          uf: String(data.uf || ''),
          cep: String(data.cep || ''),
        },
        provider: 'brasilapi',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

// 2. Extrator IA da Curadoria (Seção 11)
export interface ActExtractionInput {
  rawText?: string;
  pdfBase64?: string;
  sourceUrl?: string;
  catalogItems: ChecklistCatalogItem[];
}

export interface ActExtractor {
  extract(input: ActExtractionInput): Promise<ExtractedActDraft>;
}

export class GeminiActExtractor implements ActExtractor {
  private getClient(): GoogleGenAI {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
      throw new Error('GEMINI_API_KEY não configurada no servidor. Configure nos segredos do ambiente.');
    }
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }

  async extract(input: ActExtractionInput): Promise<ExtractedActDraft> {
    const ai = this.getClient();
    const modelName = process.env.LLM_MODEL || 'gemini-4-hydrogen';

    let urlTextContent = '';
    if (input.sourceUrl && !input.rawText && !input.pdfBase64) {
      const safeUrl = assertSafePublicUrl(input.sourceUrl);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const resp = await fetch(safeUrl.toString(), {
          signal: controller.signal,
          headers: { 'User-Agent': 'SINARC-Curadoria/1.0' },
        });
        if (!resp.ok) {
          throw new Error(`Falha ao buscar URL (${resp.status}).`);
        }
        const html = await resp.text();
        urlTextContent = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .slice(0, 40000);
      } finally {
        clearTimeout(timer);
      }
    }

    const catalogPromptList = input.catalogItems
      .map((c) => `- id="${c.id}" | codigo="${c.codigo}" | bloco="${c.bloco}" | seg="${c.segment_code ?? 'AMBOS'}" | titulo="${c.titulo}"`)
      .join('\n');

    const systemInstruction = `Você é um analista regulatório de trânsito brasileiro atuando na curadoria do SINARC.
Extraia exclusivamente atos de DETRAN relacionados a CREDENCIAMENTO de Registradoras de Contrato (REGISTRADORA) e Empresas Credenciadas de Vistoria Veicular (ECV).
Se o documento for um Diário Oficial com várias matérias, localize APENAS a matéria do DETRAN sobre credenciamento e indique o número da página em pagina_diario_oficial.
Use datas no formato ISO YYYY-MM-DD.
Para o checklist, priorize referenciar catalog_id do catálogo abaixo quando houver correspondência, e adicione itens extras específicos da portaria quando existirem.
Catálogo base disponível:
${catalogPromptList}`;

    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
    if (input.pdfBase64) {
      const cleanB64 = input.pdfBase64.replace(/^data:application\/pdf;base64,/, '');
      parts.push({
        inlineData: {
          mimeType: 'application/pdf',
          data: cleanB64,
        },
      });
    }
    const combinedText = [input.rawText, urlTextContent].filter(Boolean).join('\n\n');
    parts.push({
      text: combinedText
        ? `Analise o documento e preencha o JSON estruturado do ato de credenciamento:\n\n${combinedText}`
        : 'Analise o PDF anexo (use OCR caso seja imagem) e preencha o JSON estruturado do ato de credenciamento.',
    });

    const response = await ai.models.generateContent({
      model: modelName,
      contents: { parts },
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            uf_sigla: { type: Type.STRING, description: 'Sigla da UF com 2 letras maiúsculas (ex: GO, SP, MG)' },
            orgao: { type: Type.STRING, description: 'Nome do órgão (ex: DETRAN-GO, CET-MG)' },
            tipo: { type: Type.STRING, description: 'PORTARIA | EDITAL | RESOLUCAO | CHAMAMENTO | COMUNICADO' },
            numero: { type: Type.STRING, description: 'Número/ano do ato (ex: 412/2026)' },
            data_publicacao: { type: Type.STRING, description: 'Data YYYY-MM-DD' },
            assunto: { type: Type.STRING, description: 'ABERTURA | RENOVACAO | NOVA_EXIGENCIA | DESCREDENCIAMENTO | SUSPENSAO | PRORROGACAO' },
            natureza_base: { type: Type.STRING, description: 'OPORTUNIDADE | OBRIGACAO | AMBAS' },
            urgencia: { type: Type.STRING, description: 'URGENTE | IMPORTANTE | INFORMATIVO' },
            prazo: { type: Type.STRING, description: 'Data limite YYYY-MM-DD ou string vazia se sem prazo' },
            sem_prazo: { type: Type.BOOLEAN },
            titulo: { type: Type.STRING, description: 'Título claro em português' },
            resumo: { type: Type.STRING, description: 'Resumo executivo objetivo em português do Brasil' },
            segments: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'REGISTRADORA e/ou ECV' },
            pagina_diario_oficial: { type: Type.STRING },
            checklist: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  catalog_id: { type: Type.STRING },
                  titulo: { type: Type.STRING },
                  descricao: { type: Type.STRING },
                  obrigatorio: { type: Type.BOOLEAN },
                  ordem: { type: Type.INTEGER },
                },
              },
            },
            confidences: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  field: { type: Type.STRING },
                  confidence: { type: Type.STRING, description: 'ALTA | MEDIA | BAIXA' },
                  reason: { type: Type.STRING },
                },
              },
            },
          },
        },
      },
    });

    const jsonText = (response.text ?? '').trim();
    if (!jsonText) {
      throw new Error('A IA não retornou resposta estruturada.');
    }
    const parsed = JSON.parse(jsonText) as Omit<ExtractedActDraft, 'model_used' | 'extracted_at'>;
    return {
      ...parsed,
      prazo: parsed.sem_prazo || !parsed.prazo ? null : parsed.prazo,
      model_used: modelName,
      extracted_at: new Date().toISOString(),
    };
  }
}

// 3. WhatsApp Cloud API (Seção 9.1)
export interface WhatsAppSendParams {
  toE164: string;
  templateName: string;
  bodyText: string;
  components?: unknown[];
}

export interface WhatsAppProvider {
  sendTemplate(params: WhatsAppSendParams): Promise<{ messageId: string; simulated: boolean }>;
  sendText(toE164: string, text: string): Promise<{ messageId: string; simulated: boolean }>;
}

export class MetaWhatsAppProvider implements WhatsAppProvider {
  async sendTemplate(params: WhatsAppSendParams) {
    const token = process.env.WHATSAPP_API_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneId) {
      return {
        messageId: `wa_pending_cfg_${crypto.randomUUID().slice(0, 12)}`,
        simulated: true,
      };
    }

    const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: params.toE164.replace('+', ''),
        type: 'template',
        template: {
          name: params.templateName,
          language: { code: 'pt_BR' },
          components: params.components ?? [],
        },
      }),
    });
    const data = (await resp.json()) as { messages?: Array<{ id: string }>; error?: { message: string } };
    if (!resp.ok) {
      throw new Error(data.error?.message || `Meta WhatsApp HTTP ${resp.status}`);
    }
    return { messageId: data.messages?.[0]?.id || crypto.randomUUID(), simulated: false };
  }

  async sendText(toE164: string, text: string) {
    const token = process.env.WHATSAPP_API_TOKEN;
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneId) {
      return { messageId: `wa_txt_cfg_${crypto.randomUUID().slice(0, 12)}`, simulated: true };
    }
    const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toE164.replace('+', ''),
        type: 'text',
        text: { body: text },
      }),
    });
    const data = (await resp.json()) as { messages?: Array<{ id: string }>; error?: { message: string } };
    if (!resp.ok) {
      throw new Error(data.error?.message || `Meta WhatsApp HTTP ${resp.status}`);
    }
    return { messageId: data.messages?.[0]?.id || crypto.randomUUID(), simulated: false };
  }
}

export function formatWhatsAppAlertMessage(params: {
  natureza: 'OPORTUNIDADE' | 'OBRIGACAO';
  urgencia: 'URGENTE' | 'IMPORTANTE' | 'INFORMATIVO';
  orgao: string;
  titulo: string;
  prazo: string | null;
  companyNames: string[];
  shortUrl: string;
  isCorrection?: boolean;
}): string {
  const natEmoji = params.natureza === 'OPORTUNIDADE' ? '🟢' : '🔴';
  const natLabel = params.natureza === 'OPORTUNIDADE' ? 'Oportunidade' : 'Obrigação';
  const urgMap = {
    URGENTE: '🔥 Urgente',
    IMPORTANTE: '⚠️ Importante',
    INFORMATIVO: 'ℹ️ Informativo',
  };

  if (params.isCorrection) {
    return `✏️ SINARC | Correção: ${params.orgao} — ${params.titulo}. Ver: ${params.shortUrl}`;
  }

  const prazoLine = params.prazo ? `📅 Prazo: ${formatDateBr(params.prazo)}` : '📅 Sem prazo definido';
  return `${natEmoji} SINARC | ${natLabel} ${urgMap[params.urgencia]}

${params.orgao}: ${params.titulo}
${prazoLine}
🏢 Empresas: ${params.companyNames.join(', ')}

Ver checklist completo: ${params.shortUrl}`;
}

// 4. E-mail (Resend - Seção 9.2)
export interface EmailProvider {
  send(params: { to: string; subject: string; html: string }): Promise<{ id: string; simulated: boolean }>;
}

export class ResendEmailProvider implements EmailProvider {
  async send(params: { to: string; subject: string; html: string }) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM || 'SINARC <alertas@sinarc.com.br>';
    if (!apiKey) {
      return { id: `email_pending_cfg_${crypto.randomUUID().slice(0, 12)}`, simulated: true };
    }
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [params.to],
        subject: params.subject,
        html: params.html,
      }),
    });
    const data = (await resp.json()) as { id?: string; message?: string };
    if (!resp.ok) {
      throw new Error(data.message || `Resend HTTP ${resp.status}`);
    }
    return { id: data.id || crypto.randomUUID(), simulated: false };
  }
}

// 5. Push (Expo Push - Seção 9.3)
export interface PushProvider {
  send(tokens: string[], title: string, body: string, data?: Record<string, unknown>): Promise<{ ticketId: string; simulated: boolean }>;
}

export class ExpoPushProvider implements PushProvider {
  async send(tokens: string[], title: string, body: string, data?: Record<string, unknown>) {
    if (tokens.length === 0) {
      return { ticketId: 'no_tokens', simulated: true };
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (process.env.EXPO_ACCESS_TOKEN) {
      headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
    }
    const resp = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers,
      body: JSON.stringify(
        tokens.map((to) => ({
          to,
          sound: 'default',
          title,
          body,
          data,
        }))
      ),
    });
    if (!resp.ok) {
      throw new Error(`Expo Push HTTP ${resp.status}`);
    }
    return { ticketId: crypto.randomUUID(), simulated: false };
  }
}

// 6. Provedor de Nota Fiscal (RN-29)
export interface InvoiceIssueInput {
  stripeInvoiceId: string;
  amountCents: number;
  customerName: string;
  customerEmail: string;
  customerCnpj?: string;
  description: string;
}

export interface InvoiceProvider {
  issue(input: InvoiceIssueInput): Promise<{
    providerId: string;
    pdfUrl: string;
    xmlUrl: string;
    simulated: boolean;
  }>;
}

export class ConfigurableInvoiceProvider implements InvoiceProvider {
  async issue(input: InvoiceIssueInput) {
    const apiKey = process.env.NF_API_KEY;
    const companyId = process.env.NF_COMPANY_ID;
    const provider = process.env.NF_PROVIDER || 'nfeio';

    if (!apiKey || !companyId) {
      const id = `nf_${provider}_${crypto.randomUUID().slice(0, 10)}`;
      return {
        providerId: id,
        pdfUrl: `/api/invoices/${id}/pdf`,
        xmlUrl: `/api/invoices/${id}/xml`,
        simulated: true,
      };
    }

    const endpoint =
      provider === 'enotas'
        ? `https://api.enotasgw.com.br/v2/empresas/${companyId}/nfes`
        : `https://api.nfe.io/v1/companies/${companyId}/serviceinvoices`;

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        externalId: input.stripeInvoiceId,
        description: input.description,
        servicesAmount: input.amountCents / 100,
        borrower: {
          name: input.customerName,
          email: input.customerEmail,
          federalTaxNumber: input.customerCnpj ? normalizeCnpj(input.customerCnpj) : undefined,
        },
      }),
    });

    if (!resp.ok) {
      throw new Error(`Provedor NF (${provider}) retornou HTTP ${resp.status}.`);
    }
    const payload = (await resp.json()) as Record<string, unknown>;
    const id = String(payload.id || crypto.randomUUID());
    return {
      providerId: id,
      pdfUrl: String(payload.pdfUrl || `/api/invoices/${id}/pdf`),
      xmlUrl: String(payload.xmlUrl || `/api/invoices/${id}/xml`),
      simulated: false,
    };
  }
}

// 7. Stripe Helper
export function getStripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key);
}

export function formatCompanyListForAlert(names: string[], cnpjs?: string[]): string {
  if (names.length === 0 && cnpjs?.length) {
    return cnpjs.map(formatCnpj).join(', ');
  }
  return names.join(', ');
}
