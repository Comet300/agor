/**
 * Feature 4 — Historical Price Graph renderer.
 *
 * Renders a {@link PricePoint} series into a PNG line chart using
 * `@napi-rs/canvas`. The output is a raw `Buffer` (per the data-out schema)
 * so callers (e.g. the Telegram layer) can ship it as a photo attachment.
 */

import { createCanvas } from '@napi-rs/canvas';
import type { PricePoint } from '../contracts/index';
import { formatMoney } from '../util/money';

/** Result of a price-history render. */
export type PriceChartResult =
  | { ok: true; png: Buffer }
  | { ok: false; reason: 'insufficient_history' | 'invalid_dimensions' };

/** Optional render tuning. */
export interface PriceChartOptions {
  title?: string;
  width?: number;
  height?: number;
}

// Inner plot padding (px) — leaves room for axis labels and an optional title.
const PADDING = { top: 48, right: 24, bottom: 36, left: 64 } as const;

/** Hard cap on plotted points: a long-lived item can accumulate thousands of
 *  change points; rendering them all wastes CPU and risks OOM on a small host. */
const MAX_POINTS = 500;
/** Upper bound on caller-supplied canvas dimensions (guards against OOM). */
const MAX_DIMENSION = 2048;

/**
 * Reduce a long series to at most {@link MAX_POINTS} points, always keeping the
 * first and last observation so the chart's endpoints stay truthful. Evenly
 * strides through the middle — enough for a faithful trend at a bounded cost.
 */
function downsample(points: PricePoint[]): PricePoint[] {
  if (points.length <= MAX_POINTS) return points;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const step = (points.length - 1) / (MAX_POINTS - 1);
  const out: PricePoint[] = [];
  for (let i = 0; i < MAX_POINTS - 1; i++) {
    out.push(points[Math.round(i * step)]!);
  }
  out.push(last);
  // Guarantee the true first point leads even if rounding skipped it.
  if (out[0] !== first) out[0] = first;
  return out;
}

/**
 * Render a simple line chart of price over time.
 *
 * @param points Raw price observations (unsorted is fine — we sort by
 *               `observedAt` internally).
 * @param opts   Optional title / dimensions (defaults to 800x400).
 * @returns      `{ ok: true, png }` or `{ ok: false, reason: 'insufficient_history' }`
 *               when fewer than two points are supplied.
 */
export function renderPriceHistory(
  points: PricePoint[],
  opts: PriceChartOptions = {},
): PriceChartResult {
  // Need at least two points to draw a meaningful line.
  if (points.length < 2) {
    return { ok: false, reason: 'insufficient_history' };
  }

  const width = opts.width ?? 800;
  const height = opts.height ?? 400;
  // Reject pathological/oversized dimensions before allocating a canvas.
  if (
    !Number.isInteger(width) || !Number.isInteger(height) ||
    width <= 0 || height <= 0 ||
    width > MAX_DIMENSION || height > MAX_DIMENSION
  ) {
    return { ok: false, reason: 'invalid_dimensions' };
  }

  // Sort chronologically without mutating the caller's array, then bound the
  // plotted-point count so a years-long history can't OOM the renderer.
  // Non-empty (length >= 2 guaranteed above), so first/last are defined.
  const sorted = downsample([...points].sort((a, b) => a.observedAt - b.observedAt));
  const firstPoint = sorted[0]!;
  const lastPoint = sorted[sorted.length - 1]!;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // ── Background ────────────────────────────────────────────────────────────
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // Plot region geometry.
  const plotLeft = PADDING.left;
  const plotTop = PADDING.top;
  const plotRight = width - PADDING.right;
  const plotBottom = height - PADDING.bottom;
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;

  // ── Price + time domains ──────────────────────────────────────────────────
  const prices = sorted.map((p) => p.price);
  let minPrice = Math.min(...prices);
  let maxPrice = Math.max(...prices);
  // Avoid a zero-height range (flat price series) — pad symmetrically.
  if (minPrice === maxPrice) {
    const pad = minPrice === 0 ? 1 : Math.abs(minPrice) * 0.1;
    minPrice -= pad;
    maxPrice += pad;
  }
  const priceSpan = maxPrice - minPrice;

  const minTime = firstPoint.observedAt;
  const maxTime = lastPoint.observedAt;
  const timeSpan = maxTime - minTime || 1; // guard against all-equal timestamps

  // Map a data point into canvas pixel space.
  const xAt = (t: number) => plotLeft + ((t - minTime) / timeSpan) * plotW;
  const yAt = (price: number) =>
    plotBottom - ((price - minPrice) / priceSpan) * plotH;

  // ── Axes ──────────────────────────────────────────────────────────────────
  ctx.strokeStyle = '#333333';
  ctx.lineWidth = 1;
  ctx.beginPath();
  // Y axis.
  ctx.moveTo(plotLeft, plotTop);
  ctx.lineTo(plotLeft, plotBottom);
  // X axis.
  ctx.lineTo(plotRight, plotBottom);
  ctx.stroke();

  // ── Price line ────────────────────────────────────────────────────────────
  ctx.strokeStyle = '#1f77b4';
  ctx.lineWidth = 2;
  ctx.beginPath();
  sorted.forEach((p, i) => {
    const x = xAt(p.observedAt);
    const y = yAt(p.price);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Plot a small marker on each observation.
  ctx.fillStyle = '#1f77b4';
  for (const p of sorted) {
    ctx.beginPath();
    ctx.arc(xAt(p.observedAt), yAt(p.price), 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── Min / max price labels ────────────────────────────────────────────────
  const currency = firstPoint.currency;
  ctx.fillStyle = '#333333';
  ctx.font = '12px sans-serif';

  // Max at the top of the Y axis, min at the bottom.
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(formatMoney(maxPrice, currency), plotLeft - 6, yAt(maxPrice));
  ctx.fillText(formatMoney(minPrice, currency), plotLeft - 6, yAt(minPrice));

  // ── Optional title ────────────────────────────────────────────────────────
  if (opts.title) {
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(opts.title, width / 2, PADDING.top / 2);
  }

  return { ok: true, png: canvas.toBuffer('image/png') };
}
