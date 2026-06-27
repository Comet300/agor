# Price rating & fair-price — design

## TL;DR

We **rate** a price (great/fair/overpriced vs comparables), we don't predict an
exact number. Rating is robust at low sample sizes, category-agnostic, and
honest about asking-vs-sold. A point fair-price estimate is a later *sharpener*
that rides on accumulated per-category slope weights — not the foundation.

**Shipped (v1):** category-agnostic comparable **percentile rating**
(`src/features/priceRating.ts`), surfaced on browse cards and `/cheaper`.

## Why rating, not prediction

- **Low-n reality:** a category/segment often has 1–5 comparables. Regression on
  5 points is underdetermined (n < k) or wildly overfit. A *percentile of* a
  small comp set is still honest; a fitted price isn't.
- **Asking ≠ sold:** we only observe asking prices + delisting, never the
  transaction. "Cheaper than 85% of similar asks" is defensible; a predicted
  sale price is not.
- **Multi-category:** cars `{year,km,power}`, property `{area,rooms,floor}`,
  fashion `{brand,condition}` share no feature space. A rating engine keyed on a
  *comparable set* generalizes; a single regressor can't.

## v1 — comparable percentile rating (shipped)

Universal comparable key = **same currency + similar title**. Every listing in
every category has a title, price, currency, so this works everywhere with zero
per-category schema.

```
comps = collected items, same currency, not the target,
        title-token overlap >= threshold
widen: threshold from tight (3 shared significant tokens) down to 1
       until >= MIN_COMPS comparables (else → unknown)
median + percentile of comp prices
tag:  pctile <= .15 great_deal · >= .85 overpriced · else fair_price
confidence: comp count x how tight a threshold gathered them
```

- Robust: percentile + median, so scam under-prices / outliers don't swing it.
- Honest: `unknown` (no verdict) when comps are too thin.
- Pi-trivial: filter + sort, no fit, no storage beyond the `items` we keep.

Surfaced: a line on the browse card ("🟢 Great deal — cheaper than 88% of 24
similar") and atop `/cheaper`.

## v2 — attribute refinement + slope weights (future)

Sharpens v1 from "similar title" to "similar spec", and adds a point estimate.

### Prereqs
- **Attribute normalization:** `"145.000 km"→145000`, `"2.016"→2016`,
  `"65 m²"→65`, unit detection. Also unlocks attribute *range filters*.
- **Category inference:** vendor + URL path prior, confirmed by attribute
  signature (year+km → car; area+rooms → property).

### Slope/level split (the core idea)
- **Slopes** (per-km depreciation, €/m²) are stable across segments → fit ONCE
  per `(category, currency)` on the pooled data (large n).
- **Level** (this model/locality baseline) is the sparse part → comes from the
  few comps, never a local fit.

### Self-building slope weights — incremental, drift-aware
Per `(category, currency)` keep normal-equation accumulators:
```
A = XᵀX   b = Xᵀy   n     // update O(k²) per tracked listing, ~100 floats/category
w = solve(A + λI, b)       // ridge; λ mandatory for sparse/collinear segments
A ← ρ·A + x·xᵀ ;  b ← ρ·b + x·y     // forgetting factor ρ≈0.99 → tracks market drift
```
No raw-row refit, no big storage, Pi-tiny. Cold start → seed sane priors (car
~15%/yr, ~€0.04/km), let data override as `A` fills.

### Hedonic adjustment (valuation at n=1–5)
Don't regress the comps — adjust them to the target's spec with global slopes,
then median:
```
fair = median over comps of [ comp_price + Σ w_f·(target_f − comp_f) ]
```
Slopes carry the curve; comps carry the level. Works at n=1.

### Confidence ladder
| Comps after widening | Action |
|---|---|
| many, tight band | high — adjusted median + CI |
| ≥ MIN_COMPS | medium |
| < MIN_COMPS even region-wide | low / suppress (no fake number) |
| slopes not trained yet | raw comp median, lowest confidence |

## v3 — outcome calibration (later)

Use delist-after-stable-price as a sold proxy to calibrate which residuals
actually convert, and to flag scams (`price ≪ predicted` + new/low-rep seller).
Real ML (trees) only if ever needed, trained **offline**, shipped as coefficient
tables the Pi evaluates — training is the expensive part, evaluation is free.

## Honesty / risks

- Tracking bias: weights from OUR tracks ≠ whole market. Slopes survive it;
  **levels skew** → that's why level stays comp-driven.
- Property needs a locality bucket from free-text `location` (it dominates price).
- Cars need title → make/model parse before slopes mean anything.
- Always per-category AND per-currency. Never mix.
