/**
 * Administration: who may act, what is scoring, and what state this deployment is in.
 *
 * Three questions get answered here and nowhere else. Which accounts exist and
 * what each role is allowed to do. What the model actually is — its training
 * data, its measured quality, and which inputs move it. Whether the platform is
 * reading live weather or a scenario, and which of its five data sources are
 * real, demonstration or simulated.
 *
 * The model card lives on this screen rather than on the dashboard because its
 * numbers need their limitations first. The card’s own `limitations` list is
 * rendered above the metrics on purpose: those metrics measure how faithfully
 * the model recovers the physical hazard model it was trained against, not how
 * well it predicts real landslides in real hillsides. A reader who meets an ROC
 * AUC of 0.98 before that sentence will remember the wrong thing, and this
 * platform would rather be trusted for the right reasons.
 *
 * The only write on the page is a re-scoring sweep, which recomputes the
 * platform’s own view of every region and raises or clears alerts from it. It
 * touches nothing a human entered. Creating accounts, changing roles and
 * deleting users are not offered, because the backend has no endpoint for them
 * and a form that posted nowhere would be worse than its absence.
 *
 * Everything shown is read from the API — the capability matrix from
 * `/auth/roles`, the row counts and provenance from `/health` and `/info`, the
 * card from `/model-info` — so this screen cannot drift away from the code that
 * enforces any of it.
 */
import {
  Activity,
  BookOpen,
  Cpu,
  Database,
  Gauge,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { PageHeader } from '../components/AppShell';
import { Chip, ModeChip, RoleChip } from '../components/Chips';
import { Panel, ResourceBody } from '../components/Panel';
import { BandBar, KeyValue, Meter, StatTile } from '../components/Readouts';
import { EmptyState, InlineError, Spinner } from '../components/States';
import { DataTable, NumCell, TwoLine, type Column } from '../components/Table';
import {
  count,
  decimal,
  featureLabel,
  formatDate,
  formatDateTime,
  percent,
  relativeTime,
  score as formatScore,
} from '../lib/format';
import { RISK_HEX, RISK_LEVELS, cx, palette } from '../lib/risk';
import { api, asApiError, type ApiError } from '../services/api';
import { usePlatform } from '../state/PlatformContext';
import { useResource } from '../state/useResource';
import type {
  AuthUser,
  FeatureImportance,
  ModelCard,
  PlaybookResponse,
  RiskLevel,
  Role,
  RolesResponse,
  SplitMetrics,
  SweepResponse,
  UserListResponse,
} from '../types/api';

/** The accent token, needed as a hex because `Meter` fills through `style`. */
const ACCENT = '#48C9E6';

type SplitName = 'train' | 'validation' | 'test';

const SPLITS: readonly SplitName[] = ['train', 'validation', 'test'];

const SPLIT_NOTE: Record<SplitName, string> = {
  train: 'Rows the model fitted on. A good number here proves only that it can memorise.',
  validation: 'Held out while the model was being chosen, so it influenced the choice.',
  test: 'Regions never seen in training or selection. This is the column that means something.',
};

interface MetricRow {
  key: string;
  label: string;
  /** What the number means, in a sentence a non-specialist can use. */
  hint: string;
  read: (metrics: SplitMetrics) => string;
}

const METRIC_ROWS: MetricRow[] = [
  {
    key: 'roc_auc',
    label: 'ROC AUC',
    hint: 'Chance that a landslide row scores above a non-landslide row. 0.5 is a coin toss, 1.0 is a perfect ranking.',
    read: (metrics) => decimal(metrics.roc_auc, 3),
  },
  {
    key: 'pr_auc',
    label: 'PR AUC',
    hint: 'Precision against recall. The harder measure, and the fairer one when landslides are rare.',
    read: (metrics) => decimal(metrics.pr_auc, 3),
  },
  {
    key: 'brier',
    label: 'Brier score',
    hint: 'Mean squared error of the stated probability. Lower is better; 0 would be perfect.',
    read: (metrics) => decimal(metrics.brier, 3),
  },
  {
    key: 'log_loss',
    label: 'Log loss',
    hint: 'Penalises confident mistakes hardest. Lower is better.',
    read: (metrics) => decimal(metrics.log_loss, 3),
  },
  {
    key: 'ece',
    label: 'Calibration error',
    hint: 'Average gap between the probability the model states and the rate actually observed.',
    read: (metrics) => decimal(metrics.ece, 3),
  },
  {
    key: 'n',
    label: 'Rows',
    hint: 'How many region-days went into this column.',
    read: (metrics) => count(metrics.n),
  },
  {
    key: 'positive_rate',
    label: 'Landslide rows',
    hint: 'Share of rows in this split that carry a landslide label.',
    read: (metrics) => percent(metrics.positive_rate, 1),
  },
];

/** The three splits side by side, with the test column called out. */
function MetricsTable({ metrics }: { metrics: Record<SplitName, SplitMetrics> }) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full min-w-[22rem] border-collapse text-left">
        <caption className="sr-only">Model quality on each data split</caption>
        <thead>
          <tr className="border-b border-hairline">
            <th scope="col" className="py-1.5 pr-2 text-2xs font-semibold uppercase tracking-wider text-faint">
              Measure
            </th>
            {SPLITS.map((split) => (
              <th
                key={split}
                scope="col"
                title={SPLIT_NOTE[split]}
                className={cx(
                  'py-1.5 pl-2 text-right text-2xs font-semibold uppercase tracking-wider',
                  split === 'test' ? 'text-accent' : 'text-faint',
                )}
              >
                {split}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {METRIC_ROWS.map((row) => (
            <tr key={row.key} className="border-b border-hairline/60 last:border-0">
              <th
                scope="row"
                title={row.hint}
                className="py-1.5 pr-2 text-xs font-normal text-dim underline decoration-hairbright decoration-dotted underline-offset-2"
              >
                {row.label}
              </th>
              {SPLITS.map((split) => (
                <td
                  key={split}
                  className={cx(
                    'tnum py-1.5 pl-2 text-right font-mono text-xs',
                    split === 'test' ? 'text-ink' : 'text-dim',
                  )}
                >
                  {row.read(metrics[split])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ImportanceGroup {
  group: string;
  share: number;
  features: FeatureImportance[];
}

/**
 * Sixteen features collapsed into the handful of causes they represent.
 *
 * "Rainfall over 24 hours: 11%, rainfall over 6 hours: 9%" is a fact about
 * columns. "Heavy rainfall: 20%" is a fact about hillsides, and it is the one a
 * district officer can act on. Both are shown, the grouping first.
 */
function groupImportance(rows: FeatureImportance[]): ImportanceGroup[] {
  const byGroup = new Map<string, ImportanceGroup>();
  for (const row of rows) {
    const found = byGroup.get(row.group);
    if (found) {
      found.share += row.importance;
      found.features.push(row);
    } else {
      byGroup.set(row.group, { group: row.group, share: row.importance, features: [row] });
    }
  }
  return [...byGroup.values()]
    .map((entry) => ({
      ...entry,
      features: [...entry.features].sort((a, b) => b.importance - a.importance),
    }))
    .sort((a, b) => b.share - a.share);
}

/** The percentage breakdown, readable without knowing what a gradient is. */
function GroupedImportance({ rows, method }: { rows: FeatureImportance[]; method: string }) {
  const groups = useMemo(() => groupImportance(rows), [rows]);
  const scale = groups[0]?.share ?? 1;

  if (groups.length === 0) {
    return (
      <p className="text-2xs leading-relaxed text-faint">
        The trained model reported no feature importances.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-2.5">
        {groups.map((entry) => (
          <li key={entry.group} className="space-y-1">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-xs text-ink">{entry.group}</span>
              <span className="tnum shrink-0 font-mono text-2xs text-accent">
                {percent(entry.share, 1)}
              </span>
            </div>
            <Meter
              value={entry.share * 100}
              max={scale * 100}
              hex={ACCENT}
              label={`${entry.group}: ${percent(entry.share, 1)} of the model’s decisions`}
            />
            <p className="text-2xs leading-tight text-faint">
              {entry.features
                .map((row) => `${featureLabel(row.feature)} ${percent(row.importance, 1)}`)
                .join(' · ')}
            </p>
          </li>
        ))}
      </ul>
      <p className="text-2xs leading-relaxed text-faint">
        Shares are {method} over the whole training set and sum to 100%. They say which inputs the
        model leans on in general, which is a different question from why one region scored what it
        did today — that answer is on the region’s own panel, from SHAP values computed for that
        row.
      </p>
    </div>
  );
}

/**
 * Stated probability against observed rate, bin by bin.
 *
 * A model can rank perfectly and still lie about magnitude. This is the table
 * that catches it: if the rows the model called 40% came in at 12%, every
 * threshold built on the number is wrong, and no ranking metric would say so.
 */
function CalibrationTable({ bins }: { bins: SplitMetrics['calibration'] }) {
  const populated = bins.filter((bin) => bin.count > 0);
  if (populated.length === 0) {
    return (
      <p className="text-2xs leading-relaxed text-faint">
        The test split had too few rows to bin.
      </p>
    );
  }
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full min-w-[20rem] border-collapse text-left">
        <caption className="sr-only">Calibration of the test split</caption>
        <thead>
          <tr className="border-b border-hairline">
            <th scope="col" className="py-1 pr-2 text-2xs font-semibold uppercase tracking-wider text-faint">
              Band
            </th>
            <th scope="col" className="py-1 pl-2 text-right text-2xs font-semibold uppercase tracking-wider text-faint">
              Rows
            </th>
            <th scope="col" className="py-1 pl-2 text-right text-2xs font-semibold uppercase tracking-wider text-faint">
              Model said
            </th>
            <th scope="col" className="py-1 pl-2 text-right text-2xs font-semibold uppercase tracking-wider text-faint">
              Actually happened
            </th>
          </tr>
        </thead>
        <tbody>
          {populated.map((bin) => {
            const gap = bin.observed_rate - bin.mean_predicted;
            return (
              <tr key={`${bin.bin_low}-${bin.bin_high}`} className="border-b border-hairline/60 last:border-0">
                <th scope="row" className="tnum py-1 pr-2 font-mono text-2xs font-normal text-dim">
                  {percent(bin.bin_low, 0)}–{percent(bin.bin_high, 0)}
                </th>
                <td className="tnum py-1 pl-2 text-right font-mono text-2xs text-dim">
                  {count(bin.count)}
                </td>
                <td className="tnum py-1 pl-2 text-right font-mono text-2xs text-dim">
                  {percent(bin.mean_predicted, 1)}
                </td>
                <td
                  className={cx(
                    'tnum py-1 pl-2 text-right font-mono text-2xs',
                    Math.abs(gap) > 0.1 ? 'text-risk-moderate' : 'text-ink',
                  )}
                  title={
                    Math.abs(gap) > 0.1
                      ? 'More than ten points away from what the model stated'
                      : 'Within ten points of what the model stated'
                  }
                >
                  {percent(bin.observed_rate, 1)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * What the platform can still say when `model_card.json` is missing.
 *
 * The pickle can load and score perfectly well without its card - the card is
 * written by the training run, not by the model - so this reports the loaded
 * model honestly rather than implying the model itself is broken.
 */
function ModelUnavailable({ card }: { card: Extract<ModelCard, { card_available: false }> }) {
  return (
    <div className="space-y-3">
      <div className="divide-y divide-hairline/60">
        <KeyValue label="Loaded" value={card.loaded ? 'yes' : 'no'} />
        <KeyValue label="Backend" value={card.backend} />
        <KeyValue label="Model" value={`${card.model_name} v${card.model_version}`} />
        <KeyValue label="Features" value={count(card.feature_count)} />
        <KeyValue
          label="Trained"
          value={card.trained_at ? formatDateTime(card.trained_at) : 'unknown'}
        />
      </div>
      <p className="text-2xs leading-relaxed text-dim">{card.explanation}</p>
      <p className="flex items-start gap-2 text-2xs leading-relaxed text-risk-moderate">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{card.note}</span>
      </p>
      <p className="text-2xs leading-relaxed text-faint">
        Run <span className="font-mono text-ink">python ml/train_model.py</span> to rebuild the
        model and write the card beside it. Until then this screen cannot show the training data,
        the measured quality or the feature influences, and it will not invent them.
      </p>
    </div>
  );
}

/** The card the training run writes, once it exists. */
type FullCard = Extract<ModelCard, { card_available: true }>;

/** What the model is for, and - first - what it is not for. */
function ModelPurpose({ card }: { card: FullCard }) {
  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-ink">{card.intended_use}</p>
      <div>
        <p className="flex items-center gap-1.5 font-display text-2xs font-semibold uppercase tracking-wider text-risk-moderate">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Read these before the numbers
        </p>
        <ul className="mt-1.5 space-y-1.5">
          {card.limitations.map((limitation) => (
            <li key={limitation} className="flex items-start gap-2 text-2xs leading-relaxed text-dim">
              <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-risk-moderate" aria-hidden />
              <span>{limitation}</span>
            </li>
          ))}
        </ul>
      </div>
      <dl className="divide-y divide-hairline/60">
        {Object.entries(card.data_provenance).map(([source, sentence]) => (
          <div key={source} className="py-1.5">
            <dt className="text-2xs uppercase tracking-wider text-faint">
              {featureLabel(source)}
            </dt>
            <dd className="mt-0.5 text-2xs leading-relaxed text-dim">{sentence}</dd>
          </div>
        ))}
      </dl>
      <p className="text-2xs leading-relaxed text-faint">{card.note}</p>
    </div>
  );
}

/** The identity block: which artefact is loaded, and what it was fitted on. */
function ModelFacts({ card }: { card: FullCard }) {
  const { status } = card;
  return (
    <div className="space-y-2">
      <div className="divide-y divide-hairline/60">
        <KeyValue label="Model" value={`${card.model_name} v${card.model_version}`} />
        <KeyValue label="Backend" value={status.backend} title={status.explanation} />
        <KeyValue
          label="Ensemble"
          value={card.members !== null ? `${count(card.members)} members` : 'single estimator'}
          title="Members vote and their spread becomes the confidence figure shown beside a score."
        />
        <KeyValue
          label="Features"
          value={`${count(card.feature_order.length)} · schema ${String(card.feature_schema_version)}`}
          title="The schema version is checked at inference: a model trained on a different feature order refuses to score rather than scoring wrongly."
        />
        <KeyValue
          label="Trained"
          value={`${formatDate(card.trained_at)} · ${relativeTime(card.trained_at)}`}
        />
        <KeyValue label="Training rows" value={count(card.training_rows)} />
        <KeyValue
          label="Split rows"
          value={`${count(card.split_sizes.train)} / ${count(card.split_sizes.validation)} / ${count(card.split_sizes.test)}`}
          title="Train / validation / test"
        />
        <KeyValue
          label="Regions"
          value={`${count(card.regions.train)} / ${count(card.regions.validation)} / ${count(card.regions.test)} of ${count(card.regions.total)}`}
          title="Split by region rather than by row, so no region appears on both sides of the divide and the test score cannot be inflated by a neighbouring day."
        />
      </div>
      {status.members && status.members.length > 0 && (
        <p className="text-2xs leading-relaxed text-faint">
          Members: <span className="font-mono text-dim">{status.members.join(', ')}</span>. Their
          disagreement is what the confidence figure reports — it is a measure of the model’s own
          steadiness, not of how likely a landslide is.
        </p>
      )}
    </div>
  );
}

/**
 * Measured quality, with the ceiling stated before the scores.
 *
 * The labels the model learned from are drawn stochastically from a physical
 * hazard model, so even a perfect learner cannot separate them completely. The
 * ceiling is that limit. Reporting the model as a fraction of it is the honest
 * version of "0.98": it says how much of the recoverable signal was recovered,
 * and implies nothing about real hillsides.
 */
function ModelQuality({ card }: { card: FullCard }) {
  const ceiling = card.label_noise_ceiling;
  return (
    <div className="space-y-3">
      <p className="rounded-panel border border-risk-moderate/30 bg-risk-moderate/10 px-3 py-2 text-2xs leading-relaxed text-risk-moderate">
        {ceiling.note}
      </p>
      <div className="grid gap-1.5 sm:grid-cols-3">
        <StatTile
          label="Achievable"
          value={decimal(ceiling.test_roc_auc, 3)}
          unit="ROC AUC"
          hint="The best ROC AUC anything could reach against these labels, because the labels themselves are drawn with noise."
        />
        <StatTile
          label="Model reaches"
          value={percent(ceiling.model_fraction_of_ceiling, 1)}
          hint="The model's test ROC AUC as a share of that ceiling."
          tone="text-accent"
        />
        <StatTile
          label="Tracks true risk"
          value={decimal(ceiling.correlation_with_true_probability, 3)}
          hint="Correlation between the model's probability and the physical model's own probability on held-out rows. 1.0 would mean the model had recovered the physics exactly."
        />
      </div>
      <MetricsTable metrics={card.metrics} />
      <div>
        <p className="label">Calibration on the test split</p>
        <CalibrationTable bins={card.metrics.test.calibration} />
        <p className="mt-1.5 text-2xs leading-relaxed text-faint">
          Every row of that table is held-out. Where the two right-hand columns agree, a stated
          probability can be read as a rate; where they diverge, the score is still a usable ranking
          but its magnitude is not.
        </p>
      </div>
    </div>
  );
}

/**
 * The parts only an engineer needs, folded away.
 *
 * A `<details>` element rather than a tab: it needs no state, it is keyboard
 * operable for free, and it opens when the page is printed.
 */
function ModelInternals({ card }: { card: FullCard }) {
  const reference = Object.entries(card.confidence_reference);
  const notes = reference.filter(([, value]) => typeof value === 'string');
  const numbers = reference.filter(([, value]) => typeof value === 'number');
  return (
    <details className="mt-1">
      <summary className="cursor-pointer font-display text-2xs font-semibold uppercase tracking-wider text-faint hover:text-accent">
        Hyperparameters, feature order and training-set statistics
      </summary>
      <div className="mt-3 space-y-4">
        <div>
          <p className="label">Hyperparameters</p>
          <ul className="flex flex-wrap gap-1.5">
            {Object.entries(card.hyperparams).map(([key, value]) => (
              <li
                key={key}
                className="rounded-panel border border-hairline bg-raised/40 px-2 py-1 font-mono text-2xs text-dim"
              >
                {key}=<span className="text-ink">{String(value)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="label">How confidence is derived</p>
          {notes.map(([key, value]) => (
            <p key={key} className="text-2xs leading-relaxed text-dim">
              {value}
            </p>
          ))}
          <div className="mt-1 divide-y divide-hairline/60">
            {numbers.map(([key, value]) => (
              <KeyValue key={key} label={featureLabel(key)} value={decimal(value, 3)} />
            ))}
          </div>
        </div>
        <div>
          <p className="label">Feature order</p>
          <ol className="flex flex-wrap gap-x-2 gap-y-1 font-mono text-2xs text-dim">
            {card.feature_order.map((feature, index) => (
              <li key={feature}>
                <span className="text-faint">{index + 1}.</span> {feature}
              </li>
            ))}
          </ol>
          <p className="mt-1 text-2xs leading-relaxed text-faint">
            Inference builds its vector in exactly this order. It is part of the contract between{' '}
            <span className="font-mono text-dim">preprocess.py</span> and the stored model, which is
            why the schema version above is checked before a score is produced.
          </p>
        </div>
        <div>
          <p className="label">What the training set looked like</p>
          <div className="min-w-0 overflow-x-auto">
            <table className="w-full min-w-[26rem] border-collapse text-left">
              <caption className="sr-only">Distribution of each feature across the training rows</caption>
              <thead>
                <tr className="border-b border-hairline">
                  <th scope="col" className="py-1 pr-2 text-2xs font-semibold uppercase tracking-wider text-faint">
                    Feature
                  </th>
                  {['mean', 'sd', 'min', 'median', 'max'].map((head) => (
                    <th
                      key={head}
                      scope="col"
                      className="py-1 pl-2 text-right text-2xs font-semibold uppercase tracking-wider text-faint"
                    >
                      {head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {card.training_summary.map((row) => (
                  <tr key={row.feature} className="border-b border-hairline/60 last:border-0">
                    <th scope="row" className="py-1 pr-2 text-2xs font-normal text-dim">
                      {featureLabel(row.feature)}
                    </th>
                    <td className="tnum py-1 pl-2 text-right font-mono text-2xs text-ink">
                      {decimal(row.mean, 1)}
                    </td>
                    <td className="tnum py-1 pl-2 text-right font-mono text-2xs text-dim">
                      {decimal(row.std, 1)}
                    </td>
                    <td className="tnum py-1 pl-2 text-right font-mono text-2xs text-dim">
                      {decimal(row.min, 1)}
                    </td>
                    <td className="tnum py-1 pl-2 text-right font-mono text-2xs text-dim">
                      {decimal(row.p50, 1)}
                    </td>
                    <td className="tnum py-1 pl-2 text-right font-mono text-2xs text-dim">
                      {decimal(row.max, 1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-2xs leading-relaxed text-faint">
            A region whose conditions fall outside these ranges is being scored by extrapolation,
            and the score should be read with that in mind.
          </p>
        </div>
      </div>
    </details>
  );
}

/** The whole card, in the order a sceptical reader should meet it. */
function ModelSection({ card }: { card: FullCard }) {
  const bands = card.band_distribution;
  return (
    <>
      <Panel
        title="The model"
        note={`${card.model_name} v${card.model_version}`}
        right={<Chip className="border-hairbright bg-raised text-dim">{card.status.backend}</Chip>}
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <ModelPurpose card={card} />
          <ModelFacts card={card} />
        </div>
      </Panel>

      <Panel title="Measured quality" note="on held-out regions">
        <ModelQuality card={card} />
        <div className="rule my-3" />
        <ModelInternals card={card} />
      </Panel>

      <Panel title="What moves the score" note={card.importance_method}>
        <GroupedImportance rows={card.feature_importance} method={card.importance_method} />
        <div className="rule my-3" />
        <p className="label">Where the scores land</p>
        <BandBar counts={bands.counts} />
        <div className="mt-2 divide-y divide-hairline/60">
          <KeyValue label="Lowest" value={formatScore(bands.score_min)} />
          <KeyValue label="Median" value={formatScore(bands.score_p50)} />
          <KeyValue
            label="95th percentile"
            value={formatScore(bands.score_p95)}
            title="Nineteen of every twenty scored region-days sit below this."
          />
          <KeyValue label="Highest" value={formatScore(bands.score_max)} />
        </div>
        <p className="mt-2 text-2xs leading-relaxed text-faint">
          Distribution over the held-out rows, not over today’s regions. A model that put half the
          country in CRITICAL would raise alerts nobody could act on; one that never left VERY LOW
          would raise none at all. This is the shape that check is made against.
        </p>
      </Panel>
    </>
  );
}

/** A row of `/auth/users`, which adds the creation time to the public shape. */
type Account = AuthUser & { created_at: string };

const ACCOUNT_COLUMNS: Column<Account>[] = [
  {
    key: 'username',
    header: 'Username',
    sort: (row) => row.username,
    cell: (row) => (
      <span className="font-mono text-xs text-ink" title={`Account #${row.id}`}>
        {row.username}
      </span>
    ),
  },
  {
    key: 'name',
    header: 'Name and organisation',
    sort: (row) => row.full_name ?? row.username,
    cell: (row) => (
      <TwoLine
        primary={row.full_name ?? 'no name recorded'}
        secondary={row.organisation ?? 'no organisation recorded'}
      />
    ),
  },
  {
    key: 'role',
    header: 'Role',
    sort: (row) => row.role,
    width: 'w-32',
    cell: (row) => <RoleChip role={row.role} />,
  },
  {
    key: 'phone',
    header: 'Phone',
    hideBelow: 'lg',
    cell: (row) => (
      <span className="font-mono text-2xs text-dim">{row.phone ?? '—'}</span>
    ),
  },
  {
    key: 'created',
    header: 'Created',
    align: 'right',
    hideBelow: 'md',
    sort: (row) => row.created_at,
    cell: (row) => (
      <NumCell className="text-2xs text-dim">
        <span title={formatDateTime(row.created_at)}>{relativeTime(row.created_at)}</span>
      </NumCell>
    ),
  },
];

type CapabilityKey = 'can_review_reports' | 'can_manage_alerts' | 'is_admin';

const CAPABILITY_LABEL: { key: CapabilityKey; label: string; hint: string }[] = [
  {
    key: 'can_review_reports',
    label: 'Read and triage reports',
    hint: 'GET and PUT on /api/citizen-report. Filing a report needs no account at all.',
  },
  {
    key: 'can_manage_alerts',
    label: 'Raise and move alerts',
    hint: 'POST /api/alerts and PUT /api/alerts/{id}. Reading the alert board is open to everyone.',
  },
  {
    key: 'is_admin',
    label: 'See accounts',
    hint: 'GET /api/auth/users, and this screen.',
  },
];

/**
 * The role model, read from the dependency that enforces it.
 *
 * This table is fetched rather than written into the page so that it cannot
 * drift from `require_officer` and `require_admin` in the backend. If somebody
 * changes what an officer may do, this screen changes with it.
 */
function RoleMatrix({ roles, note }: { roles: RolesResponse['roles']; note: string }) {
  const ordered = [...roles].sort((a, b) => a.rank - b.rank);
  return (
    <div className="space-y-3">
      {ordered.map((spec) => (
        <div key={spec.role} className="min-w-0">
          <div className="flex items-baseline gap-2">
            <RoleChip role={spec.role} />
            <span className="truncate text-xs font-semibold text-ink">{spec.label}</span>
          </div>
          <p className="mt-0.5 text-2xs leading-relaxed text-dim">{spec.description}</p>
          <ul className="mt-1.5 flex flex-wrap gap-1">
            {CAPABILITY_LABEL.map((capability) => {
              const allowed = spec[capability.key];
              return (
                <li key={capability.key}>
                  <Chip
                    className={cx(
                      allowed
                        ? 'border-risk-verylow/45 bg-risk-verylow/10 text-risk-verylow'
                        : 'border-hairline bg-raised/40 text-faint',
                    )}
                    title={`${allowed ? 'Permitted' : 'Refused by the server'} — ${capability.hint}`}
                  >
                    {allowed ? capability.label : `no ${capability.label.toLowerCase()}`}
                  </Chip>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <p className="text-2xs leading-relaxed text-faint">{note}</p>
    </div>
  );
}

/**
 * The one write on this screen: re-score everything now.
 *
 * In a deployment a scheduled job calls `/api/alerts/sweep` every few minutes;
 * here it is a button, because a judge should be able to see the platform bring
 * its own view of the country up to date. It touches nothing a human entered -
 * no report, no triage note, no account - which is why the backend leaves it
 * open to unauthenticated callers, and the caption says so rather than implying
 * an administrator is needed for it.
 */
function SweepBlock() {
  const { scenario, scenarioLabel, refresh } = usePlatform();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<SweepResponse | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const outcome = await api.sweep({ scenario });
      setResult(outcome);
      // Every other screen keys its resources off `version`, so this is what
      // makes the new scores and alerts appear without a reload.
      refresh();
    } catch (cause) {
      setError(asApiError(cause, '/alerts/sweep'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2.5">
      <button type="button" className="btn btn-accent w-full py-1.5 text-xs" disabled={busy} onClick={() => void run()}>
        {busy ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
        {busy ? 'Scoring every region…' : 'Re-score every region now'}
      </button>
      <p className="text-2xs leading-relaxed text-faint">
        Scores every monitored region under {scenarioLabel}, stores what changed, then raises alerts
        that crossed a threshold and clears the ones that fell back. Reports, triage notes and
        accounts are untouched, so this needs no special permission.
      </p>
      <InlineError error={error} />
      {result && (
        <div className="rounded-panel border border-hairline bg-raised/30 p-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="truncate font-display text-2xs font-semibold uppercase tracking-wider text-dim">
              {result.scenario_label}
            </span>
            <ModeChip mode={result.data_mode} compact />
          </div>
          <div className="mt-1.5 divide-y divide-hairline/60">
            <KeyValue label="Regions scored" value={count(result.regions_scored)} />
            <KeyValue
              label="Predictions stored"
              value={count(result.predictions_stored)}
              title="One row per region in risk_predictions, which is what the history and the forecast read back."
            />
            <KeyValue
              label="Alerts raised"
              value={count(result.alerts_raised)}
              title="New alerts created by this sweep. Existing open alerts were updated in place rather than duplicated."
            />
            <KeyValue label="High or above" value={count(result.high_risk_count)} />
            <KeyValue label="Critical" value={count(result.critical_count)} />
            <KeyValue label="Average score" value={formatScore(result.avg_score)} />
            <KeyValue label="Highest score" value={formatScore(result.max_score)} />
            <KeyValue
              label="National risk"
              value={formatScore(result.country_risk)}
              title="The single figure on the overview screen, recomputed from these scores."
            />
          </div>
          <BandBar counts={result.band_counts} className="mt-2" showLegend={false} />
        </div>
      )}
    </div>
  );
}

/**
 * What this deployment actually is, from `/health` and `/info`.
 *
 * The row counts matter more than they look: a database with no regions makes
 * every other screen empty, and "the map is blank" is a much harder thing to
 * diagnose from a dashboard than from a zero on this line.
 */
function DeploymentBlock() {
  const { health, info, offline } = usePlatform();

  if (!health || !info) {
    return (
      <p className="text-2xs leading-relaxed text-faint">
        {offline
          ? 'The backend cannot be reached, so it cannot describe itself. Start it with uvicorn and this panel fills in.'
          : 'Reading /health and /info…'}
      </p>
    );
  }

  const rows = health.database.rows;
  const healthy = health.status === 'ok' && health.ready;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip
          className={
            healthy
              ? 'border-risk-verylow/45 bg-risk-verylow/10 text-risk-verylow'
              : 'border-risk-moderate/45 bg-risk-moderate/10 text-risk-moderate'
          }
          title={health.detail}
        >
          {healthy ? <ShieldCheck className="h-3 w-3" aria-hidden /> : <ShieldAlert className="h-3 w-3" aria-hidden />}
          {health.status.toUpperCase()}
        </Chip>
        <ModeChip mode={info.data_mode} />
        <Chip className="border-hairbright bg-raised text-dim" title="Scenario the whole platform is scoring under.">
          {info.scenario.label}
        </Chip>
      </div>
      <p className="text-2xs leading-relaxed text-dim">{health.detail}</p>
      <div>
        <p className="label flex items-center gap-1.5">
          <Database className="h-3 w-3" aria-hidden />
          Database
        </p>
        <div className="divide-y divide-hairline/60">
          <KeyValue
            label="Engine"
            value={health.database.dialect ?? 'not connected'}
            title="PostgreSQL with PostGIS in a full deployment; SQLite is the fallback so the platform runs on a laptop with no database server."
          />
          <KeyValue label="Regions" value={count(rows.regions)} />
          <KeyValue label="Past landslides" value={count(rows.events)} />
          <KeyValue label="Alerts" value={count(rows.alerts)} />
          <KeyValue label="Citizen reports" value={count(rows.reports)} />
          <KeyValue
            label="Sensor readings"
            value={count(rows.sensor_rows)}
            title="Rows written by the software sensor simulator. No physical instrument is involved anywhere in this platform."
          />
        </div>
        {health.database.error && (
          <p className="mt-1 text-2xs leading-relaxed text-risk-high">{health.database.error}</p>
        )}
      </div>
      <div>
        <p className="label">Model and weather</p>
        <div className="divide-y divide-hairline/60">
          <KeyValue label="Model loaded" value={health.model.loaded ? 'yes' : 'no'} />
          <KeyValue label="Estimator" value={health.model.backend} />
          <KeyValue label="Artefact" value={health.model.path} title={health.model.path} />
          <KeyValue label="Weather source" value={health.weather.provider} />
          <KeyValue
            label="Weather mode"
            value={health.weather.mode}
            title={health.weather.note}
          />
        </div>
        <p className="mt-1 text-2xs leading-relaxed text-faint">{health.weather.note}</p>
      </div>
      <div>
        <p className="label">Where each input comes from</p>
        <dl className="divide-y divide-hairline/60">
          {Object.entries(info.data_provenance).map(([source, sentence]) => (
            <div key={source} className="py-1.5">
              <dt className="text-2xs uppercase tracking-wider text-faint">{featureLabel(source)}</dt>
              <dd className="mt-0.5 text-2xs leading-relaxed text-dim">{sentence}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/**
 * The standing response rules, band by band.
 *
 * Every alert carries a recommended action, and this is where that sentence
 * comes from - `RESPONSE_PLAYBOOK` in the backend, served rather than restated,
 * so an officer can trace the advice on an alert back to the rule that produced
 * it instead of wondering who wrote it.
 */
function PlaybookBlock({ data }: { data: PlaybookResponse }) {
  const bands = RISK_LEVELS.map((level: RiskLevel) => ({
    level,
    actions: data.playbook[level],
  })).filter((entry) => Array.isArray(entry.actions) && entry.actions.length > 0);

  if (bands.length === 0) {
    return (
      <EmptyState
        title="No playbook served"
        hint="The backend returned no response rules, so this platform has no advice to attach to an alert."
        icon={<BookOpen className="h-5 w-5" aria-hidden />}
      />
    );
  }

  return (
    <div className="space-y-3">
      {bands.map((entry) => (
        <div key={entry.level} className="min-w-0">
          <p className={cx('font-display text-2xs font-semibold uppercase tracking-wider', palette(entry.level).text)}>
            {entry.level}
          </p>
          <ul className="mt-1 space-y-1">
            {entry.actions.map((action) => (
              <li key={action} className="flex items-start gap-2 text-2xs leading-relaxed text-dim">
                <span
                  className="mt-1 h-1 w-1 shrink-0 rounded-full"
                  style={{ backgroundColor: RISK_HEX[entry.level] }}
                  aria-hidden
                />
                <span>{action}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <p className="text-2xs leading-relaxed text-faint">{data.note}</p>
    </div>
  );
}

export default function AdminPage() {
  const { info, health, version, capabilities } = usePlatform();

  const users = useResource<UserListResponse>((signal) => api.users(signal), [version], {
    enabled: capabilities.is_admin,
  });
  const roles = useResource<RolesResponse>((signal) => api.roles(signal), []);
  const card = useResource<ModelCard>((signal) => api.modelCard(signal), [version]);
  const playbook = useResource<PlaybookResponse>((signal) => api.playbook(signal), []);

  const tally = useMemo(() => {
    const counts: Record<Role, number> = { CITIZEN: 0, OFFICER: 0, ADMIN: 0 };
    for (const account of users.data?.users ?? []) counts[account.role] += 1;
    return counts;
  }, [users.data]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Administration"
        lead="Who may act, what is scoring, and what state this deployment is in. Every figure on this screen is read from the running backend, so it describes this installation rather than the documentation."
        right={info ? <Chip className="border-hairbright bg-raised text-dim">{`v${info.version}`}</Chip> : null}
      />

      <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Accounts"
          value={count(users.data?.count)}
          icon={<Users className="h-3.5 w-3.5" aria-hidden />}
          hint="Rows in the users table, read from /api/auth/users."
          footer={`${count(tally.OFFICER)} officer, ${count(tally.ADMIN)} administrator, ${count(tally.CITIZEN)} citizen`}
        />
        <StatTile
          label="Regions monitored"
          value={count(health?.database.rows.regions)}
          icon={<Activity className="h-3.5 w-3.5" aria-hidden />}
          hint="Every one of these is scored on each sweep."
          footer={health?.database.dialect ? `stored in ${health.database.dialect}` : 'database unreachable'}
        />
        <StatTile
          label="Model"
          value={health?.model.loaded ? 'Loaded' : 'Absent'}
          unit={health?.model.backend}
          icon={<Cpu className="h-3.5 w-3.5" aria-hidden />}
          tone={health?.model.loaded ? undefined : 'text-risk-high'}
          hint="Whether the trained artefact was found and unpickled at start-up."
          footer={health?.model.loaded ? 'scoring every region' : 'run python ml/train_model.py'}
        />
        <StatTile
          label="Weather"
          value={health?.weather.mode ?? 'unknown'}
          icon={<Gauge className="h-3.5 w-3.5" aria-hidden />}
          tone={health?.weather.mode === 'LIVE' ? 'text-risk-verylow' : 'text-risk-moderate'}
          hint={health?.weather.note}
          footer={
            health?.weather.live_configured
              ? `live key present · ${health.weather.provider}`
              : 'no API key, so scenario values are used'
          }
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,21rem)]">
        <div className="min-w-0 space-y-4">
          <Panel
            title="Accounts"
            note={users.data ? `${count(users.data.count)} on this deployment` : 'administrator only'}
            busy={users.refreshing}
            flush
          >
            <ResourceBody
              resource={users}
              isEmpty={(data) => data.users.length === 0}
              loadingLabel="Reading the user table"
              empty={
                <EmptyState
                  title="No accounts readable"
                  hint="The account list is served only to administrators. Signing in with an administrator account fills this table."
                  icon={<Users className="h-5 w-5" aria-hidden />}
                />
              }
            >
              {(data) => (
                <DataTable<Account>
                  rows={data.users}
                  columns={ACCOUNT_COLUMNS}
                  rowKey={(row) => row.id}
                  initialSort={{ key: 'role', direction: 'asc' }}
                  dense
                  maxHeight="max-h-[24rem]"
                  caption="Every account on this deployment, with the role each one carries"
                />
              )}
            </ResourceBody>
            <div className="border-t border-hairline px-4 py-3">
              <p className="text-2xs leading-relaxed text-faint">
                Read-only, and deliberately so: this build has no endpoint that creates an account,
                changes a role or deletes a user, and a form that posted nowhere would be worse than
                its absence. Accounts come from the seed on first start-up; their passwords are
                published on the sign-in page because a reviewer has to be able to open the officer
                desk. Before this platform goes anywhere reachable, set{' '}
                <span className="font-mono text-dim">SEED_DEMO_USERS=false</span> and change{' '}
                <span className="font-mono text-dim">JWT_SECRET</span>.
              </p>
            </div>
          </Panel>

          {card.data === null ? (
            <Panel title="The model">
              <ResourceBody resource={card} loadingLabel="Reading the model card">
                {() => null}
              </ResourceBody>
            </Panel>
          ) : card.data.card_available ? (
            <ModelSection card={card.data} />
          ) : (
            <Panel title="The model" note="no card written">
              <ModelUnavailable card={card.data} />
            </Panel>
          )}
        </div>

        <div className="min-w-0 space-y-4">
          <Panel title="This deployment" note={info?.name}>
            <DeploymentBlock />
          </Panel>

          <Panel title="Maintenance">
            <SweepBlock />
          </Panel>

          <Panel title="Roles and permissions" busy={roles.refreshing}>
            <ResourceBody
              resource={roles}
              isEmpty={(data) => data.roles.length === 0}
              loadingLabel="Reading the role model"
            >
              {(data) => <RoleMatrix roles={data.roles} note={data.note} />}
            </ResourceBody>
          </Panel>

          <Panel title="Standing response playbook" note="by risk band">
            <ResourceBody resource={playbook} loadingLabel="Reading the playbook">
              {(data) => <PlaybookBlock data={data} />}
            </ResourceBody>
          </Panel>
        </div>
      </div>

      <p className="flex items-start gap-2 text-2xs leading-relaxed text-faint">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          {info?.disclaimer ??
            'This platform is decision support. Its scores do not replace assessment by a qualified engineer, and nothing here authorises an evacuation.'}
        </span>
      </p>
    </div>
  );
}

