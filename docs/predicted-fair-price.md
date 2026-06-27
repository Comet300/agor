# Design: Predicted Fair Price (plan only — not yet implemented)

## Goal

Move beyond the current median benchmark (a single number across a search's
active listings) to a **per-listing predicted fair price** that accounts for the
attributes that actually drive value — for cars: year, mileage (km), fuel, power,
transmission. Then express each listing as a delta vs its own prediction
("≈ €1,800 under predicted") and a confidence band.

This sharpens the existing `dealTag` (`great_deal` / `fair_price` / `overpriced`),
which today compares price to the raw median and so calls a high-mileage 2014 car
"a great deal" just because it's below the median of a sample dominated by newer
cars.

## Why now is the right substrate

The pieces already exist:

- `IScrapedItem.attributes` carries `{ year, km, fuel, power, … }` as display
  strings (per-vendor `attributes` manifest maps).
- `items` rows persist the latest snapshot incl. `attributes_json`.
- `price_history` gives realized price trajectories.
- The benchmark stage (`src/pipeline/benchmarking.ts`) is already the place a
  per-listing expected price is computed and attached as `EnrichedItem.benchmark`.

## Approach (staged)

### Stage 0 — Attribute normalization (prerequisite)
Attributes are display strings ("145.000 km", "2.016", "Diesel"). Add a pure
`parseAttributes(attributes)` → `{ year?: number; km?: number; fuel?: string;
powerKw?: number }` with locale-aware number parsing (the `.`/`,`/space handling
we already do for prices) and a small fuel synonym map (ro/en). Lives in
`src/pipeline/attributes.ts`, fully unit-tested. **No model yet** — this alone
enables attribute *range filters* (a separately-scoped feature) and feeds the
predictor.

### Stage 1 — Per-search heuristic regression (ship first)
Per search cycle we already hold the full active sample. Fit a cheap model on
that sample alone (no cross-run state, no storage):

- Log-linear OLS: `ln(price) ~ 1 + year + km` (+ fuel as a categorical offset
  when enough samples per class). Closed-form normal equations, ~10 lines, no
  dependency.
- Predict each listing's price from its own attributes; `residual = price −
  predicted`. Surface `predictedPrice` + `residualPct` on `EnrichedItem`.
- Guardrails: require `n >= MIN_SAMPLE_FOR_MODEL` (e.g. 12) and a sane R²; else
  fall back to today's median benchmark and emit nothing new. Drop listings with
  missing year/km from the fit (but still score them via the median fallback).

This is self-contained, explainable, and needs **zero new storage** — the same
shape as the current benchmark, just attribute-aware.

### Stage 2 — Cross-run / cross-vendor model (later)
Accumulate `(attributes, price, soldOrDelisted, daysOnMarket)` into a training
table and fit a periodic, more expressive model (gradient-boosted trees) offline,
shipped as coefficients/threshold tables the bot loads. Enables predictions even
on a single-item product watch (where there's no live sample) and powers the
"cheaper-equivalent" and "is this a scam (too far below predicted)" features with
real backing. This is a meaningful infra step (training pipeline, model
artifacts, versioning) and should be its own project.

## Surfacing

- **Deal tag v2**: derive from `residualPct` vs predicted instead of vs median.
- **Card line**: "💡 ≈ €1,800 under predicted (€16,800)" on new-listing/browse
  cards when a confident prediction exists.
- **Deals-only filter**: reuse — "below predicted" replaces "below median".
- **Scam flag**: `residualPct < −X%` AND new/low-rep seller → caution note.

## Risks / open questions

- **Sparse attributes**: many listings omit km or year; the model must degrade to
  the median fallback per-listing, not fail the whole cycle.
- **Mixed currencies**: fit per currency bucket (we already bucket for the median).
- **Category generality**: the year/km model is car-shaped. For property
  (`area`, `rooms`) the feature set differs — Stage 1 should pick the feature set
  by the attributes actually present, or be gated to vendors/categories we trust.
- **Explainability**: keep it a transparent linear model in Stage 1 so "why is
  this a deal" stays answerable.

## Test plan (when built)

- `parseAttributes`: locale number parsing, fuel synonyms, missing fields.
- Regression: known synthetic sample → expected coefficients within tolerance;
  fallback when `n < MIN_SAMPLE`; missing-attribute listings scored via fallback.
- End-to-end cycle: a sample where a high-km cheap car is NOT tagged a great deal
  once attribute-aware (the regression test that proves the upgrade over median).

## Scope boundary

Stage 0 + Stage 1 are a single shippable PR (pure pipeline + rendering, no
storage). Stage 2 is explicitly out of scope until there's demand and a training
pipeline. This document is the plan; no code ships with it.
