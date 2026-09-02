/** Enveloppe de pagination serveur, commune à toutes les listes du portail. */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

export const PAGE_SIZE_DEFAULT = 25;
export const PAGE_SIZE_MAX = 200;
