/**
 * Pacotes de crédito. Preço e quantidade ficam SÓ aqui, no código do servidor.
 * O cliente envia apenas o id do pacote, nunca o valor.
 * Mudar o preço não afeta compras já criadas: o valor é gravado em `purchases` no momento da compra.
 *
 * Este arquivo não importa nada de servidor, então pode ser usado no navegador para exibição.
 */
export interface Pack {
  id: "starter" | "pro";
  name: string;
  credits: number;
  priceCents: number;
}

export const PACKS: readonly Pack[] = [
  { id: "starter", name: "Starter", credits: 10, priceCents: 1990 },
  { id: "pro", name: "Pro", credits: 50, priceCents: 7990 },
];

export type PackId = Pack["id"];

export function getPack(id: unknown): Pack | null {
  return PACKS.find((pack) => pack.id === id) ?? null;
}

export function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
