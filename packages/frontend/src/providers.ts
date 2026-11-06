/**
 * Display names for the judge providers the tool knows. The backend stores
 * and returns the ids; every surface that shows one shows the name instead.
 */
export const PROVIDER_NAMES: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  mistral: 'Mistral',
  llama: 'Llama',
};

/** The display name of a provider id; an unknown id is shown as it is. */
export const providerLabel = (id: string | null | undefined): string =>
  id ? PROVIDER_NAMES[id.toLowerCase()] || id : '';
