// Gingr Tips Proxy - EOD Financial Dashboard
// Reads tx.tip_amount (top-level array on the transaction object).
// Matches transactions by payment date, sums tip_amount for each matched tx.

const FACILITIES = {
  how: { subdomain: process.env.HOW_SUBDOMAIN, key: process.env.HOW_API_KEY, name: 'House of Woof' },
  rw:  { subdomain: process.env.RW_SUBDOMAIN,  key: process.env.RW_API_KEY,  name: 'Riverwalk' },
  fpi: { subdomain: process.env.FPI_SUBDOMAIN, key: process.env.FPI_API_KEY, name: 'Four Paws Inn' },
  dd:  { subdomain: process.env.DD_SUBDOMAIN,  key: process.env.DD_API_KEY,  name: 'Don Doggos' },
};

const PER_PAGE = 100;
const CONCURRENCY = 50;
const PACIFIC_OFFSET_HOURS = -7;

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

function tsToPacificDate(ts) {
  const epochMs = (parseInt(ts, 10) + PACIFIC_OFFSET_HOURS * 3600) * 1000;
  return new Date(epochMs).toISOString().split('T')[0];
}

async function fetchInvoiceIds(subdomain, key, from_date, to_date) {
  const all = [];
  let pageStart = 1;
  while (true) {
    const params = new URLSearchParams({
      key, from_date, to_date, complete: 'true',
      per_page: String(PER_PAGE), page: String(pageStart),
    });
    const res = await fetch(`https://${subdomain}.gingrapp.com/api/v1/list_invoices?${params}`);
    if (!res.ok) throw new Error(`list_invoices HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'list_invoices failed');
    const page = Array.isArray(json.data) ? json.data : [];
    all.push(...page.map(inv => inv.id));
    if (page.length < PER_PAGE) break;
    pageStart += PER_PAGE;
  }
  return all;
}

async function fetchTransaction(subdomain, key, id) {
  const params = new URLSearchParams({ key, id });
  const res = await fetch(`https://${subdomain}.gingrapp.com/api/v1/transaction?${params}`);
  if (!res.ok) return null;
  const json = await res.json();
  return json.success ? json.data : null;
}

async function batchFetch(subdomain, key, ids) {
  const results = [];
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const res = await Promise.all(batch.map(id => fetchTransaction(subdomain, key, id)));
    results.push(...res.filter(Boolean));
  }
  return results;
}

// Extract numeric tip total from tx.tip_amount (a top-level array).
// Handles: [], [number], [{tip_amount:"5.00",...}], [{amount:"5.00",...}]
function extractTip(tx) {
  const arr = tx.tip_amount;
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  let total = 0;
  for (const item of arr) {
    if (typeof item === 'number') total += item;
    else if (typeof item === 'string') total += parseFloat(item) || 0;
    else if (item && typeof item === 'object') {
      total += parseFloat(item.tip_amount || item.amount || item.value || 0);
    }
  }
  return total;
}

// True if any payment item falls in [from_date, to_date] (Pacific time)
function txInDateRange(tx, from_date, to_date) {
  for (const item of Object.values(tx.payment_items || {})) {
    const ts = parseInt(item.transaction_time || item.create_stamp || 0, 10);
    if (!ts) continue;
    const d = tsToPacificDate(ts);
    if (d >= from_date && d <= to_date) return true;
  }
  return false;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { facility, from_date, to_date, debug } = req.query;
  const config = FACILITIES[facility?.toLowerCase()];
  if (!config) return res.status(400).json({ success: false, error: `Unknown facility "${facility}"` });
  if (!config.key || !config.subdomain) return res.status(500).json({ success: false, error: `Env vars not set for "${facility}"` });
  if (!from_date || !to_date) return res.status(400).json({ success: false, error: 'from_date and to_date required' });

  try {
    const windowStart = addDays(from_date, -60);
    const windowEnd   = addDays(to_date, 60);

    const ids = await fetchInvoiceIds(config.subdomain, config.key, windowStart, windowEnd);
    const transactions = await batchFetch(config.subdomain, config.key, ids);

    let tips_total = 0;
    let matched = 0;
    const debugItems = debug === 'true' ? [] : null;
    const nonEmptyRaw = debug === 'true' ? [] : null;

    for (const tx of transactions) {
      if (!tx || !txInDateRange(tx, from_date, to_date)) continue;
      matched++;
      const tip = extractTip(tx);
      tips_total += tip;

      if (nonEmptyRaw && Array.isArray(tx.tip_amount) && tx.tip_amount.length > 0 && nonEmptyRaw.length < 5) {
        nonEmptyRaw.push({ invoice_id: tx.transaction?.id, tip_amount: tx.tip_amount, tip_refund: tx.tip_refund, tip_extracted: tip });
      }
      if (debugItems && tip > 0) {
        debugItems.push({ invoice_id: tx.transaction?.id, tip_amount_raw: tx.tip_amount, tip_extracted: tip });
      }
    }

    tips_total = Math.round(tips_total * 100) / 100;

    const response = {
      success: true, facility, facilityName: config.name, from_date, to_date,
      invoices_fetched: ids.length, invoices_matched: matched, tips_total,
    };
    if (debug === 'true') {
      response.debug_tips_with_value = debugItems;
      response.sample_nonempty_tip_amount = nonEmptyRaw;
    }

    return res.status(200).json(response);
  } catch (err) {
    return res.status(502).json({ success: false, error: err.message });
  }
};
