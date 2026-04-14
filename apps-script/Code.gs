// ============================================================
// Expense Tracker — Google Apps Script
// Sheet: 1xuRQ51hOXCVVex7TUhQqPExkFFBN8uXQYpw_j8DzPGA
// Tab:   Transactions
// ============================================================

var SHEET_ID        = '1xuRQ51hOXCVVex7TUhQqPExkFFBN8uXQYpw_j8DzPGA';
var TAB_NAME        = 'Transactions';
var MERCHANTS_TAB   = 'Merchants';
var PROCESSED_LABEL = 'Bank-Processed';

// Module-level cache — loaded once per script execution, cleared when a new
// merchant is added so the next lookup sees the updated table.
var _merchantsCache = null;


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
  var label = getOrCreateLabel(PROCESSED_LABEL);
  // Load the set of already-processed Gmail message IDs once.
  // This is the source of truth for deduplication — replaces starring.
  var processedIds = loadProcessedIds();
  var processed = 0;

  processed += processCitiEmails(label, processedIds);
  processed += processPOSBPayNowEmails(label, processedIds);
  processed += processHSBCEmails(label, processedIds);
  processed += processPOSBEverydayEmails(label, processedIds);

  // Persist any newly-added IDs back to storage
  saveProcessedIds(processedIds);
  Logger.log('Total rows written: ' + processed);
}

// ─────────────────────────────────────────────────────────────
// CITIBANK PARSER
// Subject: "Citi Alerts - Credit Card/Ready Credit Transaction"
// Sender:  alerts@citibank.com.sg
// ─────────────────────────────────────────────────────────────
function processCitiEmails(label, processedIds) {
  // Search all Citi threads (including already-labelled ones) so we can
  // process new messages that arrived after the thread was first labelled.
  var query = 'from:alerts@citibank.com.sg subject:"Citi Alerts - Credit Card" after:2026/04/01';
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
        Logger.log('Citi: could not parse email — skipping. Subject: ' + msg.getSubject());
        // Log first 400 chars of normalised body to help diagnose format changes
        Logger.log('Body (first 400 chars): ' + body.substring(0, 400));
        processedIds[msg.getId()] = true; // mark as seen so we don't retry
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
      // Clean trailing country code (e.g. "Singapore SGP" → "Singapore")
      context = context.replace(/\s+[A-Z]{3}$/, '').trim();

      var card     = 'CitiRewards';
      autoRegisterMerchant(context);
      var displayContext = resolveContext(context);
      var category = guessCategory(context);
      var remarks  = isAmaze ? 'Via Amaze' : '';

      // ── Reward calculation ──────────────────────────────
      var reward   = calcCitiReward(context, currency, amount, isAmaze);

      var row = buildRow(txnDate, amount, category, displayContext, card, currency,
                         reward.bonusEligible, reward.rate, reward.estReward, remarks);

      var written = writeRow(row);
      if (!written) {
        Logger.log('Citi: write failed — will retry on next run. Detail: ' + rawDetail);
        continue; // leave message untracked so next run retries it
      }
      processedIds[msg.getId()] = true; // mark this individual message as processed
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
function processPOSBPayNowEmails(label, processedIds) {
  // DBS sends PayNow confirmations under two subject lines — search both.
  var query = 'from:ibanking.alert@dbs.com (subject:PayNow OR subject:"iBanking Alerts") after:2026/04/01';
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
        processedIds[msg.getId()] = true;
        continue;
      }

      // Amount: handles both "SGD12.90" (iBanking Alerts format) and "S$12.90" (older format)
      var amtMatch  = body.match(/Amount\s*:\s*(?:[A-Z]{3}|S\$|\$)?\s*([\d,]+\.?\d*)/i);
      var toMatch   = body.match(/To\s*:\s*(.+)/i);
      // Date: handles "13 Apr 19:18 (SGT)" — captures day + 3-letter month, ignores time
      var dateMatch = body.match(/Date\s*(?:&|and)?\s*Time\s*:\s*(\d{1,2}\s+[A-Za-z]{3})/i);

      if (!amtMatch) {
        Logger.log('POSB PayNow: could not parse amount — skipping.');
        processedIds[msg.getId()] = true;
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
      processedIds[msg.getId()] = true;
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
function processHSBCEmails(label, processedIds) {
  var query = 'from:HSBC.Bank.Singapore.Limited@notification.hsbc.com.hk subject:"Transaction Alerts" after:2026/04/01';
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
        Logger.log('HSBC: could not parse email — skipping. Subject: ' + msg.getSubject());
        Logger.log('HSBC body (first 800 chars):\n' + body.substring(0, 800));
        processedIds[msg.getId()] = true; // prevent infinite retries
        continue;
      }

      var txnDate  = txnDateMatch ? parseHSBCDate(txnDateMatch[1]) : emailDate;
      var currency = txnAmtMatch[1].toUpperCase();
      var amount   = parseFloat(txnAmtMatch[2].replace(/,/g, ''));
      var context  = descMatch[1].replace(/\s+/g, ' ').trim();

      var card     = 'HSBC Revolution';
      autoRegisterMerchant(context);
      var displayContext = resolveContext(context);
      var category = guessCategory(context);
      var reward   = calcHSBCReward(context, currency, amount);

      var row = buildRow(txnDate, amount, category, displayContext, card, currency,
                         reward.bonusEligible, reward.rate, reward.estReward, '');

      var written = writeRow(row);
      if (!written) {
        Logger.log('HSBC: write failed — will retry. Description: ' + context);
        continue;
      }
      processedIds[msg.getId()] = true;
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
function processPOSBEverydayEmails(label, processedIds) {
  var query = 'from:ibanking.alert@dbs.com subject:"Card Transaction Alert" after:2026/04/01';
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
        processedIds[msg.getId()] = true; // not our card — mark seen and skip
        continue;
      }

      var amtMatch  = body.match(/Amount\s*:\s*([A-Z]{3})([\d,]+\.?\d*)/i);
      var toMatch   = body.match(/To\s*:\s*(.+)/i);
      var dateMatch = body.match(/Date\s*(?:&|and)?\s*Time\s*:\s*(.+)/i);

      if (!amtMatch) {
        Logger.log('POSB Everyday: could not parse amount — skipping.');
        processedIds[msg.getId()] = true;
        continue;
      }

      var currency = amtMatch[1].toUpperCase();
      var amount   = parseFloat(amtMatch[2].replace(/,/g, ''));
      var txnDate  = dateMatch ? parsePOSBCardDate(dateMatch[1]) : msg.getDate();

      // Strip trailing 3-letter country code from merchant name (e.g. "BUS/MRT SINGAPORE SGP")
      var rawMerchant = toMatch ? toMatch[1].trim() : 'Unknown';
      var context     = rawMerchant.replace(/\s+[A-Z]{3}$/, '').trim();

      autoRegisterMerchant(context);
      var displayContext = resolveContext(context);
      var category = guessCategory(context);
      var reward   = calcPOSBEverydayReward(context, currency, amount);

      var row = buildRow(txnDate, amount, category, displayContext, 'POSB Everyday', currency,
                         reward.bonusEligible, reward.rate, reward.estReward, reward.remark);

      var written = writeRow(row);
      if (!written) {
        Logger.log('POSB Everyday: write failed — will retry. Merchant: ' + context);
        continue;
      }
      processedIds[msg.getId()] = true;
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

function calcCitiReward(merchant, currency, amount, isAmaze) {
  var upper = merchant.toUpperCase();
  // Miles rounded down to nearest SGD1 per T&C clause 13
  var wholeAmt = Math.floor(amount);

  // Step 1: Hard exclusions (travel MCCs, mobile wallets) — always base rate
  for (var i = 0; i < CITI_EXCLUDE_KEYWORDS.length; i++) {
    if (upper.indexOf(CITI_EXCLUDE_KEYWORDS[i]) !== -1) {
      return { bonusEligible: 'NO', rate: '0.4 mpd', estReward: round2(wholeAmt * 0.4) };
    }
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
    return { bonusEligible: 'YES', rate: '4 mpd (online)', estReward: round2(wholeAmt * 4) };
  }
  if (record && record.citiOnline === 'NO') {
    return { bonusEligible: 'NO', rate: '0.4 mpd', estReward: round2(wholeAmt * 0.4) };
  }

  // Step 4: Confirmed-online keyword fallback — earn 4 mpd (online retail per T&C)
  for (var j = 0; j < CITI_ONLINE_KEYWORDS.length; j++) {
    if (upper.indexOf(CITI_ONLINE_KEYWORDS[j]) !== -1) {
      return { bonusEligible: 'YES', rate: '4 mpd (online)', estReward: round2(wholeAmt * 4) };
    }
  }

  // Step 5: Everything else (physical dining, groceries, transport etc.) → base 0.4 mpd
  // Citi 10X requires online channel or clothing/shoes/bags MCC — can't confirm from email alone
  return { bonusEligible: 'NO', rate: '0.4 mpd', estReward: round2(wholeAmt * 0.4) };
}

function calcHSBCReward(merchant, currency, amount) {
  var upper    = merchant.toUpperCase();
  var wholeAmt = Math.floor(amount);  // miles rounded down to nearest SGD1 per T&C clause 8

  // Step 1: Exclusions (fast food, food delivery, OTAs, transit) — always base rate
  for (var i = 0; i < HSBC_EXCLUDE_KEYWORDS.length; i++) {
    if (upper.indexOf(HSBC_EXCLUDE_KEYWORDS[i]) !== -1) {
      return { bonusEligible: 'NO', rate: '0.4 mpd', estReward: round2(wholeAmt * 0.4) };
    }
  }

  // Step 2: Merchants table — definitive YES/NO overrides keyword guessing
  var record = lookupMerchant(merchant);
  if (record && record.hsbcEligible === 'YES') {
    return { bonusEligible: 'YES', rate: '4 mpd', estReward: round2(wholeAmt * 4) };
  }
  if (record && record.hsbcEligible === 'NO') {
    return { bonusEligible: 'NO', rate: '0.4 mpd', estReward: round2(wholeAmt * 0.4) };
  }

  // Step 3: Bonus keyword fallback — earn 4 mpd (both contactless + online, restored Apr 2026)
  for (var j = 0; j < HSBC_BONUS_KEYWORDS.length; j++) {
    if (upper.indexOf(HSBC_BONUS_KEYWORDS[j]) !== -1) {
      return { bonusEligible: 'YES', rate: '4 mpd', estReward: round2(wholeAmt * 4) };
    }
  }

  // Step 4: Everything else — 0.4 mpd base
  return { bonusEligible: '\u26a0\ufe0f', rate: '0.4 mpd', estReward: round2(wholeAmt * 0.4) };
}

function calcPOSBEverydayReward(merchant, currency, amount) {
  var upper = merchant.toUpperCase();
  var k, found;

  // MYR in-store: 10% (needs $800 min spend)
  if (currency === 'MYR') {
    return { bonusEligible: '\u26a0\ufe0f', rate: '10% MYR', estReward: round2(amount * 0.10), remark: 'Needs $800 min spend' };
  }

  // Food delivery: 10% (needs $800 min spend)
  for (k = 0; k < POSB_DELIVERY_10PCT.length; k++) {
    if (upper.indexOf(POSB_DELIVERY_10PCT[k]) !== -1) {
      return { bonusEligible: '\u26a0\ufe0f', rate: '10% delivery', estReward: round2(amount * 0.10), remark: 'Needs $800 min spend' };
    }
  }

  // Transit (SimplyGo / BUS/MRT): 10% (needs $800 min spend)
  for (k = 0; k < POSB_TRANSIT_10PCT.length; k++) {
    if (upper.indexOf(POSB_TRANSIT_10PCT[k]) !== -1) {
      return { bonusEligible: '\u26a0\ufe0f', rate: '10% transit', estReward: round2(amount * 0.10), remark: 'Needs $800 min spend' };
    }
  }

  // Check fast food exclusion before dining bonus
  found = false;
  for (k = 0; k < POSB_DINING_EXCL.length; k++) {
    if (upper.indexOf(POSB_DINING_EXCL[k]) !== -1) { found = true; break; }
  }

  // Dining 5% — excludes fast food (needs $800 min spend)
  if (!found) {
    for (k = 0; k < POSB_DINING_5PCT.length; k++) {
      if (upper.indexOf(POSB_DINING_5PCT[k]) !== -1) {
        return { bonusEligible: '\u26a0\ufe0f', rate: '5% dining', estReward: round2(amount * 0.05), remark: 'Needs $800 min spend' };
      }
    }
  }

  // Online shopping 5% (needs $800 min spend)
  for (k = 0; k < POSB_SHOPPING_5PCT.length; k++) {
    if (upper.indexOf(POSB_SHOPPING_5PCT[k]) !== -1) {
      return { bonusEligible: '\u26a0\ufe0f', rate: '5% online', estReward: round2(amount * 0.05), remark: 'Needs $800 min spend' };
    }
  }

  // Sheng Siong 5% — no min spend required
  for (k = 0; k < POSB_SHENGSIONG_5PCT.length; k++) {
    if (upper.indexOf(POSB_SHENGSIONG_5PCT[k]) !== -1) {
      return { bonusEligible: 'YES', rate: '5% supermarket', estReward: round2(amount * 0.05), remark: '' };
    }
  }

  // Watsons 3% — no min spend required
  for (k = 0; k < POSB_WATSONS_3PCT.length; k++) {
    if (upper.indexOf(POSB_WATSONS_3PCT[k]) !== -1) {
      return { bonusEligible: 'YES', rate: '3% Watsons', estReward: round2(amount * 0.03), remark: '' };
    }
  }

  // SPC 6% — no min spend required
  for (k = 0; k < POSB_SPC_6PCT.length; k++) {
    if (upper.indexOf(POSB_SPC_6PCT[k]) !== -1) {
      return { bonusEligible: 'YES', rate: '6% fuel', estReward: round2(amount * 0.06), remark: '' };
    }
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
  var ss    = SpreadsheetApp.openById(SHEET_ID);
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
 * Return the first Merchants row whose matchKey is a substring of
 * the given merchant name (case-insensitive).  Returns null if not found.
 */
function lookupMerchant(merchantName) {
  var upper   = merchantName.toUpperCase();
  var records = getMerchantsTable();
  for (var i = 0; i < records.length; i++) {
    if (upper.indexOf(records[i].matchKey) !== -1) return records[i];
  }
  return null;
}

/**
 * Fetches all MCC codes from MCC Explorer and builds a flat merchant-name →
 * {mcc, category} lookup map.  The full database is fetched once per script
 * execution (module-level cache) and also stored in CacheService for 6 hours
 * so subsequent trigger runs don't hit the API unnecessarily.
 *
 * Returns the map object, or null if no API key / fetch failed.
 *
 * NOTE: If the base URL below returns a 404, check your MCC Explorer dashboard
 * for the correct API base URL and update the constant here.
 */
var MCC_API_BASE = 'https://www.mccexplorer.com';

function fetchMCCDatabase() {
  // 1. In-memory cache (same execution)
  if (_mccDatabase !== null) return _mccDatabase;

  var apiKey = PropertiesService.getScriptProperties().getProperty('MCC_EXPLORER_KEY');
  if (!apiKey) return null;

  // 2. CacheService (cross-execution, 6-hour TTL)
  var cache = CacheService.getScriptCache();
  var cached = cache.get('mcc_merchant_map');
  if (cached) {
    try {
      _mccDatabase = JSON.parse(cached);
      Logger.log('MCC database loaded from cache ('
               + Object.keys(_mccDatabase).length + ' merchant entries)');
      return _mccDatabase;
    } catch (e) { /* corrupt cache — fall through to re-fetch */ }
  }

  // 3. Fetch from API
  Logger.log('Fetching MCC database from API...');
  try {
    var response = UrlFetchApp.fetch(MCC_API_BASE + '/api/v2.1/mcc-codes', {
      method: 'get',
      headers: { 'x-api-key': apiKey },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) {
      Logger.log('MCC API error: HTTP ' + response.getResponseCode()
               + ' — ' + response.getContentText().substring(0, 200));
      return null;
    }

    var raw = JSON.parse(response.getContentText());
    if (!Array.isArray(raw) || raw.length === 0) {
      // Log the raw shape so we can adjust field names if needed
      Logger.log('MCC API unexpected response shape: '
               + JSON.stringify(raw).substring(0, 400));
      return null;
    }

    Logger.log('MCC API: received ' + raw.length + ' code entries. '
             + 'First entry: ' + JSON.stringify(raw[0]).substring(0, 300));

    // Flatten: for each MCC entry → each merchant name → {mcc, category}
    // Field name fallbacks handle variation between API versions.
    var map = {};
    for (var i = 0; i < raw.length; i++) {
      var entry    = raw[i];
      var mcc      = (entry.mcc || entry.code || '').toString().trim();
      var category = (entry.category || entry.edited_description
                    || entry.combined_description || '').toString().trim();
      var merchants = entry.merchants || [];
      for (var j = 0; j < merchants.length; j++) {
        var name = merchants[j].toString().toUpperCase().trim();
        if (name.length >= 4 && mcc) {
          map[name] = { mcc: mcc, category: category };
        }
      }
    }

    _mccDatabase = map;
    Logger.log('MCC merchant map built: ' + Object.keys(map).length + ' entries');

    // Cache if it fits within CacheService's 100 KB per-key limit
    try {
      var json = JSON.stringify(map);
      if (json.length <= 95000) {
        cache.put('mcc_merchant_map', json, 21600); // 6 hours
        Logger.log('MCC database cached (' + json.length + ' bytes, 6 h TTL)');
      } else {
        Logger.log('MCC database too large to cache ('
                 + json.length + ' bytes) — will re-fetch each execution');
      }
    } catch (e) { Logger.log('MCC cache write failed: ' + e); }

    return map;
  } catch (e) {
    Logger.log('MCC database fetch error: ' + e);
    return null;
  }
}

/**
 * Looks up a merchant name against the MCC Explorer database.
 * Strategy: check whether any known merchant name is a substring of the email
 * description. Email descriptions often append location (e.g. "Wingstop Singapore"
 * → matches "Wingstop" in MCC 5814's list). We prefer the longest match to
 * avoid short names ("EAT") incorrectly matching longer strings ("EATALY").
 *
 * Returns { mcc, category } or null if no match / not configured.
 */
function lookupMCCExplorer(merchantName) {
  var db = fetchMCCDatabase();
  if (!db) return null;

  var nameUpper = merchantName.toUpperCase().trim();
  var bestMatch = null;
  var bestLen   = 0;

  var knownNames = Object.keys(db);
  for (var i = 0; i < knownNames.length; i++) {
    var known = knownNames[i]; // already uppercase, min 4 chars
    if (nameUpper.indexOf(known) !== -1 && known.length > bestLen) {
      bestLen   = known.length;
      bestMatch = db[known];
    }
  }

  if (bestMatch) {
    Logger.log('MCC Explorer match: "' + merchantName
             + '" → MCC ' + bestMatch.mcc + ' (' + bestMatch.category + ')');
    return bestMatch;
  }

  Logger.log('MCC Explorer: no match for "' + merchantName + '"');
  return null;
}

/**
 * One-shot test function — run from Apps Script editor to verify the API key,
 * base URL, and response shape.  Check the Execution Log for results.
 */
function testMCCExplorerAPI() {
  _mccDatabase = null; // force fresh fetch, ignore any in-memory cache
  CacheService.getScriptCache().remove('mcc_merchant_map'); // clear disk cache too
  var db = fetchMCCDatabase();
  if (!db) {
    Logger.log('TEST FAILED: database is null — check MCC_EXPLORER_KEY and MCC_API_BASE');
    return;
  }
  Logger.log('TEST PASS: ' + Object.keys(db).length + ' merchant entries loaded');
  // Spot-check a few known merchants
  var tests = ['WINGSTOP', 'MCDONALD', 'GRAB', 'NETFLIX', 'STARBUCKS'];
  for (var i = 0; i < tests.length; i++) {
    var result = lookupMCCExplorer(tests[i]);
    Logger.log(tests[i] + ' → ' + (result ? JSON.stringify(result) : 'no match'));
  }
}

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
 * Append a new row to the Merchants tab and clear the in-memory cache
 * so subsequent lookups within the same run see the new entry.
 */
function addMerchantToTable(matchKey, displayName, category, hsbcEligible, citiOnline, mcc, notes) {
  // Skip if this merchant is already in the table — prevents duplicate rows
  if (lookupMerchant(matchKey)) {
    Logger.log('addMerchantToTable: "' + matchKey + '" already exists — skipping');
    return;
  }
  var ss    = SpreadsheetApp.openById(SHEET_ID);
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
  _merchantsCache = null;   // force reload on next lookup
  Logger.log('Added to Merchants tab: ' + matchKey);
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function guessCategory(merchant) {
  // 1. Check the Merchants table first — allows per-merchant overrides
  var record = lookupMerchant(merchant);
  if (record && record.category) return record.category;

  // 2. Fall back to hardcoded keyword map
  var upper = merchant.toUpperCase();
  for (var cat in CATEGORY_KEYWORDS) {
    var keywords = CATEGORY_KEYWORDS[cat];
    for (var i = 0; i < keywords.length; i++) {
      if (upper.indexOf(keywords[i]) !== -1) return cat;
    }
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
 * Calls MCC Explorer to pre-fill MCC and Category if an API key is configured.
 * Safe to call on every transaction — skips silently if merchant already exists.
 */
function autoRegisterMerchant(rawMerchant) {
  if (lookupMerchant(rawMerchant)) return; // already known

  var mccResult    = lookupMCCExplorer(rawMerchant); // null if no API key set
  var mcc          = mccResult ? mccResult.mcc      : '';
  var category     = mccResult ? mccResult.category : '';
  var hsbcEligible = mcc ? mccToHsbcEligible(mcc) : '';
  var citiOnline   = mcc ? mccToCitiOnline(mcc)   : '';

  // 'Review MCC XXXX' prompts user to confirm the auto-guess; 'Needs classification'
  // means no MCC was found and both eligibility fields need to be filled manually.
  var notes = mcc ? 'Review MCC ' + mcc : 'Needs classification';

  addMerchantToTable(
    rawMerchant,   // matchKey — uppercased inside addMerchantToTable()
    '',            // displayName — user fills in
    category,      // pre-filled by MCC Explorer if available
    hsbcEligible,  // auto-determined from MCC if available
    citiOnline,    // auto-determined from MCC if available
    mcc,           // pre-filled by MCC Explorer if available
    notes
  );
}

/**
 * One-shot bulk import of known merchants into the Merchants tab.
 * Merchant data is provided manually (MCC looked up from mccexplorer.com).
 * Run once from the Apps Script editor; safe to re-run — duplicate guard skips existing rows.
 *
 * To add a new batch: update the merchants array below and run again.
 *
 * Data format:
 *   { matchKey, displayName, category, mcc }
 *   matchKey  — uppercase substring that will match against raw email merchant names
 *   mcc       — drives HSBC Eligible (col D) and Citi Online (col E) automatically
 */
function runBulkImport() {
  var merchants = [
    // ── MCC 5814 — Fast Food Restaurants (HSBC: NO, Citi Online: '') ──
    { matchKey: 'MCDONALD',     displayName: "McDonald's",             category: 'Food', mcc: '5814' },
    { matchKey: 'KFC',          displayName: 'KFC',                    category: 'Food', mcc: '5814' },
    { matchKey: 'BURGER KING',  displayName: 'Burger King',            category: 'Food', mcc: '5814' },
    { matchKey: 'SUBWAY',       displayName: 'Subway',                 category: 'Food', mcc: '5814' },
    { matchKey: 'PIZZA HUT',    displayName: 'Pizza Hut',              category: 'Food', mcc: '5814' },
    { matchKey: 'OLD CHANG KEE',displayName: 'Old Chang Kee',          category: 'Food', mcc: '5814' },
    { matchKey: '4FINGERS',     displayName: '4Fingers Crispy Chicken',category: 'Food', mcc: '5814' },
    { matchKey: 'FOUR FINGER',  displayName: '4Fingers Crispy Chicken',category: 'Food', mcc: '5814' },
    { matchKey: 'DOMINO',       displayName: "Domino's",               category: 'Food', mcc: '5814' },
    { matchKey: 'ARNOLDS',      displayName: "Arnold's Fried Chicken", category: 'Food', mcc: '5814' },
    { matchKey: 'AUNTIE ANNE',  displayName: "Auntie Anne's",          category: 'Food', mcc: '5814' },
    { matchKey: 'A&W',          displayName: 'A&W',                    category: 'Food', mcc: '5814' },
    { matchKey: 'BEARD PAPA',   displayName: 'Beard Papa',             category: 'Food', mcc: '5814' },
    { matchKey: 'CARLS',        displayName: "Carl's Junior",          category: 'Food', mcc: '5814' },
    { matchKey: 'DUNKIN',       displayName: 'Dunkin Donuts',          category: 'Food', mcc: '5814' },
    { matchKey: 'GUZMAN',       displayName: 'Guzman Y Gomez',         category: 'Food', mcc: '5814' },
    { matchKey: 'JOLLIBEE',     displayName: 'Jollibee',               category: 'Food', mcc: '5814' },
    { matchKey: 'JOLLIBEAN',    displayName: 'Jollibean',              category: 'Food', mcc: '5814' },
    { matchKey: 'LONG JOHN',    displayName: 'Long John Silvers',      category: 'Food', mcc: '5814' },
    { matchKey: 'MOS BURGER',   displayName: 'MOS Burger',             category: 'Food', mcc: '5814' },
    { matchKey: 'MR BEAN',      displayName: 'Mr Bean',                category: 'Food', mcc: '5814' },
    { matchKey: 'PEZZO',        displayName: 'Pezzo',                  category: 'Food', mcc: '5814' },
    { matchKey: 'POPEYES',      displayName: 'Popeyes Louisiana Kitchen', category: 'Food', mcc: '5814' },
    { matchKey: 'SHAKE SHACK',  displayName: 'Shake Shack',            category: 'Food', mcc: '5814' },
    { matchKey: 'TACO BELL',    displayName: 'Taco Bell',              category: 'Food', mcc: '5814' },
    { matchKey: 'TORI-Q',       displayName: 'Tori-Q',                 category: 'Food', mcc: '5814' },
    { matchKey: 'WENDY',        displayName: "Wendy's",                category: 'Food', mcc: '5814' },
    { matchKey: 'WINGSTOP',     displayName: 'Wingstop',               category: 'Food', mcc: '5814' },
    { matchKey: 'JINJJA',       displayName: 'Jinjja Chicken',         category: 'Food', mcc: '5814' },
    { matchKey: 'CHICKEN UP',   displayName: 'Chicken Up',             category: 'Food', mcc: '5814' },
    { matchKey: 'GREENDOT',     displayName: 'Greendot',               category: 'Food', mcc: '5814' },
    { matchKey: 'QIJI',         displayName: 'Qiji',                   category: 'Food', mcc: '5814' },
    { matchKey: 'PEPPER LUNCH', displayName: 'Pepper Lunch',           category: 'Food', mcc: '5814' },
    { matchKey: 'SALAD STOP',   displayName: 'Salad Stop',             category: 'Food', mcc: '5814' },
    { matchKey: 'SOUP SPOON',   displayName: 'Soup Spoon',             category: 'Food', mcc: '5814' },
    { matchKey: 'STUFFD',       displayName: "Stuff'd",                category: 'Food', mcc: '5814' },
    { matchKey: 'PROJECT ACAI', displayName: 'Project Acai',           category: 'Food', mcc: '5814' },
  ];

  var added = 0, skipped = 0;
  merchants.forEach(function(m) {
    if (lookupMerchant(m.matchKey)) { skipped++; return; }
    addMerchantToTable(
      m.matchKey,
      m.displayName,
      m.category,
      mccToHsbcEligible(m.mcc),
      mccToCitiOnline(m.mcc),
      m.mcc,
      'Bulk import MCC ' + m.mcc
    );
    added++;
  });
  Logger.log('Bulk import: ' + added + ' added, ' + skipped + ' skipped (already existed)');
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
    var ss    = SpreadsheetApp.openById(SHEET_ID);
    var sheet = ss.getSheetByName(TAB_NAME);
    if (!sheet) {
      Logger.log('ERROR: Sheet tab "' + TAB_NAME + '" not found!');
      return false;
    }
    sheet.appendRow(row);
    Logger.log('Written: ' + JSON.stringify(row));
    return true;
  } catch (e) {
    Logger.log('ERROR writing row: ' + e.toString());
    return false;
  }
}

function getOrCreateLabel(name) {
  var label = GmailApp.getUserLabelByName(name);
  if (!label) label = GmailApp.createLabel(name);
  return label;
}

/**
 * Load the set of already-processed Gmail message IDs from Script Properties.
 * Returns a plain object used as a hash set: { messageId: true, ... }
 * This replaces the "star as sentinel" approach so that:
 *   1. Stars remain free for the user's own bookmarking.
 *   2. Threaded emails (multiple transactions in one thread) are correctly
 *      deduplicated — each message ID is tracked individually.
 */
function loadProcessedIds() {
  var raw = PropertiesService.getScriptProperties().getProperty('processedMsgIds');
  if (!raw) return {};
  try {
    var arr = JSON.parse(raw);
    var map = {};
    for (var i = 0; i < arr.length; i++) map[arr[i]] = true;
    return map;
  } catch (e) {
    Logger.log('loadProcessedIds: parse error, resetting. ' + e);
    return {};
  }
}

/**
 * Persist the processed-ID set back to Script Properties.
 * Keeps only the most recent 400 IDs to stay within the 9 KB property limit.
 * Older IDs beyond this window are pruned — safe because emails that old
 * would already have been labelled Bank-Processed and won't be written again.
 */
function saveProcessedIds(map) {
  var arr = Object.keys(map);
  // If over the cap, drop from the front (oldest additions first).
  // Because we add to the set in order of processing, the front of the
  // key list tends to be the oldest, but this is best-effort — the real
  // guard against duplicates is the Bank-Processed label on the thread.
  var MAX_IDS = 400;
  if (arr.length > MAX_IDS) arr = arr.slice(arr.length - MAX_IDS);
  PropertiesService.getScriptProperties().setProperty('processedMsgIds', JSON.stringify(arr));
}

// Parse "DD/MM/YY" (Citi format) → Date
function parseCitiDate(str) {
  var parts = str.split('/');
  var day   = parseInt(parts[0], 10);
  var month = parseInt(parts[1], 10) - 1; // 0-indexed
  var year  = 2000 + parseInt(parts[2], 10);
  return new Date(year, month, day);
}

// Parse "09 Apr 2026" (DBS PayNow format) → Date
function parseDBSDate(str) {
  return new Date(str);
}

// Parse "11/APR/2026" (HSBC format) → Date
function parseHSBCDate(str) {
  // new Date("11 APR 2026") is understood by V8
  var parts = str.split('/');
  if (parts.length !== 3) return new Date();
  return new Date(parts[0] + ' ' + parts[1] + ' ' + parts[2]);
}

// Parse "11 APR 19:58 (SGT)" (POSB Everyday format) → Date
// Extracts day and month only; uses current calendar year.
function parsePOSBCardDate(str) {
  var match = str.match(/(\d{1,2})\s+([A-Za-z]{3})/);
  if (!match) return new Date();
  return new Date(match[1] + ' ' + match[2] + ' ' + new Date().getFullYear());
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

// ─────────────────────────────────────────────────────────────
// ONE-TIME SETUP — run manually from the Apps Script editor
// ─────────────────────────────────────────────────────────────

/**
 * Creates the Merchants tab with headers if it doesn't already exist.
 * Run once from the Apps Script editor: select setupMerchantsTab → Run.
 */
function setupMerchantsTab() {
  var ss    = SpreadsheetApp.openById(SHEET_ID);
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

  var ss       = SpreadsheetApp.openById(SHEET_ID);
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

  var ss        = SpreadsheetApp.openById(SHEET_ID);
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
  var ss    = SpreadsheetApp.openById(SHEET_ID);
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
  var txns = getTransactions(params);
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
  var query = 'from:HSBC.Bank.Singapore.Limited@notification.hsbc.com.hk subject:"Transaction Alerts" after:2026/04/01';
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
  var ss    = SpreadsheetApp.openById(SHEET_ID);
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
