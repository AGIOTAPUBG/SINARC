import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { CompanyUfKind, UfRecord } from '../../packages/shared/types.ts';

// Grade cartográfica simplificada das 27 UFs mantendo disposição geográfica do Brasil (Norte, Nordeste, Centro-Oeste, Sudeste, Sul)
const UF_GRID_POSITIONS: Record<string, { col: number; row: number }> = {
  RR: { col: 3, row: 1 },
  AP: { col: 5, row: 1 },
  AM: { col: 2, row: 2 },
  PA: { col: 4, row: 2 },
  MA: { col: 6, row: 2 },
  CE: { col: 7, row: 2 },
  RN: { col: 8, row: 2 },
  AC: { col: 1, row: 3 },
  RO: { col: 2, row: 3 },
  TO: { col: 5, row: 3 },
  PI: { col: 6, row: 3 },
  PB: { col: 8, row: 3 },
  PE: { col: 7, row: 3 },
  MT: { col: 3, row: 4 },
  GO: { col: 4, row: 4 },
  DF: { col: 5, row: 4 },
  BA: { col: 6, row: 4 },
  AL: { col: 8, row: 4 },
  SE: { col: 7, row: 4 },
  MS: { col: 3, row: 5 },
  MG: { col: 5, row: 5 },
  ES: { col: 6, row: 5 },
  SP: { col: 4, row: 6 },
  RJ: { col: 5, row: 6 },
  PR: { col: 3, row: 7 },
  SC: { col: 4, row: 7 },
  RS: { col: 3, row: 8 },
};

interface BrazilUfMapProps {
  ufs: UfRecord[];
  mode: CompanyUfKind;
  selectedCredenciadas: string[];
  selectedInteresse: string[];
  maxTotal?: number;
  onToggleUf: (sigla: string) => void;
}

export function BrazilUfMap({
  ufs,
  mode,
  selectedCredenciadas,
  selectedInteresse,
  maxTotal,
  onToggleUf,
}: BrazilUfMapProps) {
  const [search, setSearch] = useState('');

  const filteredList = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ufs;
    return ufs.filter(
      (u) =>
        u.sigla.toLowerCase().includes(q) ||
        u.nome.toLowerCase().includes(q) ||
        u.orgao_nome.toLowerCase().includes(q)
    );
  }, [ufs, search]);

  const totalCount = selectedCredenciadas.length + selectedInteresse.length;

  const getUfState = (sigla: string) => {
    const isCred = selectedCredenciadas.includes(sigla);
    const isInt = selectedInteresse.includes(sigla);
    const isCurrent = mode === 'CREDENCIADA' ? isCred : isInt;
    const isOther = mode === 'CREDENCIADA' ? isInt : isCred;
    return { isCred, isInt, isCurrent, isOther };
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* Mapa Cartográfico Clicável das 27 UFs */}
      <div className="lg:col-span-7 border border-slate-200 dark:border-slate-800 rounded-xl p-5 bg-white dark:bg-slate-900">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div>
            <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Mapa interativo do Brasil (27 UFs)
            </h4>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Clique nas UFs para {mode === 'CREDENCIADA' ? 'marcar atuação credenciada' : 'marcar interesse de expansão'}.
            </p>
          </div>
          {typeof maxTotal === 'number' && (
            <span className="text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300">
              {totalCount}/{maxTotal} UFs
            </span>
          )}
        </div>

        <div
          className="grid gap-1.5 max-w-md mx-auto py-2"
          style={{ gridTemplateColumns: 'repeat(8, minmax(0, 1fr))' }}
          role="group"
          aria-label="Mapa clicável das 27 Unidades Federativas"
        >
          {ufs.map((uf) => {
            const pos = UF_GRID_POSITIONS[uf.sigla] || { col: 1, row: 1 };
            const { isCurrent, isOther } = getUfState(uf.sigla);
            const atLimit = typeof maxTotal === 'number' && totalCount >= maxTotal && !isCurrent;
            const disabled = isOther || atLimit;

            const colorClass = isCurrent
              ? mode === 'CREDENCIADA'
                ? 'bg-[#0B1F3A] text-white border-[#0B1F3A] dark:bg-sky-600 dark:border-sky-500'
                : 'bg-emerald-700 text-white border-emerald-700 dark:bg-emerald-600 dark:border-emerald-500'
              : isOther
                ? 'bg-slate-100 text-slate-400 border-slate-200 dark:bg-slate-800/60 dark:text-slate-600 dark:border-slate-800 cursor-not-allowed'
                : 'bg-slate-50 text-slate-800 border-slate-200 hover:border-slate-400 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700 dark:hover:border-slate-500';

            return (
              <button
                key={uf.sigla}
                type="button"
                disabled={disabled}
                onClick={() => onToggleUf(uf.sigla)}
                title={`${uf.nome} (${uf.orgao_nome})${isOther ? ' — já marcada na outra categoria' : ''}`}
                style={{ gridColumnStart: pos.col, gridRowStart: pos.row }}
                className={`h-10 rounded-md border text-xs font-semibold font-mono transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 ${colorClass}`}
              >
                {uf.sigla}
              </button>
            );
          })}
        </div>

        <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center gap-4 text-xs text-slate-600 dark:text-slate-400">
          <span>Credenciada: {selectedCredenciadas.length} UF(s)</span>
          <span aria-hidden="true">·</span>
          <span>Interesse: {selectedInteresse.length} UF(s)</span>
          <span aria-hidden="true">·</span>
          <span>Uma UF não pode ser credenciada e de interesse ao mesmo tempo</span>
        </div>
      </div>

      {/* Lista com Busca */}
      <div className="lg:col-span-5 border border-slate-200 dark:border-slate-800 rounded-xl p-4 bg-white dark:bg-slate-900">
        <div className="relative mb-3">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar UF, estado ou DETRAN..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 dark:border-slate-700 rounded-lg bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-600"
          />
        </div>

        <div className="max-h-72 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
          {filteredList.map((uf) => {
            const { isCurrent, isOther } = getUfState(uf.sigla);
            const atLimit = typeof maxTotal === 'number' && totalCount >= maxTotal && !isCurrent;
            return (
              <label
                key={uf.sigla}
                className={`flex items-center justify-between py-2.5 px-2 text-sm cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 rounded ${
                  isOther || atLimit ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <input
                    type="checkbox"
                    checked={isCurrent}
                    disabled={isOther || atLimit}
                    onChange={() => onToggleUf(uf.sigla)}
                    className="h-4 w-4 rounded border-slate-300 text-[#0B1F3A] focus:ring-sky-600"
                  />
                  <span className="font-mono font-semibold text-slate-900 dark:text-slate-100 w-7">
                    {uf.sigla}
                  </span>
                  <span className="truncate text-slate-700 dark:text-slate-300">
                    {uf.nome}
                  </span>
                </div>
                <span className="text-xs text-slate-500 dark:text-slate-400 shrink-0 ml-2">
                  {isOther ? 'Outra lista' : uf.orgao_nome}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}
