// Gingr Finance Proxy - EOD Financial Dashboard
// Filters by PAYMENT DATE, not reservation date.
// Deposits live in tx.deposits / tx.deposit, separate from tx.payment_items.

const FACILITIES = {
  how: { subdomain: process.env.HOW_SUBDOMAIN, key: process.env.HOW_API_KEY, name: 'House of Woof' },
  rw:  { subdomain: process.env.RW_SUBDOMAIN,  key: process.env.RW_API_KEY,  name: 'Riverwalk' },
  fpi: { subdomain: process.env.FPI_SUBDOMAIN, key: process.env.FPI_API_KEY, name: 'Four Paws Inn' },
  dd:  { subdomain: process.env.DD_SUBDOMAIN,  key: process.env.DD_API_KEY,  name: 'Don Doggos' },
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

function categorize(item) {
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
  if (type === 'credit card') return 'credit_card';
  return 'other';
}

// Normalize a deposit record to the payment_item shape expected by categorize().
//
// CRITICAL: We only use created_at (when the deposit was COLLECTED from the client).
// - consumed_at = when applied at checkout. For Gingr Payments (Stripe), the corresponding
//   charge is already tracked in payment_items — using consumed_at would double-count.
// - check_out_stamp = reservation checkout time, not a payment date — never use it.
//
// Gingr's "Collected Deposits" in the EOD report = deposits with created_at = today.
function normalizeDeposit(dep) {
  // Skip cancelled or forfeited deposits
  if (dep.cancel_stamp || dep.forfeited_at) return null;
  // Skip deposits with no collection date (can't assign to a day)
  if (!dep.created_at) return null;
  const isRefund = parseFloat(dep.refund_amount || 0) > 0 || !!dep.refunded_at;
  return {
    payment_method_type: dep.payment_method || dep.payment_method_type || dep.type || '',
    processor: dep.processor || null,
    total_balance: dep.deposit_amount || dep.paid_amount || dep.amount || dep.total_balance || '0',
    zero_payment: '0',
    transaction_time: dep.created_at,
    payment_allocation_refund: isRefund ? '1' : '0',
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
      if (!depositPaymentIds.has(String(key))) {
        items.push(item);
      }
    }
  }
  return items;
}

function aggregate(transactions, from_date, to_date) {
  const t = {
    cardconnect: 0, helcim: 0, gingr_payments: 0,
    cash: 0, check: 0, store_credit: 0, credit_card: 0,
    other: 0, refunds: 0,
  };
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
      if (!amount) continue;
      if (item.zero_payment === '1') continue;

      if (item.payment_allocation_refund === '1') {
        t.refunds -= amount;
        continue;
      }

      const cat = categorize(item);
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

  const { facility, from_date, to_date, debug } = req.query;
  const isDebug = debug === 'true';
  const config = FACILITIES[facility?.toLowerCase()];
  if (!config) return res.status(400).json({ success: false, error: `Unknown facility "${facility}"` });
  if (!config.key || !config.subdomain) return res.status(500).json({ success: false, error: `Env vars not set for "${facility}"` });
  if (!from_date || !to_date) return res.status(400).json({ success: false, error: 'from_date and to_date required' });

  try {
    const windowStart = addDays(from_date, -30);
    const windowEnd   = addDays(to_date, 1);
    const futureEnd   = addDays(to_date, 90);

    const [closedIds, openIds] = await Promise.all([
      fetchInvoiceIds(config.subdomain, config.key, windowStart, windowEnd, { complete: 'true' }),
      fetchInvoiceIdsSafe(config.subdomain, config.key, windowStart, futureEnd, { complete: 'false' }),
    ]);

    const allIds = [...new Set([...closedIds, ...openIds])];
    const transactions = await batchFetch(config.subdomain, config.key, allIds);
    const { totals, matched_invoices } = aggregate(transactions, from_date, to_date);

    const net_with_refunds = Math.round(
      Object.values(totals).reduce((a, b) => a + b, 0) * 100
    ) / 100;

    // Debug: show matched deposits and any Helcim payment_items with their raw dates
    let debugInfo = {};
    if (isDebug) {
      const matchingDeposits = [];
      const helcimPaymentItems = [];

      for (const tx of transactions) {
        // Deposits
        const src = tx?.deposits || tx?.deposit;
        if (src) {
          const deps = Array.isArray(src) ? src : Object.values(src);
          for (const d of deps) {
            const createdDate = d.created_at ? tsToPacificDate(d.created_at) : null;
            const consumedDate = d.consumed_at ? tsToPacificDate(d.consumed_at) : null;
            const checkoutDate = d.check_out_stamp ? tsToPacificDate(d.check_out_stamp) : null;
            if (createdDate !== from_date && consumedDate !== from_date && checkoutDate !== from_date) continue;
            matchingDeposits.push({
              id: d.id, payment_id: d.payment_id,
              amount: d.deposit_amount, method: d.payment_method,
              created_at_date: createdDate, consumed_at_date: consumedDate,
              check_out_stamp_date: checkoutDate,
              cancel_stamp: d.cancel_stamp || null,
              forfeited_at: d.forfeited_at || null,
              refund_amount: d.refund_amount || null,
              counted: createdDate === from_date && !d.cancel_stamp && !d.forfeited_at && !!d.created_at,
            });
          }
        }
        // Helcim payment_items — all dates, to find the missing $45
        if (tx?.payment_items) {
          for (const [key, item] of Object.entries(tx.payment_items)) {
            const type = (item.payment_method_type || '').toLowerCase();
            const proc = (item.processor || '').toLowerCase();
            if (!type.includes('helcim') && proc !== 'helcim') continue;
            const ts = parseInt(item.transaction_time || item.create_stamp || 0, 10);
            helcimPaymentItems.push({
              key,
              amount: item.total_balance,
              type: item.payment_method_type,
              proc: item.processor,
              date: ts ? tsToPacificDate(ts) : null,
              isRefund: item.payment_allocation_refund,
            });
          }
        }
      }
      debugInfo = { matchingDeposits, helcimPaymentItems };
    }

    return res.status(200).json({
      success: true,
      facility, facilityName: config.name, from_date, to_date,
      invoices_fetched: allIds.length,
      invoice_count: matched_invoices,
      totals,
      net_total: net_with_refunds,
      ...debugInfo,
    });
  } catch (err) {
    return res.status(502).json({ success: false, error: err.message });
  }
};
