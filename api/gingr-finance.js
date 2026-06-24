// Gingr Finance Proxy - EOD Financial Dashboard
// Revenue attribution rules (matches Gingr's EOD report):
//   - Gingr Payments / cash / check: payment_items attributed to payment date (transaction_time)
//   - Helcim / CardConnect: payment_items attributed to payment date (transaction_time)
//   - Deposits (deposits field): attributed to COLLECTION DATE (created_at only)
//   - Lookback window: 60 days to catch long-term boardings

const FACILITIES = {
  how: { subdomain: process.env.HOW_SUBDOMAIN, key: process.env.HOW_API_KEY, name: 'House of Woof', defaultCardProc: 'cardconnect' },
  rw:  { subdomain: process.env.RW_SUBDOMAIN,  key: process.env.RW_API_KEY,  name: 'Riverwalk',    defaultCardProc: 'gingr_payments' },
  fpi: { subdomain: process.env.FPI_SUBDOMAIN, key: process.env.FPI_API_KEY, name: 'Four Paws Inn', defaultCardProc: 'gingr_payments' },
  dd:  { subdomain: process.env.DD_SUBDOMAIN,  key: process.env.DD_API_KEY,  name: 'Don Doggos',   defaultCardProc: 'gingr_payments' },
};

const PER_PAGE = 100;
const CONCURRENCY = 30;
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

async function fetchInvoiceIds(subdomain, key, from_date, to_date, extraParams = {}) {
  const all = [];
  let pageStart = 1;
  while (true) {
    const params = new URLSearchParams({
      key, from_date, to_date,
      per_page: String(PER_PAGE), page: String(pageStart),
      ...extraParams,
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

async function fetchInvoiceIdsSafe(subdomain, key, from_date, to_date, extraParams = {}) {
  try {
    return await fetchInvoiceIds(subdomain, key, from_date, to_date, extraParams);
  } catch (_) {
    return [];
  }
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

function categorize(item, defaultCardProc) {
  const type = (item.payment_method_type || '').toLowerCase().trim();
  const proc = (item.processor || '').toLowerCase().trim();
  if (type === 'no payment' || item.zero_payment === '1') return null;
  if (!parseFloat(item.total_balance || 0)) return null;
  if (type === 'cash') return 'cash';
  if (type === 'check') return 'check';
  if (type === 'store credit' || type === 'account credit') return 'store_credit';
  if (type.includes('admin') || type.includes('comped') || type.includes('credit comped')) return 'store_credit';
  if (proc === 'cardconnect') return 'cardconnect';
  if (proc === 'helcim') return 'helcim';
  if (proc === 'stripe') return 'gingr_payments';
  if (type.includes('helcim')) return 'helcim';
  if (type.includes('cardconnect')) return 'cardconnect';
  if (type.includes('gingr payment')) return 'gingr_payments';
  if (type === 'credit card') return defaultCardProc;
  return 'other';
}

// Only count deposits with known payment method, collected today (created_at).
// Deposits with consumed_at are ALREADY in payment_items — do not double-count.
// check_out_stamp is the reservation checkout time, NOT a payment date — skip it.
function normalizeDeposit(dep) {
  const method = (dep.payment_method || dep.payment_method_type || dep.type || '').trim();
  if (!method) return null;
  if (dep.cancel_stamp || dep.forfeited_at) return null;
  if (parseFloat(dep.refund_amount || 0) >= parseFloat(dep.deposit_amount || dep.paid_amount || 1)) return null;
  if (!dep.created_at) return null;
  const isRefund = parseFloat(dep.refund_amount || 0) > 0 || !!dep.refunded_at;
  return {
    payment_method_type: method,
    processor: dep.processor || null,
    total_balance: dep.deposit_amount || dep.paid_amount || dep.amount || dep.total_balance || '0',
    zero_payment: '0',
    transaction_time: dep.created_at,
    payment_allocation_refund: isRefund ? '1' : '0',
    _isDeposit: true,
  };
}

function getItemsToProcess(tx) {
  const items = [];
  const depositPaymentIds = new Set();
  const depSrc = tx.deposits || tx.deposit;
  if (depSrc) {
    const deps = Array.isArray(depSrc) ? depSrc : Object.values(depSrc);
    for (const d of deps) {
      if (d.payment_id) depositPaymentIds.add(String(d.payment_id));
      const normalized = normalizeDeposit(d);
      if (normalized) items.push(normalized);
    }
  }
  if (tx.payment_items && typeof tx.payment_items === 'object') {
    for (const [key, item] of Object.entries(tx.payment_items)) {
      if (!depositPaymentIds.has(String(key))) items.push(item);
    }
  }
  return items;
}

function aggregate(transactions, from_date, to_date, defaultCardProc) {
  const t = { cardconnect: 0, helcim: 0, gingr_payments: 0, cash: 0, check: 0, store_credit: 0, credit_card: 0, other: 0, refunds: 0 };
  let matched_invoices = 0;
  for (const tx of transactions) {
    if (!tx) continue;
    const items = getItemsToProcess(tx);
    let invoiceMatched = false;
    for (const item of items) {
      const ts = parseInt(item.transaction_time || item.create_stamp || 0, 10);
      if (!ts) continue;
      const payDate = tsToPacificDate(ts);
      if (payDate < from_date || payDate > to_date) continue;
      invoiceMatched = true;
      const amount = parseFloat(item.total_balance || 0);
      if (!amount || item.zero_payment === '1') continue;
      if (item.payment_allocation_refund === '1') { t.refunds -= amount; continue; }
      const cat = categorize(item, defaultCardProc);
      if (cat) t[cat] = (t[cat] || 0) + amount;
    }
    if (invoiceMatched) matched_invoices++;
  }
  return { totals: t, matched_invoices };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { facility, from_date, to_date } = req.query;
  const config = FACILITIES[facility?.toLowerCase()];
  if (!config) return res.status(400).json({ success: false, error: `Unknown facility "${facility}"` });
  if (!config.key || !config.subdomain) return res.status(500).json({ success: false, error: `Env vars not set for "${facility}"` });
  if (!from_date || !to_date) return res.status(400).json({ success: false, error: 'from_date and to_date required' });

  try {
    const windowStart = addDays(from_date, -60);
    const windowEnd   = addDays(to_date, 1);
    const futureEnd   = addDays(to_date, 90);
    const [closedIds, openIds] = await Promise.all([
      fetchInvoiceIds(config.subdomain, config.key, windowStart, windowEnd, { complete: 'true' }),
      fetchInvoiceIdsSafe(config.subdomain, config.key, windowStart, futureEnd, { complete: 'false' }),
    ]);
    const allIds = [...new Set([...closedIds, ...openIds])];
    const transactions = await batchFetch(config.subdomain, config.key, allIds);
    const { totals, matched_invoices } = aggregate(transactions, from_date, to_date, config.defaultCardProc);
    const net_with_refunds = Math.round(Object.values(totals).reduce((a, b) => a + b, 0) * 100) / 100;
    return res.status(200).json({
      success: true, facility, facilityName: config.name, from_date, to_date,
      invoices_fetched: allIds.length, invoice_count: matched_invoices,
      totals, net_total: net_with_refunds,
    });
  } catch (err) {
    return res.status(502).json({ success: false, error: err.message });
  }
};
