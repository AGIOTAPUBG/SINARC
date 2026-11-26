import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileUp,
  Plus,
  Send,
  Sparkles,
  Upload,
} from 'lucide-react';
import { formatDateBr } from '../../packages/shared/rules.ts';
import type {
  ActAssunto,
  ActChangeType,
  ActChecklistItem,
  ActNaturezaBase,
  ActRecord,
  ActTipo,
  ActUrgencia,
  ChecklistCatalogItem,
  ExtractedActDraft,
  SegmentRecord,
  UfRecord,
} from '../../packages/shared/types.ts';
import { apiFetch } from '../lib/api.ts';

interface WatchSuggestionRow {
  id: string;
  target_id: string;
  detectado_em: string;
  diff_resumo: string;
  status: 'PENDENTE' | 'VIROU_ATO' | 'DESCARTADA';
  uf_sigla: string;
  url: string;
  target_descricao: string;
}

interface CuratorWorkspaceProps {
  currentUserId: string;
  ufs: UfRecord[];
  segments: SegmentRecord[];
}

export function CuratorWorkspace({ currentUserId, ufs, segments }: CuratorWorkspaceProps) {
  const [tab, setTab] = useState<'RASCUNHO' | 'EM_REVISAO' | 'SUGESTOES' | 'PUBLICADO' | 'NOVO' | 'IMPORT'>('EM_REVISAO');
  const [acts, setActs] = useState<ActRecord[]>([]);
  const [suggestions, setSuggestions] = useState<WatchSuggestionRow[]>([]);
  const [catalog, setCatalog] = useState<ChecklistCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  // Novo Ato + IA
  const [aiRawText, setAiRawText] = useState('');
  const [aiSourceUrl, setAiSourceUrl] = useState('');
  const [aiPdfBase64, setAiPdfBase64] = useState<string | null>(null);
  const [aiPdfName, setAiPdfName] = useState('');
  const [aiExtracting, setAiExtracting] = useState(false);
  const [lowConfidenceFields, setLowConfidenceFields] = useState<Record<string, string>>({});
  const [aiMetadata, setAiMetadata] = useState<unknown>(null);
  const [fromSuggestionId, setFromSuggestionId] = useState<string | undefined>(undefined);

  // Form fields
  const [ufSigla, setUfSigla] = useState('GO');
  const [orgao, setOrgao] = useState('DETRAN-GO');
  const [tipo, setTipo] = useState<ActTipo>('PORTARIA');
  const [numero, setNumero] = useState('');
  const [dataPublicacao, setDataPublicacao] = useState(new Date().toISOString().slice(0, 10));
  const [assunto, setAssunto] = useState<ActAssunto>('ABERTURA');
  const [naturezaBase, setNaturezaBase] = useState<ActNaturezaBase>('AMBAS');
  const [urgencia, setUrgencia] = useState<ActUrgencia>('IMPORTANTE');
  const [prazo, setPrazo] = useState('');
  const [semPrazo, setSemPrazo] = useState(false);
  const [titulo, setTitulo] = useState('');
  const [resumo, setResumo] = useState('');
  const [fonteUrl, setFonteUrl] = useState('');
  const [selectedSegments, setSelectedSegments] = useState<string[]>(['ECV']);
  const [checklist, setChecklist] = useState<ActChecklistItem[]>([]);

  // Revisão / Devolução / Atualização
  const [reviewAct, setReviewAct] = useState<ActRecord | null>(null);
  const [returnComment, setReturnComment] = useState('');
  const [reviseTarget, setReviseTarget] = useState<ActRecord | null>(null);
  const [reviseType, setReviseType] = useState<ActChangeType>('ATUALIZACAO');
  const [reviseNote, setReviseNote] = useState('');
  const [revisePrazo, setRevisePrazo] = useState('');

  // Importação CSV
  const [csvText, setCsvText] = useState(
    'uf_sigla;orgao;tipo;numero;data_publicacao;assunto;natureza_base;urgencia;prazo;titulo;resumo;segments\nBA;DETRAN-BA;EDITAL;022/2026;2026-11-26;ABERTURA;OPORTUNIDADE;IMPORTANTE;2027-02-10;Edital de credenciamento de ECVs na Bahia;Abertura de credenciamento de novas vistorias veiculares.;ECV'
  );

  const loadWorkspace = async () => {
    setLoading(true);
    try {
      const res = await apiFetch<{
        acts: ActRecord[];
        suggestions: WatchSuggestionRow[];
        catalog: ChecklistCatalogItem[];
      }>('/api/curator/workspace');
      setActs(res.acts);
      setSuggestions(res.suggestions);
      setCatalog(res.catalog);
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao carregar fila.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadWorkspace();
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAiPdfName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      setAiPdfBase64(String(reader.result || ''));
    };
    reader.readAsDataURL(file);
  };

  const handleExtractWithAi = async () => {
    setFeedback(null);
    setAiExtracting(true);
    try {
      const res = await apiFetch<{ draft: ExtractedActDraft }>('/api/curator/extract-ai', {
        method: 'POST',
        body: JSON.stringify({
          rawText: aiRawText || undefined,
          sourceUrl: aiSourceUrl || undefined,
          pdfBase64: aiPdfBase64 || undefined,
        }),
      });
      const d = res.draft;
      setUfSigla(d.uf_sigla || 'GO');
      setOrgao(d.orgao || `DETRAN-${d.uf_sigla || 'GO'}`);
      setTipo(d.tipo || 'PORTARIA');
      setNumero(d.numero || '');
      setDataPublicacao(d.data_publicacao || new Date().toISOString().slice(0, 10));
      setAssunto(d.assunto || 'ABERTURA');
      setNaturezaBase(d.natureza_base || 'AMBAS');
      setUrgencia(d.urgencia || 'IMPORTANTE');
      setPrazo(d.prazo || '');
      setSemPrazo(Boolean(d.sem_prazo));
      setTitulo(d.titulo || '');
      setResumo(d.resumo || '');
      if (aiSourceUrl) setFonteUrl(aiSourceUrl);
      if (d.segments?.length) setSelectedSegments(d.segments);
      if (d.checklist?.length) setChecklist(d.checklist);

      const lowMap: Record<string, string> = {};
      for (const c of d.confidences || []) {
        if (c.confidence === 'BAIXA' || c.confidence === 'MEDIA') {
          lowMap[c.field] = `${c.confidence}${c.reason ? `: ${c.reason}` : ''}`;
        }
      }
      setLowConfidenceFields(lowMap);
      setAiMetadata({
        model_used: d.model_used,
        extracted_at: d.extracted_at,
        pagina_diario_oficial: d.pagina_diario_oficial,
      });
      setFeedback({
        type: 'ok',
        msg: `Extração concluída (${d.model_used}). Revise os campos destacados antes de enviar.`,
      });
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro na extração IA.' });
    } finally {
      setAiExtracting(false);
    }
  };

  const handleSaveDraft = async (sendToReview: boolean) => {
    setFeedback(null);
    try {
      const created = await apiFetch<{ id: string }>('/api/curator/acts', {
        method: 'POST',
        body: JSON.stringify({
          uf_sigla: ufSigla,
          orgao,
          tipo,
          numero,
          data_publicacao: dataPublicacao,
          assunto,
          natureza_base: naturezaBase,
          urgencia,
          prazo: semPrazo ? null : prazo || null,
          sem_prazo: semPrazo,
          titulo,
          resumo,
          fonte_url: fonteUrl || null,
          pdfBase64: aiPdfBase64,
          segments: selectedSegments,
          checklist,
          ai_metadata: aiMetadata,
          from_suggestion_id: fromSuggestionId,
        }),
      });
      if (sendToReview) {
        await apiFetch(`/api/curator/acts/${created.id}/submit`, { method: 'POST' });
      }
      setFromSuggestionId(undefined);
      setTitulo('');
      setResumo('');
      setNumero('');
      setAiPdfBase64(null);
      setAiPdfName('');
      setChecklist([]);
      await loadWorkspace();
      setTab(sendToReview ? 'EM_REVISAO' : 'RASCUNHO');
      setFeedback({
        type: 'ok',
        msg: sendToReview ? 'Ato salvo e enviado para dupla revisão.' : 'Rascunho salvo com sucesso.',
      });
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao salvar ato.' });
    }
  };

  const drafts = acts.filter((a) => a.status === 'RASCUNHO');
  const inReview = acts.filter((a) => a.status === 'EM_REVISAO');
  const published = acts.filter((a) => a.status === 'PUBLICADO' || a.status === 'ENCERRADO' || a.status === 'REVOGADO');
  const pendingSuggestions = suggestions.filter((s) => s.status === 'PENDENTE');

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold">Painel da Curadoria</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Pré-preenchimento assistido por IA, revisão em dupla checagem e gestão de versões.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTab('IMPORT')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-semibold whitespace-nowrap"
          >
            <Upload className="w-4 h-4" /> Importar CSV
          </button>
          <button
            type="button"
            onClick={() => setTab('NOVO')}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#0B1F3A] text-white text-xs font-semibold whitespace-nowrap"
          >
            <Plus className="w-4 h-4" /> Novo ato
          </button>
        </div>
      </div>

      {/* Navegação de filas */}
      <div className="flex flex-wrap gap-1 p-1 bg-slate-100 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 w-fit">
        {(
          [
            ['RASCUNHO', `Rascunhos (${drafts.length})`],
            ['EM_REVISAO', `Em revisão (${inReview.length})`],
            ['SUGESTOES', `Sugestões do robô (${pendingSuggestions.length})`],
            ['PUBLICADO', `Publicados (${published.length})`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setTab(key);
              setReviewAct(null);
            }}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md whitespace-nowrap ${
              tab === key ? 'bg-white dark:bg-slate-800 shadow-sm text-slate-900 dark:text-white' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {feedback && (
        <div
          className={`p-3.5 rounded-xl border text-sm flex items-center justify-between ${
            feedback.type === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950/40 dark:border-emerald-900 dark:text-emerald-300'
              : 'bg-red-50 border-red-200 text-red-800 dark:bg-red-950/40 dark:border-red-900 dark:text-red-300'
          }`}
        >
          <span>{feedback.msg}</span>
          <button type="button" onClick={() => setFeedback(null)} className="text-xs underline">
            Fechar
          </button>
        </div>
      )}

      {loading ? (
        <div className="p-8 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 text-sm text-slate-500">
          Carregando fila de curadoria...
        </div>
      ) : tab === 'NOVO' ? (
        <div className="space-y-6">
          {/* Bloco Extração IA */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-sky-600" />
              <h2 className="text-base font-bold">Pré-preenchimento automático com IA (entra sempre como Rascunho)</h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium mb-1">Upload de PDF oficial (suporta OCR)</label>
                <label className="flex items-center gap-2 px-3.5 py-2.5 border border-dashed border-slate-300 dark:border-slate-700 rounded-lg cursor-pointer text-xs text-slate-600 dark:text-slate-300">
                  <FileUp className="w-4 h-4" />
                  <span>{aiPdfName || 'Selecionar arquivo PDF'}</span>
                  <input type="file" accept="application/pdf" onChange={handleFileChange} className="hidden" />
                </label>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Ou URL da página oficial do DETRAN</label>
                <input
                  type="url"
                  value={aiSourceUrl}
                  onChange={(e) => setAiSourceUrl(e.target.value)}
                  placeholder="https://www.detran..."
                  className="w-full px-3.5 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">Ou cole o texto da portaria / Diário Oficial</label>
              <textarea
                rows={4}
                value={aiRawText}
                onChange={(e) => setAiRawText(e.target.value)}
                placeholder="Cole aqui o texto integral ou trecho do Diário Oficial..."
                className="w-full px-3.5 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
              />
            </div>

            <button
              type="button"
              disabled={aiExtracting}
              onClick={handleExtractWithAi}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-700 hover:bg-sky-800 text-white text-xs font-semibold disabled:opacity-50"
            >
              <Sparkles className="w-4 h-4" />
              {aiExtracting ? 'Analisando documento...' : 'Extrair campos com IA'}
            </button>
          </div>

          {/* Formulário completo do ato */}
          <div className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-6 space-y-5">
            <h3 className="text-base font-bold">Dados estruturados do ato</h3>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium mb-1">
                  UF {lowConfidenceFields.uf_sigla && <span className="text-amber-600">({lowConfidenceFields.uf_sigla})</span>}
                </label>
                <select
                  value={ufSigla}
                  onChange={(e) => {
                    const nextUf = e.target.value;
                    setUfSigla(nextUf);
                    const found = ufs.find((u) => u.sigla === nextUf);
                    if (found) setOrgao(found.orgao_nome);
                  }}
                  className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                >
                  {ufs.map((u) => (
                    <option key={u.sigla} value={u.sigla}>
                      {u.sigla} — {u.nome}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Órgão</label>
                <input
                  type="text"
                  value={orgao}
                  onChange={(e) => setOrgao(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Tipo</label>
                <select
                  value={tipo}
                  onChange={(e) => setTipo(e.target.value as ActTipo)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                >
                  <option value="PORTARIA">Portaria</option>
                  <option value="EDITAL">Edital</option>
                  <option value="RESOLUCAO">Resolução</option>
                  <option value="CHAMAMENTO">Chamamento</option>
                  <option value="COMUNICADO">Comunicado</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">Número</label>
                <input
                  type="text"
                  value={numero}
                  onChange={(e) => setNumero(e.target.value)}
                  placeholder="Ex: 014/2026"
                  className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Data de publicação</label>
                <input
                  type="date"
                  value={dataPublicacao}
                  onChange={(e) => setDataPublicacao(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Assunto</label>
                <select
                  value={assunto}
                  onChange={(e) => setAssunto(e.target.value as ActAssunto)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                >
                  <option value="ABERTURA">Abertura</option>
                  <option value="RENOVACAO">Renovação</option>
                  <option value="NOVA_EXIGENCIA">Nova exigência</option>
                  <option value="DESCREDENCIAMENTO">Descredenciamento</option>
                  <option value="SUSPENSAO">Suspensão</option>
                  <option value="PRORROGACAO">Prorrogação</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">Natureza base</label>
                <select
                  value={naturezaBase}
                  onChange={(e) => setNaturezaBase(e.target.value as ActNaturezaBase)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                >
                  <option value="OPORTUNIDADE">Oportunidade</option>
                  <option value="OBRIGACAO">Obrigação</option>
                  <option value="AMBAS">Ambas</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Urgência</label>
                <select
                  value={urgencia}
                  onChange={(e) => setUrgencia(e.target.value as ActUrgencia)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                >
                  <option value="URGENTE">Urgente</option>
                  <option value="IMPORTANTE">Importante</option>
                  <option value="INFORMATIVO">Informativo</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">
                  Prazo {lowConfidenceFields.prazo && <span className="text-amber-600">({lowConfidenceFields.prazo})</span>}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    disabled={semPrazo}
                    value={prazo}
                    onChange={(e) => setPrazo(e.target.value)}
                    className="flex-1 px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950 disabled:opacity-40"
                  />
                  <label className="text-xs flex items-center gap-1 whitespace-nowrap">
                    <input type="checkbox" checked={semPrazo} onChange={(e) => setSemPrazo(e.target.checked)} />
                    Sem prazo
                  </label>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">Segmentos atingidos</label>
              <div className="flex gap-3">
                {segments.map((s) => (
                  <label key={s.code} className="inline-flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedSegments.includes(s.code)}
                      onChange={() =>
                        setSelectedSegments((prev) =>
                          prev.includes(s.code) ? prev.filter((x) => x !== s.code) : [...prev, s.code]
                        )
                      }
                    />
                    {s.nome}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">Título</label>
              <input
                type="text"
                value={titulo}
                onChange={(e) => setTitulo(e.target.value)}
                className={`w-full px-3 py-2 text-sm border rounded-lg bg-white dark:bg-slate-950 ${
                  lowConfidenceFields.titulo ? 'border-amber-500' : 'border-slate-300 dark:border-slate-700'
                }`}
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">Resumo interpretado</label>
              <textarea
                rows={4}
                value={resumo}
                onChange={(e) => setResumo(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">URL da fonte oficial</label>
              <input
                type="url"
                value={fonteUrl}
                onChange={(e) => setFonteUrl(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
              />
            </div>

            {/* Checklist editor */}
            <div className="space-y-3 pt-2 border-t border-slate-100 dark:border-slate-800">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold">Checklist ({checklist.length} itens)</h4>
                <div className="flex gap-2">
                  <select
                    onChange={(e) => {
                      const found = catalog.find((c) => c.id === e.target.value);
                      if (found) {
                        setChecklist((prev) => [
                          ...prev,
                          {
                            catalog_id: found.id,
                            titulo: found.titulo,
                            descricao: found.descricao,
                            obrigatorio: true,
                            ordem: prev.length + 1,
                          },
                        ]);
                      }
                      e.target.value = '';
                    }}
                    className="px-2.5 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                  >
                    <option value="">+ Adicionar do catálogo CONTRAN 807</option>
                    {catalog.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.codigo} — {c.titulo}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() =>
                      setChecklist((prev) => [
                        ...prev,
                        { titulo: 'Novo item específico', descricao: '', obrigatorio: true, ordem: prev.length + 1 },
                      ])
                    }
                    className="px-3 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-lg"
                  >
                    + Item extra
                  </button>
                </div>
              </div>

              {checklist.map((item, idx) => (
                <div key={idx} className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
                  <input
                    type="text"
                    value={item.titulo}
                    onChange={(e) =>
                      setChecklist((prev) => prev.map((it, i) => (i === idx ? { ...it, titulo: e.target.value } : it)))
                    }
                    className="sm:col-span-5 px-2.5 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                  />
                  <input
                    type="text"
                    value={item.descricao}
                    onChange={(e) =>
                      setChecklist((prev) => prev.map((it, i) => (i === idx ? { ...it, descricao: e.target.value } : it)))
                    }
                    placeholder="Descrição"
                    className="sm:col-span-6 px-2.5 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                  />
                  <button
                    type="button"
                    onClick={() => setChecklist((prev) => prev.filter((_, i) => i !== idx))}
                    className="sm:col-span-1 text-xs text-red-600 hover:underline"
                  >
                    Remover
                  </button>
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-3 pt-3">
              <button
                type="button"
                onClick={() => handleSaveDraft(false)}
                className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-sm font-medium"
              >
                Salvar rascunho
              </button>
              <button
                type="button"
                onClick={() => handleSaveDraft(true)}
                className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg bg-[#0B1F3A] text-white text-sm font-semibold"
              >
                <Send className="w-4 h-4" /> Enviar para revisão
              </button>
            </div>
          </div>
        </div>
      ) : tab === 'IMPORT' ? (
        <div className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-6 space-y-4">
          <h2 className="text-base font-bold">Importação inicial em lote (todos entram como RASCUNHO)</h2>
          <p className="text-xs text-slate-500">
            Formato separado por ponto e vírgula (;): uf_sigla;orgao;tipo;numero;data_publicacao;assunto;natureza_base;urgencia;prazo;titulo;resumo;segments
          </p>
          <textarea
            rows={6}
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            className="w-full font-mono text-xs p-3 border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
          />
          <button
            type="button"
            onClick={async () => {
              const lines = csvText.trim().split('\n').slice(1).filter(Boolean);
              const rows = lines.map((line) => {
                const [uf_sigla, orgaoVal, tipoVal, numeroVal, dataVal, assuntoVal, natVal, urgVal, prazoVal, tituloVal, resumoVal, segVal] =
                  line.split(';');
                return {
                  uf_sigla,
                  orgao: orgaoVal,
                  tipo: tipoVal,
                  numero: numeroVal,
                  data_publicacao: dataVal,
                  assunto: assuntoVal,
                  natureza_base: natVal,
                  urgencia: urgVal,
                  prazo: prazoVal || null,
                  titulo: tituloVal,
                  resumo: resumoVal,
                  segments: (segVal || 'ECV').split(',').map((s) => s.trim()),
                };
              });
              const res = await apiFetch<{ imported: number }>('/api/curator/import-csv', {
                method: 'POST',
                body: JSON.stringify({ rows }),
              });
              await loadWorkspace();
              setTab('RASCUNHO');
              setFeedback({ type: 'ok', msg: `${res.imported} ato(s) importado(s) como rascunho.` });
            }}
            className="px-5 py-2 rounded-lg bg-[#0B1F3A] text-white text-sm font-semibold"
          >
            Importar como rascunhos
          </button>
        </div>
      ) : tab === 'SUGESTOES' ? (
        <div className="space-y-3">
          {pendingSuggestions.length === 0 ? (
            <div className="p-8 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 text-center text-sm text-slate-500">
              Nenhuma sugestão pendente do robô de vigilância.
            </div>
          ) : (
            pendingSuggestions.map((s) => (
              <div
                key={s.id}
                className="border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
              >
                <div className="space-y-1">
                  <p className="text-xs text-slate-500">
                    <span className="font-mono font-bold text-slate-900 dark:text-white">{s.uf_sigla}</span> ·{' '}
                    {s.target_descricao} · Detectado em {formatDateBr(s.detectado_em)}
                  </p>
                  <p className="text-sm text-slate-800 dark:text-slate-200">{s.diff_resumo}</p>
                  <a href={s.url} target="_blank" rel="noreferrer" className="text-xs underline text-sky-700 dark:text-sky-400">
                    {s.url}
                  </a>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setUfSigla(s.uf_sigla);
                      setOrgao(`DETRAN-${s.uf_sigla}`);
                      setAiSourceUrl(s.url);
                      setFonteUrl(s.url);
                      setAiRawText(s.diff_resumo);
                      setFromSuggestionId(s.id);
                      setTab('NOVO');
                    }}
                    className="px-3.5 py-2 rounded-lg bg-[#0B1F3A] text-white text-xs font-semibold"
                  >
                    Criar ato a partir disto
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await apiFetch(`/api/curator/suggestions/${s.id}/discard`, { method: 'POST' });
                      await loadWorkspace();
                    }}
                    className="px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs"
                  >
                    Descartar
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {reviewAct && (
            <div className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-3 border-b lg:border-b-0 lg:border-r border-slate-100 dark:border-slate-800 pb-4 lg:pb-0 lg:pr-6">
                <p className="text-xs font-semibold text-slate-500">Documento / Fonte</p>
                <p className="text-sm font-bold">{reviewAct.titulo}</p>
                <p className="text-xs text-slate-500">
                  {reviewAct.uf_sigla} · {reviewAct.orgao} · {reviewAct.tipo} {reviewAct.numero} · Publicação:{' '}
                  {formatDateBr(reviewAct.data_publicacao)}
                </p>
                <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-line">{reviewAct.resumo}</p>
                {reviewAct.fonte_url && (
                  <a href={reviewAct.fonte_url} target="_blank" rel="noreferrer" className="text-xs underline text-sky-700 dark:text-sky-400">
                    Abrir fonte oficial
                  </a>
                )}
              </div>

              <div className="space-y-4">
                <p className="text-xs font-semibold text-slate-500">Conferência dupla (RN-21)</p>
                <div className="text-xs space-y-1 text-slate-600 dark:text-slate-300">
                  <p>Natureza: {reviewAct.natureza_base} · Urgência: {reviewAct.urgencia}</p>
                  <p>Segmentos: {reviewAct.segments.join(', ')}</p>
                  <p>Prazo: {reviewAct.sem_prazo ? 'Sem prazo' : formatDateBr(reviewAct.prazo)}</p>
                  <p>Itens no checklist: {reviewAct.checklist.length}</p>
                </div>

                {reviewAct.submitted_by === currentUserId && (
                  <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-xs text-amber-800 dark:text-amber-300 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    Você enviou este ato para revisão. Outro curador ou administrador deve aprová-lo (RN-21).
                  </div>
                )}

                <div className="space-y-2">
                  <input
                    type="text"
                    value={returnComment}
                    onChange={(e) => setReturnComment(e.target.value)}
                    placeholder="Comentário obrigatório caso devolva para rascunho"
                    className="w-full px-3 py-2 text-xs border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={reviewAct.submitted_by === currentUserId}
                      onClick={async () => {
                        try {
                          await apiFetch(`/api/curator/acts/${reviewAct.id}/approve`, {
                            method: 'POST',
                            body: JSON.stringify({}),
                          });
                          setReviewAct(null);
                          await loadWorkspace();
                          setFeedback({ type: 'ok', msg: 'Ato aprovado, publicado e alertas disparados.' });
                        } catch (err) {
                          setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao aprovar.' });
                        }
                      }}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-700 text-white text-xs font-semibold disabled:opacity-40"
                    >
                      <CheckCircle2 className="w-4 h-4" /> Aprovar e publicar
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await apiFetch(`/api/curator/acts/${reviewAct.id}/return`, {
                            method: 'POST',
                            body: JSON.stringify({ comment: returnComment }),
                          });
                          setReturnComment('');
                          setReviewAct(null);
                          await loadWorkspace();
                          setFeedback({ type: 'ok', msg: 'Ato devolvido para rascunho.' });
                        } catch (err) {
                          setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Informe um comentário.' });
                        }
                      }}
                      className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium"
                    >
                      Devolver com comentário
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {reviseTarget && (
            <div className="border border-slate-200 dark:border-slate-800 rounded-2xl bg-white dark:bg-slate-900 p-6 space-y-4">
              <h3 className="text-base font-bold">Nova versão / alteração: {reviseTarget.titulo}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <select
                  value={reviseType}
                  onChange={(e) => setReviseType(e.target.value as ActChangeType)}
                  className="px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                >
                  <option value="ATUALIZACAO">Atualização (ex: prorrogação)</option>
                  <option value="CORRECAO">Correção de erro</option>
                  <option value="ENCERRAMENTO">Encerramento</option>
                  <option value="REVOGACAO">Revogação</option>
                </select>
                <input
                  type="date"
                  value={revisePrazo}
                  onChange={(e) => setRevisePrazo(e.target.value)}
                  className="px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                />
                <input
                  type="text"
                  value={reviseNote}
                  onChange={(e) => setReviseNote(e.target.value)}
                  placeholder="Nota de mudança obrigatória"
                  className="px-3 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await apiFetch(`/api/curator/acts/${reviseTarget.id}/revise`, {
                        method: 'POST',
                        body: JSON.stringify({
                          change_type: reviseType,
                          change_note: reviseNote,
                          prazo: revisePrazo || undefined,
                        }),
                      });
                      setReviseTarget(null);
                      setReviseNote('');
                      await loadWorkspace();
                      setFeedback({ type: 'ok', msg: 'Nova versão publicada e lembretes recalculados.' });
                    } catch (err) {
                      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao revisar.' });
                    }
                  }}
                  className="px-4 py-2 rounded-lg bg-[#0B1F3A] text-white text-xs font-semibold"
                >
                  Publicar nova versão
                </button>
                <button
                  type="button"
                  onClick={() => setReviseTarget(null)}
                  className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}

          <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl bg-white dark:bg-slate-900">
            {(tab === 'RASCUNHO' ? drafts : tab === 'EM_REVISAO' ? inReview : published).map((act) => (
              <div key={act.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="font-mono font-bold text-slate-900 dark:text-white">{act.uf_sigla}</span>
                    <span>·</span>
                    <span>{act.orgao}</span>
                    <span>·</span>
                    <span>{act.tipo} {act.numero}</span>
                    <span>·</span>
                    <span>v{act.current_version}</span>
                    <span>·</span>
                    <span>{act.status}</span>
                  </div>
                  <p className="text-sm font-semibold text-slate-900 dark:text-white mt-0.5">{act.titulo}</p>
                  {act.return_comment && (
                    <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
                      Devolvido: {act.return_comment}
                    </p>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  {act.status === 'RASCUNHO' && (
                    <button
                      type="button"
                      onClick={async () => {
                        await apiFetch(`/api/curator/acts/${act.id}/submit`, { method: 'POST' });
                        await loadWorkspace();
                      }}
                      className="px-3.5 py-1.5 rounded-lg bg-[#0B1F3A] text-white text-xs font-semibold"
                    >
                      Enviar para revisão
                    </button>
                  )}
                  {act.status === 'EM_REVISAO' && (
                    <button
                      type="button"
                      onClick={() => setReviewAct(act)}
                      className="px-3.5 py-1.5 rounded-lg bg-[#0B1F3A] text-white text-xs font-semibold"
                    >
                      Revisar ato
                    </button>
                  )}
                  {act.status === 'PUBLICADO' && (
                    <button
                      type="button"
                      onClick={() => {
                        setReviseTarget(act);
                        setRevisePrazo(act.prazo || '');
                      }}
                      className="px-3.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium"
                    >
                      Atualizar / Corrigir / Encerrar
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
