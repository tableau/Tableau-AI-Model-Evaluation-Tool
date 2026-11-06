/**
 * Home page: what the tool does, an "Evaluation Setup" panel with the three steps
 * to a result (connect, judge, evaluate) showing their live state, and one
 * card per Tableau AI feature listing its capabilities and every evaluation
 * run against it.
 *
 * Configuration is edited in place: the connection and the judge each open
 * a right-side drawer from their step card (there is no header settings
 * button, UX review 2026-09-24). A passing connection test saves the
 * connection — one "Test and save" button, not a test and a separate save
 * that was easy to miss.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Alert, Button, Card, Collapse, Divider, Drawer, Form, Input, message,
  Popconfirm, Popover, Progress, Select, Space, Switch, Table, Tabs, Tag,
  Tooltip, Typography,
} from './ui';
import {
  CaretRightOutlined, CheckCircleFilled, DeleteOutlined, DownloadOutlined,
  PauseOutlined, QuestionCircleOutlined, StopOutlined,
} from './ui/icons';

import { API_BASE } from './api';
import { parseTableauConnectionUrl } from './tableauConnectionUrl';
import { EvaluationFeedback } from './EvaluationFeedback';
import { PRIMARY_COLOR, DANGER_COLOR } from './components/designSystem';
import { TDS } from './tdsTheme';
import { isDevMode } from './devMode';
import { fetchVisibleRuns } from './runVisibility';
import { ACTIVE_STATUSES, RUNNING_STATUSES, runStatusInfo, isResumableRun, StatusCell } from './runStatus';
import { CATEGORIES, FEATURES, categoryOfRun, featureOfRun, featureOfSuite } from './featureGroups';
import { SCOPE_OPTIONS, STATUS_FILTERS } from './RunHistoryPanel';
import { getColorForLabel } from './ui';
import {
  Suite, jfetch, launchSuite, newBatchId, METRICS_BY_CAPABILITY,
} from './launch';
import {
  Evaluation, RunRecord, groupEvaluations, latestEvaluation, latestFinished, publicFullSuite,
} from './evaluationGroups';
import { BaselineLegend, BaselineLookup, HeadlineScores } from './headlineScores';
import { useTour } from './tour/TourContext';
import { TOUR_FEATURE, TOUR_TARGETS, TourTargetId } from './tour/tourConfig';
import { providerLabel } from './providers';
import { useObservedRunRecords } from './useNlqEvalStream';

const { Text } = Typography;

interface JudgeSettings {
  configured: boolean;
  provider?: string;
  model?: string;
  api_key?: string;
  model_under_test_family?: string;
  /** The evaluated model's family, as the last connection test saw the site's gateway answer. */
  evaluated_model_family?: string | null;
  /** The evaluator model shares a family with the evaluated model. */
  same_family_warning?: boolean;
}

/** One stage of the preflight ladder (server → sign-in → generations). */
interface PreflightStage {
  ok: boolean;
  message: string;
  reason?: string;
  product_version?: string | null;
  /** The release as the admin knows it ("2025.3"), and whether it has the
   *  AI endpoint; null for a development build, which does not say. */
  release?: string | null;
  release_supported?: boolean | null;
  /** What the gateway's model answered when asked to name itself, and the
   *  family we could read out of it. Self-reported: the endpoint does not
   *  report which model served a request and the site's AI settings are not
   *  exposed over REST, so this is the only signal available. */
  model_reply?: string | null;
  model_family?: string | null;
  /** Set when Site Settings names one family and the gateway answers as another. */
  family_mismatch?: { site_settings: string; gateway_answered: string } | null;
}

/** The site's configured AI models, read from Site Settings (REST 3.31). */
interface PreflightSite {
  models?: Array<{ label: string; model: string; under_test?: boolean }>;
  model_under_test?: string | null;
  provider?: string | null;
  gateway_url?: string | null;
  auth_mode?: string | null;
  /** The site runs Tableau's default models (Tableau Cloud without a custom model). */
  default_models?: boolean;
}

/** The connected server's release is earlier than 2026.3, the first with the
 *  AI endpoint: the connection works (and publishing with it), evaluating does not. */
interface ServerTooOld {
  release: string | null;
  min_release: string;
  message: string;
}

interface PreflightResult {
  ok: boolean;
  /** Reached and signed in, whatever the AI endpoint said. */
  connection_ok?: boolean;
  server_too_old?: ServerTooOld | null;
  server: PreflightStage;
  session: PreflightStage;
  generations: PreflightStage;
  site?: PreflightSite;
  /** Tableau Agent in Dashboards on the site: on, off, or unknown. Never fails the connection. */
  dashboard_qa?: PreflightStage & { enabled?: boolean | null };
  /** Tableau Agent in Authoring (web authoring) on the site: on, off, or unknown. Never fails the connection. */
  web_authoring?: PreflightStage & { enabled?: boolean | null };
}

/** One Connection Details line for a site switch the suites depend on. */
function SiteSwitchLine({ stage, label }: { stage?: PreflightStage & { enabled?: boolean | null }; label: string }) {
  if (!stage || stage.reason === 'skipped') return null;
  const on = Boolean(stage.enabled && stage.ok);
  return (
    <div style={{ marginBottom: 4 }}>
      <Tag color={on ? 'success' : stage.enabled === false || !stage.ok ? 'warning' : 'default'}>
        {on ? 'On' : stage.enabled ? 'On, service failing' : stage.enabled === false ? 'Off' : 'Unknown'}
      </Tag>
      <Text style={{ fontSize: 12 }}>{label}</Text>
      {!on && (
        <div style={{ fontSize: 12, marginLeft: 4 }}>
          <Text type="secondary">{stage.message}</Text>
        </div>
      )}
    </div>
  );
}

/** The site settings the suites depend on, with the suites each one gates. */
const SITE_SWITCHES: Array<{ key: 'dashboard_qa' | 'web_authoring'; setting: string; suites: string }> = [
  { key: 'dashboard_qa', setting: 'Tableau Agent in Dashboards', suites: 'Dashboard Narratives' },
  { key: 'web_authoring', setting: 'Tableau Agent in Authoring', suites: 'Build a visualization, Calculated fields and Color palettes' },
];

/** One sentence per site switch the last connection test found off, naming
 *  the suites it keeps out. A build that lacks the endpoint altogether (a
 *  reason other than the switch) keeps the test's own sentence. Read from a
 *  fresh test result or from the stored last test, which carry the same keys. */
function siteSwitchNotes(result: Partial<Record<'dashboard_qa' | 'web_authoring', (PreflightStage & { enabled?: boolean | null }) | undefined>>): string[] {
  return SITE_SWITCHES.flatMap(({ key, setting, suites }) => {
    const stage = result[key];
    if (!stage || stage.enabled !== false) return [];
    const settingOff = !stage.reason || stage.reason === 'site_setting_off';
    return [settingOff ? `${setting} is off, so ${suites} can't run.` : stage.message];
  });
}

/** What the tool publishes for a Questions about a dashboard suite, and whether it did (GET /nlq-eval/dashboard-content). */
interface SampleContentEntry {
  project: string;
  workbook: string;
  dashboard: string;
  datasources: string[];
  files_present: boolean;
  published: boolean;
  ids: { workbook_luid?: string; datasources?: Array<{ luid: string; name: string }> };
}
interface SampleContentStatus {
  configured: boolean;
  server_url: string;
  site: string;
  suites: Record<string, SampleContentEntry>;
}

const PREFLIGHT_STAGES: Array<['server' | 'session' | 'generations', string]> = [
  ['server', 'Server reachable'],
  ['session', 'PAT sign-in'],
  ['generations', 'AI endpoint'],
];

/** What the tool says when a site runs Tableau's default models and names none. */
const DEFAULT_MODELS_LABEL = "Tableau's default model (Site Settings names no custom model)";

/**
 * Connection result as a card: the headline answers "can I run, and against
 * what model", and everything else — per-stage detail, the other model slots,
 * the gateway — sits behind a disclosure so the common case stays scannable.
 */
const PreflightReport: React.FC<{ result: PreflightResult }> = ({ result }) => {
  const site = result.site;
  const underTest = site?.models?.find((m) => m.under_test);
  const failed = PREFLIGHT_STAGES.filter(([k]) => !result[k].ok && result[k].reason !== 'skipped');
  const tooOld = result.server_too_old || null;

  const stageLines = PREFLIGHT_STAGES.map(([key, label]) => {
    const stage = result[key];
    const skipped = !stage.ok && stage.reason === 'skipped';
    return (
      <div key={key} style={{ marginBottom: 4 }}>
        <Tag color={stage.ok ? 'success' : skipped ? 'default' : 'error'}>
          {stage.ok ? 'Passed' : skipped ? 'Skipped' : 'Failed'}
        </Tag>
        <Text style={{ fontSize: 12 }}>{label}</Text>
        {/* Skipped stages show their message too: a bare "skipped" tag read as
            "nothing wrong here" and hid the fact that an earlier stage failed
            (bug-bash B-3). The backend says which stage blocked this one. */}
        {!stage.ok && (
          <div style={{ fontSize: 12, marginLeft: 4 }}>
            <Text type="secondary">{stage.message}</Text>
          </div>
        )}
      </div>
    );
  });

  // The tag answers one question, whether the server was reached and signed
  // in. What the site lets the suites do (its settings, its AI gateway) is
  // said in the alerts below, not folded into the tag (decision of 2026-11-04:
  // "Connected, AI endpoint off" read as a broken connection).
  const connected = Boolean(result.connection_ok ?? result.ok);
  const switchNotes = siteSwitchNotes(result);
  const aiFailed = connected && !tooOld && !result.generations.ok && result.generations.reason !== 'skipped';

  return (
    <Card size="small" style={{ marginTop: 12 }}>
      <Space align="center">
        <Tag color={connected ? 'success' : 'error'}>{connected ? 'Connected' : 'Not connected'}</Tag>
        {connected && !tooOld && result.server.product_version && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            Tableau {result.server.product_version}
          </Text>
        )}
        {tooOld && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            Tableau {tooOld.release || result.server.product_version || '(release not reported)'}, needs {tooOld.min_release} or later
          </Text>
        )}
        {!connected && failed.length > 0 && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {failed[0][1]} failed, see Connection Details
          </Text>
        )}
      </Space>

      {switchNotes.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 8 }}
          message="Site settings needed for evaluations"
          description={
            <div>
              <div>Evaluating a feature needs its site setting turned on. On this site:</div>
              {switchNotes.map((note) => (
                <div key={note}>· {note}</div>
              ))}
              <div style={{ marginTop: 4 }}>
                A site administrator turns a setting on in Site Settings › AI in Tableau; then test the connection again.
              </div>
            </div>
          }
        />
      )}

      {aiFailed && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 8 }}
          message="The site's AI endpoint failed its test"
          description={
            <div>
              <div>{result.generations.message}</div>
              <div style={{ marginTop: 4 }}>
                Evaluations can still be started. Their requests go through the same site gateway, so they may fail the same way until it answers.
              </div>
            </div>
          }
        />
      )}

      {tooOld && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 8 }}
          message="This server can't run evaluations"
          description={tooOld.message}
        />
      )}

      {underTest && (
        <div style={{ marginTop: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>Evaluated model</Text>
          <div>
            <Text code style={{ fontSize: 13 }}>{underTest.model}</Text>
          </div>
        </div>
      )}
      {!underTest && site?.default_models && (
        <div style={{ marginTop: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>Evaluated model</Text>
          <div>
            <Text style={{ fontSize: 13 }}>{DEFAULT_MODELS_LABEL}</Text>
          </div>
        </div>
      )}

      {result.generations.family_mismatch && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 8 }}
          message="Gateway does not match Site Settings"
          description={`Site Settings names ${result.generations.family_mismatch.site_settings}, but the gateway reported a ${result.generations.family_mismatch.gateway_answered} model. Results would be attributed to the wrong model.`}
        />
      )}

      {/* Detail on demand: stage-by-stage and the rest of the AI config. */}
      <Collapse
        ghost
        size="small"
        style={{ marginTop: 4, marginLeft: -12 }}
        items={[
          {
            key: 'detail',
            label: <Text style={{ fontSize: 12 }}>Connection Details</Text>,
            children: (
              <div style={{ fontSize: 12 }}>
                {stageLines}
                <SiteSwitchLine stage={result.dashboard_qa} label="Tableau Agent in Dashboards" />
                <SiteSwitchLine stage={result.web_authoring} label="Tableau Agent in Authoring" />
                {site?.models?.length ? (
                  <div style={{ marginTop: 8 }}>
                    <Text strong style={{ fontSize: 12 }}>Site AI Configuration</Text>
                    {site.models.map((m) => (
                      <div key={m.label} style={{ marginTop: 3 }}>
                        <Text type="secondary">{m.label}: </Text>
                        <Text code>{m.model}</Text>
                        {m.under_test && (
                          <Tag color="blue" style={{ marginLeft: 6, fontSize: 10, lineHeight: '16px' }}>
                            Under test
                          </Tag>
                        )}
                      </div>
                    ))}
                    {site.provider && (
                      <div style={{ marginTop: 3 }}>
                        <Text type="secondary">Provider: </Text>
                        <Text>{site.provider}</Text>
                      </div>
                    )}
                    {site.gateway_url && (
                      <div style={{ marginTop: 3, wordBreak: 'break-all' }}>
                        <Text type="secondary">Gateway: </Text>
                        <Text>{site.gateway_url}</Text>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            ),
          },
        ]}
      />
    </Card>
  );
};


/** A count with thousands separators: 1,006 of 1,160. */
const fmtCount = (n: number | null | undefined): string => (n || 0).toLocaleString('en-US');

/** Host of a server URL, for compact display. */
const hostOf = (url: string | undefined): string => {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const minutesOf = (seconds: number): number => Math.max(1, Math.round(seconds / 60));

/** A running time in words: "about 5 min", "about 2 h 10 min". */
const durationText = (seconds: number): string => {
  const mins = minutesOf(seconds);
  if (mins < 60) return `about ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `about ${h} h ${m} min` : `about ${h} h`;
};

/** A task clause ("writes a formula from a request") as the start of a tooltip. */
const sentence = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * One step of the Evaluation Setup, in the idiom of the Tableau AI settings
 * page's "Quick ways to get started" cards. The three cards share one row
 * grid (CSS subgrid, see .quick-start-card): title, description, details,
 * progress and footer sit on the same lines in every card, whatever each
 * card holds.
 */
const StepCard: React.FC<{
  n: number;
  title: string;
  /** A tag beside the title, e.g. "Optional". */
  tag?: string;
  description: string;
  done: boolean;
  /** What the step has set up: label / value rows. */
  details?: Array<{ label: string; value: React.ReactNode }>;
  /** Progress bar under the details, 0-100. */
  percent?: number;
  action?: { label: string; onClick: () => void; disabled?: boolean; primary?: boolean; tooltip?: string };
  /** The guided tour's name for this card. */
  tourTarget?: TourTargetId;
}> = ({ n, title, tag, description, done, details, percent, action, tourTarget }) => (
  <div
    className={done ? 'tui-card quick-start-card quick-start-done' : 'tui-card quick-start-card'}
    data-tour={tourTarget}
  >
    <div className="quick-start-title">
      <Text type="secondary" style={{ fontSize: 12, lineHeight: '16px', fontWeight: 600, whiteSpace: 'nowrap' }}>
        {n}.
      </Text>
      <span className="tds-h3" style={{ color: done ? TDS.textSecondary : TDS.textPrimary }}>{title}</span>
      {tag && <Tag>{tag}</Tag>}
    </div>
    <Text type="secondary" className="quick-start-description">{description}</Text>
    <div className="quick-start-details">
      {(details || []).map((d) => (
        <div key={d.label} className="quick-start-detail">
          <Text type="secondary" style={{ whiteSpace: 'nowrap' }}>{d.label}:</Text>
          <Text style={{ textAlign: 'right', minWidth: 0, overflowWrap: 'anywhere' }}>{d.value}</Text>
        </div>
      ))}
    </div>
    <div className="quick-start-progress">
      {percent !== undefined && (
        <Progress percent={percent} showInfo={false} status={done ? 'success' : 'normal'} />
      )}
    </div>
    <div className="quick-start-footer">
      {action && (
        <Tooltip title={action.tooltip}>
          {/* A disabled button takes no mouse events: the span carries the hover. */}
          <span style={{ display: 'inline-block' }}>
            <Button
              size="small"
              type={action.primary ? 'primary' : 'default'}
              onClick={action.onClick}
              disabled={action.disabled}
              style={action.primary && !action.disabled ? { backgroundColor: PRIMARY_COLOR, borderColor: PRIMARY_COLOR } : undefined}
            >
              {action.label}
            </Button>
          </span>
        </Tooltip>
      )}
      {done && (
        <Tooltip title="Done">
          <CheckCircleFilled aria-label="Done" style={{ color: TDS.success, fontSize: 18 }} />
        </Tooltip>
      )}
    </div>
  </div>
);

/** Console idiom: label text with a (i) hover for help, not extra prose. */
const labelWithInfo = (label: string, help: string) => (
  <span>
    {label}{' '}
    <Tooltip title={help}>
      <QuestionCircleOutlined style={{ color: '#999' }} />
    </Tooltip>
  </span>
);

/** How to mint a PAT, shown next to both PAT fields. Long-form help lives in
 *  a Popover rather than a Tooltip so it stays open while it is read and the
 *  link inside it can be clicked. */
const PAT_HELP = (
  <div style={{ maxWidth: 380, fontSize: 13, lineHeight: 1.5 }}>
    <p style={{ marginTop: 0 }}>
      A personal access token (PAT) signs the tool in to Tableau Server without
      your password.
    </p>
    <b>To create one</b>
    <ol style={{ paddingLeft: 18, margin: '4px 0' }}>
      <li>On your Tableau site, select your account icon, then My Account Settings.</li>
      <li>Under Personal Access Tokens, enter a name and select Create Token.</li>
      <li>Select Copy Secret and save it. The secret is shown only once.</li>
    </ol>
    <p style={{ margin: '4px 0' }}>
      Enter the token name exactly as Tableau shows it after creation. Tokens
      expire after one year; revoke one from the same screen. If multi-factor
      authentication is on, a PAT is required.
    </p>
    <a
      href="https://help.tableau.com/current/pro/desktop/en-us/useracct.htm"
      target="_blank"
      rel="noopener noreferrer"
    >
      Learn more
    </a>
  </div>
);

/** Field label with a keyboard-reachable help affordance beside it. */
const labelWithHelp = (label: React.ReactNode, help: React.ReactNode) => (
  <span>
    {label}{' '}
    <Popover content={help} trigger={['hover', 'focus', 'click']} placement="rightTop">
      <span
        role="button"
        tabIndex={0}
        aria-label="How to create a personal access token"
        style={{ cursor: 'help' }}
      >
        <QuestionCircleOutlined style={{ color: '#999' }} />
      </span>
    </Popover>
  </span>
);

/** Whether the Evaluation Setup panel is open is remembered per browser. */
const QUICK_START_KEY = 'ai_eval_quickstart_open';
const readQuickStart = (): boolean | null => {
  try {
    const v = window.localStorage.getItem(QUICK_START_KEY);
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
};

const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const [suites, setSuites] = useState<Suite[] | null>(null);
  const [listedRuns, setRuns] = useState<RunRecord[] | null>(null);
  const observedRuns = useObservedRunRecords(listedRuns || []);
  const runs = listedRuns ? observedRuns : null;
  const [judge, setJudge] = useState<JudgeSettings>({ configured: false });
  // The two edit drawers, each opened from its Evaluation Setup step.
  const [connOpen, setConnOpen] = useState(false);
  const [judgeOpen, setJudgeOpen] = useState(false);
  // Older links (and the guide) arrive with ?settings=open: open the
  // connection drawer and drop the flag from the URL, keeping ?dev=1.
  const location = useLocation();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('settings') !== 'open') return;
    setConnOpen(true);
    params.delete('settings');
    const rest = params.toString();
    navigate(rest ? `/?${rest}` : '/', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);
  // The results page sends a suite that needs its set-up (Questions about a
  // dashboard) here with ?setup=<suite id>: open its launch drawer once the
  // suites are known, and drop the flag from the URL.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const wanted = params.get('setup');
    if (!wanted || !suites) return;
    const suite = suites.find((x) => x.id === wanted);
    params.delete('setup');
    const rest = params.toString();
    navigate(rest ? `/?${rest}` : '/', { replace: true });
    if (suite) openLaunch(suite);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search, suites]);
  // The single Tableau Server connection: the customer path connects to
  // exactly one remote machine, configured once here and reused by launch,
  // preflight, and publish.
  const [tableauConn, setTableauConn] = useState<any>({ configured: false });
  const [connForm] = Form.useForm();
  const [savingConn, setSavingConn] = useState(false);
  const [launchSuiteState, setLaunchSuite] = useState<Suite | null>(null);
  // Which launch is in flight: a suite id, or `feature:<key>` for a whole
  // section. A single boolean here made every Evaluate button on the page
  // show a spinner while one suite was starting.
  const [launchingKey, setLaunchingKey] = useState<string | null>(null);
  const launching = launchingKey !== null;
  const [launchFeedback, setLaunchFeedback] = useState<string | undefined>();
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [preflightRunning, setPreflightRunning] = useState(false);
  // Sample content for Questions about a dashboard: null until the status
  // endpoint answers with the shape this page expects (an older backend
  // answers the SPA page instead).
  const [sampleContent, setSampleContent] = useState<SampleContentStatus | null>(null);
  const [sampleContentLoaded, setSampleContentLoaded] = useState(false);
  const [publishingContent, setPublishingContent] = useState<string | null>(null);
  const isSampleContentStatus = (b: any): b is SampleContentStatus =>
    Boolean(b) && typeof b.configured === 'boolean' && b.suites && typeof b.suites === 'object';
  const refreshSampleContent = useCallback(() => {
    jfetch('/nlq-eval/dashboard-content')
      .then((b) => setSampleContent(isSampleContentStatus(b) ? b : null))
      .catch(() => setSampleContent(null))
      .finally(() => setSampleContentLoaded(true));
  }, []);
  const publishSampleContent = async (suite: Suite) => {
    if (!suite.content && !suite.parts?.length) return;
    setPublishingContent(suite.id);
    try {
      // A combined suite publishes every part's content in one request.
      const target = suite.parts?.length ? suite.id : suite.content!;
      await jfetch(`/nlq-eval/dashboard-content/${encodeURIComponent(target)}/publish`, { method: 'POST' });
      message.success(`Published the sample content for ${suite.label}`);
      refreshSampleContent();
    } catch (e: any) {
      message.error(e.message);
    }
    setPublishingContent(null);
  };
  // The suites the launch drawer can switch between: the public suites of the
  // open suite's capability (Questions about a dashboard has one per sample
  // dashboard; most capabilities have one).
  const siblingSuites: Suite[] = launchSuiteState
    ? (suites || []).filter(
        (x) => x.capability === launchSuiteState.capability && x.visibility === 'public' && !x.ui_hidden && x.available,
      )
    : [];
  // A Questions about a dashboard suite publishes its sample dashboard itself when
  // the evaluation starts; only missing sample files hold it back.
  const contentFilesPresent = (s: Suite): boolean =>
    s.adapter !== 'cabu'
    || (s.parts?.length
      ? s.parts.every((p) => !p.content || (sampleContent?.suites?.[p.content]?.files_present ?? true))
      : !s.content || (sampleContent?.suites?.[s.content]?.files_present ?? true));
  const launchContentReady = !launchSuiteState || contentFilesPresent(launchSuiteState);
  const [judgeForm] = Form.useForm();
  const [runForm] = Form.useForm();
  // In the customer path the server resolves the model from Site Settings
  // (the Viz & Calc generation setting) and ignores any model named in the
  // request — by design. The override only applies to direct-gateway runs,
  // which exist only behind the dev flag (?dev=1 / localStorage ai_eval_dev).
  const devMode = useMemo(() => isDevMode(), []);
  const generationsMode = Form.useWatch('generations_mode', runForm);
  const cesMode = !devMode || generationsMode === 'ces';

  // Server-declared UI capabilities. `allowSelfSigned` is true when the server
  // was started with `tableau-ai-eval serve --allow-self-signed` (or
  // TABLEAU_AI_EVAL_ALLOW_SELF_SIGNED=1); it surfaces the TLS controls in normal mode so
  // an on-prem server with a self-signed cert is reachable without the dev flag.
  const [uiCaps, setUiCaps] = useState<{ allowSelfSigned: boolean; devMode: boolean }>({
    allowSelfSigned: false,
    devMode: false,
  });
  // The TLS controls (verify toggle, CES base URL) show when the dev flag is set
  // OR the server was launched with --allow-self-signed.
  const showTls = devMode || uiCaps.allowSelfSigned;
  // Watched so the "verify off" warning re-renders as the toggle flips.
  const connVerifyTls = Form.useWatch('verify_tls', connForm);
  const selectedProvider = Form.useWatch('provider', judgeForm);


  const runsLoading = useRef(false);
  const refreshRuns = useCallback(() => {
    if (runsLoading.current) return;
    runsLoading.current = true;
    fetchVisibleRuns().then((r) => setRuns(r as RunRecord[])).catch(() => {})
      .finally(() => { runsLoading.current = false; });
  }, []);

  const refreshJudge = useCallback(() => {
    jfetch('/nlq-eval/settings/judge').then(setJudge).catch(() => {});
  }, []);

  const refreshSuites = useCallback(() => {
    jfetch('/nlq-eval/suites')
      .then((b) => setSuites((b.suites || []).filter(
        (s: Suite) => !s.ui_hidden,
      )))
      .catch(() => {});
  }, []);


  const refreshConn = useCallback(() => {
    jfetch('/nlq-eval/settings/tableau').then(setTableauConn).catch(() => {});
  }, []);

  // One-time load. Suites and runs are loaded by the effect below, which also re-runs when
  // their refresh callbacks change.
  useEffect(() => {
    refreshJudge();
    jfetch('/nlq-eval/settings/ui')
      .then((caps) =>
        setUiCaps({
          allowSelfSigned: !!caps.allowSelfSigned,
          devMode: !!caps.devMode,
        }),
      )
      .catch(() => setUiCaps({ allowSelfSigned: false, devMode: false }));
    refreshConn();
    refreshSampleContent();
  }, [refreshJudge, refreshConn, refreshSampleContent]);

  useEffect(() => {
    refreshSuites();
    refreshRuns();
  }, [refreshSuites, refreshRuns]);

  // Poll history while something is running, and for half a minute after a
  // launch so the queued → started flip is seen even when the previous
  // snapshot had nothing active (a launch from the drawer did not refresh
  // at all, bug bash 2026-09-23).
  const hasActive = useMemo(
    () => (runs || []).some((r) => ACTIVE_STATUSES.includes(r.status)),
    [runs],
  );
  const [pollUntil, setPollUntil] = useState(0);
  const noteLaunch = () => setPollUntil(Date.now() + 30_000);
  useEffect(() => {
    const recentlyLaunched = Date.now() < pollUntil;
    if (!hasActive && !recentlyLaunched) return;
    const timer = setInterval(refreshRuns, 1000);
    const stop = recentlyLaunched && !hasActive
      ? setTimeout(() => setPollUntil(0), Math.max(0, pollUntil - Date.now()))
      : null;
    return () => {
      clearInterval(timer);
      if (stop) clearTimeout(stop);
    };
  }, [hasActive, pollUntil, refreshRuns]);

  useEffect(() => {
    if (judge.configured) judgeForm.setFieldsValue(judge);
  }, [judge, judgeForm]);

  useEffect(() => {
    if (tableauConn.configured) {
      connForm.setFieldsValue(tableauConn);
    } else if (uiCaps.allowSelfSigned) {
      // A brand-new connection on an --allow-self-signed server defaults verify
      // OFF (a self-signed cert would otherwise fail the test). A saved
      // connection's explicit verify_tls, set above, is respected and never
      // overridden here. The customer default (verify ON) is untouched when the
      // flag is not set.
      connForm.setFieldsValue({ verify_tls: false });
    }
  }, [tableauConn, connForm, uiCaps.allowSelfSigned]);

  const judgeReady = judge.configured;

  // ---- launch ------------------------------------------------------------

  /** Run every available suite for a feature. The worker consumes its queue
   *  one job at a time, so submitting them all runs them in sequence — no
   *  client-side chaining that a closed tab would break. */
  const runnableSuites = (featureSuites: Suite[]): Suite[] =>
    featureSuites.filter((s) =>
      s.available && s.path && s.server_supported !== false &&
      // A Questions about a dashboard suite publishes its sample content itself
      // when it starts; only missing sample files keep it out.
      contentFilesPresent(s),
    );
  /** Why the connected server cannot run these suites, when it is the server
   *  (a site setting off, a release too old) rather than this machine that
   *  keeps them out: the distinct reasons the suite list carries, else null. */
  const serverKeepsOut = (featureSuites: Suite[]): string | null => {
    const reasons = featureSuites
      .filter((s) => s.available && s.path && s.server_supported === false && s.server_message)
      .map((s) => s.server_message as string);
    return reasons.length ? Array.from(new Set(reasons)).join(' ') : null;
  };
  /** The feature's suites the connected server keeps out (a site setting off,
   *  a release too old) while others in the section still run: the Evaluate
   *  hover names them, so a batch that skips a suite says why. */
  const keptOutSuites = (featureSuites: Suite[]): Suite[] =>
    featureSuites.filter((s) => s.available && s.path && s.server_supported === false);
  /** Submit one feature's runnable suites as one batch. Returns how many
   *  were queued; the caller owns the button state and the toast. */
  const launchFeatureBatch = async (runnable: Suite[], warnings: Set<string>): Promise<number> => {
    const batchId = newBatchId();
    for (const suite of runnable) {
      setLaunchFeedback(`Submitting ${suite.label}… Waiting for the server to confirm it.`);
      // eslint-disable-next-line no-await-in-loop
      const launched = await launchSuite(suite, { judgeReady, batchId });
      launched.warnings.forEach((w) => warnings.add(w));
      noteLaunch();
      refreshRuns();
    }
    return runnable.length;
  };
  // Launching stays on this page: the feature card's live tag and View
  // Results are here, and a jump to the results page cost a click back
  // (bug bash 2026-10-23, items 3b and 8).
  const launchAll = async (featureSuites: Suite[], featureKey: string) => {
    const runnable = runnableSuites(featureSuites);
    if (!runnable.length) return;
    setLaunchingKey(`feature:${featureKey}`);
    setLaunchFeedback('Submitting evaluation… Waiting for the server to confirm it.');
    const warnings = new Set<string>();
    try {
      const n = await launchFeatureBatch(runnable, warnings);
      message.success(`Queued ${n} suite${n === 1 ? '' : 's'} — they run one after another`);
      warnings.forEach((w) => message.warning(w));
      noteLaunch();
      refreshRuns();
    } catch (e: any) {
      message.error(e.message);
    }
    setLaunchingKey(null);
    setLaunchFeedback(undefined);
  };
  /** Evaluate All: every feature's suites, one batch per feature, in the
   *  order the features are listed (bug bash 2026-10-23, items 3a and 8). A
   *  feature already in flight is left alone. */
  const startEvaluating = async () => {
    const todo = FEATURES
      .filter((f) => !(evalsByFeature.get(f.key) || []).some((e) => ACTIVE_STATUSES.includes(e.status)))
      .map((f) => ({ key: f.key, runnable: runnableSuites(suitesByFeature.get(f.key) || []) }))
      .filter((f) => f.runnable.length > 0);
    if (!todo.length) return;
    setLaunchingKey('all');
    setLaunchFeedback('Submitting evaluations… Waiting for the server to confirm them.');
    const warnings = new Set<string>();
    let queued = 0;
    try {
      for (const f of todo) {
        // eslint-disable-next-line no-await-in-loop
        queued += await launchFeatureBatch(f.runnable, warnings);
      }
      message.success(
        `Queued ${queued} suite${queued === 1 ? '' : 's'} across ${todo.length} feature${todo.length === 1 ? '' : 's'} — they run one after another`,
      );
      warnings.forEach((w) => message.warning(w));
      noteLaunch();
      refreshRuns();
    } catch (e: any) {
      message.error(e.message);
    }
    setLaunchingKey(null);
    setLaunchFeedback(undefined);
  };

  const openLaunch = (suite: Suite) => {
    runForm.setFieldsValue({
      compute_nl_judge: false,
      // Customer path: everything routes through the configured Tableau
      // Server. Direct-gateway mode exists only behind the dev flag.
      generations_mode: devMode ? 'direct' : 'ces',
    });
    setPreflight(null);
    setLaunchSuite(suite);
    if (suite.adapter === 'cabu' && suite.content) {
      runForm.setFieldsValue({ workbook_luid: undefined, datasource_luid: undefined, datasource_name: undefined });
      refreshSampleContent();
    } else if (suite.adapter === 'cabu') {
      // Offer the workbook ids the last run on this site used.
      jfetch('/nlq-eval/settings/content')
        .then((c) => { if (c.dashboard_qa) runForm.setFieldsValue(c.dashboard_qa); })
        .catch(() => undefined);
    }
  };

  const submitRun = async () => {
    const launchSuiteDef = launchSuiteState;
    if (!launchSuiteDef) return;
    const v = runForm.getFieldsValue();
    setLaunchingKey(launchSuiteDef.id);
    setLaunchFeedback('Submitting evaluation… Waiting for the server to confirm it.');
    try {
      const payload: Record<string, unknown> = {
        // Same identity as runPayloadFor, so a drawer-launched run is
        // labelled by its suite everywhere, not by the runner id.
        suite_id: launchSuiteDef.id,
        suite_label: launchSuiteDef.label,

        runner: launchSuiteDef.runner,
        ai_feature: launchSuiteDef.capability,
        test_path: launchSuiteDef.path,
        compute_nl_judge: !!v.compute_nl_judge,
      };
      if (launchSuiteDef.adapter && launchSuiteDef.adapter !== 'nlq') {
        payload.adapter = launchSuiteDef.adapter;
      }
      if (launchSuiteDef.adapter === 'cabu') {
        // Dashboard Q&A drives the server-side CABU product API: the
        // server/PAT come from the stored Tableau connection (backend
        // merge); only the content identifiers are per-run.
        if (v.workbook_luid) payload.workbook_luid = v.workbook_luid;
        if (v.datasource_luid) payload.datasource_luid = v.datasource_luid;
        if (v.datasource_name) payload.datasource_name = v.datasource_name;
      } else if (devMode && v.generations_mode !== 'ces') {
        // Dev-only direct-gateway path (custom testing / benchmarks).
        const metrics = METRICS_BY_CAPABILITY[launchSuiteDef.capability];
        if (metrics) payload.metrics_file = metrics;
        if (v.org_id) payload.org_id = v.org_id;
        if (v.gateway_url) payload.gateway_url = v.gateway_url;
        if (v.llm_key) payload.llm_key = v.llm_key;
        if (v.model) payload.models = { create: v.model };
      } else {
        // Customer path: route through the configured Tableau Server.
        // Server/site/PAT/TLS/ces_url all come from the stored connection
        // (backend merge); the model is resolved by Site Settings — never
        // send an override, only the admin's declaration for the record.
        const metrics = METRICS_BY_CAPABILITY[launchSuiteDef.capability];
        if (metrics) payload.metrics_file = metrics;
        payload.generations_mode = 'ces';
        if (v.declared_site_model) payload.declared_site_model = v.declared_site_model;
      }
      const body = await jfetch('/nlq-eval/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      noteLaunch();
      refreshRuns();
      (body.warnings || []).forEach((w: string) => message.warning(w));
      message.success(`Queued ${launchSuiteDef.label}`);
      setLaunchSuite(null);
    } catch (e: any) {
      message.error(e.message);
    }
    setLaunchingKey(null);
    setLaunchFeedback(undefined);
  };

  // ---- connection: test, and save when the test passes (UX-1) -----------

  const preflightBody = () => {
    // Prefer the connection form's values; fall back to the dev collapse's
    // per-run fields. Anything left undefined — including a masked PAT —
    // resolves from the stored connection server-side, so JSON.stringify
    // dropping undefined is the desired behavior.
    const c = connForm.getFieldsValue();
    const r = runForm.getFieldsValue();
    const patValue =
      c.pat_value && !String(c.pat_value).startsWith('****')
        ? c.pat_value
        : r.tableau_pat_value;
    const verifyTls = c.verify_tls !== undefined ? c.verify_tls : r.verify_tls;
    const server = String(c.server_url || r.tableau_server || '').trim().replace(/\/$/, '');
    // Connection-form CES URL first (dev override). Blank means the CES on
    // this Tableau Server — same derivation the backend uses.
    const cesUrl = String(c.ces_url || r.ces_url || '').trim()
      || (server ? `${server}/content-exploration` : '');
    return {
      tableau_server: c.server_url || r.tableau_server,
      tableau_site: c.site ?? r.tableau_site,
      tableau_pat_name: c.pat_name || r.tableau_pat_name,
      tableau_pat_value: patValue,
      ...(cesUrl ? { ces_url: cesUrl } : {}),
      ...(verifyTls !== undefined ? { verify_tls: verifyTls !== false } : {}),
    };
  };

  /** The connection test alone (launch drawer, dev collapse). */
  const runPreflight = async (): Promise<PreflightResult | null> => {
    setPreflightRunning(true);
    setPreflight(null);
    let result: PreflightResult | null = null;
    try {
      result = await jfetch('/nlq-eval/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(preflightBody()),
      });
      setPreflight(result);
      // The backend records this preflight result against the saved connection;
      // refresh the stored-connection view so `connReady` (derived from
      // tableauConn.last_verified.ok) updates immediately — independent of
      // whether the user clicks Save before or after Test.
      refreshConn();
    } catch (e: any) {
      message.error(e.message);
    }
    setPreflightRunning(false);
    return result;
  };

  /** Test the connection and, when all three stages pass, store it. A
   *  failed test stores nothing: saving a connection that cannot reach the
   *  server only records a broken setting. */
  const testAndSaveConn = async () => {
    const result = await runPreflight();
    // A server earlier than 2026.3 reaches and signs in but has no AI
    // endpoint. The connection is still saved: results can be published to
    // it, and the home page can then say why the suites are disabled.
    const tooOld = Boolean(result?.server_too_old && result?.connection_ok);
    // Reached and signed in, but the generic AI endpoint is off (a release
    // flag, or Tableau Cloud's LLM gateway switch): saved too. The suites
    // that need that endpoint are disabled with the reason; the others run.
    const aiOff = Boolean(result?.connection_ok && !result?.ok && !tooOld);
    if (!result?.ok && !tooOld && !aiOff) return;
    setSavingConn(true);
    try {
      await jfetch('/nlq-eval/settings/tableau', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(connForm.getFieldsValue()),
      });
      // What the site keeps the suites from doing, in the order an administrator
      // can act on it: settings first, then the AI gateway.
      const caveats = [
        ...siteSwitchNotes(result || {}),
        ...(aiOff ? ["The site's AI endpoint failed its test; see the connection card."] : []),
      ];
      if (tooOld) {
        message.warning(
          'Connection saved. This server is too old to evaluate against; results can still be published to it.',
        );
      } else if (caveats.length) {
        message.warning(`Connection saved. ${caveats.join(' ')} The other suites can run.`);
      } else {
        message.success('Connection tested and saved');
      }
      refreshConn();
      refreshSuites();
    } catch (e: any) {
      message.error(`Connection works but could not be saved: ${e.message}`);
    }
    setSavingConn(false);
  };

  // ---- judge -------------------------------------------------------------

  const saveJudge = async () => {
    try {
      const v = judgeForm.getFieldsValue();
      await jfetch('/nlq-eval/settings/judge', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(v),
      });
      message.success('Evaluator model saved');
      refreshJudge();
      setJudgeOpen(false);
    } catch (e: any) {
      message.error(e.message);
    }
  };

  // ---- run actions -------------------------------------------------------

  const runAction = async (path: string, ok: string) => {
    try {
      await jfetch(path, { method: 'POST' });
      message.success(ok);
    } catch (e: any) {
      message.error(e.message);
    }
    refreshRuns();
  };

  /** Delete every run of an evaluation (one, or a whole Evaluate all). */
  const deleteEvaluation = async (ev: Evaluation) => {
    let removed = 0;
    for (const r of ev.runs) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await jfetch(`/nlq-eval/results/${r.job_id}`, { method: 'DELETE' });
        removed += 1;
      } catch (e: any) {
        message.error(e.message);
      }
    }
    if (removed) message.success(removed === 1 ? 'Run deleted' : `Deleted ${removed} runs`);
    refreshRuns();
  };

  // ---- feature sections --------------------------------------------------

  const suitesByFeature = useMemo(() => {
    const m = new Map<string, Suite[]>();
    for (const s of suites || []) {
      const k = featureOfSuite(s);
      m.set(k, [...(m.get(k) || []), s]);
    }
    return m;
  }, [suites]);

  const evalsByFeature = useMemo(() => {
    const byFeature = new Map<string, RunRecord[]>();
    for (const r of runs || []) {
      const k = featureOfRun(r);
      byFeature.set(k, [...(byFeature.get(k) || []), r]);
    }
    const m = new Map<string, Evaluation[]>();
    byFeature.forEach((list, k) => m.set(k, groupEvaluations(list)));
    return m;
  }, [runs]);

  const evalStatus = (e: Evaluation) =>
    runStatusInfo(e.status, {
      neverStarted: e.never_started,
      failedCases: e.failedCases,
      total: e.totalCases,
    });

  /** The status column: the evaluation's state, one word; how far it got
   *  and why it stopped are in the tooltip. */
  /** The status word for an evaluation: a clean single-suite completion is
   *  "Completed"; a batch or a run with errors keeps the fuller label. */
  const evalStatusLabel = (e: Evaluation): string => {
    const st = evalStatus(e);
    return e.status === 'finished' && !(e.isBatch || e.failedCases > 0) ? 'Completed' : st.label;
  };

  const evalStatusCell = (e: Evaluation): React.ReactNode => {
    const st = evalStatus(e);
    const label = evalStatusLabel(e);
    const progress = e.isBatch
      ? `${e.finishedSuites} of ${e.totalSuites} suites done · ${e.completedCases} of ${e.totalCases} cases`
      : `${e.completedCases} of ${e.totalCases} cases`;
    const detail = e.runs
      .map((r) => r.pause_reason || r.dominant_error || r.error)
      .find(Boolean);
    // Before the first case: what the run is doing right now, so minutes of
    // preparation are not a bare "In progress" (bug bash 2026-10-23, item 10).
    const phase = e.runs.find((r) => RUNNING_STATUSES.includes(r.status) && r.phase && !r.completed)?.phase;
    return (
      <Tooltip
        title={
          <>
            {progress}
            {e.isBatch && <><br />{e.runs.map((r) => r.suite_label || r.runner_name).join(', ')}</>}
            {phase && <><br />{phase}…</>}
            {detail && <><br />{detail}</>}
          </>
        }
      >
        <span><StatusCell icon={st.icon} label={label} /></span>
      </Tooltip>
    );
  };

  /** A suite's baseline, for colouring its scores. */
  const baselineOfSuite: BaselineLookup = useCallback((suiteId) => {
    const s = (suites || []).find((x) => x.id === suiteId);
    return s && typeof s.baseline === 'number'
      ? { baseline: s.baseline, provisional: Boolean(s.baseline_provisional) }
      : null;
  }, [suites]);

  /** A timestamp as date over time, the tables' two-line idiom. */
  const dateOverTime = (v: string | null | undefined) =>
    v ? (
      <Tooltip title={v}>
        <Space direction="vertical" size={0}>
          <Text style={{ whiteSpace: 'nowrap' }}>{v.slice(0, 10)}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{v.slice(11, 16)}</Text>
        </Space>
      </Tooltip>
    ) : (
      <Text type="secondary">—</Text>
    );

  const evaluationColumns = useMemo(() => [
    {
      title: 'Evaluated model',
      key: 'models',
      render: (_: unknown, e: Evaluation) => (
        <Space direction="vertical" size={0}>
          <Text style={{ whiteSpace: 'nowrap' }}>{e.model_name || '—'}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {[
              e.isBatch
                ? `${e.totalSuites} ${e.totalSuites === 1 ? 'suite' : 'suites'}`
                : e.runs[0].suite_label || (devMode ? e.runs[0].runner_name : null),
              e.judge_provider ? `Evaluator model: ${providerLabel(e.judge_provider)}` : 'No evaluator model',
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </Space>
      ),
    },
    {
      title: 'Test start',
      dataIndex: 'created_at',
      width: 128,
      // To the minute: the seconds are in the run's own page.
      render: (v: string) => (
        <Tooltip title={v || undefined}>
          <Text type="secondary" style={{ whiteSpace: 'nowrap' }}>{(v || '').slice(0, 16) || '—'}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'Test end',
      dataIndex: 'finished_at',
      width: 128,
      render: (v: string | null) => (
        <Tooltip title={v || undefined}>
          <Text type="secondary" style={{ whiteSpace: 'nowrap' }}>{(v || '').slice(0, 16) || '—'}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      width: 120,
      render: (_: unknown, e: Evaluation) => evalStatusCell(e),
    },
    {
      title: (
        <Tooltip title="Each capability's own averages for the run, one per measure. The color compares a score with the baseline from the default Tableau model: green at or above it, yellow up to 25 points below, red further below.">
          <span style={{ cursor: 'help' }}>Results <QuestionCircleOutlined style={{ color: '#999' }} /></span>
        </Tooltip>
      ),
      key: 'score',
      width: 236,
      // The pill's colour is the comparison with the suite's baseline; the
      // difference itself is not printed (hover a pill for its baseline).
      // No scores while the evaluation is still going (decision of 2026-10-07):
      // a number over a partial run reads as a result.
      render: (_: unknown, e: Evaluation) =>
        ACTIVE_STATUSES.includes(e.status) ? (
          <Tooltip title="Scores appear after the evaluation is complete">
            <Text type="secondary">—</Text>
          </Tooltip>
        ) : (
          <HeadlineScores scores={e.headlineScores} baselineOf={baselineOfSuite} />
        ),
    },
    {
      // A labelled link for the main action, icons for the rest, as the
      // Site Settings test-results table does. Every icon is labelled for
      // screen readers.
      title: '',
      key: 'actions',
      width: 205,
      render: (_: unknown, e: Evaluation) => {
        const live = e.runs.find((r) => RUNNING_STATUSES.includes(r.status))
          || e.runs.find((r) => isResumableRun(r))
          || e.runs.find((r) => r.status === 'queued');
        const isActive = Boolean(live && ACTIVE_STATUSES.includes(live.status));
        const isPausedRun = Boolean(live && isResumableRun(live));
        // Anything with results so far can be downloaded: finished, paused,
        // or still going. A batch offers one CSV per suite.
        const downloadable = e.runs.filter((r) => (r.completed || 0) > 0);
        const csvHref = (id: string) => `${API_BASE}/nlq-eval/export/${id}?format=csv`;
        // Fixed slots — link, download, pause/resume, cancel, delete — so
        // each icon keeps its column from row to row whatever a row offers
        // (decision of 2026-09-30: an aligned delete beats a packed one).
        return (
          <div className="row-actions" data-tour={TOUR_TARGETS.rowActions}>
            {/* A full evaluation opens on its Result Summary; a single
                suite has no summary and opens on its results. */}
            <Link to={`/results/${e.firstJobId}${e.isBatch ? '?tab=summary' : ''}`} className="row-link">View Results</Link>
            <span className="row-action-slot">
              {downloadable.length === 0 ? null : e.isBatch ? (
                <Tooltip title="Download results (.csv, one per suite)">
                <Popover
                  trigger="click"
                  placement="bottomRight"
                  content={
                    <div style={{ fontSize: 13 }}>
                      <div style={{ fontWeight: 600, marginBottom: 6 }}>Download CSV</div>
                      {downloadable.map((r) => (
                        <div key={r.job_id} style={{ marginTop: 4 }}>
                          <a href={csvHref(r.job_id)} download>
                            {r.suite_label || r.runner_name}
                          </a>
                          <Text type="secondary" style={{ fontSize: 12 }}>{` · ${r.completed || 0} cases`}</Text>
                        </div>
                      ))}
                    </div>
                  }
                >
                  <button type="button" className="row-icon" aria-label="Download results as CSV">
                    <DownloadOutlined />
                  </button>
                </Popover>
                </Tooltip>
              ) : (
                <Tooltip title="Download results (.csv)">
                  <a className="row-icon" href={csvHref(e.firstJobId)} download aria-label="Download results as CSV">
                    <DownloadOutlined />
                  </a>
                </Tooltip>
              )}
            </span>
            <span className="row-action-slot">
              {/* Pause and Resume act on the whole evaluation, like Cancel:
                  one click pauses the running suite and holds the queued
                  ones, one click resumes every paused suite in launch order
                  (decision of 2026-11-03: no more one suite at a time). */}
              {isActive && live && (
                <Tooltip title={e.isBatch ? 'Pause all suites' : 'Pause run'}>
                  <button type="button" className="row-icon" aria-label={e.isBatch ? 'Pause all suites' : 'Pause run'}
                    onClick={() => (e.isBatch
                      ? runAction(`/nlq-eval/batches/${encodeURIComponent(e.key)}/pause`, 'Pause requested for all suites')
                      : runAction(`/nlq-eval/pause/${live.job_id}`, 'Pause requested'))}>
                  <PauseOutlined />
                </button>
              </Tooltip>
              )}
              {isPausedRun && live && (
                <Tooltip title={e.isBatch ? 'Resume all paused suites' : 'Resume run'}>
                  <button type="button" className="row-icon row-icon-primary"
                    aria-label={e.isBatch ? 'Resume all paused suites' : 'Resume run'}
                    onClick={() => (e.isBatch
                      ? runAction(`/nlq-eval/batches/${encodeURIComponent(e.key)}/resume`, 'Resumed all paused suites')
                      : runAction(`/nlq-eval/resume/${live.job_id}`, 'Resumed'))}>
                  <CaretRightOutlined />
                </button>
              </Tooltip>
              )}
            </span>
            <span className="row-action-slot">
              {/* Stops the whole evaluation: every unfinished suite of a
                  batch, not just the one that happens to be running. A
                  paused run can be stopped too; a failed one has ended. */}
              {live && (isActive || live.status === 'paused') && (
                <Tooltip title={e.isBatch ? 'Cancel all suites' : 'Cancel run'}>
                  <Popconfirm
                    title={e.isBatch
                      ? 'Cancel all unfinished suites? Completed cases are kept.'
                      : 'Cancel this run? Completed cases are kept.'}
                    onConfirm={() => (e.isBatch
                      ? runAction(`/nlq-eval/batches/${encodeURIComponent(e.key)}/cancel`, 'Cancel requested for all suites')
                      : runAction(`/nlq-eval/cancel/${live.job_id}`, 'Cancel requested'))}
                  >
                    <button type="button" className="row-icon row-icon-danger"
                      aria-label={e.isBatch ? 'Cancel all suites' : 'Cancel run'}>
                      <StopOutlined />
                    </button>
                  </Popconfirm>
                </Tooltip>
              )}
            </span>
            <span className="row-action-slot">
              <Tooltip title="Delete evaluation">
                <Popconfirm
                  title={e.isBatch
                    ? `Delete this evaluation (${e.totalSuites} runs) and its results?`
                    : 'Delete this run and its results?'}
                  onConfirm={() => deleteEvaluation(e)}
                >
                  <button type="button" className="row-icon row-icon-danger" aria-label="Delete evaluation">
                    <DeleteOutlined />
                  </button>
                </Popconfirm>
              </Tooltip>
            </span>
          </div>
        );
      },
    },
  ], [devMode, suites]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Evaluation History tab: every evaluation, in the feature table's
  //      language, with a name column in front and the suites of an
  //      Evaluate all in an expandable row. ----
  const [historyScope, setHistoryScope] = useState('all');
  const [historyStatus, setHistoryStatus] = useState('all');
  const allEvaluations = useMemo(() => groupEvaluations(runs || []), [runs]);
  const historyScopeOptions = useMemo(
    () => SCOPE_OPTIONS.filter((o) => o.value === 'all' || allEvaluations.some(o.match)),
    [allEvaluations],
  );
  const historyRows = useMemo(() => {
    const scope = SCOPE_OPTIONS.find((o) => o.value === historyScope) || SCOPE_OPTIONS[0];
    const status = STATUS_FILTERS.find((o) => o.value === historyStatus) || STATUS_FILTERS[0];
    return allEvaluations.filter(scope.match).filter(status.match);
  }, [allEvaluations, historyScope, historyStatus]);
  const historyScoped = useMemo(() => {
    const scope = SCOPE_OPTIONS.find((o) => o.value === historyScope) || SCOPE_OPTIONS[0];
    return allEvaluations.filter(scope.match);
  }, [allEvaluations, historyScope]);

  /** What an evaluation is called: its suite, or the feature and suite
   *  count for an evaluation of every capability of a feature. */
  const evaluationName = (e: Evaluation): { name: string; sub: string } => {
    const feature = FEATURES.find((f) => f.key === featureOfRun(e.runs[0]));
    if (e.isBatch) {
      return {
        name: `${feature ? feature.short : 'Evaluation'} · ${e.totalSuites} ${e.totalSuites === 1 ? 'suite' : 'suites'}`,
        sub: 'All capabilities',
      };
    }
    return {
      name: e.runs[0].suite_label || categoryOfRun(e.runs[0]).label,
      sub: feature ? feature.short : '',
    };
  };

  const historyColumns = useMemo(() => [
    {
      title: 'Evaluation',
      key: 'name',
      width: 232,
      render: (_: unknown, e: Evaluation) => {
        const { name, sub } = evaluationName(e);
        return (
          <Space direction="vertical" size={0}>
            <Text strong>{name}</Text>
            {sub && <Text type="secondary" style={{ fontSize: 12 }}>{sub}</Text>}
          </Space>
        );
      },
    },
    {
      title: 'Evaluated model',
      key: 'models',
      width: 179,
      render: (_: unknown, e: Evaluation) => (
        <Space direction="vertical" size={0}>
          <Text style={{ whiteSpace: 'nowrap' }}>{e.model_name || '—'}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {e.judge_provider ? `Evaluator model: ${providerLabel(e.judge_provider)}` : 'No evaluator model'}
          </Text>
        </Space>
      ),
    },
    // Date over time, the table's two-line idiom: it leaves the results
    // column room for a capability's several averages inside the page width.
    ...evaluationColumns.slice(1).map((c: any) =>
      c.dataIndex === 'created_at' || c.dataIndex === 'finished_at'
        ? {
            ...c,
            width: 98,
            render: (v: string | null) => dateOverTime(v),
          }
        : c),
  ], [evaluationColumns, baselineOfSuite]);  // eslint-disable-line react-hooks/exhaustive-deps

  /** The suites of an Evaluate all, under its row: one line per suite on
   *  the table's own column grid (name, start, end, status, results, link),
   *  so every piece sits under its heading. */
  const historyExpanded = (e: Evaluation) => (
    <div className="history-suites">
      {e.runs.map((r) => {
        const st = runStatusInfo(r.status, { neverStarted: r.never_started, failedCases: r.failed_cases, total: r.total });
        return (
          <div key={r.job_id} className="history-suite">
            <span />
            <span><Text>{r.suite_label || categoryOfRun(r).label}</Text></span>
            <span />
            <span>{dateOverTime(r.created_at)}</span>
            <span>{dateOverTime(r.finished_at)}</span>
            <span>
              <Tooltip title={r.total ? `${fmtCount(r.completed)} of ${fmtCount(r.total)} cases` : undefined}>
                <span>
                  <StatusCell icon={st.icon} label={r.status === 'finished' && !(r.failed_cases || 0) ? 'Completed' : st.label} />
                </span>
              </Tooltip>
            </span>
            <span>
              {ACTIVE_STATUSES.includes(r.status) ? (
                <Text type="secondary">—</Text>
              ) : (
                <HeadlineScores scores={r.headline_scores} suiteId={r.suite_id} baselineOf={baselineOfSuite} />
              )}
            </span>
            <span className="row-actions">
              <Link to={`/results/${r.job_id}`} className="row-link">View Results</Link>
            </span>
          </div>
        );
      })}
    </div>
  );

  // A percentage width collapses to an unusable sliver on small screens and
  // leaves the connection form cramped on large ones. Clamp to a readable
  // band, but never wider than the viewport itself.
  const drawerWidth = Math.min(
    520,
    Math.max(380, window.innerWidth * 0.3),
    window.innerWidth * 0.95,
  );

  // An evaluator model may not share a family with the evaluated model, so once the
  // connection test has told us what the gateway answered as, propose one
  // from a different family instead of leaving the admin to work it out.
  // Each entry is that provider's current top general model (OpenAI's model
  // list, Anthropic's models overview); refresh them when a newer one ships.
  const JUDGE_ALTERNATIVES: Record<string, { provider: string; model: string }> = {
    anthropic: { provider: 'openai', model: 'gpt-6.1-sol' },
    openai: { provider: 'anthropic', model: 'claude-opus-5-5' },
    gemini: { provider: 'openai', model: 'gpt-6.1-sol' },
  };
  const detectedFamily = preflight?.generations?.model_family || null;
  const configuredModel = preflight?.site?.model_under_test || null;
  const suggestedJudge =
    detectedFamily && JUDGE_ALTERNATIVES[detectedFamily]
      ? { detected: detectedFamily, ...JUDGE_ALTERNATIVES[detectedFamily] }
      : null;

  // Evaluations route through the stored Tableau connection, so launching
  // before one is saved can only fail. Gate the entry points and say why.
  // "Saved" is not the same as "works". A connection saved last month whose
  // PAT has since expired would otherwise leave Evaluate enabled and fail on
  // the first case, so gate on the recorded result of the last connection
  // test, not on the presence of a stored connection.
  const lastVerified = tableauConn.last_verified || null;
  // Reached and signed in counts as ready: a site whose generic AI endpoint
  // is off still runs the suites with their own endpoint (the suite list
  // disables the rest). A too-old server is handled separately below.
  const connReady = Boolean(
    tableauConn.configured &&
    (lastVerified?.ok || (lastVerified?.connection_ok && !lastVerified?.server_too_old)),
  );
  const verifiedAge = lastVerified?.at
    ? Math.floor((Date.now() - new Date(lastVerified.at).getTime()) / 86400000)
    : null;
  const verifiedStale = verifiedAge !== null && verifiedAge >= 7;
  // Where the site's model is chosen: Site Settings › AI in Tableau. The
  // Default site has no site segment in its URL.
  const siteSettingsUrl = tableauConn.server_url
    ? `${String(tableauConn.server_url).replace(/\/+$/, '')}/#/${
        tableauConn.site ? `site/${tableauConn.site}/` : ''
      }settings`
    : '';
  // A connected server earlier than 2026.3: saved (for publishing), but no
  // suite can run against it. Every launch entry point says so.
  const serverTooOld: ServerTooOld | null = lastVerified?.server_too_old || null;
  const launchBlockedReason = !tableauConn.configured
    ? 'Connect your Tableau Server first (Evaluation Setup, step 1).'
    : !lastVerified
    ? 'Test the connection before launching an evaluation (Evaluation Setup, step 1).'
    : serverTooOld
    ? serverTooOld.message
    : !lastVerified.ok && !lastVerified.connection_ok
    ? `The last connection test failed at the ${lastVerified.failed_stage} check. Fix it in Evaluation Setup, step 1, and test again.`
    : '';
  // Flag the rule violation where it is visible, not only on save.
  const sameFamilyWarning = Boolean(
    judge.same_family_warning ||
    (judgeReady && detectedFamily && judge.provider === detectedFamily),
  );
  // The evaluated model's family: the stored connection test's answer, or
  // this session's test when the stored one has not caught up yet.
  const evaluatedFamily = judge.evaluated_model_family || detectedFamily || null;
  // Warn as the provider is picked, before Save (bug bash 2026-10-23, item 5).
  const selectedSameFamily = Boolean(evaluatedFamily && selectedProvider === evaluatedFamily);

  // ---- evaluation setup: the three steps and their live state -----------------

  const featuresWithSuites = FEATURES.filter((f) =>
    (suitesByFeature.get(f.key) || []).some((s) => s.available && s.path),
  );
  const testedFeatures = featuresWithSuites.filter((f) =>
    Boolean(latestFinished(evalsByFeature.get(f.key) || [])),
  );
  const step3Done = featuresWithSuites.length > 0 && testedFeatures.length === featuresWithSuites.length;
  const runnableCount = featuresWithSuites.reduce(
    (n, f) => n + runnableSuites(suitesByFeature.get(f.key) || []).length, 0);
  const anyRunnable = runnableCount > 0;
  const allStepsDone = connReady && judgeReady && step3Done;
  // Nothing set up at all: the accordion opens on every load (a collapse
  // lasts for the visit only). Once a step is done the choice is remembered,
  // and it stays open by default until every step is done.
  const nothingDone = !tableauConn.configured && !judgeReady && testedFeatures.length === 0;
  const [quickStartOpen, setQuickStartOpen] = useState<boolean | null>(readQuickStart);
  const [mainTab, setMainTab] = useState<'features' | 'history'>('features');
  const [quickStartVisit, setQuickStartVisit] = useState<boolean | null>(null);
  // A guided tour step shows what it points at (the setup panel, a tab, a
  // feature card) for as long as the step is up. It is laid over the admin's
  // own choices, which are back as they were when the tour moves on.
  const { scene: tourScene } = useTour();
  const quickStartExpanded = tourScene?.setup
    || (nothingDone ? quickStartVisit ?? true : quickStartOpen ?? !allStepsDone);
  const shownTab = tourScene?.tab ?? mainTab;
  const [openFeatures, setOpenFeatures] = useState<string[]>([]);
  const shownFeatures = tourScene?.feature && !openFeatures.includes(tourScene.feature)
    ? [...openFeatures, tourScene.feature]
    : openFeatures;
  const toggleQuickStart = (open: boolean) => {
    setQuickStartVisit(open);
    if (nothingDone) return;
    setQuickStartOpen(open);
    try {
      window.localStorage.setItem(QUICK_START_KEY, open ? '1' : '0');
    } catch {
      /* private mode: the panel still works, it just is not remembered */
    }
  };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', position: 'relative' }}>
      <h1 className="tds-h1" style={{ marginBottom: 4 }}>
        Which Model Speaks Your Data Language?
      </h1>
      <Text type="secondary" style={{ display: 'block', fontSize: 16, lineHeight: '24px', marginBottom: 24 }}>
        See how well <em>your</em> model powers Tableau Agent.
      </Text>
      <EvaluationFeedback pending={launchFeedback} />

      {/* ---- Evaluation Setup: the three steps, as one accordion in the same
              idiom as the feature cards below (chevron on the left, the whole
              header toggles). Open on every load until something is set up. ---- */}
      <div data-tour={TOUR_TARGETS.setup} className="quick-start-panel" style={{ marginBottom: 32 }}>
      <Collapse
        activeKey={quickStartExpanded ? ['quick-start'] : []}
        // A tour step holding the panel open is not the admin closing it.
        onChange={(keys) => { if (!tourScene?.setup) toggleQuickStart(keys.includes('quick-start')); }}
        items={[{
          key: 'quick-start',
          label: (
            <span className="tds-h2 tui-collapse-title">Evaluation Setup</span>
          ),
          children: (
            <div id="quick-start-steps" className="quick-start-steps">
            <div className="quick-start-grid">
              <StepCard
                n={1}
                tourTarget={TOUR_TARGETS.setupConnect}
                title="Connect Your Server"
                description="Sign in with a personal access token to evaluate your site's AI model. This tool will not change your model settings."
                done={connReady}
                details={
                  tableauConn.configured
                    ? [
                        { label: 'Server', value: hostOf(tableauConn.server_url) || '—' },
                        { label: 'Site name', value: tableauConn.site || 'Default' },
                        ...(serverTooOld
                          ? [{
                              label: 'Release',
                              value: (
                                <Text type="warning">
                                  {serverTooOld.release || 'Earlier than ' + serverTooOld.min_release}
                                  {serverTooOld.release ? ` (needs ${serverTooOld.min_release} or later)` : ''}
                                </Text>
                              ),
                            }]
                          : []),
                        {
                          label: 'Evaluated model',
                          value: connReady && lastVerified?.model_under_test ? (
                            <Tooltip title="Read from Site Settings at the last connection test; change it there">
                              <a href={siteSettingsUrl} target="_blank" rel="noreferrer">
                                {lastVerified.model_under_test}
                              </a>
                            </Tooltip>
                          ) : connReady && tableauConn.declared_model ? (
                            <Tooltip title="Entered in an earlier version of the tool; the site runs Tableau's default model and names none">
                              <span>{tableauConn.declared_model} (entered)</span>
                            </Tooltip>
                          ) : connReady && lastVerified?.default_models ? (
                            <Tooltip title="Site Settings names no custom model; the site runs Tableau's default model.">
                              <span>{DEFAULT_MODELS_LABEL}</span>
                            </Tooltip>
                          ) : connReady ? (
                            'Not reported by the site'
                          ) : serverTooOld ? (
                            'Not available on this release'
                          ) : lastVerified ? (
                            'Last test failed'
                          ) : (
                            'Not tested yet'
                          ),
                        },
                      ]
                    : [{ label: 'Connection', value: 'Not set up' }]
                }
                percent={connReady ? 100 : tableauConn.configured ? 50 : 0}
                action={{
                  label: connReady ? 'Change' : tableauConn.configured ? 'Test Again' : 'Start',
                  primary: !connReady,
                  // Frozen while an evaluation runs: a new sign-in would end
                  // the run's session (bug bash 2026-10-23, item 22).
                  disabled: hasActive,
                  tooltip: hasActive ? 'Pause or stop the running evaluation to change the connection.' : undefined,
                  onClick: () => {
                    setPreflight(null);
                    setConnOpen(true);
                  },
                }}
              />
              <StepCard
                n={2}
                tourTarget={TOUR_TARGETS.setupJudge}
                title="Select Evaluator Model"
                tag="Optional"
                description={judgeReady
                  ? `Scores natural language responses using ${providerLabel(judge.provider)} ${judge.model}.`
                  : 'Scores natural language responses using a second model from a different family.'}
                done={judgeReady}
                details={[
                  { label: 'Evaluator', value: judgeReady ? `${providerLabel(judge.provider)} ${judge.model}` : 'None' },
                  ...(sameFamilyWarning
                    ? [{ label: 'Warning', value: <Text type="warning">Same family as the evaluated model</Text> }]
                    : []),
                ]}
                percent={judgeReady ? 100 : 0}
                action={{
                  label: judgeReady ? 'Change' : 'Start',
                  primary: !judgeReady && connReady,
                  // A run keeps the evaluator model it started with; the
                  // server refuses a change meanwhile (item 22).
                  disabled: hasActive,
                  tooltip: hasActive ? 'Pause or stop the running evaluation to change the evaluator model.' : undefined,
                  onClick: () => setJudgeOpen(true),
                }}
              />
              <StepCard
                n={3}
                tourTarget={TOUR_TARGETS.setupEvaluate}
                title="Evaluate the Features"
                description="Evaluate All runs every feature's test suites, one evaluation per feature. Expand a feature below to evaluate it alone, or one of its capabilities."
                done={step3Done}
                details={[
                  {
                    label: 'Tested features',
                    value: testedFeatures.length
                      ? testedFeatures.map((f) => f.short).join(', ')
                      : 'None yet',
                  },
                  ...(featuresWithSuites.length > testedFeatures.length
                    ? [{
                        label: 'Not yet tested',
                        value: featuresWithSuites
                          .filter((f) => !testedFeatures.includes(f))
                          .map((f) => f.short)
                          .join(', '),
                      }]
                    : []),
                ]}
                percent={featuresWithSuites.length
                  ? (100 * testedFeatures.length) / featuresWithSuites.length
                  : 0}
                action={{
                  label: launchingKey === 'all' ? 'Submitting…' : 'Evaluate All',
                  primary: connReady && !step3Done && !hasActive,
                  disabled: !connReady || hasActive || launching || !anyRunnable,
                  tooltip: !connReady
                    ? 'Connect your server first (step 1).'
                    : hasActive
                    ? 'Evaluations are running. Evaluate All is available again when they finish.'
                    : !anyRunnable
                    ? (serverKeepsOut(suites || []) || 'No suites are available on this machine.')
                    : `Runs ${runnableCount} suite${runnableCount === 1 ? '' : 's'} across ${featuresWithSuites.length} feature${featuresWithSuites.length === 1 ? '' : 's'}, one evaluation per feature.`,
                  onClick: startEvaluating,
                }}
              />
            </div>

            {serverTooOld && (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 14 }}
                message={`Tableau Server ${serverTooOld.release || ''} can't run evaluations`.replace('  ', ' ')}
                description={serverTooOld.message}
                action={
                  <Button size="small" onClick={() => { setPreflight(null); setConnOpen(true); }}>
                    Test Again
                  </Button>
                }
              />
            )}

            {connReady && verifiedStale && (
              <Alert
                type="info"
                showIcon
                style={{ marginTop: 14 }}
                message={`Connection last tested ${verifiedAge} days ago`}
                description="Personal access tokens expire. Test the connection again if evaluations start failing."
                action={
                  <Button size="small" onClick={() => setConnOpen(true)}>
                    Test Again
                  </Button>
                }
              />
            )}
            </div>
          ),
        }]}
      />
      </div>

      {/* ---- Two tabs: the features (each with its capabilities and
              evaluations) and every evaluation in one list. The feature cards
              file runs under their feature, which answers "how is authoring
              doing" but not "what is running, what did I leave paused, what
              can I clear out" — that is what the history tab's filter and
              bulk delete are for. ---- */}
      <div id="features" style={{ scrollMarginTop: 16 }}>
        <Tabs
          activeKey={shownTab}
          onChange={(k) => setMainTab(k as 'features' | 'history')}
          items={[
            {
              key: 'features',
              label: 'Evaluate AI in Tableau Features',
              children: (
                <>
        <div data-tour={TOUR_TARGETS.features}>
        <Collapse
          activeKey={shownFeatures}
          onChange={setOpenFeatures}
          items={FEATURES.map((f) => {
            const featureEvals = evalsByFeature.get(f.key) || [];
            const featureSuites = suitesByFeature.get(f.key) || [];
            const featureCats = CATEGORIES.filter((c) => c.feature === f.key && !c.held_back);
            // The card's "Last run" is the newest evaluation whatever its
            // state, with that state beside the time (decision of 2026-11-03:
            // a feature whose latest evaluations are all paused is not
            // "Not yet tested").
            const latest = latestEvaluation(featureEvals);
            // The card's counts: how many of its capabilities have a completed
            // run, and how many suite runs it has had in all.
            const testedCapabilities = new Set(
              featureEvals.flatMap((e) =>
                e.runs.filter((r) => r.status === 'finished').map((r) => categoryOfRun(r).key)),
            ).size;
            const runCount = featureEvals.reduce((n, e) => n + e.runs.length, 0);
            const runnable = runnableSuites(featureSuites);
            // Queued counts: a second Evaluate while the first batch waits for
            // the worker queued the same suites twice (bug bash 2026-10-23, 3c).
            const featureInFlight = featureEvals.some((e) => ACTIVE_STATUSES.includes(e.status));
            const blocked = !connReady || runnable.length === 0 || featureInFlight;
            return {
              key: f.key,
              label: (
                <div>
                  <div className="tui-collapse-title">
                    <span className="tds-h3" style={{ lineHeight: 'inherit' }}>{f.title}</span>
                  </div>
                  <Text type="secondary" style={{ display: 'block', marginTop: 2 }}>{f.description}</Text>
                </div>
              ),
              extra: (
                <Space size={4}>
                  {featureEvals.length > 0 && (
                    <Tooltip title="View Last Run's Results">
                      <Button
                        size="small"
                        // Not a <Link>: the click must not reach the Collapse header
                        // (it would toggle the panel), and stopping it there also
                        // stopped react-router's own handler, so the button did
                        // nothing (bug bash S2-5). Navigate directly instead.
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/results/feature/${f.key}`);
                        }}
                      >
                        View Results
                      </Button>
                    </Tooltip>
                  )}
                  <Tooltip
                    overlayStyle={{ maxWidth: 360 }}
                    title={
                      launchBlockedReason ||
                      (featureInFlight
                        ? 'An evaluation for this feature is already in progress'
                        : runnable.length
                        ? (
                          // What a click starts, so no confirmation stands between
                          // the button and the run (UX review, 2026-10-21).
                          <div>
                            <div style={{ marginBottom: 4 }}>
                              Runs {runnable.length === 1 ? 'this suite' : `these ${runnable.length} suites, one after another`}:
                            </div>
                            {runnable.map((sx) => (
                              <div key={sx.id}>
                                · {sx.label}: {fmtCount(sx.case_count)} test cases, {durationText(sx.estimated_seconds)}
                              </div>
                            ))}
                            <div style={{ marginTop: 4 }}>
                              {fmtCount(runnable.reduce((n, sx) => n + (sx.case_count || 0), 0))} test cases,{' '}
                              {durationText(runnable.reduce((n, sx) => n + (sx.estimated_seconds || 0), 0))} in total.
                               Suites in other sections are not included. Selecting Evaluate submits them to the queue.
                            </div>
                            {keptOutSuites(featureSuites).length > 0 && (
                              <div style={{ marginTop: 4 }}>
                                <div>
                                  Not run: {keptOutSuites(featureSuites).map((sx) => sx.label).join(', ')}.
                                </div>
                                <div>{serverKeepsOut(featureSuites)}</div>
                              </div>
                            )}
                          </div>
                        )
                        : serverKeepsOut(featureSuites)
                        ? serverKeepsOut(featureSuites)
                        : featureSuites.some((s) => s.coming_soon)
                        ? 'Coming soon — public test cases for this feature are being prepared'
                        : 'No suites available on this machine')
                    }
                  >
                    <Button
                      type="primary"
                      size="small"
                      icon={<CaretRightOutlined />}
                      data-tour={f.key === TOUR_FEATURE ? TOUR_TARGETS.evaluateAll : undefined}
                      loading={launchingKey === `feature:${f.key}`}
                      disabled={blocked || (launching && launchingKey !== `feature:${f.key}`)}
                      style={
                        blocked
                          ? undefined
                          : { backgroundColor: PRIMARY_COLOR, borderColor: PRIMARY_COLOR }
                      }
                      onClick={(e) => {
                        // Not through the Collapse header (it would toggle the panel).
                        e.stopPropagation();
                        launchAll(runnable, f.key);
                      }}
                    >
                      {launchingKey === `feature:${f.key}` ? 'Submitting…' : 'Evaluate'}
                    </Button>
                  </Tooltip>
                </Space>
              ),
              // One line under the description: the capabilities as chips,
              // then the counts and the last run's date (decision of 2026-10-28). The
              // last run's scores sit on the Test Results table and a live
              // run's status in the history. The header is a button, so the
              // chips live in the summary row (always visible) rather than
              // in the label. Clicking one opens its results.
              summary: (
                <div data-tour={TOUR_TARGETS.capabilities} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <Text type="secondary">Available capabilities:</Text>
                    {featureCats.map((cat) => {
                      const suite = publicFullSuite(cat, featureSuites);
                      const ready = Boolean(suite && suite.available && suite.path);
                      const tip = ready && suite!.server_supported === false
                        ? `${sentence(cat.task)} · ${suite!.server_message || launchBlockedReason} Click for earlier results.`
                        : ready
                        ? `${sentence(cat.task)} · ${suite!.case_count} test cases · about ${minutesOf(suite!.estimated_seconds)} min · Click for results`
                        : suite?.coming_soon
                        ? `${sentence(cat.task)} · Coming soon, the public test cases are being prepared`
                        : `${sentence(cat.task)} · No test cases on this machine`;
                      // Dev-mode gateway runs launch from the launch drawer;
                      // every capability launches from the feature results
                      // page. Questions about a dashboard needs no set-up:
                      // its run publishes the sample dashboards itself.
                      const needsDrawer = ready && devMode;
                      return (
                        <span key={cat.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                          <Tooltip title={tip}>
                            <button
                              type="button"
                              className="capability-chip"
                              disabled={!ready}
                              onClick={() => navigate(`/results/feature/${f.key}?capability=${cat.key}`)}
                            >
                              {cat.label}
                            </button>
                          </Tooltip>
                          {needsDrawer && (
                            <Tooltip title={
                              suite!.server_supported === false
                                ? suite!.server_message
                                : launchBlockedReason || `Set up and evaluate ${cat.label}`
                            }>
                              <Button
                                type="text"
                                size="small"
                                aria-label={`Set up and evaluate ${cat.label}`}
                                icon={<CaretRightOutlined />}
                                disabled={!connReady || launching || suite!.server_supported === false}
                                onClick={() => openLaunch(suite!)}
                              />
                            </Tooltip>
                          )}
                        </span>
                      );
                    })}
                  <Text type="secondary"> · </Text>
                  <Text type="secondary">Capabilities tested:</Text>
                  <Text strong>{testedCapabilities}</Text>
                  <Text type="secondary"> · </Text>
                  <Text type="secondary">Runs:</Text>
                  <Text strong>{runCount}</Text>
                  <Text type="secondary"> · </Text>
                  {latest ? (
                    <>
                      <Text type="secondary">Last run:</Text>
                      <Text>{(latest.finished_at || latest.created_at || '').slice(0, 16)}</Text>
                      {/* The state as its icon alone (decision of 2026-11-03: no
                          word); the word is the tooltip and the accessible name. */}
                      <Tooltip title={evalStatusLabel(latest)}>
                        <span
                          className="feature-last-run-status"
                          data-testid="feature-last-run-status"
                          role="img"
                          aria-label={evalStatusLabel(latest)}
                          style={{ display: 'inline-flex', alignItems: 'center', fontSize: 16 }}
                        >
                          {evalStatus(latest).icon}
                        </span>
                      </Tooltip>
                    </>
                  ) : (
                    <Text type="secondary">Not yet tested</Text>
                  )}
                </div>
              ),
              children: (
                <div style={{ paddingTop: 4 }}>
                  <div data-tour={TOUR_TARGETS.featureResults}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <Text strong>Test Results</Text>
                    {featureEvals.length > 0 && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {featureEvals.length} evaluation{featureEvals.length === 1 ? '' : 's'}
                      </Text>
                    )}
                    <span style={{ marginLeft: 'auto' }}><BaselineLegend /></span>
                  </div>
                  {/* Scrolls inside the card on a narrow window (history
                      panel open) rather than clipping the action column. */}
                  <div style={{ overflowX: 'auto' }}>
                    <Table
                      className="metrics-table evaluations-table"
                      rowKey="key"
                      size="small"
                      loading={runs === null}
                      pagination={featureEvals.length > 6 ? { pageSize: 6 } : false}
                      columns={evaluationColumns as any}
                      dataSource={featureEvals}
                      locale={{ emptyText: 'No evaluations yet. Select Evaluate above.' }}
                    />
                  </div>
                  </div>
                </div>
              ),
            };
          })}
        />
        </div>
                </>
              ),
            },
            {
              key: 'history',
              label: 'Evaluation History',
              children: (
                <div data-tour={TOUR_TARGETS.history}>
                  <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '8px 16px', marginBottom: 12, flexWrap: 'wrap' }}>
                    <Space size={12} align="end">
                      {historyScopeOptions.length > 2 && (
                        <label style={{ display: 'flex', flexDirection: 'column' }}>
                          <span className="tui-form-label">Feature or capability</span>
                          <Select
                            aria-label="Filter by feature or capability"
                            size="small"
                            value={historyScope}
                            onChange={setHistoryScope}
                            style={{ width: 220 }}
                            options={historyScopeOptions.map((o) => ({
                              value: o.value,
                              label: `${o.label} (${allEvaluations.filter(o.match).length})`,
                            }))}
                          />
                        </label>
                      )}
                      <label style={{ display: 'flex', flexDirection: 'column' }}>
                        <span className="tui-form-label">Status</span>
                        <Select
                          aria-label="Filter by status"
                          size="small"
                          value={historyStatus}
                          onChange={setHistoryStatus}
                          style={{ width: 200 }}
                          options={STATUS_FILTERS.map((f) => ({
                            value: f.value,
                            label: `${f.label} (${historyScoped.filter(f.match).length})`,
                          }))}
                        />
                      </label>
                    </Space>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {historyRows.length} of {allEvaluations.length} evaluation{allEvaluations.length === 1 ? '' : 's'} · {(runs || []).length} run{(runs || []).length === 1 ? '' : 's'}
                    </Text>
                  </div>
                  <div className="heading-with-legend" style={{ justifyContent: 'flex-end', marginBottom: 8 }}>
                    <span data-tour={TOUR_TARGETS.scoreLegend}><BaselineLegend /></span>
                  </div>
                  <div style={{ overflowX: 'auto' }}>
                    <Table
                      className="metrics-table evaluations-table"
                      rowKey="key"
                      size="small"
                      loading={runs === null}
                      pagination={historyRows.length > 10 ? { pageSize: 10 } : false}
                      columns={historyColumns as any}
                      dataSource={historyRows}
                      // Declared widths (32 + 232 + 179 + 98 + 98 + 120 + 236
                      // + 205 = 1200, mirrored by .history-suite in index.css)
                      // so the suites of an expanded row sit under the
                      // columns; narrower windows scroll the table.
                      scroll={{ x: 1200 }}
                      expandable={{
                        rowExpandable: (e: Evaluation) => e.isBatch,
                        expandedRowRender: historyExpanded,
                      }}
                      locale={{
                        emptyText: allEvaluations.length
                          ? 'No evaluations match these filters.'
                          : 'No evaluations yet. Evaluations you run are listed here.',
                      }}
                    />
                  </div>
                </div>
              ),
            },
          ]}
        />
      </div>

      {/* ---- Launch drawer (Dashboard Q&A content ids; dev-mode gateway) ---- */}
      <Drawer
        title="Set Up Your Evaluation"
        placement="right"
        width={drawerWidth}
        open={!!launchSuiteState}
        onClose={() => setLaunchSuite(null)}
      >
        {launchSuiteState && (
          <Form form={runForm} layout="vertical" size="small">
            <Divider>Suite</Divider>
            {siblingSuites.length > 1 && (
              <Form.Item label="Suite" style={{ marginBottom: 8 }}>
                <Select
                  value={launchSuiteState.id}
                  onChange={(id: string) => {
                    const next = siblingSuites.find((x) => x.id === id);
                    if (next) openLaunch(next);
                  }}
                  options={siblingSuites.map((x) => ({
                    value: x.id,
                    label: `${x.label} (${x.case_count} test cases)`,
                  }))}
                />
              </Form.Item>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <Text strong>{launchSuiteState.label}</Text>
              <Tag color={getColorForLabel(launchSuiteState.capability)}>{launchSuiteState.capability}</Tag>
              <Tag>{launchSuiteState.case_count} test cases</Tag>
              <Tag>about {minutesOf(launchSuiteState.estimated_seconds)} min</Tag>
            </div>

            <Divider>Tableau Server</Divider>
            {tableauConn.configured ? (
              <Alert
                type="success"
                showIcon
                style={{ marginBottom: 12 }}
                message={`Runs through ${tableauConn.server_url}`}
                description={`Site: ${tableauConn.site || '(default)'} · Personal access token: ${tableauConn.pat_name}. Change it from Evaluation Setup, step 1.`}
              />
            ) : (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message="No Tableau Server Connection"
                description={
                  <span>
                    Evaluations run through your Tableau Server, so connect to it first.{' '}
                    <Button size="small" onClick={() => { setLaunchSuite(null); setConnOpen(true); }}>
                      Connect
                    </Button>
                  </span>
                }
              />
            )}

            {launchSuiteState.adapter === 'cabu' && launchSuiteState.content ? (
              <>
                <Divider>Content Under Test</Divider>
                {(() => {
                  const entry = sampleContent?.suites?.[launchSuiteState.content];
                  if (sampleContentLoaded && !sampleContent) {
                    return (
                      <Alert
                        type="warning"
                        showIcon
                        style={{ marginBottom: 12 }}
                        message="Restart the tool to set up this suite"
                        description="The running backend predates the sample content feature. Stop the tool and start it again, then open this set-up once more."
                      />
                    );
                  }
                  if (!entry) {
                    return <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Checking the sample content…" />;
                  }
                  const same = sampleContent && tableauConn.server_url &&
                    String(sampleContent.server_url).replace(/\/+$/, '').toLowerCase() === String(tableauConn.server_url).replace(/\/+$/, '').toLowerCase();
                  return (
                    <>
                      <Alert
                        type={entry.published ? 'success' : 'info'}
                        showIcon
                        style={{ marginBottom: 12 }}
                        message={entry.published
                          ? `The sample dashboard is on ${same ? 'your site' : 'the connected site'}`
                          : 'The sample dashboard will be published when the evaluation starts'}
                        description={
                          <div style={{ fontSize: 12 }}>
                            <div>
                              The questions are asked of Tableau Agent in Dashboards about the workbook{' '}
                              <Text strong>{entry.workbook}</Text> (dashboard <Text strong>{entry.dashboard}</Text>),
                              built on {entry.datasources.length === 1 ? 'the data source' : 'the data sources'}{' '}
                              {entry.datasources.map((n, i) => (
                                <span key={n}>{i > 0 ? ' and ' : ''}<Text strong>{n}</Text></span>
                              ))}, in the project <Text strong>{entry.project}</Text>. The site's settings choose the model.
                            </div>
                            {entry.published && entry.ids?.workbook_luid && (
                              <div style={{ marginTop: 4 }}>
                                <Text type="secondary">Workbook id {entry.ids.workbook_luid}</Text>
                              </div>
                            )}
                            {!entry.files_present && (
                              <div style={{ marginTop: 4 }}>
                                <Text type="danger">The sample files are missing from the tool's public-suites folder.</Text>
                              </div>
                            )}
                          </div>
                        }
                      />
                      <Button
                        size="small"
                        loading={publishingContent === launchSuiteState.id}
                        disabled={!connReady || !entry.files_present || Boolean(publishingContent)}
                        onClick={() => { publishSampleContent(launchSuiteState); }}
                        style={{ marginBottom: 12 }}
                      >
                        {entry.published ? 'Publish Sample Content Again' : 'Publish Sample Content Now'}
                      </Button>
                    </>
                  );
                })()}
              </>
            ) : launchSuiteState.adapter === 'cabu' && launchSuiteState.parts?.length ? (
              <>
                <Divider>Content Under Test</Divider>
                {(() => {
                  const parts = launchSuiteState.parts || [];
                  const entries = parts.map((p) => ({ part: p, entry: p.content ? sampleContent?.suites?.[p.content] : undefined }));
                  const publishedCount = entries.filter((x) => x.entry?.published).length;
                  const allFiles = entries.every((x) => x.entry?.files_present ?? true);
                  return (
                    <>
                      <Alert
                        type={publishedCount === parts.length ? 'success' : 'info'}
                        showIcon
                        style={{ marginBottom: 12 }}
                        message={publishedCount === parts.length
                          ? 'All eight sample dashboards are on your site'
                          : `${publishedCount} of ${parts.length} sample dashboards are on your site; the evaluation publishes the rest when it starts`}
                        description={
                          <div style={{ fontSize: 12 }}>
                            <div style={{ marginBottom: 6 }}>
                              Each question is asked of Tableau Agent in Dashboards about its own sample dashboard,
                              in the project <Text strong>{entries[0]?.entry?.project || 'AI Model Evaluation Samples'}</Text>.
                              The site's settings choose the model.
                            </div>
                            {entries.map(({ part, entry }) => (
                              <div key={part.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                                <Tag color={entry?.published ? 'success' : 'default'} style={{ marginRight: 0 }}>
                                  {entry?.published ? 'Published' : 'Not yet'}
                                </Tag>
                                <Text>{part.label}</Text>
                                <Text type="secondary">
                                  {entry ? entry.dashboard : ''} · {part.case_count} questions
                                </Text>
                              </div>
                            ))}
                            {!allFiles && (
                              <div style={{ marginTop: 4 }}>
                                <Text type="danger">Some sample files are missing from the tool's public-suites folder.</Text>
                              </div>
                            )}
                          </div>
                        }
                      />
                      <Button
                        size="small"
                        loading={publishingContent === launchSuiteState.id}
                        disabled={!connReady || !allFiles || Boolean(publishingContent)}
                        onClick={() => { publishSampleContent(launchSuiteState); }}
                        style={{ marginBottom: 12 }}
                      >
                        {publishedCount === parts.length ? 'Publish Sample Content Again' : 'Publish Sample Content Now'}
                      </Button>
                    </>
                  );
                })()}
              </>
            ) : launchSuiteState.adapter === 'cabu' ? (
              <>
                <Divider>Content Under Test</Divider>
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="These questions are asked of Tableau Agent in Dashboards on your server, about a workbook published on your site. The site's settings choose the model. The ids are kept for later runs."
                />
                <Form.Item
                  name="workbook_luid"
                  label={labelWithInfo('Workbook ID', 'The LUID of the workbook published on your site, the dashboard the questions are about')}
                  rules={[{ required: true }]}
                >
                  <Input />
                </Form.Item>
                <Form.Item
                  name="datasource_luid"
                  label="Data source ID"
                  rules={[{ required: true }]}
                >
                  <Input />
                </Form.Item>
                <Form.Item name="datasource_name" label="Data source name (optional)">
                  <Input />
                </Form.Item>
              </>
            ) : !devMode ? (
              <>
                <Form.Item
                  name="declared_site_model"
                  label={labelWithInfo(
                    'Model in Site Settings (for the record)',
                    'The model named in Site Settings, recorded with the run so exports name the model that was tested',
                  )}
                >
                  <Input placeholder="For example, gpt-4o" />
                </Form.Item>
                <Button
                  size="small"
                  loading={preflightRunning}
                  onClick={() => { runPreflight(); }}
                  style={{ marginBottom: 12 }}
                >
                  Test Connection
                </Button>
                {preflight && <PreflightReport result={preflight} />}
              </>
            ) : (
              <>
            <Divider>Gateway and Credentials</Divider>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="Leave gateway fields blank to use the local credential file (credentials/llm.json)."
            />
            <Form.Item name="org_id" label={labelWithInfo('Org ID', 'Written to the credential file as the gateway org id. Direct-gateway runs only.')}>
              <Input />
            </Form.Item>
            <Form.Item name="gateway_url" label={labelWithInfo('Gateway URL', 'The LLM gateway under test, e.g. the local bridge at https://localhost:5001.')}>
              <Input placeholder="https://localhost:5001" />
            </Form.Item>
            <Form.Item name="llm_key" label="Gateway API key">
              <Input.Password placeholder="blank = credential file" />
            </Form.Item>
            <Form.Item
              name="model"
              label={labelWithInfo('Model override', 'Sets models.create so all runners use this model instead of their defaults. Direct-gateway runs only.')}
              extra={cesMode
                ? 'Not applicable via Tableau Server: the server uses the model configured in Site Settings (Perform analytics tasks).'
                : undefined}
            >
              <Input placeholder="e.g. gpt-4o-mini" disabled={cesMode} />
            </Form.Item>
              </>
            )}

            <Divider>Evaluator Scoring</Divider>
            {!launchSuiteState.judge_capable ? (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message="Not applicable to this suite"
                description="This suite's answers are formulas or plans, not written replies, so there is nothing for an evaluator model to score."
              />
            ) : !judgeReady ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message="Set up an evaluator model to score written answers"
                description="Set up the evaluator model in Evaluation Setup, step 2"
              />
            ) : null}
            <Form.Item name="compute_nl_judge" label="Evaluator scoring" valuePropName="checked">
              <Switch
                disabled={!launchSuiteState.judge_capable || !judgeReady}
                checkedChildren="On"
                unCheckedChildren="Off"
              />
            </Form.Item>

            {devMode && launchSuiteState.adapter !== 'cabu' && (
            <Collapse
              ghost
              items={[{
                key: 'ces',
                label: 'Advanced: route through Tableau Server (CES)',
                children: (
                  <>
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message="Customer path: all gateway-under-test traffic goes through Tableau Server, authenticated with your PAT."
                    />
                    <Form.Item name="generations_mode" label="Generations mode">
                      <Select
                        options={[
                          { value: 'direct', label: 'Direct to gateway (dev)' },
                          { value: 'ces', label: 'Via Tableau Server CES (customer path)' },
                        ]}
                      />
                    </Form.Item>
                    {cesMode && (
                      <Form.Item
                        name="declared_site_model"
                        label={labelWithInfo(
                          'Model in Site Settings (for the record)',
                          'The model named in Site Settings, recorded with the run so exports name the model that was tested',
                        )}
                      >
                        <Input placeholder="For example, gpt-4o" />
                      </Form.Item>
                    )}
                    <Form.Item name="ces_url" label="CES URL">
                      <Input placeholder="http://localhost:8080" />
                    </Form.Item>
                    <Form.Item name="tableau_server" label="Tableau Server URL">
                      <Input placeholder="https://my-server" />
                    </Form.Item>
                    <Form.Item name="tableau_site" label={labelWithInfo('Site name', "The part of the site URL after #/site/, for example EvalTesting (case-sensitive). Blank for the default site.")}>
                      <Input placeholder="Leave blank for the default site" />
                    </Form.Item>
                    <Form.Item name="tableau_pat_name" label="PAT name">
                      <Input />
                    </Form.Item>
                    <Form.Item name="tableau_pat_value" label="PAT secret">
                      <Input.Password />
                    </Form.Item>
                    <Form.Item
                      name="verify_tls"
                      label="Verify TLS certificate"
                      valuePropName="checked"
                      initialValue={true}
                      extra="Turn off only for dev servers with self-signed certificates."
                    >
                      <Switch checkedChildren="On" unCheckedChildren="Off" />
                    </Form.Item>
                    {/* Connectivity check: probes server → PAT →
                        generations endpoint, so a bad PAT and a server
                        build without the endpoint read differently. */}
                    <Button
                      size="small"
                      loading={preflightRunning}
                      onClick={() => { runPreflight(); }}
                    >
                      Test Connection
                    </Button>
                    {preflight && <PreflightReport result={preflight} />}
                  </>
                ),
              }]}
            />
            )}

            <Divider />
            <EvaluationFeedback pending={launchFeedback} />
            <Space>
              <Tooltip title={launchContentReady ? undefined : "The sample files are missing from the tool's public-suites folder"}>
                <Button
                  type="primary"
                  loading={launching}
                  disabled={!launchContentReady}
                  style={launchContentReady ? { backgroundColor: PRIMARY_COLOR, borderColor: PRIMARY_COLOR } : undefined}
                  onClick={submitRun}
                >
                  {launching ? 'Submitting…' : 'Evaluate'}
                </Button>
              </Tooltip>
              <Button
                style={{ color: DANGER_COLOR, borderColor: DANGER_COLOR }}
                onClick={() => setLaunchSuite(null)}
              >
                Cancel
              </Button>
            </Space>
          </Form>
        )}
      </Drawer>

      {/* ---- Connection drawer (Evaluation Setup, step 1) ---- */}
      <Drawer
        title="Tableau Server Connection"
        placement="right"
        width={drawerWidth}
        open={connOpen}
        onClose={() => setConnOpen(false)}
      >
        <Text type="secondary" style={{ display: 'block', fontSize: 13, marginBottom: 12 }}>
          Evaluations run through Tableau Server, signed in with a personal access token that is
          stored on this computer.
        </Text>
        <Card size="small" type="inner" style={{ marginBottom: 20 }}>
          <Form form={connForm} layout="vertical" size="small" onFinish={testAndSaveConn}>
            <Form.Item
              name="server_url"
              label="Tableau Server URL"
              rules={[{ required: true }]}
            >
              <Input
                placeholder="https://my-server"
                onPaste={(event) => {
                  const connection = parseTableauConnectionUrl(event.clipboardData.getData('text'));
                  if (!connection) return;
                  event.preventDefault();
                  connForm.setFieldsValue(connection);
                }}
              />
            </Form.Item>
            <Form.Item
              name="site"
              label={labelWithInfo('Site name', "The part of the site URL after #/site/, for example EvalTesting (case-sensitive). Blank for the default site.")}
            >
              <Input placeholder="Leave blank for the default site" />
            </Form.Item>
            <Form.Item
              name="pat_name"
              label={labelWithHelp('Personal access token name', PAT_HELP)}
              rules={[{ required: true }]}
            >
              <Input placeholder="As Tableau shows it, for example my-token-917" />
            </Form.Item>
            <Form.Item
              name="pat_value"
              label={labelWithHelp(
                tableauConn.configured
                  ? <>Personal access token secret <Tag color="green">Stored</Tag></>
                  : 'Personal access token secret',
                PAT_HELP,
              )}
              rules={[{ required: true }]}
            >
              <Input.Password placeholder={tableauConn.configured ? 'Unchanged unless you replace it' : ''} />
            </Form.Item>
            {/* TLS controls surface behind the dev flag OR when the server was
                started with --allow-self-signed (showTls), so an on-prem server
                with a self-signed cert or a private CA is reachable without dev
                mode. On a customer server presenting a valid certificate these
                stay hidden and verify defaults ON. */}
            {showTls && (
              <>
                <Form.Item
                  name="verify_tls"
                  label="Verify TLS certificate"
                  valuePropName="checked"
                  initialValue={uiCaps.allowSelfSigned ? false : true}
                >
                  <Switch checkedChildren="On" unCheckedChildren="Off" />
                </Form.Item>
                {connVerifyTls === false && (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="TLS certificate verification is disabled"
                    description={
                      <span>
                        Traffic to the Tableau Server is not authenticated against a
                        trusted CA. Use only for trusted dev servers with self-signed
                        certificates. For verified connections, run{' '}
                        <Text code>tableau-ai-eval trust &lt;server-url&gt;</Text> to trust the
                        server&rsquo;s CA instead.
                      </span>
                    }
                  />
                )}
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message="Keeping verification on"
                  description={
                    <span>
                      A CA bundle can be trusted server-side via{' '}
                      <Text code>TABLEAU_AI_EVAL_CA_BUNDLE</Text> or{' '}
                      <Text code>tableau-ai-eval trust &lt;server-url&gt;</Text> (writes
                      ~/.tableau-ai-eval/ca.pem, auto-detected) — so you can verify the
                      connection instead of disabling checking.
                    </span>
                  }
                />
              </>
            )}
            {showTls && (
              <Form.Item
                name="ces_url"
                label={labelWithInfo(
                  'CES base URL (optional)',
                  'Only for setups where the content-exploration service runs somewhere else — a standalone CES on its own port. On a Tableau Server, leave this blank.',
                )}
                extra="Leave blank; derived as <server>/content-exploration."
              >
                <Input placeholder="blank = <server>/content-exploration" />
              </Form.Item>
            )}
            {/* One button: the test runs, and a pass stores the connection.
                A separate Save was easy to miss after a passing test (UX-1),
                and a connection that fails its test is never worth storing. */}
            <Tooltip title="Tests the server, token, and AI endpoint, then saves the connection. A server earlier than 2026.3 is saved for publishing only.">
              <Button
                type="primary"
                htmlType="submit"
                loading={preflightRunning || savingConn}
                style={{ backgroundColor: PRIMARY_COLOR, borderColor: PRIMARY_COLOR }}
              >
                Test and Save Connection
              </Button>
            </Tooltip>
            {preflight ? (
              <div style={{ marginTop: 12 }}><PreflightReport result={preflight} /></div>
            ) : lastVerified ? (
              <div style={{ marginTop: 12 }}>
                <Tag color={lastVerified.ok || lastVerified.connection_ok ? 'success' : 'error'}>
                  {lastVerified.ok || lastVerified.connection_ok ? 'Last test: connected' : 'Last test failed'}
                </Tag>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {new Date(lastVerified.at).toLocaleString()}
                  {(lastVerified.ok || lastVerified.connection_ok) && lastVerified.model_under_test
                    ? ` · ${lastVerified.model_under_test}`
                    : ''}
                </Text>
                {lastVerified.server_too_old && (
                  <div style={{ fontSize: 12, marginTop: 4 }}>
                    <Text type="secondary">{lastVerified.server_too_old.message}</Text>
                  </div>
                )}
                {siteSwitchNotes(lastVerified).map((note: string) => (
                  <div key={note} style={{ fontSize: 12, marginTop: 4 }}>
                    <Text type="secondary">{note} Turn it on in Site Settings, then test the connection again.</Text>
                  </div>
                ))}
                {lastVerified.connection_ok && !lastVerified.ok && !lastVerified.server_too_old && lastVerified.generations?.message && (
                  <div style={{ fontSize: 12, marginTop: 4 }}>
                    <Text type="secondary">The site's AI endpoint failed its test: {lastVerified.generations.message}</Text>
                  </div>
                )}
              </div>
            ) : null}
          </Form>
        </Card>

        {/* Same order as Site Settings › AI in Tableau: the connection, then
            the model the site uses. The model is read-only here: it is
            chosen on the server. */}
        <Divider>
          {labelWithInfo(
            'Evaluated Model',
            'The model selected in Site Settings > AI in Tableau. The tool reads it during the connection test and never changes it.',
          )}
        </Divider>
        <Card size="small" type="inner">
          {connReady && lastVerified?.model_under_test ? (
            <>
              <div>
                <Text strong>{lastVerified.model_under_test}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {' '}· from Site Settings, {new Date(lastVerified.at).toLocaleString()}
                </Text>
              </div>
              <a href={siteSettingsUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                Change in Site Settings
              </a>
            </>
          ) : connReady && tableauConn.declared_model ? (
            <div>
              <Text strong>{tableauConn.declared_model}</Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {' '}· entered in an earlier version of the tool; the site runs Tableau's default model and names none
              </Text>
            </div>
          ) : connReady && lastVerified?.default_models ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {DEFAULT_MODELS_LABEL}.
            </Text>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              Shown after a successful connection test.
            </Text>
          )}
        </Card>

      </Drawer>

      {/* ---- Evaluator model drawer (Evaluation Setup, step 2) ---- */}
      <Drawer
        title="Select Evaluator Model"
        placement="right"
        width={drawerWidth}
        open={judgeOpen}
        onClose={() => setJudgeOpen(false)}
      >
        {/* Overview first: who is judging, and is it valid. The rule and its
            reasoning stay behind a disclosure rather than as standing prose. */}
        <Card size="small" style={{ marginBottom: 12 }}>
          <Space align="center" wrap>
            <Tag color={judgeReady ? 'success' : 'error'}>
              {judgeReady ? 'Evaluator model configured' : 'No evaluator model'}
            </Tag>
            {judgeReady && judge.provider && (
              <Text code style={{ fontSize: 12 }}>{providerLabel(judge.provider)} {judge.model}</Text>
            )}
          </Space>
          <div style={{ marginTop: 8, fontSize: 12 }}>
            <Text type="secondary">Evaluated model: </Text>
            {evaluatedFamily ? (
              <Text>{providerLabel(evaluatedFamily)} (from the connection test)</Text>
            ) : (
              <Text type="secondary">family not known yet; test the connection in step 1</Text>
            )}
          </div>
          {(sameFamilyWarning || selectedSameFamily) && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 8 }}
              message={selectedSameFamily && !sameFamilyWarning
                ? 'This provider is the evaluated model\'s family'
                : 'The evaluator model shares a family with the evaluated model'}
              description="A model evaluating its own family tends to favor it. Runs still go ahead, and their evaluator scores carry this warning; pick an evaluator model from another provider to clear it."
            />
          )}

          {suggestedJudge && (
            <div style={{ marginTop: 8 }}>
              <Text style={{ fontSize: 12 }}>
                Recommended for{' '}
                <Text code>{configuredModel || suggestedJudge.detected}</Text>:{' '}
                <Text strong>{providerLabel(suggestedJudge.provider)} {suggestedJudge.model}</Text>
              </Text>
              <Button
                size="small"
                style={{ marginLeft: 8 }}
                onClick={() => {
                  judgeForm.setFieldsValue({
                    provider: suggestedJudge.provider,
                    model: suggestedJudge.model,
                    model_under_test_family: suggestedJudge.detected,
                  });
                }}
              >
                Use This
              </Button>
            </div>
          )}

          <Collapse
            ghost
            size="small"
            style={{ marginTop: 4, marginLeft: -12 }}
            items={[
              {
                key: 'why',
                label: <Text style={{ fontSize: 12 }}>Choosing an evaluator model</Text>,
                children: (
                  <div style={{ fontSize: 12 }}>
                    <p style={{ marginTop: 0 }}>
                      An evaluator model scores natural-language response quality
                      that automated checks can't measure.
                    </p>
                    <p style={{ marginBottom: 0 }}>
                      To prevent bias, select an evaluator model from a different
                      family than your evaluated model.
                    </p>
                  </div>
                ),
              },
            ]}
          />
        </Card>

        <Card size="small" type="inner">
          <Form form={judgeForm} layout="vertical" size="small" onFinish={saveJudge}>
            <Form.Item name="provider" label="Provider" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: 'openai', label: 'OpenAI' },
                  { value: 'anthropic', label: 'Anthropic' },
                  { value: 'gemini', label: 'Gemini' },
                ]}
                placeholder="Select a provider"
              />
            </Form.Item>
            <Form.Item name="model" label={labelWithInfo('Model ID', 'The evaluator model id, for example claude-opus-5-5 or gpt-6.1-sol')} rules={[{ required: true }]}>
              <Input placeholder="For example, claude-opus-5-5" />
            </Form.Item>
            <Form.Item
              name="api_key"
              label={
                <span>
                  API key{' '}
                  <Tag color={judgeReady ? 'green' : 'red'}>
                    {judgeReady ? 'Stored' : 'Missing'}
                  </Tag>
                </span>
              }
              rules={[{ required: !judgeReady }]}
            >
              <Input.Password placeholder={judgeReady ? 'Leave as is to keep the stored key' : 'sk-…'} />
            </Form.Item>
            {devMode && (
              // The family comes from the connection test; a manual choice
              // stays for dev runs through a gateway the test never saw.
              <Form.Item
                name="model_under_test_family"
                label={labelWithInfo('Evaluated model family (dev)', 'Used only when the connection test did not see the evaluated model answer')}
              >
                <Select
                  allowClear
                  options={['openai', 'anthropic', 'gemini', 'mistral', 'llama'].map(
                    (v) => ({ value: v, label: providerLabel(v) }),
                  )}
                />
              </Form.Item>
            )}
            <Button
              type="primary"
              htmlType="submit"
              style={{ backgroundColor: PRIMARY_COLOR, borderColor: PRIMARY_COLOR }}
            >
              Save
            </Button>
          </Form>
        </Card>
      </Drawer>
    </div>
  );
};

export default Dashboard;
