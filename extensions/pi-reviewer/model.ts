export interface ModelEntry {
  id: string;
  name?: string;
  provider: string;
}

export function resolveCurrentModelId(
  model: string | undefined,
  availableModels: ModelEntry[],
  sessionModel: { id: string; provider: string } | undefined,
): string | undefined {
  const entry = model
    ? availableModels.find((m) => m.id === model || `${m.provider}/${m.id}` === model)
    : sessionModel
      ? { id: sessionModel.id, provider: sessionModel.provider }
      : undefined;
  return entry ? `${entry.provider}/${entry.id}` : model;
}

/**
 * Which model id to budget the diff cap against. SSH reviews run in the
 * existing session agent, which a --model flag or configured model never
 * switches, so the session model owns the budget — and without one there is
 * no execution model to budget against, hence undefined (100k fallback).
 * Local reviews spawn `pi --model`, and CI pins the agent model, so the
 * override applies there.
 */
export interface BudgetModelOptions {
  ssh: boolean;
  currentModelId: string | undefined;
  sessionModel: { id: string; provider: string } | undefined;
}

export function resolveBudgetModelId(options: BudgetModelOptions): string | undefined {
  if (options.ssh) {
    return options.sessionModel
      ? `${options.sessionModel.provider}/${options.sessionModel.id}`
      : undefined;
  }
  return options.currentModelId;
}
