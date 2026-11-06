/**
 * The side panel behind a name in the results table's Datasource column:
 * the dataset as the model is shown it. The public suites ship each dataset
 * as a list of fields (role, type, description, sample values), not as rows,
 * so that list is what the panel shows.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Button, Drawer, Input, Table, Typography } from "./ui";
import type { ColumnsType } from "./ui";
import { LoadingOutlined, SearchOutlined } from "./ui/icons";
import { API_BASE } from "./api";

const { Text } = Typography;

export interface DatasetInfo {
  id: string;
  name: string;
  field_count: number;
}

interface DatasetField {
  /** Set where a name alone is not unique (a flow with several input steps). */
  key?: string;
  name: string;
  description: string;
  role: string;
  datatype: string;
  default_aggregation: string;
  distinct_count: number | null;
  sample_values: unknown[];
  value_count: number;
}

interface ExtractRowsPage {
  columns: Array<{ name: string; type: string }>;
  rows: Array<Array<string | null>>;
  total: number;
  limit: number;
}

interface Dataset {
  id: string;
  name: string;
  /** What this data is, where it is not a dataset of the public pack: a
   *  Tableau Prep flow, or the step data a flow-plan case shows the model. */
  note?: string;
  /** The extract ships with the tool, so its first rows can be shown. */
  has_rows?: boolean;
  fields: DatasetField[];
}

/** The datasets that can be opened, by the id the Datasource column shows.
 *  Empty when the server has none to offer; the names then stay plain text. */
export function useDatasets(): Record<string, DatasetInfo> {
  const [datasets, setDatasets] = useState<Record<string, DatasetInfo>>({});
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/nlq-eval/datasets`)
      .then((r) => (r.ok ? r.json() : { datasets: [] }))
      .then((body) => {
        if (cancelled) return;
        const next: Record<string, DatasetInfo> = {};
        for (const d of body.datasets || []) next[d.id] = d;
        setDatasets(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return datasets;
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "—");

export const DatasetPanel: React.FC<{
  /** The dataset to show; null closes the panel. */
  datasetId: string | null;
  onClose: () => void;
}> = ({ datasetId, onClose }) => {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    setDataset(null);
    setError(null);
    setSearch("");
    if (!datasetId) return undefined;
    let cancelled = false;
    fetch(`${API_BASE}/nlq-eval/datasets/${encodeURIComponent(datasetId)}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "This dataset is not part of the public test content." : `HTTP ${r.status}`);
        return r.json();
      })
      .then((body) => {
        if (!cancelled) setDataset(body);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [datasetId]);

  // The first rows of the extract, on request (Questions about a dashboard only).
  const [rows, setRows] = useState<ExtractRowsPage | null>(null);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [rowsLoading, setRowsLoading] = useState(false);
  useEffect(() => { setRows(null); setRowsError(null); setRowsLoading(false); }, [datasetId]);
  const loadRows = () => {
    if (!datasetId) return;
    setRowsLoading(true);
    setRowsError(null);
    fetch(`${API_BASE}/nlq-eval/datasets/${encodeURIComponent(datasetId)}/rows?limit=50`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
        return body as ExtractRowsPage;
      })
      .then(setRows)
      .catch((e) => setRowsError(e.message))
      .finally(() => setRowsLoading(false));
  };

  const fields = useMemo(() => {
    const all = dataset?.fields || [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((f) =>
      [f.name, f.description, f.role, f.datatype].some((v) => (v || "").toLowerCase().includes(q)),
    );
  }, [dataset, search]);

  const columns: ColumnsType<DatasetField> = [
    {
      title: "Field",
      key: "name",
      width: 220,
      render: (_: unknown, f: DatasetField) => (
        <div>
          <Text strong>{f.name}</Text>
          {/* Many fields are described by their own name; that is not repeated. */}
          {f.description && f.description !== f.name && (
            <div style={{ fontSize: 12 }}>
              <Text type="secondary">{f.description}</Text>
            </div>
          )}
        </div>
      ),
    },
    // Tableau Prep data has no dimension or measure roles; the column is
    // left out rather than shown empty.
    ...((dataset?.fields || []).some((f) => f.role)
      ? [{ title: "Role", key: "role", width: 100, render: (_: unknown, f: DatasetField) => capitalize(f.role) }]
      : []),
    { title: "Data type", key: "datatype", width: 100, render: (_: unknown, f: DatasetField) => capitalize(f.datatype) },
    {
      title: "Sample values",
      key: "values",
      render: (_: unknown, f: DatasetField) =>
        f.sample_values.length ? (
          <span style={{ overflowWrap: "anywhere" }}>
            {f.sample_values.map((v) => String(v)).join(", ")}
            {f.value_count > f.sample_values.length && (
              <Text type="secondary">{` and ${f.value_count - f.sample_values.length} more`}</Text>
            )}
          </span>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
  ];

  return (
    <Drawer
      open={!!datasetId}
      onClose={onClose}
      placement="right"
      width="min(820px, 94vw)"
      title={dataset ? `Data Source: ${dataset.name}` : "Data Source"}
    >
      {error ? (
        <Text type="danger">{error}</Text>
      ) : !dataset ? (
        <div style={{ padding: "32px 0", textAlign: "center" }} aria-busy="true">
          <LoadingOutlined style={{ fontSize: 20 }} />
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <Text type="secondary">
              {`${dataset.id} · ${dataset.fields.length} fields. `}
              {dataset.note ||
                "This is the dataset as the model is shown it for these test cases: each field with its role, " +
                  "data type, description and sample values. The test content does not include the dataset's rows."}
            </Text>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
            <Input
              placeholder="Search fields"
              prefix={<SearchOutlined />}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              allowClear
              style={{ width: 260 }}
            />
            <Text type="secondary">
              {fields.length === dataset.fields.length ? `${fields.length} fields` : `${fields.length} of ${dataset.fields.length} fields`}
            </Text>
          </div>
          <Table<DatasetField>
            className="dataset-fields"
            columns={columns}
            dataSource={fields}
            rowKey={(f: DatasetField) => f.key || f.name}
            size="small"
            pagination={false}
            locale={{ emptyText: "No field matches the search" }}
          />
          {dataset.has_rows && (
            <div style={{ marginTop: 16 }}>
              {!rows && (
                <Button size="small" onClick={loadRows} loading={rowsLoading} disabled={rowsLoading}>
                  Show the First 50 Rows
                </Button>
              )}
              {rowsError && <div style={{ marginTop: 8 }}><Text type="danger">{rowsError}</Text></div>}
              {rows && (
                <div>
                  <Text type="secondary" style={{ display: "block", marginBottom: 8 }}>
                    {`The first ${rows.rows.length.toLocaleString()} of ${rows.total.toLocaleString()} rows, as stored in the extract the questions are asked about.`}
                  </Text>
                  <div className="dataset-rows">
                    <table>
                      <thead>
                        <tr>{rows.columns.map((c) => <th key={c.name} title={c.type}>{c.name}</th>)}</tr>
                      </thead>
                      <tbody>
                        {rows.rows.map((r, i) => (
                          <tr key={i}>{r.map((cell, j) => <td key={j}>{cell === null ? <Text type="secondary">NULL</Text> : cell}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Drawer>
  );
};
