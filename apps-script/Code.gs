// ============================================================
// Expense Tracker — Google Apps Script
// Sheet: 1xuRQ51hOXCVVex7TUhQqPExkFFBN8uXQYpw_j8DzPGA
// Tab:   Transactions
// ============================================================

var SHEET_ID        = '1xuRQ51hOXCVVex7TUhQqPExkFFBN8uXQYpw_j8DzPGA';
var TAB_NAME        = 'Transactions';
var MERCHANTS_TAB   = 'Merchants';
var PROCESSED_LABEL = 'Bank-Processed';

// How many days back each Gmail search looks. Processed-ID retention is kept
// LONGER than this window so an email that is still searchable can never have
// its ID forgotten (which would cause it to be re-written as a duplicate row).
var ROLLING_WINDOW_DAYS      = 30;
var PROCESSED_RETENTION_DAYS = 44;   // window + buffer

// Most 5-minute runs only need to see the last couple of days of email; a
// full ROLLING_WINDOW_DAYS sweep still runs once an hour as a safety net for
// late-delivered mail. Cuts Gmail read quota ~10x without losing anything.
var QUICK_SCAN_DAYS = 2;

// Foreign transactions are converted to SGD at processing time using a live
// mid-market rate, then multiplied by FX_MARKUP to approximate the bank's
// foreign-transaction fee (Visa/Mastercard charge ~3.25% on SGD cards).
//   1.00   = pure mid-market (no markup)
//   1.0325 = +3.25% (typical card FCY fee)  ← current setting
var FX_MARKUP = 1.0325;

// FX rates cached for this execution to avoid repeated API calls in one run.
var _fxCache = {};

// Module-level cache — loaded once per script execution, cleared when a new
// merchant is added so the next lookup sees the updated table.
var _merchantsCache = null;

// Cached Spreadsheet handle — opening by ID is the slow part, so we open once
// per execution instead of on every read/write. Re-set on each function entry
// point is unnecessary: a fresh execution starts with this null.
var _ss = null;


// ── Column indices (1-based) ──────────────────────────────────
var COL = {
  MONTH_KEY:     1,  // A
  DATE:          2,  // B
  AMOUNT:        3,  // C
  CATEGORY:      4,  // D
  CONTEXT:       5,  // E
  CARD:          6,  // F
  CURRENCY:      7,  // G
  BONUS_ELIGIBLE:8,  // H
  REWARD_RATE:   9,  // I
  EST_REWARD:   10,  // J
  REMARKS:      11   // K
};

// ── Category keyword map ──────────────────────────────────────
var CATEGORY_KEYWORDS = {
  'Food':          ['FAIRPRICE', 'NTUC', 'COLD STORAGE', 'SHENG SIONG', 'GIANT',
                    'MCDONALD', 'KFC', 'STARBUCKS', 'KOUFU', 'KOPITIAM',
                    'RESTAURANT', 'CAFE', 'BAKERY', 'HAWKER', 'FOODPANDA',
                    'FOOD PANDA', 'FP*', 'DELIVEROO', 'GRABFOOD', 'WINGSTOP'],
  'Transport':     ['GRAB', 'COMFORT', 'GOJEK', 'SIMPLYGO', 'BUS', 'MRT',
                    'LTA', 'TAXI', 'RYDE'],
  'Shopping':      ['LAZADA', 'SHOPEE', 'AMAZON', 'UNIQLO', 'ZARA', 'H&M',
                    'DECATHLON', 'DAISO', 'DONKI', 'IKEA', 'MUSTAFA'],
  'Subscriptions': ['NETFLIX', 'SPOTIFY', 'APPLE', 'GOOGLE', 'YOUTUBE',
                    'CHATGPT', 'CLAUDE', 'OPENAI', 'DISNEY', 'HULU'],
  'Entertainment': ['AIRASIA', 'SINGAPORE AIR', 'SCOOT', 'BOOKING', 'AGODA',
                    'KLOOK', 'CHANGI', 'CATHAY', 'GOLDEN VILLAGE', 'GV '],
  'Misc':          ['GUARDIAN', 'WATSONS', 'UNITY', 'CLINIC', 'PHARMACY',
                    'HOSPITAL', 'POLYCLINIC']
};

// ── Citi Rewards: confirmed-online merchants — earn 4 mpd ────
// Per T&C, Citi Rewards 10X applies ONLY to:
//   (a) online retail transactions (any non-travel merchant, online channel)
//   (b) physical clothing/shoes/bags stores (specific MCCs)
// Since emails don't reveal the MCC, we whitelist known-online merchants.
// Everything else (physical restaurants, groceries, transport) earns 0.4 mpd
// UNLESS the transaction went via Amaze (which forces online MCC processing).
var CITI_ONLINE_KEYWORDS = [
  // Food delivery apps — MCC 5812/5814 via online channel
  'FOODPANDA', 'FOOD PANDA', 'FP*', 'GRABFOOD', 'DELIVEROO',
  // Ride-hailing via app — MCC 4121, app-based payment = online
  'GRAB', 'GOJEK',
  // E-commerce marketplaces — always online
  'SHOPEE', 'LAZADA', 'AMAZON', 'ZALORA', 'QOO10',
  // Digital subscriptions / streaming — always online
  'NETFLIX', 'SPOTIFY', 'DISNEY', 'YOUTUBE', 'APPLE', 'GOOGLE',
  'CHATGPT', 'CLAUDE', 'OPENAI', 'HULU'
];

// ── Citi Rewards: bonus blacklist (travel / mobile wallets) ──
var CITI_EXCLUDE_KEYWORDS = [
  'AIRASIA', 'SCOOT', 'SINGAPORE AIR', 'SILKAIR', 'JETSTAR',
  'AGODA', 'BOOKING.COM', 'EXPEDIA', 'KLOOK', 'TRIP.COM',
  'MARRIOTT', 'HILTON', 'SHANGRI', 'HYATT', 'IHG', 'ACCOR',
  'HERTZ', 'AVIS', 'BUDGET CAR',
  'APPLE PAY', 'GOOGLE PAY', 'SAMSUNG PAY'
];

// ── HSBC Revolution: bonus whitelist ─────────────────────────
// Earn rate: 10X (4 mpd) on eligible CONTACTLESS + ONLINE transactions.
// History: contactless was cut to 1X in July 2024, then PERMANENTLY
// RESTORED from 1 April 2026 (card upgraded Platinum → Visa Signature).
// Cap: 9,000 Bonus Points per calendar month (~SGD1,000 eligible spend).
// Source: HSBC website April 2026 + MileLion 16 Mar 2026 confirmation.
//
// Excluded MCCs (regardless of channel): fast food (5814), food delivery
// (inconsistent MCC), OTAs, public transit (4111), insurance, utilities.
var HSBC_BONUS_KEYWORDS = [
  // MCC 5812/5462 — Sit-down restaurants, cafes, bakeries, hawker centres
  // Contactless tap now earns 4 mpd (restored April 2026)
  'RESTAURANT', 'CAFE', 'BAKERY', 'KOPITIAM', 'KOUFU', 'HAWKER',

  // MCC 4121 — Ride-hailing (Grab/Gojek app = online transaction)
  'GRAB', 'GOJEK',

  // MCC 5311/5999 — Online retail / marketplaces
  'SHOPEE', 'LAZADA', 'AMAZON', 'ZALORA', 'QOO10',

  // MCC 7372/7375 — Digital subscriptions / streaming
  'NETFLIX', 'SPOTIFY', 'DISNEY', 'YOUTUBE', 'APPLE', 'GOOGLE ONE',

  // MCC 3000–3999 / 4511 — Airlines (direct booking)
  'SINGAPORE AIR', 'SCOOT', 'AIRASIA', 'JETSTAR', 'CATHAY',

  // MCC 3501–3999 / 7011 — Hotels (direct booking)
  'MARRIOTT', 'HILTON', 'HYATT', 'ACCOR', 'IHG'
];

// ── HSBC Revolution: exclusion list — these do NOT earn 4 mpd ─
var HSBC_EXCLUDE_KEYWORDS = [
  // MCC 5814 — Fast Food / Quick Service Restaurants
  'MCDONALD', 'KFC', 'BURGER KING', 'SUBWAY', 'POPEYES',
  'TEXAS CHICKEN', 'JOLLIBEE', 'WINGSTOP', '4FINGERS', 'FOUR FINGERS',
  'SHAKE SHACK', 'FIVE GUYS', 'CARLS JR',
  'STARBUCKS',          // Starbucks SG is inconsistently coded 5814/5812 — exclude to be safe

  // Food delivery platforms — randomly coded 5812 or 5814; exclude to avoid over-claiming
  'GRABFOOD', 'FOODPANDA', 'FOOD PANDA', 'FP*', 'DELIVEROO',

  // MCC 4722/4723 — Online travel agencies (OTAs)
  'AGODA', 'BOOKING.COM', 'EXPEDIA', 'KLOOK',

  // MCC 4111 — Public transport
  'SIMPLYGO'
];

// ── POSB Everyday: tier keyword lists ────────────────────────
// All bonus tiers below require $800/mo min spend (marked ⚠️)
var POSB_DELIVERY_10PCT  = ['FOODPANDA', 'FOOD PANDA', 'FP*', 'DELIVEROO', 'GRABFOOD'];
var POSB_TRANSIT_10PCT   = ['SIMPLYGO', 'BUS/MRT'];
var POSB_DINING_5PCT     = ['RESTAURANT', 'CAFE', 'BAKERY', 'KOPITIAM', 'KOUFU', 'HAWKER'];
var POSB_DINING_EXCL     = ['MCDONALD', 'KFC', 'BURGER KING', 'SUBWAY', 'POPEYES', 'STARBUCKS'];
var POSB_SHOPPING_5PCT   = ['LAZADA', 'SHOPEE', 'AMAZON'];
// No min spend required for these:
var POSB_SHENGSIONG_5PCT = ['SHENG SIONG'];
var POSB_WATSONS_3PCT    = ['WATSONS'];
var POSB_SPC_6PCT        = ['SPC'];

// ─────────────────────────────────────────────────────────────
// MAIN TRIGGER — runs every 5 minutes
// ─────────────────────────────────────────────────────────────
function processEmails() {
  // Without a lock, a slow run overlapping the next 5-minute trigger means two
  // executions load the same processed-ID map and write every in-flight email
  // twice — the exact duplicate-row failure the ID store exists to prevent.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    Logger.log('processEmails: another run still active — skipping');
    return;
  }

  try {
    var label = getOrCreateLabel(PROCESSED_LABEL);
    var processedIds = loadProcessedIds();
    var processed = 0;

    // Hourly full sweep; quick scan on the other runs (see QUICK_SCAN_DAYS).
    var searchDays = (new Date().getMinutes() < 5) ? ROLLING_WINDOW_DAYS : QUICK_SCAN_DAYS;

    // The finally save covers thrown errors (e.g. Gmail quota), but Apps
    // Script's hard 6-minute kill does NOT run finally blocks — that case is
    // covered by the per-parser saves here plus the periodic save inside
    // markProcessed(), so a timeout can only lose the last few marks.
    try {
      processed += processCitiEmails(label, processedIds, searchDays);
      saveProcessedIds(processedIds);
      processed += processPOSBPayNowEmails(label, processedIds, searchDays);
      saveProcessedIds(processedIds);
      processed += processHSBCEmails(label, processedIds, searchDays);
      saveProcessedIds(processedIds);
      processed += processPOSBEverydayEmails(label, processedIds, searchDays);
    } finally {
      saveProcessedIds(processedIds);
    }

    Logger.log('Total rows written: ' + processed);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Returns a Gmail date filter string for the last N days, e.g. "after:2026/05/03".
 * Using a rolling window instead of a fixed date keeps search result counts low as
 * time passes, which reduces Gmail API quota consumption significantly.
 */
function rollingDateFilter(days) {
  var d = new Date();
  d.setDate(d.getDate() - days);
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart ? String(d.getMonth() + 1).padStart(2, '0') : (d.getMonth() + 1 < 10 ? '0' : '') + (d.getMonth() + 1);
  var day = String(d.getDate()).padStart ? String(d.getDate()).padStart(2, '0') : (d.getDate() < 10 ? '0' : '') + d.getDate();
  return 'after:' + y + '/' + m + '/' + day;
}

// ─────────────────────────────────────────────────────────────
// CITIBANK PARSER
// Subject: "Citi Alerts - Credit Card/Ready Credit Transaction"
// Sender:  alerts@citibank.com.sg
// ─────────────────────────────────────────────────────────────
function processCitiEmails(label, processedIds, searchDays) {
  // Search all Citi threads (including already-labelled ones) so we can
  // process new messages that arrived after the thread was first labelled.
  var query = 'from:alerts@citibank.com.sg subject:"Citi Alerts - Credit Card" ' + rollingDateFilter(searchDays);
  var threads = GmailApp.search(query);
  var count = 0;

  for (var i = 0; i < threads.length; i++) {
    var thread = threads[i];
    var messages = thread.getMessages();
    var wroteAny = false;

    for (var j = 0; j < messages.length; j++) {
      var msg = messages[j];

      // Skip messages already processed in a previous run
      if (processedIds[msg.getId()]) continue;

      // Normalise body: replace non-breaking spaces and collapse whitespace
      // around colons so regex works regardless of HTML-to-text rendering.
      var rawBody = msg.getPlainBody();
      var body = rawBody
        .replace(/\u00a0/g, ' ')           // non-breaking space → regular space
        .replace(/\r\n/g, '\n')            // CRLF → LF
        .replace(/[ \t]+:/g, ':')          // strip spaces before colons
        .replace(/:[ \t]+/g, ': ');        // normalise space after colons

      var emailDate = msg.getDate(); // fallback date from email header

      // ── Extract fields ──────────────────────────────────
      // Allow the value to be on the same line OR the next line (some HTML
      // renderers place label and value in separate table cells → separate lines)
      var txnDateMatch  = body.match(/Transaction\s+date\s*:[\s\n]*(\d{2}\/\d{2}\/\d{2})/i);
      var txnAmtMatch   = body.match(/Transaction\s+amount\s*:[\s\n]*([A-Z]{3})\s*([\d,]+\.?\d*)/i);
      var txnDetailMatch= body.match(/Transaction\s+details\s*:[\s\n]*(.+)/i);

      if (!txnAmtMatch || !txnDetailMatch) {
        Logger.log('Citi: could not parse email. Subject: ' + msg.getSubject());
        // Log first 400 chars of normalised body to help diagnose format changes
        Logger.log('Body (first 400 chars): ' + body.substring(0, 400));
        var citiStubCard = /citi[\s\-]*cash[\s\-]*back\+/i.test(body) ? 'CitiCashback+' : 'CitiRewards';
        writeParseFailureStub(msg, citiStubCard, processedIds);
        continue;
      }

      // Date: prefer email body date, fall back to email send date
      var txnDate;
      if (txnDateMatch) {
        txnDate = parseCitiDate(txnDateMatch[1]); // DD/MM/YY → Date
      } else {
        txnDate = emailDate;
      }

      var currency = txnAmtMatch[1].toUpperCase();
      var amount   = parseFloat(txnAmtMatch[2].replace(/,/g, ''));
      var rawDetail= txnDetailMatch[1].replace(/\s+/g, ' ').trim();

      // ── Amaze detection ────────────────────────────────
      var isAmaze  = /^AMAZE\*/i.test(rawDetail) || /INSTAREM/i.test(rawDetail);
      var context  = rawDetail.replace(/^AMAZE\*\s*/i, '').replace(/^INSTAREM\s*/i, '').trim();
      context = stripTrailingCountry(context);
      context = normalizeContext(context);

      // Detect card type from email body.
      // Citi emails write "Citi Cash Back+ Card" (with space), so match both forms.
      var isCashbackCard = /citi[\s\-]*cash[\s\-]*back\+/i.test(body);
      var card     = isCashbackCard ? 'CitiCashback+' : 'CitiRewards';
      autoRegisterMerchant(context);
      var displayContext = resolveContext(context);
      var category = guessCategory(context);
      // ── Convert foreign amounts to SGD ──────────────────
      // Reward logic still uses the ORIGINAL currency (for FCY labelling), but
      // the recorded amount and reward maths use the converted SGD value.
      var conv     = toSGD(amount, currency);
      var remarks  = joinRemarks(isAmaze ? 'Via Amaze' : '', conv.remark);

      // ── Reward calculation ──────────────────────────────
      var reward   = isCashbackCard
        ? calcCitiCashbackReward(conv.amount)
        : calcCitiReward(context, currency, conv.amount, isAmaze);

      // FX fetch failed → conv still holds the FOREIGN amount. Don't let it
      // masquerade as SGD or earn a reward computed on the wrong number —
      // surface it on the review queue instead.
      if (conv.currency !== 'SGD') {
        category = '⚠️ REVIEW';
        reward   = { bonusEligible: '⚠️', rate: '', estReward: 0 };
      }

      var row = buildRow(txnDate, conv.amount, category, displayContext, card, conv.currency,
                         reward.bonusEligible, reward.rate, reward.estReward, remarks);

      var written = writeRow(row);
      if (!written) {
        Logger.log('Citi: write failed — will retry on next run. Detail: ' + rawDetail);
        continue; // leave message untracked so next run retries it
      }
      markProcessed(processedIds, msg); // mark this individual message as processed
      msg.markRead();
      count++;
      wroteAny = true;
    }

    // Apply thread label so the inbox stays tidy
    if (wroteAny) thread.addLabel(label);
  }

  Logger.log('Citi: wrote ' + count + ' rows');
  return count;
}

// ─────────────────────────────────────────────────────────────
// POSB PayNow PARSER
// Sender: ibanking.alert@dbs.com
// Subjects: "PayNow" OR "iBanking Alerts" (both used by DBS)
// ─────────────────────────────────────────────────────────────
function processPOSBPayNowEmails(label, processedIds, searchDays) {
  // DBS sends PayNow confirmations under two subject lines — search both.
  var query = 'from:ibanking.alert@dbs.com (subject:PayNow OR subject:"iBanking Alerts") ' + rollingDateFilter(searchDays);
  var threads = GmailApp.search(query);
  var count = 0;

  for (var i = 0; i < threads.length; i++) {
    var thread = threads[i];
    var messages = thread.getMessages();
    var wroteAny = false;

    for (var j = 0; j < messages.length; j++) {
      var msg = messages[j];

      if (processedIds[msg.getId()]) continue; // already processed

      var body = msg.getPlainBody();

      // Guard: only process emails that are actually PayNow confirmations.
      // "iBanking Alerts" is a broad subject — this prevents accidentally
      // capturing other DBS alert types that share the same subject line.
      if (body.toUpperCase().indexOf('PAYNOW') === -1) {
        Logger.log('POSB PayNow: email skipped — body does not mention PAYNOW. Subject: ' + msg.getSubject());
        markProcessed(processedIds, msg);
        continue;
      }

      // Amount: handles both "SGD12.90" (iBanking Alerts format) and "S$12.90" (older format)
      var amtMatch  = body.match(/Amount\s*:\s*(?:[A-Z]{3}|S\$|\$)?\s*([\d,]+\.?\d*)/i);
      var toMatch   = body.match(/To\s*:\s*(.+)/i);
      // Date: handles "13 Apr 19:18 (SGT)" — captures day + 3-letter month, ignores time
      var dateMatch = body.match(/Date\s*(?:&|and)?\s*Time\s*:\s*(\d{1,2}\s+[A-Za-z]{3})/i);

      if (!amtMatch) {
        Logger.log('POSB PayNow: could not parse amount. Subject: ' + msg.getSubject());
        writeParseFailureStub(msg, 'POSB Savings', processedIds);
        continue;
      }

      var amount  = parseFloat(amtMatch[1].replace(/,/g, ''));
      var recipient = toMatch ? toMatch[1].trim() : 'Unknown';
      var txnDate = dateMatch ? parseDBSDate(dateMatch[1]) : msg.getDate();

      var context  = 'PayNow \u2192 ' + recipient;
      var row = buildRow(txnDate, amount, '\u26a0\ufe0f REVIEW', context,
                         'POSB Savings', 'SGD', 'NO', '0%', 0, '');

      var written = writeRow(row);
      if (!written) {
        Logger.log('POSB PayNow: write failed — will retry on next run. Recipient: ' + recipient);
        continue; // leave message untracked so next run retries it
      }
      markProcessed(processedIds, msg);
      msg.markRead();
      count++;
      wroteAny = true;
    }

    if (wroteAny) thread.addLabel(label);
  }

  Logger.log('POSB PayNow: wrote ' + count + ' rows');
  return count;
}

// ─────────────────────────────────────────────────────────────
// HSBC REVOLUTION PARSER
// Subject: "Transaction Alerts (Credit Card)"
// Sender:  HSBC.Bank.Singapore.Limited@notification.hsbc.com.hk
// Email is table-based HTML; plain text has label and value on
// separate lines (no colon), so regex uses \s+ between them.
// ─────────────────────────────────────────────────────────────
function processHSBCEmails(label, processedIds, searchDays) {
  var query = 'from:HSBC.Bank.Singapore.Limited@notification.hsbc.com.hk subject:"Transaction Alerts" ' + rollingDateFilter(searchDays);
  var threads = GmailApp.search(query);
  var count = 0;

  for (var i = 0; i < threads.length; i++) {
    var thread = threads[i];
    var messages = thread.getMessages();
    var wroteAny = false;

    for (var j = 0; j < messages.length; j++) {
      var msg = messages[j];
      if (processedIds[msg.getId()]) continue;

      var rawBody = msg.getPlainBody();
      var body = rawBody
        .replace(/\u00a0/g, ' ')   // non-breaking space → regular space
        .replace(/\r\n/g, '\n')    // CRLF → LF
        .replace(/[ \t]{2,}/g, ' '); // collapse multiple spaces/tabs (table cell artefacts)

      var emailDate = msg.getDate();

      // Fields are on their own lines, label then value (may have blank lines between).
      // \s* between currency code and digits handles "SGD 12.80" and "SGD12.80" variants.
      var txnDateMatch = body.match(/Transaction\s+Date\s*:?\s+(\d{2}\/[A-Za-z]{3}\/\d{4})/i);
      var txnAmtMatch  = body.match(/Transaction\s+Amount\s*:?\s+([A-Z]{3})\s*([\d,]+\.?\d*)/i);
      var descMatch    = body.match(/Description\s*:?\s+([^\n\r]+)/i);

      if (!txnAmtMatch || !descMatch) {
        Logger.log('HSBC: could not parse email. Subject: ' + msg.getSubject());
        Logger.log('HSBC body (first 800 chars):\n' + body.substring(0, 800));
        writeParseFailureStub(msg, 'HSBC Revolution', processedIds);
        continue;
      }

      var txnDate  = txnDateMatch ? parseHSBCDate(txnDateMatch[1]) : emailDate;
      var currency = txnAmtMatch[1].toUpperCase();
      var amount   = parseFloat(txnAmtMatch[2].replace(/,/g, ''));
      var context  = normalizeContext(stripTrailingCountry(descMatch[1].replace(/\s+/g, ' ').trim()));

      var card     = 'HSBC Revolution';
      autoRegisterMerchant(context);
      var displayContext = resolveContext(context);
      var category = guessCategory(context);

      // Convert foreign amounts to SGD; reward maths uses the SGD value.
      var conv     = toSGD(amount, currency);
      var reward   = calcHSBCReward(context, currency, conv.amount);

      // FX fetch failed → amount is still foreign; flag for review, no reward.
      if (conv.currency !== 'SGD') {
        category = '⚠️ REVIEW';
        reward   = { bonusEligible: '⚠️', rate: '', estReward: 0 };
      }

      var row = buildRow(txnDate, conv.amount, category, displayContext, card, conv.currency,
                         reward.bonusEligible, reward.rate, reward.estReward, conv.remark);

      var written = writeRow(row);
      if (!written) {
        Logger.log('HSBC: write failed — will retry. Description: ' + context);
        continue;
      }
      markProcessed(processedIds, msg);
      msg.markRead();
      count++;
      wroteAny = true;
    }

    if (wroteAny) thread.addLabel(label);
  }

  Logger.log('HSBC: wrote ' + count + ' rows');
  return count;
}

// ─────────────────────────────────────────────────────────────
// POSB EVERYDAY CARD PARSER
// Subject: "Card Transaction Alert"
// Sender:  ibanking.alert@dbs.com
// Only processes transactions for card ending 9299.
// ─────────────────────────────────────────────────────────────
function processPOSBEverydayEmails(label, processedIds, searchDays) {
  var query = 'from:ibanking.alert@dbs.com subject:"Card Transaction Alert" ' + rollingDateFilter(searchDays);
  var threads = GmailApp.search(query);
  var count = 0;

  for (var i = 0; i < threads.length; i++) {
    var thread = threads[i];
    var messages = thread.getMessages();
    var wroteAny = false;

    for (var j = 0; j < messages.length; j++) {
      var msg = messages[j];
      if (processedIds[msg.getId()]) continue;

      var body = msg.getPlainBody().replace(/\u00a0/g, ' ').replace(/\r\n/g, '\n');

      // Only process transactions from card ending 9299
      if (body.indexOf('9299') === -1) {
        markProcessed(processedIds, msg); // not our card — mark seen and skip
        continue;
      }

      // \s* between currency and digits: DBS uses both "SGD0.10" and "SGD 0.10"
      var amtMatch  = body.match(/Amount\s*:\s*([A-Z]{3})\s*([\d,]+\.?\d*)/i);
      var toMatch   = body.match(/To\s*:\s*(.+)/i);
      var dateMatch = body.match(/Date\s*(?:&|and)?\s*Time\s*:\s*(.+)/i);

      if (!amtMatch) {
        Logger.log('POSB Everyday: could not parse amount. Subject: ' + msg.getSubject());
        writeParseFailureStub(msg, 'POSB Everyday', processedIds);
        continue;
      }

      var currency = amtMatch[1].toUpperCase();
      var amount   = parseFloat(amtMatch[2].replace(/,/g, ''));
      var txnDate  = dateMatch ? parsePOSBCardDate(dateMatch[1]) : msg.getDate();

      // Strip trailing country code from merchant name (e.g. "BUS/MRT SINGAPORE SGP")
      var rawMerchant = toMatch ? toMatch[1].trim() : 'Unknown';
      var context     = normalizeContext(stripTrailingCountry(rawMerchant));

      autoRegisterMerchant(context);
      var displayContext = resolveContext(context);
      var category = guessCategory(context);

      // Convert to SGD. The reward calculator still receives the ORIGINAL
      // currency so the MYR 10% tier (Malaysia spend) is detected correctly,
      // but the cashback maths and recorded amount use the converted SGD value.
      var conv     = toSGD(amount, currency);
      var reward   = calcPOSBEverydayReward(context, currency, conv.amount);

      // FX fetch failed → amount is still foreign; flag for review, no reward.
      if (conv.currency !== 'SGD') {
        category = '⚠️ REVIEW';
        reward   = { bonusEligible: '⚠️', rate: '', estReward: 0, remark: '' };
      }

      var remarks  = joinRemarks(reward.remark, conv.remark);

      var row = buildRow(txnDate, conv.amount, category, displayContext, 'POSB Everyday', conv.currency,
                         reward.bonusEligible, reward.rate, reward.estReward, remarks);

      var written = writeRow(row);
      if (!written) {
        Logger.log('POSB Everyday: write failed — will retry. Merchant: ' + context);
        continue;
      }
      markProcessed(processedIds, msg);
      msg.markRead();
      count++;
      wroteAny = true;
    }

    if (wroteAny) thread.addLabel(label);
  }

  Logger.log('POSB Everyday: wrote ' + count + ' rows');
  return count;
}

// ─────────────────────────────────────────────────────────────
// REWARD CALCULATORS
// ─────────────────────────────────────────────────────────────

function calcCitiCashbackReward(amount) {
  // Citi CashBack+ Card: flat 1.6% cashback on all spend, no exclusions
  return { bonusEligible: 'YES', rate: '1.6%', estReward: round2(amount * 0.016) };
}

function calcCitiReward(merchant, currency, amount, isAmaze) {
  var upper = merchant.toUpperCase();
  // Miles rounded down to nearest SGD1 per T&C clause 13
  var wholeAmt = Math.floor(amount);

  // FCY note — non-SGD spend is converted to SGD upstream (toSGD) before it
  // reaches here; the note flags that the estimate rests on a live FX rate.
  var fcyNote = (currency !== 'SGD') ? ' (FCY est.)' : '';

  // Step 1: Hard exclusions (travel MCCs, mobile wallets) — always base rate
  if (matchesAny(upper, CITI_EXCLUDE_KEYWORDS)) {
    return { bonusEligible: 'NO', rate: '0.4 mpd', estReward: round2(wholeAmt * 0.4) };
  }

  // Step 2: Via Amaze — Amaze re-codes any merchant as online MCC → 4 mpd
  if (isAmaze) {
    var isFCY = (currency !== 'SGD');
    return {
      bonusEligible: 'YES',
      rate: isFCY ? '4 mpd (FCY via Amaze)' : '4 mpd (via Amaze)',
      estReward: round2(wholeAmt * 4)
    };
  }

  // Step 3: Merchants table — definitive YES/NO overrides keyword guessing
  var record = lookupMerchant(merchant);
  if (record && record.citiOnline === 'YES') {
    return { bonusEligible: 'YES', rate: '4 mpd (online)' + fcyNote, estReward: round2(wholeAmt * 4) };
  }
  if (record && record.citiOnline === 'NO') {
    return { bonusEligible: 'NO', rate: '0.4 mpd', estReward: round2(wholeAmt * 0.4) };
  }

  // Step 4: Confirmed-online keyword fallback — earn 4 mpd (online retail per T&C)
  if (matchesAny(upper, CITI_ONLINE_KEYWORDS)) {
    return { bonusEligible: 'YES', rate: '4 mpd (online)' + fcyNote, estReward: round2(wholeAmt * 4) };
  }

  // Step 5: Everything else (physical dining, groceries, transport etc.) → base 0.4 mpd
  // Citi 10X requires online channel or clothing/shoes/bags MCC — can't confirm from email alone
  return { bonusEligible: 'NO', rate: '0.4 mpd', estReward: round2(wholeAmt * 0.4) };
}

function calcHSBCReward(merchant, currency, amount) {
  var upper    = merchant.toUpperCase();
  var wholeAmt = Math.floor(amount);  // miles rounded down to nearest SGD1 per T&C clause 8

  // FCY note — non-SGD spend is converted to SGD upstream (toSGD) before it
  // reaches here; the note flags that the estimate rests on a live FX rate.
  var fcyNote = (currency !== 'SGD') ? ' (FCY est.)' : '';

  // Step 1: Exclusions (fast food, food delivery, OTAs, transit) — always base rate
  if (matchesAny(upper, HSBC_EXCLUDE_KEYWORDS)) {
    return { bonusEligible: 'NO', rate: '0.4 mpd', estReward: round2(wholeAmt * 0.4) };
  }

  // Step 2: Merchants table — definitive YES/NO overrides keyword guessing
  var record = lookupMerchant(merchant);
  if (record && record.hsbcEligible === 'YES') {
    return { bonusEligible: 'YES', rate: '4 mpd' + fcyNote, estReward: round2(wholeAmt * 4) };
  }
  if (record && record.hsbcEligible === 'NO') {
    return { bonusEligible: 'NO', rate: '0.4 mpd', estReward: round2(wholeAmt * 0.4) };
  }

  // Step 2b: GRAB* — normalizeContext collapses every Grab charge (rides AND
  // GrabFood) to "GRAB*", and the two earn opposite rates on this card (rides
  // 4 mpd via the GRAB keyword, GrabFood excluded at 0.4 mpd). The descriptor
  // can't tell them apart, so flag for review at base rate instead of letting
  // the keyword list award 4 mpd to food delivery. A Merchants-table row for
  // GRAB* (Step 2) still overrides this if you decide one way.
  if (/^GRAB\*/.test(upper)) {
    return { bonusEligible: '⚠️', rate: '0.4 mpd (Grab ride/food?)', estReward: round2(wholeAmt * 0.4) };
  }

  // Step 3: Bonus keyword fallback — earn 4 mpd (both contactless + online, restored Apr 2026)
  if (matchesAny(upper, HSBC_BONUS_KEYWORDS)) {
    return { bonusEligible: 'YES', rate: '4 mpd' + fcyNote, estReward: round2(wholeAmt * 4) };
  }

  // Step 4: Everything else — 0.4 mpd base
  return { bonusEligible: '\u26a0\ufe0f', rate: '0.4 mpd', estReward: round2(wholeAmt * 0.4) };
}

function calcPOSBEverydayReward(merchant, currency, amount) {
  var upper = merchant.toUpperCase();

  // MYR in-store: 10% (needs $800 min spend)
  if (currency === 'MYR') {
    return { bonusEligible: '\u26a0\ufe0f', rate: '10% MYR', estReward: round2(amount * 0.10), remark: 'Needs $800 min spend' };
  }

  // GRAB* is ambiguous after normalizeContext (ride vs GrabFood) — GrabFood
  // would earn the 10% delivery tier, rides only base. Flag for review at the
  // base rate rather than guessing 10%.
  if (/^GRAB\*/.test(upper)) {
    return { bonusEligible: '⚠️', rate: '0.3% (Grab ride/food?)', estReward: round2(amount * 0.003), remark: 'Grab: fix tier after review' };
  }

  // Food delivery: 10% (needs $800 min spend)
  if (matchesAny(upper, POSB_DELIVERY_10PCT)) {
    return { bonusEligible: '\u26a0\ufe0f', rate: '10% delivery', estReward: round2(amount * 0.10), remark: 'Needs $800 min spend' };
  }

  // Transit (SimplyGo / BUS/MRT): 10% (needs $800 min spend)
  if (matchesAny(upper, POSB_TRANSIT_10PCT)) {
    return { bonusEligible: '\u26a0\ufe0f', rate: '10% transit', estReward: round2(amount * 0.10), remark: 'Needs $800 min spend' };
  }

  // Dining 5% — excludes fast food (needs $800 min spend)
  if (!matchesAny(upper, POSB_DINING_EXCL) && matchesAny(upper, POSB_DINING_5PCT)) {
    return { bonusEligible: '\u26a0\ufe0f', rate: '5% dining', estReward: round2(amount * 0.05), remark: 'Needs $800 min spend' };
  }

  // Online shopping 5% (needs $800 min spend)
  if (matchesAny(upper, POSB_SHOPPING_5PCT)) {
    return { bonusEligible: '\u26a0\ufe0f', rate: '5% online', estReward: round2(amount * 0.05), remark: 'Needs $800 min spend' };
  }

  // Sheng Siong 5% — no min spend required
  if (matchesAny(upper, POSB_SHENGSIONG_5PCT)) {
    return { bonusEligible: 'YES', rate: '5% supermarket', estReward: round2(amount * 0.05), remark: '' };
  }

  // Watsons 3% — no min spend required
  if (matchesAny(upper, POSB_WATSONS_3PCT)) {
    return { bonusEligible: 'YES', rate: '3% Watsons', estReward: round2(amount * 0.03), remark: '' };
  }

  // SPC 6% — no min spend required
  if (matchesAny(upper, POSB_SPC_6PCT)) {
    return { bonusEligible: 'YES', rate: '6% fuel', estReward: round2(amount * 0.06), remark: '' };
  }

  // Base rate 0.3% — always applicable
  return { bonusEligible: 'YES', rate: '0.3%', estReward: round2(amount * 0.003), remark: '' };
}

// ─────────────────────────────────────────────────────────────
// MERCHANT TABLE — reads the Merchants sheet tab
// ─────────────────────────────────────────────────────────────

/**
 * Load the Merchants tab into memory (cached for the lifetime of this
 * script execution).  Each row becomes an object with keys:
 *   matchKey, displayName, category, hsbcEligible, citiOnline, mcc, notes
 */
function getMerchantsTable() {
  if (_merchantsCache) return _merchantsCache;
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName(MERCHANTS_TAB);
  if (!sheet) return (_merchantsCache = []);
  var rows = sheet.getDataRange().getValues();
  _merchantsCache = [];
  for (var i = 1; i < rows.length; i++) {   // row 0 is the header
    var key = rows[i][0];
    if (!key || key.toString().trim() === '') continue;
    _merchantsCache.push({
      matchKey:     key.toString().toUpperCase().trim(),
      displayName:  rows[i][1] ? rows[i][1].toString().trim() : '',
      category:     rows[i][2] ? rows[i][2].toString().trim() : '',
      hsbcEligible: rows[i][3] ? rows[i][3].toString().toUpperCase().trim() : '',
      citiOnline:   rows[i][4] ? rows[i][4].toString().toUpperCase().trim() : '',
      mcc:          rows[i][5] ? rows[i][5].toString().trim() : '',
      notes:        rows[i][6] ? rows[i][6].toString().trim() : ''
    });
  }
  Logger.log('Merchants table loaded: ' + _merchantsCache.length + ' entries');
  return _merchantsCache;
}

/**
 * Return the Merchants row whose matchKey matches the merchant name.
 * Matching is word-start anchored (same rule as containsKeyword), so a short
 * key like "SPC" can't fire mid-word, and when several keys match the LONGEST
 * one wins ("GRABPAY" beats "GRAB") instead of whichever row happens to sit
 * higher in the sheet. Returns null if nothing matches.
 */
function lookupMerchant(merchantName) {
  var upper   = merchantName.toUpperCase();
  var records = getMerchantsTable();
  var best    = null;
  for (var i = 0; i < records.length; i++) {
    if (containsKeyword(upper, records[i].matchKey) &&
        (!best || records[i].matchKey.length > best.matchKey.length)) {
      best = records[i];
    }
  }
  return best;
}

// MCC Explorer API removed — did not reliably identify Singapore merchants.
// MCC lookup is now done manually: user provides merchant→MCC groupings,
// which are batch-loaded via runSheetImport().


/**
 * Maps an MCC code to HSBC Revolution bonus eligibility.
 * Returns 'YES' (4 mpd), 'NO' (0.4 mpd), or '' (unknown — user reviews).
 * Source: HSBC Revolution T&C + MileLion April 2026 confirmation.
 */
function mccToHsbcEligible(mcc) {
  var n = parseInt(mcc, 10);
  if (isNaN(n)) return '';

  // Excluded — always 0.4 mpd
  if (n === 5814)               return 'NO';  // Fast food / QSR
  if (n === 4111 || n === 4131) return 'NO';  // Public transit / SimplyGo
  if (n === 4722 || n === 4723) return 'NO';  // OTAs (Agoda, Booking.com etc.)

  // Bonus eligible — 4 mpd (contactless + online, restored Apr 2026)
  if (n === 5812 || n === 5811 || n === 5462) return 'YES'; // Restaurants / bakeries
  if (n === 4121)               return 'YES'; // Taxicabs / ride-hailing
  if (n === 4511)               return 'YES'; // Airlines (direct booking)
  if (n === 7011)               return 'YES'; // Hotels (direct booking)
  if (n === 5815)               return 'YES'; // Digital goods / streaming
  if (n === 7372 || n === 7375) return 'YES'; // Software / subscriptions
  if (n === 5311 || n === 5999) return 'YES'; // Department / retail stores
  if (n >= 3000 && n <= 3350)   return 'YES'; // Airline MCCs (direct)
  if (n >= 3501 && n <= 3999)   return 'YES'; // Hotel MCCs (direct)

  return ''; // Unknown — user reviews
}

/**
 * Maps an MCC code to Citi Rewards online eligibility.
 * Travel MCCs are hard-excluded by T&C regardless of channel → 'NO'.
 * All other MCCs return '' because the online/offline channel cannot be
 * determined from the email alone — keyword arrays and user override handle it.
 * Source: Citi Rewards 10X Promotion T&C, effective 1 April 2024.
 */
function mccToCitiOnline(mcc) {
  var n = parseInt(mcc, 10);
  if (isNaN(n)) return '';

  // Citi hard exclusions — always 0.4 mpd regardless of channel
  if (n === 4511)               return 'NO'; // Airlines
  if (n === 7011)               return 'NO'; // Hotels
  if (n === 7512)               return 'NO'; // Car rental
  if (n === 4722 || n === 4723) return 'NO'; // OTAs
  if (n >= 3000 && n <= 3350)   return 'NO'; // Airline MCCs
  if (n >= 3351 && n <= 3500)   return 'NO'; // Car rental MCCs
  if (n >= 3501 && n <= 3999)   return 'NO'; // Hotel MCCs

  return ''; // Channel unknown — keyword list / user fills in
}

/**
 * Append a new row to the Merchants tab and add it to the in-memory cache so
 * subsequent lookups within the same run see the new entry. (Nulling the
 * cache here used to force a full re-read of the Merchants tab after every
 * new merchant — O(n²) sheet reads during bulk imports.)
 */
function addMerchantToTable(matchKey, displayName, category, hsbcEligible, citiOnline, mcc, notes) {
  // Skip if this merchant is already in the table — prevents duplicate rows
  if (lookupMerchant(matchKey)) {
    Logger.log('addMerchantToTable: "' + matchKey + '" already exists — skipping');
    return;
  }
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName(MERCHANTS_TAB);
  if (!sheet) {
    Logger.log('addMerchantToTable: Merchants tab not found — skipping');
    return;
  }
  sheet.appendRow([
    matchKey.toUpperCase().trim(),
    displayName,
    category,
    hsbcEligible,
    citiOnline,
    mcc,
    notes
  ]);
  if (_merchantsCache) {
    _merchantsCache.push({
      matchKey:     matchKey.toUpperCase().trim(),
      displayName:  displayName ? String(displayName).trim() : '',
      category:     category ? String(category).trim() : '',
      hsbcEligible: hsbcEligible ? String(hsbcEligible).toUpperCase().trim() : '',
      citiOnline:   citiOnline ? String(citiOnline).toUpperCase().trim() : '',
      mcc:          mcc ? String(mcc).trim() : '',
      notes:        notes ? String(notes).trim() : ''
    });
  }
  Logger.log('Added to Merchants tab: ' + matchKey);
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Email yourself when something breaks. Throttled to one email per distinct
 * subject per 6 hours (CacheService) so a broken parser can't flood the inbox.
 * Failure paths used to be Logger.log-only, which nobody reads — a bank
 * changing its email template would have dropped transactions with no symptom.
 */
function notifyError(subject, detail) {
  try {
    var cache = CacheService.getScriptCache();
    var key = 'err_' + subject.replace(/\W+/g, '_').substring(0, 90);
    if (cache.get(key)) return;
    cache.put(key, '1', 6 * 3600);
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
                      '[Expense Tracker] ' + subject, detail);
  } catch (e) {
    Logger.log('notifyError failed (' + subject + '): ' + e);
  }
}

/**
 * A parser hit an email it could not read (bank changed the template, new
 * alert variant, …). Instead of marking it processed and losing the
 * transaction forever, write a ⚠️ REVIEW stub row carrying the email's date
 * and subject, and send an alert. The message is only marked processed once
 * the stub is safely in the sheet — if the write fails, next run retries.
 */
function writeParseFailureStub(msg, cardLabel, processedIds) {
  var row = buildRow(msg.getDate(), 0, '⚠️ REVIEW',
                     'PARSE FAILED: ' + msg.getSubject(), cardLabel, 'SGD',
                     'NO', '', 0,
                     'Parser could not read this email — find it in Gmail and enter the amount manually');
  if (writeRow(row)) {
    markProcessed(processedIds, msg);
  }
  notifyError(cardLabel + ' parse failure',
              'Could not parse "' + msg.getSubject() + '" (' + msg.getDate() + ').\n' +
              'A ⚠️ REVIEW stub row (amount 0) was written to the sheet.\n' +
              'The bank may have changed its email template — check the execution log.');
}

// ISO alpha-3 codes that appear as trailing country markers on card
// descriptors. A bare /[A-Z]{3}$/ strip also chopped real merchant words
// ("GONG CHA" → "GONG"), so only strip a known country code.
var TRAILING_COUNTRY_RE = /\s+(SGP|MYS|JPN|THA|IDN|VNM|PHL|KHM|MMR|LKA|IND|CHN|HKG|TWN|KOR|MAC|AUS|NZL|USA|CAN|GBR|IRL|FRA|DEU|NLD|BEL|LUX|CHE|AUT|ITA|ESP|PRT|GRC|TUR|ARE|QAT|SAU|DNK|SWE|NOR|FIN|ISL)\s*$/i;

function stripTrailingCountry(s) {
  return s.replace(TRAILING_COUNTRY_RE, '').trim();
}

/**
 * Strips location suffixes from merchant strings so that one Merchants table
 * entry covers all location variants of the same chain.
 *
 * Applied before autoRegisterMerchant() in every parser, so new locations
 * of a known merchant never create a duplicate row.
 *
 * Rules (applied in order):
 *  1. GRAB* booking codes  → "GRAB* A-98IFM9CGWAWRAV SINGAPORE" → "GRAB*"
 *  2. @ separator          → "STARBUCKS@WEST COAST" → "STARBUCKS"
 *                            "KOPITIAM @VIVO SINGAPORE" → "KOPITIAM"
 *  3. " - " separator      → "CHICHA SAN CHEN - TAMP" → "CHICHA SAN CHEN"
 *                            "MISTER DONUT - TAMPINE" → "MISTER DONUT"
 *  4. Trailing SINGAPORE / SGP (left over when the parser didn't pre-strip it)
 *                            "SOME MERCHANT SINGAPORE" → "SOME MERCHANT"
 *
 * NOT handled here (no separator): "SPC 337 CHANGI RD", "COLD STORAGE WEST COAS".
 * Fix those by setting a short matchKey in the Merchants table (e.g. "SPC",
 * "COLD STORAGE") — the substring lookup then catches all location variants.
 */
function normalizeContext(context) {
  // Rule 1: GRAB* dynamic booking codes
  if (/^GRAB\*/i.test(context)) return 'GRAB*';

  // Rule 2: @ separator (with optional leading space)
  var atIdx = context.search(/\s*@/);
  if (atIdx > 0) context = context.substring(0, atIdx).trim();

  // Rule 3: " - " separator (spaces on both sides keeps "7-ELEVEN" safe)
  var dashIdx = context.indexOf(' - ');
  if (dashIdx > 0) context = context.substring(0, dashIdx).trim();

  // Rule 4: trailing SINGAPORE or SGP
  context = context.replace(/\s+(SINGAPORE|SGP)\s*$/i, '').trim();

  return context;
}

/**
 * True if `keyword` appears in `haystack` at a word start, e.g. "APPLE" matches
 * "APPLE.COM" and "APPLE PAY" but NOT "PINEAPPLE". A plain indexOf would match
 * the latter and wrongly classify it. We anchor the START only (a leading \b),
 * not the end, so prefix-style keywords still work: "MCDONALD" matches
 * "MCDONALDS". Keywords beginning with a non-word char (e.g. "FP*") get no
 * anchor and fall back to a plain substring match.
 */
function containsKeyword(haystack, keyword) {
  var escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var lead = /^\w/.test(keyword) ? '\\b' : '';
  return new RegExp(lead + escaped, 'i').test(haystack);
}

// True if any keyword in the list matches the merchant string.
function matchesAny(haystack, keywords) {
  for (var i = 0; i < keywords.length; i++) {
    if (containsKeyword(haystack, keywords[i])) return true;
  }
  return false;
}

function guessCategory(merchant) {
  // 1. Check the Merchants table first — allows per-merchant overrides
  var record = lookupMerchant(merchant);
  if (record && record.category) return record.category;

  // 2. Fall back to hardcoded keyword map
  var upper = merchant.toUpperCase();
  for (var cat in CATEGORY_KEYWORDS) {
    if (matchesAny(upper, CATEGORY_KEYWORDS[cat])) return cat;
  }
  return '\u26a0\ufe0f REVIEW';
}

/**
 * Returns the display name to write into the Context column.
 * Uses the Merchants table displayName when set; falls back to the raw email string.
 */
function resolveContext(rawMerchant) {
  var record = lookupMerchant(rawMerchant);
  if (record && record.displayName) return record.displayName;
  return rawMerchant;
}

/**
 * Registers a merchant in the Merchants table the first time it is seen.
 * All fields are left blank for the user to fill in via runSheetImport() or manually.
 * Safe to call on every transaction — skips silently if merchant already exists.
 */
function autoRegisterMerchant(rawMerchant) {
  if (!rawMerchant || !rawMerchant.trim()) return; // nothing to register — avoids blank rows
  if (lookupMerchant(rawMerchant)) return;         // already known

  addMerchantToTable(
    rawMerchant,        // matchKey — uppercased inside addMerchantToTable()
    '',                 // displayName — user fills in
    '',                 // category — user fills in via runBulkImport()
    '',                 // hsbcEligible — user fills in
    '',                 // citiOnline — user fills in
    '',                 // mcc — user fills in
    'Needs classification'
  );
}

/**
 * Sheet-driven bulk import. Reads from the "BulkImport" tab.
 * Columns: A = Merchant Name | B = MCC | C = Category (optional, defaults to "Food")
 *
 * matchKey is auto-generated: strip trailing location suffix like "(Jem)", uppercase.
 *   "Ichiban Boshi (Jem)" → matchKey "ICHIBAN BOSHI"
 * Duplicate chains with multiple location rows collapse to one matchKey automatically.
 *
 * Safe to re-run — existing matchKeys are skipped.
 * To import a new MCC batch: update col A & B in the BulkImport tab, re-run.
 */
function runSheetImport() {
  var ss          = getSpreadsheet();
  var importSheet = ss.getSheetByName('BulkImport');
  if (!importSheet) {
    Logger.log('runSheetImport: BulkImport tab not found. Run setupBulkImportTab() first.');
    return;
  }

  var data   = importSheet.getDataRange().getValues();
  var added  = 0, skipped = 0, errors = 0;

  for (var i = 1; i < data.length; i++) {        // row 0 is the header
    var rawName  = String(data[i][0]).trim();
    var mcc      = String(data[i][1]).trim();
    var category = String(data[i][2]).trim() || 'Food';

    if (!rawName) continue;                       // skip blank rows

    // Strip trailing location suffix, e.g. "(Jem)" or "(Jurong Point)"
    var matchKey = rawName.replace(/\s*\([^)]*\)\s*$/, '').trim().toUpperCase();

    if (lookupMerchant(matchKey)) { skipped++; continue; }

    try {
      addMerchantToTable(
        matchKey,
        rawName,
        category,
        mccToHsbcEligible(mcc),
        mccToCitiOnline(mcc),
        mcc,
        'Bulk import MCC ' + mcc
      );
      added++;
    } catch (e) {
      Logger.log('runSheetImport: error on row ' + (i + 1) + ' (' + rawName + '): ' + e.toString());
      errors++;
    }
  }

  Logger.log('Sheet import complete — added: ' + added + ', skipped: ' + skipped + ', errors: ' + errors);
}

/**
 * One-time setup: creates the BulkImport staging tab.
 * Run this once, then paste merchant names into col A and the MCC into col B.
 */
function setupBulkImportTab() {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName('BulkImport');
  if (sheet) {
    Logger.log('setupBulkImportTab: tab already exists — nothing to do');
    return;
  }
  sheet = ss.insertSheet('BulkImport');
  sheet.getRange(1, 1, 1, 3).setValues([['Merchant Name', 'MCC', 'Category']]);
  sheet.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground('#fce5cd');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 260);
  sheet.setColumnWidth(2, 80);
  sheet.setColumnWidth(3, 100);
  Logger.log('setupBulkImportTab: BulkImport tab created');
}

/** Build an 11-element array matching column order A–K */
function buildRow(date, amount, category, context, card, currency,
                  bonusEligible, rewardRate, estReward, remarks) {
  var monthKey = formatMonthKey(date);
  var dateStr  = formatDate(date);
  return [monthKey, dateStr, amount, category, context, card,
          currency, bonusEligible, rewardRate, estReward, remarks];
}

function writeRow(row) {
  try {
    var ss    = getSpreadsheet();
    var sheet = ss.getSheetByName(TAB_NAME);
    if (!sheet) {
      Logger.log('ERROR: Sheet tab "' + TAB_NAME + '" not found!');
      notifyError('Sheet tab "' + TAB_NAME + '" not found',
                  'writeRow() cannot find the Transactions tab. The pipeline is ' +
                  'stalled (rows are retried each run) until the tab is restored.');
      return false;
    }
    sheet.appendRow(row);
    Logger.log('Written: ' + JSON.stringify(row));
    return true;
  } catch (e) {
    Logger.log('ERROR writing row: ' + e.toString());
    notifyError('Sheet write failing',
                'writeRow() threw: ' + e + '\nThe row will be retried on the next run.');
    return false;
  }
}

function getOrCreateLabel(name) {
  var label = GmailApp.getUserLabelByName(name);
  if (!label) label = GmailApp.createLabel(name);
  return label;
}

// Whole-day number since the Unix epoch (used to age out processed IDs).
function epochDay(date) {
  return Math.floor(date.getTime() / 86400000);
}

/**
 * Record a message as processed, storing the DAY of the email (not "true").
 * Storing the day lets saveProcessedIds() prune by age rather than by a blind
 * count, which is what guarantees an email still inside the search window is
 * never forgotten and re-written as a duplicate.
 */
var _marksSinceSave = 0;

function markProcessed(processedIds, msg) {
  processedIds[msg.getId()] = epochDay(msg.getDate());
  // Periodic save: Apps Script's hard 6-minute kill skips finally blocks, so
  // without this a timeout mid-backlog would forget every row written this
  // run and duplicate them all next run. Now at most ~10 marks are at risk.
  if (++_marksSinceSave >= 10) {
    _marksSinceSave = 0;
    saveProcessedIds(processedIds);
  }
}

/**
 * Load the map of already-processed Gmail message IDs from Script Properties.
 * Returns { messageId: epochDay, ... }. Backward-compatible with the old format
 * (a plain JSON array of IDs) — those are imported as "seen today".
 */
function loadProcessedIds() {
  var raw = PropertiesService.getScriptProperties().getProperty('processedMsgIds');
  if (!raw) return {};
  try {
    var parsed = JSON.parse(raw);
    var map = {};
    if (Array.isArray(parsed)) {
      // Legacy format: array of IDs with no dates — keep them, dated today.
      var today = epochDay(new Date());
      for (var i = 0; i < parsed.length; i++) map[parsed[i]] = today;
    } else {
      map = parsed; // new format: { id: epochDay }
    }
    return map;
  } catch (e) {
    // A corrupt store must ABORT the run: returning {} would re-process every
    // email in the search window and write them all as duplicate rows.
    notifyError('processedMsgIds store corrupted',
                'JSON parse failed: ' + e + '\nRaw value (first 500 chars): ' +
                String(raw).substring(0, 500) +
                '\nRuns are halted until the "processedMsgIds" Script Property is fixed or deleted.');
    throw new Error('loadProcessedIds: corrupt store — aborting to avoid duplicate rows: ' + e);
  }
}

/**
 * Persist the processed-ID map back to Script Properties.
 * Prunes any ID older than PROCESSED_RETENTION_DAYS — safe because an email
 * that old is already outside the ROLLING_WINDOW_DAYS search window, so it can
 * never be re-found and re-written. Retention > search window is the actual
 * guard against duplicate rows.
 *
 * A hard count cap (MAX_IDS) is kept only as a 9 KB property-size safety net;
 * it would only ever trigger above ~10 transactions/day sustained.
 */
function saveProcessedIds(map) {
  var nowDay = epochDay(new Date());
  var cutoff = nowDay - PROCESSED_RETENTION_DAYS;

  var kept = {};
  var keys = Object.keys(map);
  for (var i = 0; i < keys.length; i++) {
    var day = map[keys[i]];
    if (typeof day !== 'number') day = nowDay; // legacy "true" → treat as today
    if (day >= cutoff) kept[keys[i]] = day;
  }

  // Safety net against the 9 KB per-property limit: keep the newest by day.
  // 300 entries ≈ 8 KB of JSON — the previous cap of 450 could EXCEED 9 KB,
  // making setProperty throw and lose every ID from the run. Trimming can
  // evict IDs still inside the search window, so it alerts when it fires.
  var keptKeys = Object.keys(kept);
  var MAX_IDS = 300;
  if (keptKeys.length > MAX_IDS) {
    keptKeys.sort(function(a, b) { return kept[a] - kept[b]; }); // oldest first
    var trimmed = {};
    for (var k = keptKeys.length - MAX_IDS; k < keptKeys.length; k++) {
      trimmed[keptKeys[k]] = kept[keptKeys[k]];
    }
    kept = trimmed;
    notifyError('processedMsgIds trimmed to ' + MAX_IDS + ' entries',
                'The processed-ID store hit its size cap. IDs still inside the ' +
                ROLLING_WINDOW_DAYS + '-day search window may have been evicted — ' +
                'watch the sheet for duplicate rows.');
  }

  try {
    PropertiesService.getScriptProperties().setProperty('processedMsgIds', JSON.stringify(kept));
  } catch (e) {
    // This runs inside finally blocks — alert before rethrowing, because a
    // failed save means every row from this run gets duplicated next run.
    notifyError('Failed to save processed-ID store', String(e));
    throw e;
  }
}

// Parse "DD/MM/YY" (Citi format) → Date
function parseCitiDate(str) {
  var parts = str.split('/');
  var day   = parseInt(parts[0], 10);
  var month = parseInt(parts[1], 10) - 1; // 0-indexed
  var year  = 2000 + parseInt(parts[2], 10);
  return new Date(year, month, day);
}

/**
 * Guards against two date-parsing hazards:
 *  1. A date with no year (V8 defaults missing years to 2001).
 *  2. Year rollover — e.g. a 31 Dec transaction processed on 1 Jan would
 *     otherwise be stamped with the new year. If the result lands more than
 *     2 days in the future, roll it back a year.
 */
function withYearGuard(date) {
  if (isNaN(date.getTime())) return new Date();
  var now = new Date();
  if (date.getTime() - now.getTime() > 2 * 86400000) {
    date.setFullYear(date.getFullYear() - 1);
  }
  return date;
}

// Parse "13 Apr" (DBS PayNow format — no year in the email) → Date.
// The previous version did new Date("13 Apr"), which V8 dates to the year 2001.
function parseDBSDate(str) {
  var m = str.match(/(\d{1,2})\s+([A-Za-z]{3})/);
  if (!m) return new Date();
  return withYearGuard(new Date(m[1] + ' ' + m[2] + ' ' + new Date().getFullYear()));
}

// Parse "11/APR/2026" (HSBC format) → Date
function parseHSBCDate(str) {
  // new Date("11 APR 2026") is understood by V8
  var parts = str.split('/');
  if (parts.length !== 3) return new Date();
  var d = new Date(parts[0] + ' ' + parts[1] + ' ' + parts[2]);
  // Invalid Date would otherwise write "NaN/undefined/NaN" into the sheet
  return isNaN(d.getTime()) ? new Date() : d;
}

// Parse "11 APR 19:58 (SGT)" (POSB Everyday format) → Date
// Extracts day and month only; uses current calendar year.
function parsePOSBCardDate(str) {
  var match = str.match(/(\d{1,2})\s+([A-Za-z]{3})/);
  if (!match) return new Date();
  return withYearGuard(new Date(match[1] + ' ' + match[2] + ' ' + new Date().getFullYear()));
}

// Format Date → "07/Apr/2026"
function formatDate(date) {
  var months = ['Jan','Feb','Mar','Apr','May','Jun',
                'Jul','Aug','Sep','Oct','Nov','Dec'];
  var d = String(date.getDate()).padStart ?
          String(date.getDate()).padStart(2,'0') :
          (date.getDate() < 10 ? '0' : '') + date.getDate();
  return d + '/' + months[date.getMonth()] + '/' + date.getFullYear();
}

// Format Date → "Apr-2026"
function formatMonthKey(date) {
  var months = ['Jan','Feb','Mar','Apr','May','Jun',
                'Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[date.getMonth()] + '-' + date.getFullYear();
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Open the spreadsheet once per execution. openById() is the slow Apps Script
// call, so caching the handle avoids re-opening on every row read/write.
function getSpreadsheet() {
  if (!_ss) _ss = SpreadsheetApp.openById(SHEET_ID);
  return _ss;
}

/**
 * Fetch how many SGD one unit of `currency` is worth (live mid-market rate).
 * Source: open.er-api.com — free, no API key, ~160 currencies (covers JPY, USD,
 * MYR, THB, TWD, VND etc.). Returns null if the lookup fails so callers can
 * leave the amount unconverted and flag it for review.
 *
 * Rates are cached for this run (_fxCache) and for 6 hours across runs
 * (CacheService) so we don't hit the API on every transaction.
 */
function getFxRate(currency) {
  if (_fxCache[currency] != null) return _fxCache[currency];

  var cache  = CacheService.getScriptCache();
  var cached = cache.get('fx_' + currency);
  if (cached) { _fxCache[currency] = parseFloat(cached); return _fxCache[currency]; }

  try {
    var url  = 'https://open.er-api.com/v6/latest/' + encodeURIComponent(currency);
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      Logger.log('getFxRate: HTTP ' + resp.getResponseCode() + ' for ' + currency);
      return null;
    }
    var data = JSON.parse(resp.getContentText());
    if (!data || data.result !== 'success' || !data.rates || !data.rates.SGD) {
      Logger.log('getFxRate: no SGD rate for ' + currency);
      return null;
    }
    var rate = data.rates.SGD;
    _fxCache[currency] = rate;
    cache.put('fx_' + currency, String(rate), 6 * 3600); // cache 6 hours
    return rate;
  } catch (e) {
    Logger.log('getFxRate error for ' + currency + ': ' + e);
    return null;
  }
}

/**
 * Convert a foreign amount to SGD (mid-market rate × FX_MARKUP).
 * Returns { amount, currency, remark }:
 *   - success  → SGD amount, currency 'SGD', remark records the original.
 *   - SGD in   → unchanged, no remark.
 *   - failure  → original amount/currency kept, remark flags it for review.
 */
function toSGD(amount, currency) {
  if (!currency || currency === 'SGD') {
    return { amount: amount, currency: 'SGD', remark: '' };
  }

  var rate = getFxRate(currency);
  if (!rate) {
    notifyError('FX rate unavailable for ' + currency,
                'open.er-api.com lookup failed. The transaction was written as a ' +
                '⚠️ REVIEW row with the original ' + currency + ' amount and no reward.');
    return {
      amount: amount,
      currency: currency,
      remark: 'REVIEW: FX rate unavailable for ' + currency + ' - amount NOT converted'
    };
  }

  var sgd       = round2(amount * rate * FX_MARKUP);
  var markupPct = round2((FX_MARKUP - 1) * 100);
  var remark    = 'Orig ' + currency + ' ' + amount + ' @ ' + rate.toFixed(4) +
                  (markupPct ? ' +' + markupPct + '%' : '');
  return { amount: sgd, currency: 'SGD', remark: remark };
}

// Merge a base remark with the FX conversion note (either may be empty).
function joinRemarks(base, fxRemark) {
  if (base && fxRemark) return base + ' | ' + fxRemark;
  return base || fxRemark || '';
}

// ─────────────────────────────────────────────────────────────
// ONE-TIME SETUP — run manually from the Apps Script editor
// ─────────────────────────────────────────────────────────────

/**
 * Creates the Merchants tab with headers if it doesn't already exist.
 * Run once from the Apps Script editor: select setupMerchantsTab → Run.
 */
function setupMerchantsTab() {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName(MERCHANTS_TAB);

  if (sheet) {
    Logger.log('setupMerchantsTab: tab already exists — nothing to do');
    return;
  }

  sheet = ss.insertSheet(MERCHANTS_TAB);
  var headers = [
    'Match Key',      // A — substring matched against raw merchant name (uppercase)
    'Display Name',   // B — clean readable name (for your reference only)
    'Category',       // C — Food / Transport / Shopping / Subscriptions / Entertainment / Misc
    'HSBC Eligible',  // D — YES = 4 mpd | NO = 0.4 mpd | blank = fall back to keyword logic
    'Citi Online',    // E — YES = 4 mpd online | NO = 0.4 mpd | blank = fall back to keyword logic
    'MCC Code',       // F — optional, for reference (look up on heymax.ai)
    'Notes'           // G — freetext
  ];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  // Style the header row
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#d9e1f2');

  // Freeze header row
  sheet.setFrozenRows(1);

  // Set sensible column widths
  sheet.setColumnWidth(1, 200);  // Match Key
  sheet.setColumnWidth(2, 180);  // Display Name
  sheet.setColumnWidth(3, 120);  // Category
  sheet.setColumnWidth(4, 120);  // HSBC Eligible
  sheet.setColumnWidth(5, 110);  // Citi Online
  sheet.setColumnWidth(6, 90);   // MCC Code
  sheet.setColumnWidth(7, 200);  // Notes

  Logger.log('setupMerchantsTab: Merchants tab created successfully');
  SpreadsheetApp.flush();
}

/**
 * Write placeholder rows into the Merchants tab for every auto-captured merchant
 * (from 1 Apr 2026) that is not yet classified.
 *
 * Run this once from the Apps Script editor to seed the Merchants tab.
 * Each row will have the Match Key pre-filled and all other columns blank —
 * open the sheet, look each one up on https://heymax.ai, then fill in
 * Category, HSBC Eligible, Citi Online, and MCC Code.
 *
 * Safe to re-run: already-known merchants are skipped (no duplicates added).
 */
function seedMerchantsTab() {
  var CUTOFF = new Date(2026, 3, 1);

  var AUTO_CAPTURED_CARDS = {
    'CitiRewards':     true,
    'HSBC Revolution': true,
    'POSB Everyday':   true,
    'POSB Savings':    true
  };

  var ss       = getSpreadsheet();
  var txnSheet = ss.getSheetByName(TAB_NAME);
  var mchSheet = ss.getSheetByName(MERCHANTS_TAB);

  if (!mchSheet) {
    Logger.log('seedMerchantsTab: Merchants tab not found — run setupMerchantsTab() first');
    return;
  }

  var txnRows   = txnSheet.getDataRange().getValues();
  var merchants = getMerchantsTable();   // existing entries (for duplicate check)

  var seen  = {};
  var added = 0;

  for (var i = 1; i < txnRows.length; i++) {
    var card = txnRows[i][COL.CARD - 1] ? txnRows[i][COL.CARD - 1].toString().trim() : '';
    if (!AUTO_CAPTURED_CARDS[card]) continue;

    var rawDate = txnRows[i][COL.DATE - 1];
    if (rawDate) {
      var txnDate = new Date(rawDate.toString());
      if (isNaN(txnDate.getTime()) || txnDate < CUTOFF) continue;
    }

    var ctx = txnRows[i][COL.CONTEXT - 1];
    if (!ctx) continue;
    var upper = ctx.toString().toUpperCase().trim();
    if (seen[upper]) continue;
    seen[upper] = true;

    if (upper.indexOf('PAYNOW') !== -1) continue;   // PayNow always ⚠️ REVIEW by design

    // Skip if already in the Merchants table
    var alreadyKnown = false;
    for (var j = 0; j < merchants.length; j++) {
      if (upper.indexOf(merchants[j].matchKey) !== -1) { alreadyKnown = true; break; }
    }
    if (alreadyKnown) continue;

    // Write a placeholder row — Match Key pre-filled, rest blank for you to complete
    mchSheet.appendRow([upper, ctx.toString().trim(), '', '', '', '', 'Needs classification']);
    added++;
    Logger.log('Seeded: ' + upper);
  }

  _merchantsCache = null;   // clear cache after bulk insert
  Logger.log('seedMerchantsTab: added ' + added + ' placeholder rows to the Merchants tab.');
  Logger.log('Open the sheet, look each merchant up on https://heymax.ai, then fill in the blank columns.');
  SpreadsheetApp.flush();
}

/**
 * Helper: scan the Transactions tab for unique merchant names and list
 * any that are not yet in the Merchants tab.  Run from the editor to see
 * which merchants you should look up on heymax.ai and add to the table.
 *
 * NOTE: Output goes to the Execution Log in the Apps Script editor —
 * click "Execution log" at the bottom of the screen after running.
 * This function does NOT write to the sheet — use seedMerchantsTab() for that.
 */
function listUnknownMerchants() {
  var CUTOFF = new Date(2026, 3, 1);  // 1 Apr 2026 — only consider transactions from this date

  // Only rows written by the email parsers are relevant for the Merchants table.
  // Manual entries in the sheet are excluded — they may have arbitrary merchants
  // that don't reflect real card transactions.
  var AUTO_CAPTURED_CARDS = {
    'CitiRewards':    true,
    'HSBC Revolution': true,
    'POSB Everyday':  true,
    'POSB Savings':   true   // PayNow — still auto-captured, though always ⚠️ REVIEW
  };

  var ss        = getSpreadsheet();
  var txnSheet  = ss.getSheetByName(TAB_NAME);
  var txnRows   = txnSheet.getDataRange().getValues();
  var merchants = getMerchantsTable();

  var seen    = {};
  var unknown = [];

  for (var i = 1; i < txnRows.length; i++) {
    // Skip manual entries — only process rows captured by the email parsers
    var card = txnRows[i][COL.CARD - 1] ? txnRows[i][COL.CARD - 1].toString().trim() : '';
    if (!AUTO_CAPTURED_CARDS[card]) continue;

    // Date is column B (index 1), stored as "DD/MMM/YYYY" e.g. "07/Apr/2026"
    var rawDate = txnRows[i][COL.DATE - 1];
    if (rawDate) {
      var txnDate = new Date(rawDate.toString());
      if (isNaN(txnDate.getTime()) || txnDate < CUTOFF) continue;
    }

    var ctx = txnRows[i][COL.CONTEXT - 1];
    if (!ctx) continue;
    var upper = ctx.toString().toUpperCase();
    if (seen[upper]) continue;
    seen[upper] = true;

    // Skip PayNow entries — always ⚠️ REVIEW by design, no merchant to classify
    if (upper.indexOf('PAYNOW') !== -1) continue;

    var found = false;
    for (var j = 0; j < merchants.length; j++) {
      if (upper.indexOf(merchants[j].matchKey) !== -1) { found = true; break; }
    }
    if (!found) unknown.push(ctx.toString());
  }

  Logger.log('=== Merchants not yet in Merchants tab (' + unknown.length + ') — auto-captured, from 1 Apr 2026 ===');
  unknown.forEach(function(m) { Logger.log('  ' + m); });
  Logger.log('=== Look these up on https://heymax.ai then add to the Merchants tab ===');
}

// ─────────────────────────────────────────────────────────────
// doGet — JSON API for dashboard
// ─────────────────────────────────────────────────────────────
function doGet(e) {
  var action = e && e.parameter && e.parameter.action ? e.parameter.action : 'transactions';
  var data;

  if (action === 'transactions') {
    data = { transactions: getTransactions(e.parameter) };
  } else if (action === 'cap_usage') {
    data = getCapUsage(e.parameter);
  } else if (action === 'card_config') {
    data = getCardConfig();
  } else {
    data = { error: 'Unknown action' };
  }

  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function getTransactions(params) {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName(TAB_NAME);
  var rows  = sheet.getDataRange().getValues();
  var headers = rows[0];
  var result  = [];

  var filterMonth = params && params.month ? params.month : null; // e.g. "Apr-2026"

  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r[COL.DATE - 1]) continue; // skip empty rows
    if (filterMonth && r[COL.MONTH_KEY - 1] !== filterMonth) continue;

    result.push({
      monthKey:     r[COL.MONTH_KEY - 1],
      date:         r[COL.DATE - 1],
      amount:       r[COL.AMOUNT - 1],
      category:     r[COL.CATEGORY - 1],
      context:      r[COL.CONTEXT - 1],
      card:         r[COL.CARD - 1],
      currency:     r[COL.CURRENCY - 1],
      bonusEligible:r[COL.BONUS_ELIGIBLE - 1],
      rewardRate:   r[COL.REWARD_RATE - 1],
      estReward:    r[COL.EST_REWARD - 1],
      remarks:      r[COL.REMARKS - 1]
    });
  }
  return result;
}

function getCapUsage(params) {
  // Caps are a per-month figure. If no month is requested, default to the
  // current month — otherwise getTransactions() returns all history and the
  // cap usage would be summed across every month ever recorded.
  // NOTE: this groups by calendar month (MonthKey). Citi's cap actually resets
  // on the statement month (~19th), so Citi usage is approximate near month-end.
  var capParams = params || {};
  if (!capParams.month) capParams = { month: formatMonthKey(new Date()) };

  var txns = getTransactions(capParams);
  var usage = {
    CitiRewards:    { bonusSpend: 0, cap: 1000 },
    HSBCRevolution: { bonusSpend: 0, cap: 1000 }
  };

  txns.forEach(function(t) {
    if (t.currency !== 'SGD') return; // caps apply to SGD only
    if (t.card === 'CitiRewards' && t.bonusEligible === 'YES') {
      usage.CitiRewards.bonusSpend += t.amount;
    }
    if (t.card === 'HSBC Revolution' && t.bonusEligible === 'YES') {
      usage.HSBCRevolution.bonusSpend += t.amount;
    }
  });

  return usage;
}

function getCardConfig() {
  return {
    cards: [
      { id: 'CitiRewards',    rewardType: 'miles', bonusRate: 4,  baseRate: 0.4, cap: 1000, model: 'blacklist' },
      { id: 'HSBCRevolution', rewardType: 'miles', bonusRate: 4,  baseRate: 0.4, cap: 1000, model: 'whitelist' },
      { id: 'POSBEveryday',   rewardType: 'cashback', baseRate: 0.3, minSpend: 800 },
      { id: 'POSBSavings',    rewardType: 'none' }
    ]
  };
}

// ─────────────────────────────────────────────────────────────
// TEST HELPERS — run manually from the Apps Script editor
// ─────────────────────────────────────────────────────────────

/** Simulate parsing the real Citi email body you shared */
function testCitiParse() {
  var body = [
    'Transaction date: 09/04/26',
    'Transaction time: 20:11:00',
    'Transaction amount: SGD14.89',
    'Transaction details : fp*Food Panda Singapore SGP'
  ].join('\n');

  var txnDateMatch   = body.match(/Transaction date\s*:\s*(\d{2}\/\d{2}\/\d{2})/i);
  var txnAmtMatch    = body.match(/Transaction amount\s*:\s*([A-Z]{3})([\d,]+\.?\d*)/i);
  var txnDetailMatch = body.match(/Transaction details\s*:\s*(.+)/i);

  Logger.log('Date match: '   + (txnDateMatch   ? txnDateMatch[1]   : 'NONE'));
  Logger.log('Amount match: ' + (txnAmtMatch    ? txnAmtMatch[2]    : 'NONE'));
  Logger.log('Currency: '     + (txnAmtMatch    ? txnAmtMatch[1]    : 'NONE'));
  Logger.log('Detail match: ' + (txnDetailMatch ? txnDetailMatch[1] : 'NONE'));

  if (txnDateMatch && txnAmtMatch && txnDetailMatch) {
    var date     = parseCitiDate(txnDateMatch[1]);
    var currency = txnAmtMatch[1];
    var amount   = parseFloat(txnAmtMatch[2]);
    var raw      = txnDetailMatch[1].trim();
    var context  = raw.replace(/^AMAZE\*\s*/i, '').replace(/\s+[A-Z]{3}$/, '').trim();
    var cat      = guessCategory(context);
    var reward   = calcCitiReward(context, currency, amount, false);

    Logger.log('Parsed date: '    + formatDate(date));
    Logger.log('Context: '        + context);
    Logger.log('Category: '       + cat);
    Logger.log('Bonus eligible: ' + reward.bonusEligible);
    Logger.log('Reward rate: '    + reward.rate);
    Logger.log('Est reward: '     + reward.estReward);

    var row = buildRow(date, amount, cat, context, 'CitiRewards', currency,
                       reward.bonusEligible, reward.rate, reward.estReward, '');
    Logger.log('Row: ' + JSON.stringify(row));
  }
}

/**
 * Dumps the raw + normalised plain-text body of the most recent unstarred
 * Citi email so you can see exactly what getPlainBody() returns.
 * Run this manually from the Apps Script editor, then check Logs.
 */
function debugCitiBody() {
  var threads = GmailApp.search(
    'from:alerts@citibank.com.sg subject:"Citi Alerts - Credit Card" after:2026/04/01'
  );
  if (!threads.length) { Logger.log('No threads found.'); return; }

  var msg = threads[0].getMessages()[0];
  var raw = msg.getPlainBody();
  var normalised = raw
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+:/g, ':')
    .replace(/:[ \t]+/g, ': ');

  Logger.log('=== RAW (first 600) ===\n' + raw.substring(0, 600));
  Logger.log('=== NORMALISED (first 600) ===\n' + normalised.substring(0, 600));

  var amtMatch    = normalised.match(/Transaction amount\s*:[\s\n]*([A-Z]{3})\s*([\d,]+\.?\d*)/i);
  var detailMatch = normalised.match(/Transaction details\s*:[\s\n]*(.+)/i);
  Logger.log('amtMatch: '    + JSON.stringify(amtMatch));
  Logger.log('detailMatch: ' + JSON.stringify(detailMatch));
}

/**
 * Dumps the raw + normalised plain-text body of the most recent HSBC email
 * and runs the three field regexes so you can see what matches or fails.
 * Run this manually from the Apps Script editor, then check Logs.
 */
function debugHSBCBody() {
  var threads = GmailApp.search(
    'from:HSBC.Bank.Singapore.Limited@notification.hsbc.com.hk subject:"Transaction Alerts" after:2026/04/01'
  );
  if (!threads.length) { Logger.log('HSBC: no threads found matching query.'); return; }

  var msg = threads[0].getMessages()[0];
  var raw = msg.getPlainBody();
  var normalised = raw
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ');

  Logger.log('=== RAW (first 800) ===\n' + raw.substring(0, 800));
  Logger.log('=== NORMALISED (first 800) ===\n' + normalised.substring(0, 800));

  var dateMatch = normalised.match(/Transaction\s+Date\s*:?\s+(\d{2}\/[A-Za-z]{3}\/\d{4})/i);
  var amtMatch  = normalised.match(/Transaction\s+Amount\s*:?\s+([A-Z]{3})\s*([\d,]+\.?\d*)/i);
  var descMatch = normalised.match(/Description\s*:?\s+([^\n\r]+)/i);

  Logger.log('dateMatch: ' + JSON.stringify(dateMatch));
  Logger.log('amtMatch:  ' + JSON.stringify(amtMatch));
  Logger.log('descMatch: ' + JSON.stringify(descMatch));
}

/**
 * Removes HSBC email message IDs from the processedIds store so the next
 * processEmails() run will re-attempt any HSBC emails that previously
 * failed to parse (e.g. due to the amount regex bug).
 *
 * Safe to run: only touches HSBC message IDs, leaves all others intact.
 * Run this ONCE after deploying the regex fix, then run processEmails().
 */
function resetHSBCProcessedIds() {
  var query = 'from:HSBC.Bank.Singapore.Limited@notification.hsbc.com.hk subject:"Transaction Alerts" ' + rollingDateFilter(ROLLING_WINDOW_DAYS);
  var threads = GmailApp.search(query);
  var processedIds = loadProcessedIds();
  var removed = 0;

  for (var i = 0; i < threads.length; i++) {
    var messages = threads[i].getMessages();
    for (var j = 0; j < messages.length; j++) {
      var id = messages[j].getId();
      if (processedIds[id]) {
        delete processedIds[id];
        removed++;
      }
    }
  }

  saveProcessedIds(processedIds);
  Logger.log('resetHSBCProcessedIds: removed ' + removed + ' HSBC message IDs from processedIds.');
  Logger.log('Now run processEmails() to reprocess them.');
}

/** Simulate parsing a real HSBC email body */
function testHSBCParse() {
  var body = [
    'Card Number',
    'XXXX-XXXX-XXXX-6513',
    '',
    'Transaction Date',
    '11/APR/2026',
    '',
    'Transaction Time',
    '20:11:17',
    '',
    'Transaction Amount',
    'SGD12.80',
    '',
    'Description',
    'Wingstop Singapore'
  ].join('\n');

  var txnDateMatch = body.match(/Transaction\s+Date\s*:?\s+(\d{2}\/[A-Z]{3}\/\d{4})/i);
  var txnAmtMatch  = body.match(/Transaction\s+Amount\s*:?\s+([A-Z]{3})\s*([\d,]+\.?\d*)/i);
  var descMatch    = body.match(/Description\s*:?\s+([^\n\r]+)/i);

  Logger.log('Date match: '   + (txnDateMatch ? txnDateMatch[1] : 'NONE'));
  Logger.log('Amount match: ' + (txnAmtMatch  ? txnAmtMatch[2]  : 'NONE'));
  Logger.log('Currency: '     + (txnAmtMatch  ? txnAmtMatch[1]  : 'NONE'));
  Logger.log('Desc match: '   + (descMatch    ? descMatch[1]    : 'NONE'));

  if (txnAmtMatch && descMatch) {
    var date     = txnDateMatch ? parseHSBCDate(txnDateMatch[1]) : new Date();
    var currency = txnAmtMatch[1];
    var amount   = parseFloat(txnAmtMatch[2]);
    var context  = descMatch[1].replace(/\s+/g, ' ').trim();
    var cat      = guessCategory(context);
    var reward   = calcHSBCReward(context, currency, amount);

    Logger.log('Parsed date: '    + formatDate(date));
    Logger.log('Context: '        + context);
    Logger.log('Category: '       + cat);
    Logger.log('Bonus eligible: ' + reward.bonusEligible);
    Logger.log('Reward rate: '    + reward.rate);
    Logger.log('Est reward: '     + reward.estReward);

    var row = buildRow(date, amount, cat, context, 'HSBC Revolution', currency,
                       reward.bonusEligible, reward.rate, reward.estReward, '');
    Logger.log('Row: ' + JSON.stringify(row));
  }
}

/** Simulate parsing a real POSB Everyday card email body */
function testPOSBEverydayParse() {
  var body = [
    'Card Transaction Alert',
    'Transaction Ref: SP1300144800000000195806',
    '',
    'Dear Sir / Madam,',
    '',
    'Date & Time: 11 APR 19:58 (SGT)',
    'Amount: SGD0.10',
    'From: DBS/POSB card ending 9299',
    'To: BUS/MRT SINGAPORE SGP'
  ].join('\n');

  // Guard: only process our card
  if (body.indexOf('9299') === -1) {
    Logger.log('POSB Everyday test: card 9299 not found — would skip');
    return;
  }

  var amtMatch  = body.match(/Amount\s*:\s*([A-Z]{3})([\d,]+\.?\d*)/i);
  var toMatch   = body.match(/To\s*:\s*(.+)/i);
  var dateMatch = body.match(/Date\s*(?:&|and)?\s*Time\s*:\s*(.+)/i);

  Logger.log('Amount match: ' + (amtMatch  ? amtMatch[2]  : 'NONE'));
  Logger.log('Currency: '     + (amtMatch  ? amtMatch[1]  : 'NONE'));
  Logger.log('To match: '     + (toMatch   ? toMatch[1]   : 'NONE'));
  Logger.log('Date match: '   + (dateMatch ? dateMatch[1] : 'NONE'));

  if (amtMatch) {
    var currency = amtMatch[1].toUpperCase();
    var amount   = parseFloat(amtMatch[2]);
    var txnDate  = dateMatch ? parsePOSBCardDate(dateMatch[1]) : new Date();
    var rawMerch = toMatch ? toMatch[1].trim() : 'Unknown';
    var context  = rawMerch.replace(/\s+[A-Z]{3}$/, '').trim();
    var cat      = guessCategory(context);
    var reward   = calcPOSBEverydayReward(context, currency, amount);

    Logger.log('Parsed date: '    + formatDate(txnDate));
    Logger.log('Context: '        + context);
    Logger.log('Category: '       + cat);
    Logger.log('Bonus eligible: ' + reward.bonusEligible);
    Logger.log('Reward rate: '    + reward.rate);
    Logger.log('Est reward: '     + reward.estReward);
    Logger.log('Remark: '         + reward.remark);

    var row = buildRow(txnDate, amount, cat, context, 'POSB Everyday', currency,
                       reward.bonusEligible, reward.rate, reward.estReward, reward.remark);
    Logger.log('Row: ' + JSON.stringify(row));
  }
}

/**
 * Write one test row to the Merchants tab, then immediately delete it.
 * Run this to confirm the Merchants tab exists and is writable.
 * Check the Execution Log after running — it will say PASS or FAIL.
 */
function testMerchantsTabWrite() {
  var ss    = getSpreadsheet();
  var sheet = ss.getSheetByName(MERCHANTS_TAB);

  if (!sheet) {
    Logger.log('FAIL: Merchants tab not found. Run setupMerchantsTab() first.');
    return;
  }

  var beforeRows = sheet.getLastRow();
  sheet.appendRow(['TEST_MERCHANT', 'Test Entry', 'Food', 'YES', 'NO', '5812', 'Auto-test — delete me']);
  SpreadsheetApp.flush();
  var afterRows = sheet.getLastRow();

  if (afterRows === beforeRows + 1) {
    Logger.log('PASS: Row written successfully to Merchants tab (row ' + afterRows + ').');
    // Clean up the test row
    sheet.deleteRow(afterRows);
    SpreadsheetApp.flush();
    Logger.log('PASS: Test row deleted. Merchants tab is working correctly.');
  } else {
    Logger.log('FAIL: Row count did not increase. Something went wrong.');
  }

  _merchantsCache = null;  // reset cache
}

/** Write a single test row to the sheet */
function testWriteRow() {
  var row = buildRow(
    new Date(2026, 3, 9),   // 9 Apr 2026
    14.89,
    'Food',
    'fp*Food Panda Singapore',
    'CitiRewards',
    'SGD',
    'YES',
    '4 mpd',
    round2(14.89 * 4),
    ''
  );
  Logger.log('Attempting to write: ' + JSON.stringify(row));
  writeRow(row);
  Logger.log('Done.');
}

/**
 * Confirms the FX conversion works AND that the external-request permission is
 * granted. Run this from the editor:
 *   - If a "Authorization required" prompt appears → approve it (this is the
 *     permission you were expecting). Run again afterwards.
 *   - If it logs live rates and converted amounts → permission is already
 *     granted and the FX feature is working.
 *   - If it errors that getFxRate/toSGD is "not defined" → the new code is NOT
 *     saved in the editor yet; paste Code.gs in, Save (Ctrl+S), and re-run.
 */
function testFx() {
  Logger.log('USD->SGD rate: ' + getFxRate('USD'));
  Logger.log('JPY->SGD rate: ' + getFxRate('JPY'));
  Logger.log('Convert JPY 10000: ' + JSON.stringify(toSGD(10000, 'JPY')));
  Logger.log('Convert USD 100: '   + JSON.stringify(toSGD(100, 'USD')));
  Logger.log('Convert SGD 50: '     + JSON.stringify(toSGD(50, 'SGD')));
}
