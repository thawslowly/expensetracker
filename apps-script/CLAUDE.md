# Apps Script Rules

`Code.gs` is a **reference copy only**. Changes here must be manually copied into the Apps Script editor and saved. They do not auto-deploy.

## What This Script Does

1. Searches Gmail for bank alert emails every 5 minutes
2. Parses transaction fields from the email body
3. Writes one row per transaction to the `Transactions` tab
4. Stars the individual Gmail message after a confirmed write (processed sentinel)
5. Labels the thread `Bank-Processed`

## Processed Message Sentinel

- `msg.isStarred()` → already processed, skip
- Star is set **only after `writeRow()` returns `true`**
- If write fails, message stays unstarred → retried on next trigger run
- If parsing fails (unrecognisable format), message is starred without writing to prevent infinite retries — the normalised body is logged for diagnosis

## Email Parsers

### Citibank (`alerts@citibank.com.sg`)

Gmail query: `from:alerts@citibank.com.sg subject:"Citi Alerts - Credit Card" after:2026/04/01`

**Citi emails have inconsistent formatting across templates. Always use `\s+` between words in field-name regexes — never a literal single space.**

Known variants observed:
```
# Variant A — space before colon, single spaces between words
Transaction details : AMAZE* IKYU CORPORA SINGAPORE SGP

# Variant B — double space between words, multiple spaces in merchant, no space before colon
Transaction  details: fp*Food Panda          Singapore     SGP
```

Regex patterns (handle both variants):
```javascript
/Transaction\s+date\s*:[\s\n]*(\d{2}\/\d{2}\/\d{2})/i
/Transaction\s+amount\s*:[\s\n]*([A-Z]{3})\s*([\d,]+\.?\d*)/i
/Transaction\s+details\s*:[\s\n]*(.+)/i
```

After extraction, collapse multiple spaces in merchant name:
```javascript
rawDetail.replace(/\s+/g, ' ').trim()
```

Strip trailing 3-letter country code (e.g. `SGP`, `MYS`):
```javascript
context.replace(/\s+[A-Z]{3}$/, '').trim()
```

Amaze detection: `^AMAZE\*` or `INSTAREM` prefix → strip prefix, set `remarks = 'Via Amaze'`, card stays `CitiRewards`.

Date format in email: `DD/MM/YY` → parsed by `parseCitiDate()` → stored as `DD/MMM/YYYY`.

### POSB PayNow (`ibanking.alert@dbs.com`)

Gmail query: `from:ibanking.alert@dbs.com subject:PayNow after:2026/04/01`

Fields: Amount, To (recipient), Date & Time. Category always `⚠️ REVIEW`. Context stored as `PayNow → [recipient]`.

### POSB Everyday Card

Deferred — not yet implemented. Email sender: `ibanking.alert@dbs.com`.

### HSBC Revolution

Placeholder only — regex not tuned. Needs a real email sample. Sender TBD (alerts not yet enabled).

## Card Reward Logic

### Citi Rewards — Blacklist model
Everything earns 4 mpd **unless** merchant matches an exclusion keyword.

Exclusions: `AIRASIA`, `SCOOT`, `SINGAPORE AIR`, `SILKAIR`, `JETSTAR`, `AGODA`, `BOOKING.COM`, `EXPEDIA`, `KLOOK`, `TRIP.COM`, `MARRIOTT`, `HILTON`, `SHANGRI`, `HYATT`, `IHG`, `ACCOR`, `HERTZ`, `AVIS`, `BUDGET CAR`, `APPLE PAY`, `GOOGLE PAY`, `SAMSUNG PAY`

Cap: S$1,000 per **statement** month (resets 19th, not calendar month end).

### HSBC Revolution — Whitelist model
Only earns 4 mpd if merchant matches a bonus keyword AND does not match an exclusion.

Cap: S$1,000 per **calendar** month (posting date basis).

### POSB Everyday — Tier-based cashback
S$800/month minimum spend to unlock bonus tiers. Base rate 0.3% on everything else.

| Category | Rate | Cap | Min Spend |
|---|---|---|---|
| Food Delivery (Foodpanda, Deliveroo, GrabFood) | 10% | $20/mo | S$800 |
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

- Amaze (Instarem) virtual Mastercard linked to Citi Rewards — converts offline → online, earns 4 mpd
- FX rate ~2% vs 3.25% on other cards — preferred for overseas spend
- Travel MCCs (hotels, airlines, car rental) do NOT earn 4 mpd even via Amaze — MCC is preserved
- Store as `CitiRewards` in Card column; strip `AMAZE*` prefix from Context for readability

## `doGet()` Endpoint

Returns `{ transactions: [...] }` for `?action=transactions` (default).
Also supports `?action=cap_usage` and `?action=card_config`.
Accepts optional `?month=Apr-2026` filter on the transactions action.
