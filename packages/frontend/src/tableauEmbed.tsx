/**
 * A live Tableau dashboard inside the page, through Tableau's Embedding API
 * (https://help.tableau.com/current/api/embedding_api/en-us/index.html).
 *
 * The API is a script the Tableau server itself serves
 * (`/javascripts/api/tableau.embedding.3.latest.min.js`), so it is loaded
 * from the server the dashboard is on, once per server, and never bundled.
 * The script defines the `<tableau-viz>` element; rendering the element
 * before the script arrives is fine, the browser upgrades it on definition.
 *
 * `embedUrlOf` turns the links people copy (a Share link, a browser address,
 * a Tableau Public profile page) into the `/views/<workbook>/<view>` address
 * the element takes, or null when the link is not a view at all.
 */

import React, { useEffect, useLayoutEffect, useRef } from "react";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "tableau-viz": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        width?: string | number;
        height?: string | number;
        toolbar?: "top" | "bottom" | "hidden";
        device?: "default" | "desktop" | "tablet" | "phone";
        "hide-tabs"?: boolean | "";
        "hide-edit-button"?: boolean | "";
        "hide-edit-in-desktop-button"?: boolean | "";
        "disable-url-actions"?: boolean | "";
      };
    }
  }
}

const SCRIPT_PATH = "/javascripts/api/tableau.embedding.3.latest.min.js";

/** The address the `<tableau-viz>` element takes for a dashboard someone
 *  linked to, or null when the link does not name a view. */
export function embedUrlOf(link: string | null | undefined): string | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  // Tableau Server and Tableau Cloud: a browser address or Share link is
  // "/#/site/<site>/views/<workbook>/<view>?..." (no "/site/" on the default
  // site); the element takes "/t/<site>/views/<workbook>/<view>".
  const fragment = url.hash.replace(/^#\/?/, "");
  const fromFragment = fragment.match(/^(?:site\/([^/]+)\/)?views\/([^/?]+)\/([^/?]+)/);
  if (fromFragment) {
    const [, site, workbook, view] = fromFragment;
    return `${url.origin}${site ? `/t/${site}` : ""}/views/${workbook}/${view}`;
  }

  // Tableau Public: a profile page is "/app/profile/<author>/viz/<workbook>/<view>";
  // the element takes "/views/<workbook>/<view>". A "/shared/<code>" link is
  // taken as it is.
  const path = url.pathname.replace(/\/+$/, "");
  const fromProfile = path.match(/\/app\/profile\/[^/]+\/viz\/([^/]+)\/([^/]+)$/);
  if (fromProfile) return `${url.origin}/views/${fromProfile[1]}/${fromProfile[2]}`;
  const shared = path.match(/^\/shared\/[^/]+$/);
  if (shared) return `${url.origin}${path}`;

  // Already an embed address: "/views/<workbook>/<view>" or "/t/<site>/views/...".
  const direct = path.match(/^((?:\/t\/[^/]+)?\/views\/[^/]+\/[^/]+)/);
  if (direct) return `${url.origin}${direct[1]}`;
  return null;
}

const loaded = new Set<string>();

/** Loads the Embedding API from the server at `origin`, once. */
export function loadEmbeddingApi(origin: string, doc: Document = document): void {
  if (loaded.has(origin)) return;
  loaded.add(origin);
  const script = doc.createElement("script");
  script.type = "module";
  script.src = `${origin}${SCRIPT_PATH}`;
  script.dataset.tableauEmbedding = origin;
  doc.head.appendChild(script);
}

export interface TableauVizProps {
  /** The embed address, as `embedUrlOf` gives it. */
  src: string;
  width?: string | number;
  height?: string | number;
  /** The view did not load (not signed in, not found, server unreachable). */
  onError?: (message: string) => void;
  /** The view is drawn and usable. */
  onReady?: () => void;
  style?: React.CSSProperties;
}

/** The `<tableau-viz>` element with its script loaded from the view's server,
 *  toolbar and sheet tabs hidden: the dashboard, nothing around it. */
export const TableauViz: React.FC<TableauVizProps> = ({ src, width = "100%", height = 640, onError, onReady, style }) => {
  const ref = useRef<HTMLElement>(null);
  const origin = new URL(src).origin;

  useEffect(() => {
    loadEmbeddingApi(origin);
  }, [origin]);

  // A layout effect: the listeners are on the element as soon as it is in
  // the page, before the API can report anything about it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const failed = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const message =
        (detail && typeof detail === "object" && typeof detail.message === "string" && detail.message) ||
        (typeof detail === "string" && detail) ||
        "The dashboard could not be shown here.";
      onError?.(message);
    };
    const ready = () => onReady?.();
    el.addEventListener("vizloaderror", failed);
    el.addEventListener("firstinteractive", ready);
    return () => {
      el.removeEventListener("vizloaderror", failed);
      el.removeEventListener("firstinteractive", ready);
    };
  }, [onError, onReady, src]);

  return (
    <tableau-viz
      ref={ref}
      src={src}
      width={width}
      height={height}
      toolbar="hidden"
      hide-tabs=""
      hide-edit-button=""
      hide-edit-in-desktop-button=""
      style={{ display: "block", ...style }}
      data-testid="tableau-viz"
    />
  );
};
