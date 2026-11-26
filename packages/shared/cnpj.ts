export function normalizeCnpj(raw: string): string {
  return (raw || '').replace(/\D/g, '');
}

export function formatCnpj(raw: string): string {
  const digits = normalizeCnpj(raw);
  if (digits.length !== 14) return raw;
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12, 14)}`;
}

/**
 * RN-01: Validação oficial dos dígitos verificadores do CNPJ.
 */
export function validateCnpj(raw: string): boolean {
  const cnpj = normalizeCnpj(raw);
  if (cnpj.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;

  const calcDigit = (base: string, weights: number[]): number => {
    let sum = 0;
    for (let i = 0; i < weights.length; i++) {
      sum += Number(base[i]) * weights[i];
    }
    const rem = sum % 11;
    return rem < 2 ? 0 : 11 - rem;
  };

  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

  const d1 = calcDigit(cnpj.slice(0, 12), w1);
  if (d1 !== Number(cnpj[12])) return false;

  const d2 = calcDigit(cnpj.slice(0, 13), w2);
  return d2 === Number(cnpj[13]);
}
