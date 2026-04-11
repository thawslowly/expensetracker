# Apps Script Rules

`Code.gs` is a **reference copy only**. Changes here must be manually copied into the Apps Script editor and saved. They do not auto-deploy.

## What This Script Does

1. Searches Gmail for bank alert emails every 5 minutes
2. Parses transaction fields from the email body
3. Writes one row per transaction to the `Transactions` tab
4. Records the Gmail message ID in `PropertiesService` after a confirmed write (processed sentinel)
5. Labels the thread `Bank-Processed`

## Processed Message Sentinel

- Each processed Gmail message ID is stored in `PropertiesService.getScriptProperties()` under the key `processedMsgIds` (JSON array, capped at 400 IDs).
- ID is added **only after `writeRow()` returns `true`** (or on an unrecoverable parse failure)
- If write fails, the message ID is NOT added → retried on next trigger run
- If parsing fails, ID is added without writing to prevent infinite retries — normalised body is logged
- Stars are no longer used. Thread label `Bank-Processed` is applied after a confirmed write.
- To reprocess stuck emails (e.g. after a regex fix), run `resetHSBCProcessedIds()` for HSBC or equivalent.

## Email Parsers

### Citibank (`alerts@citibank.com.sg`)

Gmail query: `from:alerts@citibank.com.sg subject:"Citi Alerts - Credit Card" after:2026/04/01`

**Citi emails have inconsistent formatting. Always use `\s+` between words in field-name regexes.**

Regex patterns:
```javascript
/Transaction\s+date\s*:[\s\n]*(\d{2}\/\d{2}\/\d{2})/i
/Transaction\s+amount\s*:[\s\n]*([A-Z]{3})\s*([\d,]+\.?\d*)/i
/Transaction\s+details\s*:[\s\n]*(.+)/i
```

- Collapse multiple spaces in merchant name: `rawDetail.replace(/\s+/g, ' ').trim()`
- Strip trailing country code: `context.replace(/\s+[A-Z]{3}$/, '').trim()`
- Amaze detection: `^AMAZE\*` or `INSTAREM` prefix → strip prefix, `remarks = 'Via Amaze'`, card = `CitiRewards`
- Date format in email: `DD/MM/YY` → `parseCitiDate()` → stored as `DD/MMM/YYYY`

### POSB PayNow (`ibanking.alert@dbs.com`)

Gmail query: `from:ibanking.alert@dbs.com subject:PayNow after:2026/04/01`

Fields: Amount, To (recipient), Date & Time. Category always `⚠️ REVIEW`. Context = `PayNow → [recipient]`.

### POSB Everyday Card (`ibanking.alert@dbs.com`)

Gmail query: `from:ibanking.alert@dbs.com subject:"Card Transaction Alert" after:2026/04/01`

**Only processes card ending 9299.** Other card numbers are skipped (ID recorded, no write).

Plain-text fields after HTML strip:
```
Date & Time: 11 APR 19:58 (SGT)
Amount: SGD0.10
From: DBS/POSB card ending 9299
To: BUS/MRT SINGAPORE SGP
```

Regex patterns:
```javascript
/Amount\s*:\s*([A-Z]{3})([\d,]+\.?\d*)/i
/To\s*:\s*(.+)/i
/Date\s*(?:&|and)?\s*Time\s*:\s*(.+)/i
```

Date parser: `parsePOSBCardDate("11 APR 19:58 (SGT)")` — extracts day + month, appends current year.

### HSBC Revolution (`HSBC.Bank.Singapore.Limited@notification.hsbc.com.hk`)

Gmail query: `from:HSBC.Bank.Singapore.Limited@notification.hsbc.com.hk subject:"Transaction Alerts" after:2026/04/01`

Email is table-based HTML. Plain-text has label on one line, value on the next (blank line between). Body normalisation collapses multiple spaces/tabs to handle table-cell artefacts.

```
Transaction Date
12/APR/2026

Transaction Amount
SGD2.99

Description
LUCKINCOFFEE
```

Regex patterns (`\s+` matches the blank line between label and value):
```javascript
/Transaction\s+Date\s*:?\s+(\d{2}\/[A-Za-z]{3}\/\d{4})/i
/Transaction\s+Amount\s*:?\s+([A-Z]{3})\s*([\d,]+\.?\d*)/i   // \s* handles "SGD 2.99" and "SGD2.99"
/Description\s*:?\s+([^\n\r]+)/i
```

Date parser: `parseHSBCDate("12/APR/2026")` — splits on `/`, constructs `new Date("12 APR 2026")`.

## Card Reward Logic

### Miles rounding (Citi + HSBC)
Per both T&Cs, miles are calculated by rounding down to the nearest SGD1 first, then multiplying.
Formula in code: `Math.floor(amount) * rate` — **not** `amount * rate`.
Example: SGD4.50 at 4 mpd = floor(4.50) × 4 = **16 miles** (not 18).

### Citi Rewards
**Model: Exclusions first, then Amaze, then online whitelist, else base rate.**

- **Excluded** (always 0.4 mpd): travel MCCs (airlines, hotels, car rental, OTAs), mobile wallets (`APPLE PAY`, `GOOGLE PAY`, `SAMSUNG PAY`), car rental (`HERTZ`, `AVIS`, `BUDGET CAR`)
- **Via Amaze** (4 mpd): Amaze re-codes any non-excluded merchant as online MCC. Best for in-person SGD and all FCY spend.
- **Confirmed-online merchants** (4 mpd): food delivery apps, ride-hailing apps, e-commerce, streaming/subscriptions — see `CITI_ONLINE_KEYWORDS` in code
- **Everything else** (0.4 mpd): physical restaurants, groceries, transport paid direct on Citi card

Cap: S$1,000 per **statement month** (resets ~19th, not calendar month end).

T&C source: Citi Rewards 10X Promotion T&C, effective 1 April 2024.

### HSBC Revolution
**Model: Exclusions first, then bonus whitelist, else base rate.**

- **Excluded** (0.4 mpd): fast food (MCC 5814), food delivery platforms (inconsistent MCC), OTAs (`AGODA`, `BOOKING.COM`, `EXPEDIA`, `KLOOK`), SimplyGo (MCC 4111)
- **Bonus-eligible** (4 mpd): sit-down dining, ride-hailing, retail, streaming, airlines/hotels direct — see `HSBC_BONUS_KEYWORDS` in code
- **Everything else** (0.4 mpd, shown as ⚠️): unrecognised merchants

Earns 4 mpd on **both contactless and online** transactions at eligible MCCs.
Contactless was cut to 0.4 mpd in July 2024 but **permanently restored from 1 April 2026** (card upgraded to Visa Signature).

Cap: S$1,000 per **calendar month** (posting date basis).
EGA tier (SGD50K ADB in Everyday Global Account): 8 mpd — not reflected in script (uncommon).

T&C source: HSBC Revolution 10X Reward Points Programme T&C + MileLion/HSBC website April 2026.

### POSB Everyday — Tier-based cashback
S$800/month minimum spend to unlock bonus tiers. Base rate 0.3%.

| Category | Rate | Cap | Min Spend |
|---|---|---|---|
| Food Delivery (FoodPanda, Deliveroo, GrabFood) | 10% | $20/mo | S$800 |
| MYR In-Store | 10% | $20/mo | S$800 |
| SimplyGo | 10% | $20/mo | S$800 |
| Dining (excl. fast food) | 5% | $20/mo | S$800 |
| Online Shopping | 5% | $20/mo | S$800 |
| Sheng Siong | 5% | $20/mo | None |
| Watsons | 3% | — | None |
| SPC Fuel | 6% | — | None |
| Everything else | 0.3% | — | None |

### POSB Savings — No rewards
Category always `⚠️ REVIEW`. Used for PayNow transfers only.

## Category Keyword Map

| Category | Keywords |
|---|---|
| Food | FAIRPRICE, NTUC, COLD STORAGE, SHENG SIONG, GIANT, MCDONALD, KFC, STARBUCKS, KOUFU, KOPITIAM, RESTAURANT, CAFE, BAKERY, HAWKER, FP*, FOOD PANDA, FOODPANDA, DELIVEROO, GRABFOOD |
| Transport | GRAB, COMFORT, GOJEK, SIMPLYGO, BUS, MRT, LTA, TAXI, RYDE |
| Shopping | LAZADA, SHOPEE, AMAZON, UNIQLO, ZARA, H&M, DECATHLON, DAISO, DONKI, IKEA, MUSTAFA |
| Subscriptions | NETFLIX, SPOTIFY, APPLE, GOOGLE, YOUTUBE, CHATGPT, CLAUDE, OPENAI, DISNEY, HULU |
| Entertainment | AIRASIA, SINGAPORE AIR, SCOOT, BOOKING, AGODA, KLOOK, CHANGI, CATHAY, GOLDEN VILLAGE |
| Misc | GUARDIAN, WATSONS, UNITY, CLINIC, PHARMACY, HOSPITAL, POLYCLINIC |

Unrecognised merchants → `⚠️ REVIEW`

## Amaze Strategy

- Amaze (Instarem) virtual Mastercard linked to Citi Rewards — re-codes offline spend as online MCC → earns 4 mpd at any non-excluded merchant
- FX rate ~2% vs 3.25% on other cards — preferred for all overseas spend
- Travel MCCs (hotels, airlines, car rental) do NOT earn 4 mpd even via Amaze — those MCCs are preserved and hit the Citi exclusion list
- Store as `CitiRewards` in Card column; strip `AMAZE*` prefix from Context for readability

## `doGet()` Endpoint

Returns `{ transactions: [...] }` for `?action=transactions` (default).
Also supports `?action=cap_usage` and `?action=card_config`.
Accepts optional `?month=Apr-2026` filter on the transactions action.
