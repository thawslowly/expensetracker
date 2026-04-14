# Apps Script Rules

`Code.gs` is a **reference copy only**. Changes here must be manually copied into the Apps Script editor and saved. They do not auto-deploy.

## What This Script Does

1. Searches Gmail for bank alert emails every 5 minutes
2. Parses transaction fields from the email body
3. Writes one row per transaction to the `Transactions` tab
4. Records the Gmail message ID in `PropertiesService` after a confirmed write
5. Labels the thread `Bank-Processed`

## Processed Message Sentinel

Each processed Gmail message ID is stored in `PropertiesService` under `processedMsgIds` (JSON array, capped at 400). Added only after `writeRow()` returns `true`, or on unrecoverable parse failure. To reprocess stuck emails after a regex fix, run `resetHSBCProcessedIds()` or equivalent.

## Email Parsers

### Citibank (`alerts@citibank.com.sg`)
Use `\s+` between words in field-name regexes — Citi emails have inconsistent formatting.
```
/Transaction\s+date\s*:[\s\n]*(\d{2}\/\d{2}\/\d{2})/i
/Transaction\s+amount\s*:[\s\n]*([A-Z]{3})\s*([\d,]+\.?\d*)/i
/Transaction\s+details\s*:[\s\n]*(.+)/i
```
- Amaze: `^AMAZE\*` or `INSTAREM` prefix → strip prefix, `remarks = 'Via Amaze'`, card = `CitiRewards`
- Date: `DD/MM/YY` → `parseCitiDate()` → stored as `DD/MMM/YYYY`

### POSB PayNow (`ibanking.alert@dbs.com`)
Subject: `PayNow` or `iBanking Alerts` (body guard checks for `PAYNOW` text). Category always `⚠️ REVIEW`.

### POSB Everyday Card (`ibanking.alert@dbs.com`)
Subject: `Card Transaction Alert`. Only processes card ending **9299**.

### HSBC Revolution (`HSBC.Bank.Singapore.Limited@notification.hsbc.com.hk`)
Table-based HTML email. Plain-text body has label on one line, value on the next.
```
/Transaction\s+Date\s*:?\s+(\d{2}\/[A-Za-z]{3}\/\d{4})/i
/Transaction\s+Amount\s*:?\s+([A-Z]{3})\s*([\d,]+\.?\d*)/i
/Description\s*:?\s+([^\n\r]+)/i
```

## Card Reward Logic

**Miles rounding (Citi + HSBC):** `Math.floor(amount) * rate` — round down to nearest SGD1 first.

### Citi Rewards
Exclusions → Amaze → online whitelist → base rate.
- **Excluded (0.4 mpd):** travel MCCs, mobile wallets, car rental
- **Via Amaze (4 mpd):** re-codes as online MCC
- **Confirmed-online (4 mpd):** food delivery, ride-hailing, e-commerce, streaming — see `CITI_ONLINE_KEYWORDS`
- **Everything else:** 0.4 mpd. Cap: S$1,000/statement month (~resets 19th).

### HSBC Revolution
Exclusions → bonus whitelist → base rate.
- **Excluded (0.4 mpd):** fast food (5814), food delivery platforms, OTAs, SimplyGo (4111)
- **Bonus (4 mpd):** dining, ride-hailing, retail, streaming, airlines/hotels direct — see `HSBC_BONUS_KEYWORDS`
- Earns 4 mpd on **both contactless and online** (contactless restored 1 Apr 2026). Cap: S$1,000/calendar month.

### POSB Everyday
Tier cashback. S$800/month minimum spend to unlock bonus tiers. Base rate 0.3%.

## Merchants Tab

Persistent lookup table checked **before** keyword arrays.

### Columns (A–G)
| Col | Field | Notes |
|-----|-------|-------|
| A | Match Key | Uppercase substring matched against raw merchant name |
| B | Display Name | Human-readable (reference only) |
| C | Category | Food / Transport / Shopping / Subscriptions / Entertainment / Misc |
| D | HSBC Eligible | `YES` / `NO` / blank (blank = fall back to keyword logic) |
| E | Citi Online | `YES` / `NO` / blank |
| F | MCC Code | Auto-filled by MCC Explorer if API key set |
| G | Notes | `Review MCC XXXX` (auto-classified) or `Needs classification` |

### Key Functions
- `lookupMerchant(name)` — returns first matching record or null
- `addMerchantToTable(...)` — appends row, skips duplicates, clears cache
- `autoRegisterMerchant(raw)` — called on every new transaction; calls MCC Explorer, runs `mccToHsbcEligible()` + `mccToCitiOnline()` to auto-fill cols D/E, writes row
- `lookupMCCExplorer(name)` — calls MCC Explorer API; requires `MCC_EXPLORER_KEY` in Script Properties (500 req/month free)
- `mccToHsbcEligible(mcc)` — maps MCC → `YES`/`NO`/`''` per HSBC T&C
- `mccToCitiOnline(mcc)` — maps travel MCCs → `NO`; everything else `''`
- `setupMerchantsTab()` — one-time tab setup
- `seedMerchantsTab()` — backfills placeholder rows from Transactions tab

### Auto-Registration Flow
New merchant → `autoRegisterMerchant()` → MCC Explorer lookup → eligibility mapped from MCC → row written with Note `Review MCC XXXX`. Without API key: blank eligibility, Note `Needs classification`.

## `doGet()` Endpoint
Returns `{ transactions: [...] }` for `?action=transactions`. Also supports `?action=cap_usage` and `?action=card_config`. Optional `?month=Apr-2026` filter.
