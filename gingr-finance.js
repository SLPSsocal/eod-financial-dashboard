// Gingr Finance Proxy - EOD Financial Dashboard
// Filters by PAYMENT DATE (transaction_time), not reservation date.
// Fetches a lookback window of invoices, then filters payment items
// by the exact target date in Pacific time.

const FACILITIES = {
  how: { subdomain: process.env.HOW_SUBDOMAIN, key: process.env.HOW_API_KEY, name: 'House of Woof' },
  rw:  { subdomain: process.env.RW_SUBDOMAIN,  key: process.env.RW_API_KEY,  name: 'Riverwalk' },
  fpi: { subdomain: process.env.FPI_SUBDOMAIN, key: process.env.FPI_API_KEY, name: 'Four Paws Inn' },
  dd:  { subdomain: process.env.DD_SUBDOMAIN,  key: process.env.DD_API_KEY,  name: 'Don Doggos' },
};

const PER_PAGE = 100;
const CONCURRENCY = 50;

// Offset for Pacific time: PDT = -7, PST = -8.
const PACIFIC_OFFSET_HOURS = -7;

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

// Convert a Unix timestamp to YYYY-MM-DD in Pacific time
function tsToPacificDate(ts) {
  const epochMs = (parseInt(ts, 10) + PACIFIC_OFFSET_HOURS * 3600) * 1000;
  return new Date(epochMs).toISOString().split('T')[0];
}

async function fetchInvoiceIds(subdomain, key, from_date, to_date) {
  const all = [];
  let pageStart = 1;
  while (true) {
    const params = new URLSearchParams({
      key, from_date, to_date,
      complete: 'true',
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

function categorize(item) {
  const type = (item.payment_method_type || '').toLowerCase().trim();
  const proc = (item.processor || '').toLowerCase().trim();

  if (type === 'no payment' || item.zero_payment === '1') return null;
  if (!parseFloat(item.total_balance || 0)) return null;

  if (type === 'cash') return 'cash';
  if (type === 'check') return 'check';
  if (type === 'store credit' || type === 'account credit') return 'store_credit';

  if (proc === 'cardconnect') return 'cardconnect';
  if (proc === 'helcim') return 'helcim';
  if (proc === 'stripe') return 'gingr_payments';

  if (type.includes('helcim')) return 'helcim';
  if (type.includes('cardconnect')) return 'cardconnect';
  if (type.includes('gingr payment')) return 'gingr_payments';
  if (type === 'credit card') return 'credit_card';

  return 'other';
}

function isRefund(item) {
  // Explicit refund flag
  if (item.payment_allocation_refund === '1') return true;
  // Negative balance = refund/credit (no explicit flag in some Gingr versions)
  if (parseFloat(item.total_balance || 0) < 0) return true;
  // Some refunds use payment_method_type = 'refund'
  const type = (item.payment_method_type || '').toLowerCase().trim();
  if (type === 'refund' || type === 'refunded') return true;
  return false;
}

function aggregate(transactions, from_date, to_date, debugItems) {
  const t = {
    cardconnect: 0, helcim: 0, gingr_payments: 0,
    cash: 0, check: 0, store_credit: 0, credit_card: 0,
    other: 0, refunds: 0,
  };
  let matched_invoices = 0;
  const debugOut = debugItems ? [] : null;

  for (const tx of transactions) {
    if (!tx?.payment_items) continue;
    let invoiceMatched = false;

    for (const item of Object.values(tx.payment_items)) {
      const ts = parseInt(item.transaction_time || item.create_stamp || 0, 10);
      if (!ts) continue;

      const payDate = tsToPacificDate(ts);
      if (payDate < from_date || payDate > to_date) continue;

      invoiceMatched = true;
      const amount = parseFloat(item.total_balance || 0);
      if (!amount) continue;

      if (debugOut) {
        debugOut.push({
          invoice_id: tx.id,
          payment_method_type: item.payment_method_type,
          processor: item.processor,
          total_balance: item.total_balance,
          payment_allocation_refund: item.payment_allocation_refund,
          transaction_time: item.transaction_time,
          payDate,
        });
      }

      if (isRefund(item)) {
        // Always subtract absolute value so refunds is negative
        t.refunds -= Math.abs(amount);
        continue;
      }

      const cat = categorize(item);
      if (cat) t[cat] = (t[cat] || 0) + amount;
    }

    if (invoiceMatched) matched_invoices++;
  }

  return { totals: t, matched_invoices, debugOut };
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
    // Backward: -60 days to catch refunds on older invoices
    // Forward: +60 days for deposits on upcoming reservations
    const windowStart = addDays(from_date, -60);
    const windowEnd   = addDays(to_date, 60);

    const ids = await fetchInvoiceIds(config.subdomain, config.key, windowStart, windowEnd);
    const transactions = await batchFetch(config.subdomain, config.key, ids);
    const { totals, matched_invoices, debugOut } = aggregate(transactions, from_date, to_date, debug === 'true');

    const net_with_refunds = Math.round(
      Object.values(totals).reduce((a, b) => a + b, 0) * 100
    ) / 100;

    const response = {
      success: true,
      facility,
      facilityName: config.name,
      from_date,
      to_date,
      invoices_fetched: ids.length,
      invoice_count: matched_invoices,
      totals,
      net_total: net_with_refunds,
    };

    if (debugOut) response.debug_items = debugOut;

    return res.status(200).json(response);
  } catch (err) {
    return res.status(502).json({ success: false, error: err.message });
  }
};
