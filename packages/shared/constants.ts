import type { ChecklistCatalogItem, SegmentRecord, UfRecord } from './types.ts';

export const TERMS_VERSION = '2026.1';
export const PRIVACY_VERSION = '2026.1';

export const WHATSAPP_OPT_IN_TEXT =
  'Autorizo a Bio Síntese Soluções em Ciência e Tecnologia Ltda (SINARC) a enviar alertas de credenciamento, prazos e atualizações normativas para o meu número de WhatsApp via API oficial da Meta. Posso cancelar a qualquer momento respondendo SAIR.';

export const TERMS_TEXT_SUMMARY = `TERMOS DE USO — SINARC (Versão ${TERMS_VERSION})
Controladora e fornecedora: Bio Síntese Soluções em Ciência e Tecnologia Ltda.
1. Objeto: O SINARC é uma plataforma informativa de monitoramento de atos normativos de credenciamento junto aos DETRANs das 27 UFs para empresas registradoras de contrato e ECVs.
2. Limites de escopo: O SINARC não é sistema de envio de documentos ao DETRAN, não presta consultoria jurídica ou administrativa e não substitui a conferência do Diário Oficial pelo usuário.
3. Planos e cobrança: O plano FREE oferece visualização superficial sem acesso a resumos completos, prazos, checklists, PDFs ou canais pagos. Os planos PRO e NACIONAL são cobrados por empresa monitorada via Stripe em BRL.
4. Propriedade e uso: É vedada a redistribuição automatizada ou revenda comercial dos alertas sem autorização formal da Bio Síntese.`;

export const PRIVACY_TEXT_SUMMARY = `POLÍTICA DE PRIVACIDADE E LGPD — SINARC (Versão ${PRIVACY_VERSION})
Controladora: Bio Síntese Soluções em Ciência e Tecnologia Ltda.
1. Dados tratados: Nome, e-mail, telefone (E.164), registros de consentimento, IP/data de aceite, CNPJ e preferências de UFs/segmentos.
2. Finalidade e base legal: Execução de contrato (art. 7º, V da LGPD), cumprimento de obrigação legal/fiscal para emissão de notas fiscais (art. 7º, II) e consentimento específico para comunicações via WhatsApp (art. 7º, I).
3. Direitos do titular: Você pode exportar seus dados (JSON/CSV) e solicitar a exclusão da conta a qualquer momento em Minha Conta > Privacidade, com anonimização em até 15 dias (preservando atos públicos e documentos fiscais obrigatórios).`;

export const BRAZIL_UFS: UfRecord[] = [
  { sigla: 'AC', nome: 'Acre', orgao_nome: 'DETRAN-AC' },
  { sigla: 'AL', nome: 'Alagoas', orgao_nome: 'DETRAN-AL' },
  { sigla: 'AP', nome: 'Amapá', orgao_nome: 'DETRAN-AP' },
  { sigla: 'AM', nome: 'Amazonas', orgao_nome: 'DETRAN-AM' },
  { sigla: 'BA', nome: 'Bahia', orgao_nome: 'DETRAN-BA' },
  { sigla: 'CE', nome: 'Ceará', orgao_nome: 'DETRAN-CE' },
  { sigla: 'DF', nome: 'Distrito Federal', orgao_nome: 'DETRAN-DF' },
  { sigla: 'ES', nome: 'Espírito Santo', orgao_nome: 'DETRAN-ES' },
  { sigla: 'GO', nome: 'Goiás', orgao_nome: 'DETRAN-GO' },
  { sigla: 'MA', nome: 'Maranhão', orgao_nome: 'DETRAN-MA' },
  { sigla: 'MT', nome: 'Mato Grosso', orgao_nome: 'DETRAN-MT' },
  { sigla: 'MS', nome: 'Mato Grosso do Sul', orgao_nome: 'DETRAN-MS' },
  { sigla: 'MG', nome: 'Minas Gerais', orgao_nome: 'CET-MG' },
  { sigla: 'PA', nome: 'Pará', orgao_nome: 'DETRAN-PA' },
  { sigla: 'PB', nome: 'Paraíba', orgao_nome: 'DETRAN-PB' },
  { sigla: 'PR', nome: 'Paraná', orgao_nome: 'DETRAN-PR' },
  { sigla: 'PE', nome: 'Pernambuco', orgao_nome: 'DETRAN-PE' },
  { sigla: 'PI', nome: 'Piauí', orgao_nome: 'DETRAN-PI' },
  { sigla: 'RJ', nome: 'Rio de Janeiro', orgao_nome: 'DETRAN-RJ' },
  { sigla: 'RN', nome: 'Rio Grande do Norte', orgao_nome: 'DETRAN-RN' },
  { sigla: 'RS', nome: 'Rio Grande do Sul', orgao_nome: 'DETRAN-RS' },
  { sigla: 'RO', nome: 'Rondônia', orgao_nome: 'DETRAN-RO' },
  { sigla: 'RR', nome: 'Roraima', orgao_nome: 'DETRAN-RR' },
  { sigla: 'SC', nome: 'Santa Catarina', orgao_nome: 'DETRAN-SC' },
  { sigla: 'SP', nome: 'São Paulo', orgao_nome: 'DETRAN-SP' },
  { sigla: 'SE', nome: 'Sergipe', orgao_nome: 'DETRAN-SE' },
  { sigla: 'TO', nome: 'Tocantins', orgao_nome: 'DETRAN-TO' },
];

export const INITIAL_SEGMENTS: SegmentRecord[] = [
  { code: 'REGISTRADORA', nome: 'Registradora de Contrato', ativo: true },
  { code: 'ECV', nome: 'ECV (Vistoria Veicular)', ativo: true },
];

export const CONTRAN_807_BASE_CATALOG: Omit<ChecklistCatalogItem, 'id'>[] = [
  {
    codigo: 'CONTRAN807-HJ-01',
    titulo: 'Contrato Social ou Estatuto Consolidado com objeto compatível',
    descricao: 'Ato constitutivo registrado na Junta Comercial contemplando atividade de vistoria veicular ou registro de contratos.',
    bloco: 'Habilitação Jurídica',
    base_normativa: 'CONTRAN 807 / CONTRAN 941',
    segment_code: null,
    uf_sigla: null,
    ativo: true,
  },
  {
    codigo: 'CONTRAN807-HJ-02',
    titulo: 'Comprovante de inscrição no CNPJ em situação ativa',
    descricao: 'Cartão CNPJ emitido pela Receita Federal com CNAE compatível com o segmento credenciado.',
    bloco: 'Habilitação Jurídica',
    base_normativa: 'CONTRAN 807',
    segment_code: null,
    uf_sigla: null,
    ativo: true,
  },
  {
    codigo: 'CONTRAN807-RF-01',
    titulo: 'Certidão Negativa de Débitos Federais e Dívida Ativa da União',
    descricao: 'Certidão conjunta RFB/PGFN válida na data do protocolo de credenciamento ou renovação.',
    bloco: 'Regularidade Fiscal e Trabalhista',
    base_normativa: 'CONTRAN 807',
    segment_code: null,
    uf_sigla: null,
    ativo: true,
  },
  {
    codigo: 'CONTRAN807-RF-02',
    titulo: 'Certidão de Regularidade do FGTS (CRF) e CNDT',
    descricao: 'Comprovação de regularidade junto à Caixa Econômica Federal e Justiça do Trabalho.',
    bloco: 'Regularidade Fiscal e Trabalhista',
    base_normativa: 'CONTRAN 807',
    segment_code: null,
    uf_sigla: null,
    ativo: true,
  },
  {
    codigo: 'CONTRAN807-RF-03',
    titulo: 'Certidões negativas estaduais e municipais da sede/filial',
    descricao: 'Comprovação de regularidade tributária na UF do DETRAN credenciador e no município da unidade.',
    bloco: 'Regularidade Fiscal e Trabalhista',
    base_normativa: 'CONTRAN 807',
    segment_code: null,
    uf_sigla: null,
    ativo: true,
  },
  {
    codigo: 'CONTRAN807-TI-01',
    titulo: 'Certificação ISO 9001 ou laudo de conformidade técnica exigido',
    descricao: 'Certificado de sistema de gestão da qualidade válido ou comprovação equivalente prevista na portaria.',
    bloco: 'Qualificação Técnica',
    base_normativa: 'CONTRAN 941 / Portarias Estaduais',
    segment_code: 'ECV',
    uf_sigla: null,
    ativo: true,
  },
  {
    codigo: 'CONTRAN807-TI-02',
    titulo: 'Prova de Conceito (PoC) e homologação de integração sistêmica',
    descricao: 'Documentação técnica de integração via webservice/API com o sistema do DETRAN e certificação de segurança da informação.',
    bloco: 'Infraestrutura Tecnológica',
    base_normativa: 'CONTRAN 807',
    segment_code: 'REGISTRADORA',
    uf_sigla: null,
    ativo: true,
  },
  {
    codigo: 'CONTRAN807-INF-01',
    titulo: 'Alvará de funcionamento e AVCB do Corpo de Bombeiros',
    descricao: 'Licenças municipais e de segurança física para operação de pátio e área administrativa.',
    bloco: 'Infraestrutura Física',
    base_normativa: 'CONTRAN 941',
    segment_code: 'ECV',
    uf_sigla: null,
    ativo: true,
  },
  {
    codigo: 'CONTRAN807-ID-01',
    titulo: 'Declaração de idoneidade e ausência de vínculo com servidores do DETRAN',
    descricao: 'Declaração assinada pelos sócios e administradores atestando inexistência de impedimentos legais.',
    bloco: 'Idoneidade e Compliance',
    base_normativa: 'CONTRAN 807',
    segment_code: null,
    uf_sigla: null,
    ativo: true,
  },
];

// Feriados nacionais fixos (MM-DD) + móveis calculados em runtime para SLA RN-23
export const FIXED_NATIONAL_HOLIDAYS_MMDD = [
  '01-01', // Confraternização Universal
  '04-21', // Tiradentes
  '05-01', // Dia do Trabalhador
  '09-07', // Independência
  '10-12', // Nossa Senhora Aparecida
  '11-02', // Finados
  '11-15', // Proclamação da República
  '11-20', // Dia Nacional de Zumbi e da Consciência Negra
  '12-25', // Natal
];
