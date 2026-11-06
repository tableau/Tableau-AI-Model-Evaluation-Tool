/** Run history for display, including custom evaluations. */
import { API_BASE } from './api';
import { NETWORK_ERROR_TEXT, httpErrorText } from './launch';

export async function fetchVisibleRuns(limit?: number): Promise<any[]> {
  const path = `/nlq-eval/runs${limit ? `?limit=${limit}` : ''}`;
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`);
  } catch {
    throw new Error(NETWORK_ERROR_TEXT);
  }
  if (!response.ok) throw new Error(httpErrorText(response.status, path));
  return (await response.json()).runs || [];
}
