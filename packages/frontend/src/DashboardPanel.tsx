/**
 * The side panel behind a name in the results table's Dashboard Name column:
 * the dashboard a Dashboard Narratives case is about. When the tool knows
 * where the dashboard is published (the case records it, or an admin saved
 * the address here) the panel embeds the live dashboard through Tableau's
 * Embedding API; otherwise it shows the picture the case sends to the server.
 * Under the picture, per view, the outliers and insights Tableau detected;
 * the live dashboard stands alone.
 */

import React, { useCallback, useEffect, useState } from "react";
import { Button, Drawer, Input, Table, Typography } from "./ui";
import type { ColumnsType } from "./ui";
import { LoadingOutlined } from "./ui/icons";
import { API_BASE } from "./api";
import { TableauViz, embedUrlOf } from "./tableauEmbed";

const { Text } = Typography;

/** The runner files a case under "Dashboard Name: <name>". */
export const dashboardNameOf = (utterance: string | null | undefined): string =>
  (utterance || "").replace(/^Dashboard Name:\s*/, "").trim();

export interface DashboardRef {
  jobId: string;
  caseId: string;
  name: string;
}

interface DashboardView {
  name: string;
  outliers: number;
  insights: number;
}

interface DashboardInfo {
  id: string;
  dashboard_id?: string | null;
  name: string;
  /** The descriptive name shown for the dashboard (the case's info.title), else the name. */
  title?: string;
  views: DashboardView[];
  has_image: boolean;
  /** Where the dashboard is published, when known. */
  url?: string | null;
  /** "case" when the test case records the address, "saved" when an admin did. */
  url_source?: "case" | "saved" | null;
  source?: string | null;
}

const count = (n: number) => (n ? String(n) : "—");

/** The embedded dashboard takes the panel's height, less the text around it. */
const embedHeight = () => Math.max(480, (typeof window !== "undefined" ? window.innerHeight : 900) - 300);

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export const DashboardPanel: React.FC<{
  /** The dashboard to show; null closes the panel. */
  dashboard: DashboardRef | null;
  onClose: () => void;
}> = ({ dashboard, onClose }) => {
  const [info, setInfo] = useState<DashboardInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The Embedding API reported the view did not load; the picture stands in. */
  const [embedFailed, setEmbedFailed] = useState<string | null>(null);
  const [embedReady, setEmbedReady] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const base = dashboard
    ? `${API_BASE}/nlq-eval/dashboards/${encodeURIComponent(dashboard.jobId)}/${encodeURIComponent(dashboard.caseId)}`
    : null;

  useEffect(() => {
    setInfo(null);
    setError(null);
    setEmbedFailed(null);
    setEmbedReady(false);
    setEditing(false);
    setDraft("");
    setSaveError(null);
    if (!base) return undefined;
    let cancelled = false;
    fetch(base)
      .then((r) => {
        if (!r.ok) {
          throw new Error(
            r.status === 404 ? "The test case file for this dashboard is not on this machine." : `HTTP ${r.status}`,
          );
        }
        return r.json();
      })
      .then((body) => {
        if (!cancelled) setInfo(body);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [base]);

  const saveLocation = useCallback(
    (url: string) => {
      if (!base) return;
      setSaving(true);
      setSaveError(null);
      fetch(`${base}/location`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      })
        .then(async (r) => {
          const body = await r.json().catch(() => ({}));
          if (!r.ok) {
            throw new Error(
              body?.error ||
                (r.status === 404 || r.status === 405
                  ? "This version of the tool's server cannot save the address. Restart the tool, then try again."
                  : `HTTP ${r.status}`),
            );
          }
          return body as DashboardInfo;
        })
        .then((body) => {
          setInfo(body);
          setEmbedFailed(null);
          setEmbedReady(false);
          setEditing(false);
          setDraft("");
        })
        .catch((e) => setSaveError(e.message))
        .finally(() => setSaving(false));
    },
    [base],
  );

  const onEmbedError = useCallback((message: string) => setEmbedFailed(message), []);
  const onEmbedReady = useCallback(() => setEmbedReady(true), []);

  const columns: ColumnsType<DashboardView> = [
    {
      title: "View",
      key: "name",
      render: (_: unknown, v: DashboardView) => <span style={{ overflowWrap: "anywhere" }}>{v.name || "—"}</span>,
    },
    { title: "Outliers", key: "outliers", width: 90, render: (_: unknown, v: DashboardView) => count(v.outliers) },
    { title: "Insights", key: "insights", width: 90, render: (_: unknown, v: DashboardView) => count(v.insights) },
  ];
  const outliers = (info?.views || []).reduce((n, v) => n + v.outliers, 0);
  const insights = (info?.views || []).reduce((n, v) => n + v.insights, 0);

  const embedSrc = info?.url ? embedUrlOf(info.url) : null;
  const embedding = !!embedSrc && !embedFailed;
  const canEditLocation = !!info && info.url_source !== "case";

  const picture = info?.has_image ? (
    <a href={`${base}/image`} target="_blank" rel="noopener noreferrer" title="Open the picture at full size">
      <img
        src={`${base}/image`}
        alt={`The dashboard ${info.name}`}
        style={{
          display: "block", maxWidth: "100%", height: "auto", marginBottom: 16,
          border: "1px solid var(--color-border-default, #d9d9d9)", borderRadius: 4,
        }}
      />
    </a>
  ) : (
    <div style={{ marginBottom: 16 }}>
      <Text type="secondary">This test case has no picture of its dashboard.</Text>
    </div>
  );

  const locationForm = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        saveLocation(draft.trim());
      }}
      style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}
    >
      <label htmlFor="dashboard-location" style={{ flex: "1 1 100%" }}>
        <Text type="secondary">
          {info?.url
            ? "Where this dashboard is published"
            : "This test case does not record where its dashboard is published. Paste the dashboard's address on your Tableau Server, Tableau Cloud site or Tableau Public to see it live here. The tool remembers the address for this dashboard."}
        </Text>
      </label>
      <Input
        id="dashboard-location"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="https://your-server/#/site/your-site/views/Workbook/Dashboard"
        style={{ flex: "1 1 320px" }}
        disabled={saving}
      />
      <Button type="primary" htmlType="submit" loading={saving} disabled={!draft.trim()}>
        Save
      </Button>
      {info?.url && (
        <Button onClick={() => { setEditing(false); setDraft(""); setSaveError(null); }} disabled={saving}>
          Cancel
        </Button>
      )}
      {info?.url && info.url_source === "saved" && (
        <Button onClick={() => saveLocation("")} disabled={saving}>
          Forget Address
        </Button>
      )}
      {saveError && (
        <Text type="danger" style={{ flex: "1 1 100%" }} role="alert">
          {saveError}
        </Text>
      )}
    </form>
  );

  return (
    <Drawer
      open={!!dashboard}
      onClose={onClose}
      placement="right"
      width="min(1280px, 94vw)"
      title={`Dashboard: ${info?.title || info?.name || dashboard?.name || ""}`}
    >
      {error ? (
        <Text type="danger">{error}</Text>
      ) : !info ? (
        <div style={{ padding: "32px 0", textAlign: "center" }} aria-busy="true">
          <LoadingOutlined style={{ fontSize: 20 }} />
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            {info.title && info.title !== info.name && (
              <div style={{ marginBottom: 4 }}>
                <Text type="secondary">{`Dashboard sheet: ${info.name}`}</Text>
              </div>
            )}
            <Text type="secondary">
              {`${info.views.length} view${info.views.length === 1 ? "" : "s"} · ${outliers} outlier${outliers === 1 ? "" : "s"} · ${insights} insight${insights === 1 ? "" : "s"}. `}
              {embedding
                ? `The dashboard is shown live from ${hostOf(embedSrc!)}. The test case sends the server a picture of it and the outliers and insights Tableau detected in each view; the server does not query the dashboard's data or this embedded view.`
                : "This is the dashboard as the test case sends it to the server: a picture of it, and the outliers and insights Tableau detected in each view. The server does not query the dashboard's data."}
            </Text>
            {info.url && (
              <div style={{ marginTop: 6, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                <a href={info.url} target="_blank" rel="noopener noreferrer">
                  Open the dashboard{info.source ? ` (${info.source})` : ""}
                </a>
                {canEditLocation && !editing && (
                  <Button
                    type="link"
                    size="small"
                    onClick={() => { setDraft(info.url || ""); setEditing(true); }}
                    style={{ padding: 0 }}
                  >
                    Change Address
                  </Button>
                )}
              </div>
            )}
          </div>

          {(editing || (canEditLocation && !info.url)) && locationForm}

          {embedFailed && (
            <div style={{ marginBottom: 12 }} role="status">
              <Text type="warning">
                {`The dashboard could not be shown here: ${embedFailed} `}
                {`If it is on your Tableau Server, sign in to ${hostOf(embedSrc || info.url || "")} in this browser and open the dashboard again. The picture from the test case is shown instead.`}
              </Text>
            </div>
          )}
          {info.url && !embedSrc && (
            <div style={{ marginBottom: 12 }} role="status">
              <Text type="secondary">
                The recorded address is not a link to a view, so the picture from the test case is shown. A view
                link ends in /views/&lt;workbook&gt;/&lt;dashboard&gt;.
              </Text>
            </div>
          )}

          {embedding ? (
            // The live dashboard is the whole story: no table of views under it.
            <div
              style={{
                position: "relative",
                border: "1px solid var(--color-border-default, #d9d9d9)", borderRadius: 4, overflow: "hidden",
              }}
            >
              {!embedReady && (
                <div
                  style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}
                  aria-busy="true"
                >
                  <LoadingOutlined style={{ fontSize: 20 }} />
                </div>
              )}
              <TableauViz src={embedSrc!} height={embedHeight()} onError={onEmbedError} onReady={onEmbedReady} />
            </div>
          ) : (
            <>
              {picture}
              <Table<DashboardView>
                className="dataset-fields"
                columns={columns}
                dataSource={info.views}
                rowKey={(v: DashboardView) => v.name}
                size="small"
                pagination={false}
                locale={{ emptyText: "The test case lists no views" }}
              />
            </>
          )}
        </>
      )}
    </Drawer>
  );
};
