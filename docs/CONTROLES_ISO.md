# Mapeamento de Controles — ISO/IEC 27001:2022 e ISO/IEC 27701 (SINARC v1)

Controladora: **Bio Síntese Soluções em Ciência e Tecnologia Ltda**  
Escopo: Plataforma SINARC (`app.sinarc.com.br`, `admin.sinarc.com.br`, API e motor de alertas).

| Controle SINARC | Evidência no Sistema | ISO/IEC 27001:2022 (Anexo A) | ISO/IEC 27701 |
|---|---|---|---|
| Segregação de ambientes e chaves em variáveis de ambiente (`.env.example`, zero segredos no código) | `server.ts`, `server/providers.ts` | A.8.9, A.8.24 | § 6.7.1 |
| Autenticação forte com hash `scrypt` + sal individual e `timingSafeEqual` | `server/security.ts` | A.8.5 | § 6.6.2 |
| Autenticação multifator (2FA TOTP RFC 6238) obrigatória para `CURADOR` e `ADMIN` e opcional para clientes | `server/security.ts`, `server.ts` | A.8.5, A.5.17 | § 6.6.2 |
| Controle de acesso baseado em papéis (RBAC) e Row Level Security (RLS) isolando empresas/perfis | `supabase/migrations/0001_sinarc_schema.sql`, `server.ts` | A.5.15, A.8.3 | § 6.6.1 |
| Segregação de funções na curadoria (quem envia para revisão não pode aprovar — RN-21) | `packages/shared/rules.ts`, `server.ts` | A.5.3 | — |
| Bloqueio de conteúdo FREE no servidor (redação antes da serialização — RN-12) | `redactActForFree` em `packages/shared/rules.ts` | A.8.3, A.8.11 | § 7.4 |
| Bucket privado e URLs assinadas temporárias com HMAC para PDFs oficiais | `signPdfAccessToken` e `/api/acts/:actId/pdf` | A.8.24, A.8.3 | — |
| Log de auditoria imutável (`audit_log` append-only protegido por trigger e permissões) | `server/db.ts`, `0001_sinarc_schema.sql` | A.8.15 | § 6.9.4 |
| Proteção contra SSRF, Path Traversal e limitação de taxa (Rate Limit) em login, cadastro e CNPJ | `assertSafePublicUrl`, `resolveConfinedPath`, `createRateLimiter` | A.8.20, A.8.26 | — |
| Gestão de consentimentos versionados (Termos, Privacidade, WhatsApp opt-in/SAIR) | Tabela `consents`, RN-30, RN-31 | A.5.34 | § 7.2.3, § 7.3.1 |
| Direitos do titular: exportação (JSON + CSV) e exclusão/anonimização em até 15 dias | `/api/lgpd/export`, `/api/lgpd/delete-account`, RN-32 | A.5.34, A.8.10 | § 7.3.6, § 7.4.7 |
| Backups diários com retenção mínima de 30 dias (região `sa-east-1` São Paulo) | Runbook de restauração em `/docs/` | A.8.13 | — |
