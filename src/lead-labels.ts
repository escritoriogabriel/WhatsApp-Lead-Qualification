const normalize = (name: string): string => name.trim().toLocaleLowerCase('pt-BR');

export type NewLeadLabelResult = 'blocked-by-clients' | 'lists-added' | 'lists-already-present';

export async function ensureNewLeadLists(
  currentLabels: readonly string[],
  addBotLists: () => Promise<void>,
): Promise<NewLeadLabelResult> {
  const labels = new Set(currentLabels.map(normalize));
  if (labels.has('clientes')) return 'blocked-by-clients';
  if (labels.has('bot - atendimento') && labels.has('novo lead')) return 'lists-already-present';
  await addBotLists();
  return 'lists-added';
}
