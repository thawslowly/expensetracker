# Apps Script Rules

`Code.gs` is a **reference copy only**. Changes here must be manually copied into the Apps Script editor and saved. They do not auto-deploy.

## What This Script Does

1. Searches Gmail for bank alert emails every 5 minutes
2. Parses transaction fields from the email body
3. Writes one row per transaction to the `Transactions` tab
4. Records the Gmail message ID in `PropertiesService` after a confirmed write
5. Labels the thread `Bank-Processed`

## Email Parsers

### Citibank (`alerts@citibank.com.sg`)
Use `\s+` between words in field-name regexes — Citi emails have inconsistent formatting.
- **Card detection:** body is checked with `/citi[\s\-]*cash[\s\-]*back\+/i` to distinguish the two Citi cards. Citi's actual email text is `"Citi Cash Back+ Card"` (space between "Cash" and "Back") — the regex handles both spaced and unspaced forms. Card field is set to `CitiCashback+` or `CitiRewards` accordingly, and the correct reward calculator is called.
- Amaze: `^AMAZE\*` or `INSTAREM` prefix → strip prefix, `remarks = 'Via Amaze'`, card = `CitiRewards`
- Date: `DD/MM/YY` → `parseCitiDate()` → stored as `DD/MMM/YYYY`

### POSB PayNow (`ibanking.alert@dbs.com`)
Subject: `PayNow` or `iBanking Alerts` (body guard checks for `PAYNOW` text). Category always `⚠️ REVIEW`.

### POSB Everyday Card (`ibanking.alert@dbs.com`)
Subject: `Card Transaction Alert`. Only processes card ending **9299**.

### HSBC Revolution (`HSBC.Bank.Singapore.Limited@notification.hsbc.com.hk`)
Table-based HTML email. Plain-text body has label on one line, value on the next.

## Card Reward Logic

**Miles rounding (Citi Rewards + HSBC):** `Math.floor(amount) * rate` — round down to nearest SGD1 first.

### Citi Rewards
Exclusions → Amaze → Merchants table → online keyword fallback → base rate.
- **Excluded (0.4 mpd):** travel MCCs, mobile wallets, car rental
- **Via Amaze (4 mpd):** re-codes as online MCC
- **Confirmed-online (4 mpd):** food delivery, ride-hailing, e-commerce, streaming — see `CITI_ONLINE_KEYWORDS`
- **Everything else:** 0.4 mpd. Cap: S$1,000/statement month (~resets 19th).

### Citi CashBack+
Flat **1.6% cashback** on all spend. No exclusions, no tiers. `calcCitiCashbackReward(amount)` — uses full amount (no floor rounding, cashback not miles).

### HSBC Revolution
Exclusions → Merchants table → bonus keyword fallback → base rate.
- **Excluded (0.4 mpd):** fast food (MCC 5814), food delivery platforms, OTAs, SimplyGo (4111)
- **Bonus (4 mpd):** dining, ride-hailing, retail, streaming, airlines/hotels direct — see `HSBC_BONUS_KEYWORDS`
- Earns 4 mpd on **both contactless and online** (contactless restored 1 Apr 2026). Cap: S$1,000/calendar month.

### POSB Everyday
Tier cashback. S$800/month minimum spend to unlock bonus tiers. Base rate 0.3%.

## Merchant Name Normalisation

`normalizeContext(context)` is called in every parser **before** `autoRegisterMerchant()`. It strips location suffixes so one Merchants table entry covers all location variants of the same chain.

| Rule | Example input | Output |
|------|---------------|--------|
| GRAB* booking code | `GRAB* A-98IFM9CGWAWRAV SINGAPORE` | `GRAB*` — ⚠️ ride vs GrabFood is indistinguishable after this, so HSBC and POSB flag `GRAB*` for review at base rate instead of guessing (Citi is unaffected: both are online = 4 mpd). A `GRAB*` Merchants-table row overrides. |
| `@` separator | `STARBUCKS@WEST COAST`, `KOPITIAM @VIVO` | `STARBUCKS`, `KOPITIAM` |
| ` - ` separator (spaces both sides, safe for `7-ELEVEN`) | `CHICHA SAN CHEN - TAMP` | `CHICHA SAN CHEN` |
| Trailing `SINGAPORE` / `SGP` | `SOME MERCHANT SINGAPORE` | `SOME MERCHANT` |

**No-separator merchants** (e.g. `SPC 337 CHANGI RD`, `COLD STORAGE WEST COAS`): code cannot auto-strip these. Fix by setting a **short matchKey** in the Merchants table (`SPC`, `COLD STORAGE`). The substring lookup then catches all location variants — no new rows created.

## Merchants Tab

Persistent lookup table checked **before** keyword arrays. Checked via substring match on Match Key.

### Columns (A–G)
| Col | Field | Notes |
|-----|-------|-------|
| A | Match Key | Uppercase substring matched against raw merchant name — use shortest reliable prefix |
| B | Display Name | Human-readable (reference only) |
| C | Category | Food / Transport / Shopping / Subscriptions / Entertainment / Misc |
| D | HSBC Eligible | `YES` / `NO` / blank (blank = fall back to keyword logic) |
| E | Citi Online | `YES` / `NO` / blank |
| F | MCC Code | Manually provided — MCC Explorer API is NOT used (unreliable for SG merchants) |
| G | Notes | `Bulk import MCC XXXX` or `Needs classification` |

### Key Functions
- `normalizeContext(context)` — strips location suffixes before registration and lookup
- `stripTrailingCountry(name)` — removes a trailing ISO country code (SGP, JPN, …) using a whitelist; the old bare `[A-Z]{3}$` strip chopped real words ("GONG CHA" → "GONG")
- `lookupMerchant(name)` — word-start match (same rule as keyword lists, so "SPC" can't fire mid-word); when several keys match, the longest wins regardless of row order
- `addMerchantToTable(...)` — appends row, skips duplicates, clears cache
- `autoRegisterMerchant(raw)` — called on every new transaction; writes blank row (`Needs classification`) if merchant unknown
- `mccToHsbcEligible(mcc)` — maps MCC → `YES`/`NO`/`''` per HSBC T&C
- `mccToCitiOnline(mcc)` — maps travel MCCs → `NO`; everything else `''`
- `runSheetImport()` — reads from the `BulkImport` tab; safe to re-run (duplicate guard)
- `setupBulkImportTab()` — one-time setup of the BulkImport staging tab
- `setupMerchantsTab()` — one-time Merchants tab setup
- `seedMerchantsTab()` — backfills placeholder rows from Transactions tab

### Bulk Import Workflow
Paste merchant names into the `BulkImport` sheet tab (col A = name, col B = MCC, col C = category). Run `runSheetImport()` from the Apps Script editor once. Safe to re-run — duplicate guard skips existing rows.

## `doGet()` Endpoint
Returns `{ transactions: [...] }` for `?action=transactions`. Also supports `?action=cap_usage` and `?action=card_config`. Optional `?month=Apr-2026` filter.

## Failure Handling and Alerting (added 2026-07-18)

- **`notifyError(subject, detail)`** emails you when something breaks, throttled to one email per distinct subject per 6 hours. Used by: parse failures, FX-rate fetch failures, sheet write failures, processed-ID store problems. First run after pasting this version will ask for a new **"Send email as you"** permission — approve it or alerts silently no-op.
- **Parse failures are never silently dropped.** If a parser can't read an email (template change), `writeParseFailureStub()` writes a `⚠️ REVIEW` row (amount 0, context `PARSE FAILED: <subject>`) and emails you. The message is only marked processed once the stub is in the sheet.
- **FX fetch failure** → the row keeps the foreign amount/currency but is forced to `⚠️ REVIEW` with estReward 0, so it can't inflate SGD totals or reward sums.

## Deduplication and Gmail Quota

### processedIds (Script Properties)
Each successfully written message ID is stored in `PropertiesService` under `processedMsgIds`.
- `processEmails()` takes a **LockService script lock** — overlapping trigger runs skip instead of double-processing.
- IDs are saved after every parser AND every ~10 marks (inside `markProcessed`), because Apps Script's hard 6-minute kill does **not** run `finally` blocks; the `finally` save still covers thrown errors (e.g. Gmail quota).
- Store cap is **300 IDs** (~8 KB; the 9 KB property limit made the old 450 cap unsafe). If the cap ever trims still-searchable IDs, you get an alert email.
- A corrupt store **aborts the run** (alert + throw) instead of resetting to `{}` — a reset would rewrite every email in the window as duplicate rows.

### Rolling date filter (`rollingDateFilter(days)`)
Runs in the first 5 minutes of each hour sweep the full `ROLLING_WINDOW_DAYS` (30); all other runs scan `QUICK_SCAN_DAYS` (2), cutting Gmail reads ~10x with no data-loss risk (late-arriving mail is caught by the hourly sweep). If you need to reprocess older emails, temporarily increase `ROLLING_WINDOW_DAYS` (e.g. 90) and run once manually.
