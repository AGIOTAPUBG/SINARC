# Relatório de Impacto à Proteção de Dados Pessoais (RIPD) — SINARC v1

**Controladora:** Bio Síntese Soluções em Ciência e Tecnologia Ltda  
**Produto:** SINARC — Sistema Nacional Radar de Credenciamento  
**Região de hospedagem:** Brasil (`sa-east-1`, São Paulo)

## 1. Dados Pessoais Tratados
- **Identificação e contato:** nome completo, e-mail corporativo, número de celular (E.164).
- **Credenciais e segurança:** hash de senha (`scrypt`), segredo TOTP (2FA), endereço IP e registros de consentimento.
- **Vínculo empresarial:** CNPJ, razão social, papel na empresa (`is_owner`), UFs e canais selecionados.
- **Registros fiscais:** dados de faturamento vinculados às faturas da Stripe e NFS-e emitidas.

## 2. Finalidades e Bases Legais (Art. 7º da LGPD)
| Tratamento | Finalidade | Base Legal | Retenção |
|---|---|---|---|
| Cadastro e autenticação | Acesso ao radar de credenciamento e gestão de empresas/membros | Execução de contrato (Art. 7º, V) | Enquanto ativa a conta (anonimização em até 15 dias após pedido de exclusão) |
| Envio de alertas por WhatsApp | Entrega de oportunidades, obrigações e prazos via API oficial Meta | Consentimento específico e destacado (Art. 7º, I), revogável a qualquer momento com "SAIR" | Até revogação ou exclusão da conta |
| Emissão de Notas Fiscais (`invoices_nf`) | Cumprimento de obrigação tributária pela Bio Síntese | Obrigação legal/regulatória (Art. 7º, II) | 5 anos (prazo legal fiscal) |
| Logs de auditoria (`audit_log`) | Rastreabilidade, prevenção a fraudes e governança | Legítimo interesse e cumprimento regulatório (Art. 7º, IX e II) | Mínimo 5 anos sem alteração |

## 3. Riscos Identificados e Medidas Mitigadoras
- **Acesso cruzado entre perfis/consultorias:** mitigado por RLS no banco, validação de `user_id` e `company_members` em todas as rotas de API e testes automatizados.
- **Vazamento de conteúdo pago ou PDFs privados:** mitigado por redação no servidor (`redactActForFree`) e URLs assinadas temporárias.
- **Envio indevido de mensagens no WhatsApp:** mitigado por registro auditável de `whatsapp_opt_in`, timestamp, texto aceito e processamento imediato da palavra-chave `"SAIR"`.
- **Exercício de direitos dos titulares (Art. 18 LGPD):** exportação imediata em JSON/CSV e fluxo automatizado de anonimização preservando exclusivamente atos públicos normativos e registros fiscais obrigatórios.
