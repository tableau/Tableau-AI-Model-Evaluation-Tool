/** Split a pasted Tableau browser link into connection fields. */
export function parseTableauConnectionUrl(text: string): { server_url: string; site?: string } | null {
  try {
    const url = new URL(text.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;

    const siteMatch = url.hash.match(/^#\/site\/([^/?#]+)/)
      ?? url.pathname.match(/^\/(?:site|t)\/([^/?#]+)/);
    if (siteMatch) {
      return { server_url: url.origin, site: decodeURIComponent(siteMatch[1]) };
    }

    // A content link without a site segment targets the default site. A bare
    // server address leaves an already-entered site alone.
    const isContentLink = url.pathname !== '/' || url.hash.startsWith('#/');
    return { server_url: url.origin, ...(isContentLink ? { site: '' } : {}) };
  } catch {
    return null;
  }
}
