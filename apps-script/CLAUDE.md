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
- Amaze: `^AMAZE\*` or `INSTAREM` prefix → strip prefix, `remarks = 'Via Amaze'`, card = `CitiRewards`
- Date: `DD/MM/YY` → `parseCitiDate()` → stored as `DD/MMM/YYYY`

### POSB PayNow (`ibanking.alert@dbs.com`)
Subject: `PayNow` or `iBanking Alerts` (body guard checks for `PAYNOW` text). Category always `⚠️ REVIEW`.

### POSB Everyday Card (`ibanking.alert@dbs.com`)
Subject: `Card Transaction Alert`. Only processes card ending **9299**.

### HSBC Revolution (`HSBC.Bank.Singapore.Limited@notification.hsbc.com.hk`)
Table-based HTML email. Plain-text body has label on one line, value on the next.

## Card Reward Logic

**Miles rounding (Citi + HSBC):** `Math.floor(amount) * rate` — round down to nearest SGD1 first.

### Citi Rewards
Exclusions → Amaze → Merchants table → online keyword fallback → base rate.
- **Excluded (0.4 mpd):** travel MCCs, mobile wallets, car rental
- **Via Amaze (4 mpd):** re-codes as online MCC
- **Confirmed-online (4 mpd):** food delivery, ride-hailing, e-commerce, streaming — see `CITI_ONLINE_KEYWORDS`
- **Everything else:** 0.4 mpd. Cap: S$1,000/statement month (~resets 19th).

### HSBC Revolution
Exclusions → Merchants table → bonus keyword fallback → base rate.
- **Excluded (0.4 mpd):** fast food (MCC 5814), food delivery platforms, OTAs, SimplyGo (4111)
- **Bonus (4 mpd):** dining, ride-hailing, retail, streaming, airlines/hotels direct — see `HSBC_BONUS_KEYWORDS`
- Earns 4 mpd on **both contactless and online** (contactless restored 1 Apr 2026). Cap: S$1,000/calendar month.

### POSB Everyday
Tier cashback. S$800/month minimum spend to unlock bonus tiers. Base rate 0.3%.

## Merchants Tab

Persistent lookup table checked **before** keyword arrays. Checked via substring match on Match Key.

### Columns (A–G)
| Col | Field | Notes |
|-----|-------|-------|
| A | Match Key | Uppercase substring matched against raw merchant name |
| B | Display Name | Human-readable (reference only) |
| C | Category | Food / Transport / Shopping / Subscriptions / Entertainment / Misc |
| D | HSBC Eligible | `YES` / `NO` / blank (blank = fall back to keyword logic) |
| E | Citi Online | `YES` / `NO` / blank |
| F | MCC Code | Manually provided — MCC Explorer API is NOT used (unreliable for SG merchants) |
| G | Notes | `Bulk import MCC XXXX` or `Needs classification` |

### Key Functions
- `lookupMerchant(name)` — substring match; returns first matching record or null
- `addMerchantToTable(...)` — appends row, skips duplicates, clears cache
- `autoRegisterMerchant(raw)` — called on every new transaction; writes blank row if merchant unknown
- `mccToHsbcEligible(mcc)` — maps MCC → `YES`/`NO`/`''` per HSBC T&C
- `mccToCitiOnline(mcc)` — maps travel MCCs → `NO`; everything else `''`
- `runBulkImport()` — one-shot batch load from hardcoded array; safe to re-run (duplicate guard)
- `setupMerchantsTab()` — one-time tab setup
- `seedMerchantsTab()` — backfills placeholder rows from Transactions tab

### Bulk Import Workflow
User provides merchants grouped by MCC in chat → I populate `runBulkImport()` array → user pastes Code.gs into Apps Script editor and runs `runBulkImport()` once. Re-running is safe — duplicate guard skips existing rows.

### MCC Explorer API
**Not configured, not needed.** MCC Explorer does not reliably identify Singapore merchants. Manual MCC lookup and `runBulkImport()` is the preferred approach. `lookupMCCExplorer()` and `fetchMCCDatabase()` remain in code but return null without an API key — no impact on operation.

### Obscured Merchant Names (Pipeline To-Do)
Some transactions produce dynamic/junk merchant strings that should not pollute the Merchants tab, e.g.:
- `Grab* A-97FSUTLGWRTFAV Singapore SGP` — Grab ride with booking reference appended
- `FP* XXXXXX` — FoodPanda order codes

**Current behaviour:** `autoRegisterMerchant()` adds these as new rows with `Needs classification`.
**Fix needed:** Add a pre-processing step to detect and strip dynamic suffixes before registration, OR add short matchKeys (e.g. `GRAB`, `FP*`) to the Merchants table so the substring match catches these variants before `autoRegisterMerchant()` fires.

---

## Merchant Batch To-Do

Batches done so far — MCC and eligibility auto-set by `mccToHsbcEligible()` / `mccToCitiOnline()`:

| Batch | MCC | HSBC | Status |
|-------|-----|------|--------|
| Fast food chains (McDonald's, KFC, Burger King, etc. — 37 merchants) | 5814 | NO | ✅ Done |
| Bubble tea (LiHO, Gong Cha, Tiger Sugar, Chatime, etc. — 12 merchants) | 5814 | NO | ✅ Done |
| Cafes (Craftsmen, Daybreak, Devon Cafe, Killiney, etc. — 11 merchants) | 5814 | NO | ✅ Done |

**Pending — awaiting user to provide MCC-grouped merchant lists:**

- [ ] **MCC 5812** — Sit-down restaurants (Genki Sushi, Ichi-ban Boshi, Belgian Beer Cafe, Harbourfront Seafood, Spago, and the large 5812 list provided earlier — HSBC: YES)
- [ ] **MCC 5712** — Furniture / home furnishings (Weavve Home, Castlery, IKEA, etc. — HSBC: YES via 5999 mapping TBC)
- [ ] **MCC 5734** — Computer/software stores (Adobe, Shopee, Lazada, etc. — HSBC: YES via 5999 mapping TBC)
- [ ] **Transport merchants** — Grab, Gojek (MCC 4121, HSBC YES) and SimplyGo (MCC 4111, HSBC NO); also fixes obscured Grab dynamic-code entries
- [ ] **Obscured merchant name handling** — design and implement pre-processing filter for dynamic booking-reference suffixes (e.g. `Grab* A-97FSUTLGWRTFAV`)

## `doGet()` Endpoint
Returns `{ transactions: [...] }` for `?action=transactions`. Also supports `?action=cap_usage` and `?action=card_config`. Optional `?month=Apr-2026` filter.
