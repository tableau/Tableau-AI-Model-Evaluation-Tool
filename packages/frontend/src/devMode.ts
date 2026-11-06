/**
 * The dev flag (`?dev=1` in the URL, or localStorage `ai_eval_dev` = "1").
 *
 * It exposes developer diagnostics: the
 * direct-gateway launch path, and implementation detail such as runner names
 * and the address of the in-process bridge.
 */
export function isDevMode(): boolean {
  try {
    return (
      new URLSearchParams(window.location.search).has('dev') ||
      window.localStorage.getItem('ai_eval_dev') === '1'
    );
  } catch {
    return false;
  }
}

/**
 * True only when the address itself carries `?dev=1`, regardless of the saved flag.
 */
export function isDevUrl(): boolean {
  try {
    return new URLSearchParams(window.location.search).has('dev');
  } catch {
    return false;
  }
}
