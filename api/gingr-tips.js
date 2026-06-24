// Gingr Tips/Gratuity Proxy - EOD Financial Dashboard
// Tips attribution: payment date (transaction_time on payment_items)
// Also checks tx.gratuity (top-level) and tx.items[].gratuity_amount

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
  try { return await fetchInvoiceIds(subdomain, key, from_date, to_date, extraParams); } catch { return []; }
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

function extractTipsFromTx(tx, from_date, to_date) {
  const found = [];

  // Strategy 1: payment_items where payment_method_type contains 'gratuity' or 'tip'
  if (tx.payment_items && typeof tx.payment_items === 'object') {
    for (const [, item] of Object.entries(tx.payment_items)) {
      const type = (item.payment_method_type || '').toLowerCase();
      if (!type.includes('gratuity') && !type.includes('tip')) continue;
      const ts = parseInt(item.transaction_time || item.create_stamp || 0, 10);
      if (!ts) continue;
      const payDate = tsToPacificDate(ts);
      if (payDate < from_date || payDate > to_date) continue;
      const amount = parseFloat(item.total_balance || 0);
      if (!amount) continue;
      const isRefund = item.payment_allocation_refund === '1';
      found.push({ amount, isRefund, source: 'payment_items', method: item.payment_method_type });
    }
  }

  // Strategy 2: tx.gratuity top-level field
  if (tx.gratuity && parseFloat(tx.gratuity) > 0) {
    const ts = parseInt(tx.create_stamp || tx.transaction_time || 0, 10);
    if (ts) {
      const payDate = tsToPacificDate(ts);
      if (payDate >= from_date && payDate <= to_date) {
        found.push({ amount: parseFloat(tx.gratuity), isRefund: false, source: 'tx.gratuity' });
      }
    }
  }

  // Strategy 3: items[].gratuity_amount (service line items)
  const itemsSrc = tx.items;
  if (itemsSrc) {
    const itemsArr = Array.isArray(itemsSrc) ? itemsSrc : Object.values(itemsSrc);
    for (const item of itemsArr) {
      const ga = parseFloat(item.gratuity_amount || 0);
      if (!ga) continue;
      const ts = parseInt(item.create_stamp || item.transaction_time || tx.create_stamp || 0, 10);
      if (!ts) continue;
      const payDate = tsToPacificDate(ts);
      if (payDate < from_date || payDate > to_date) continue;
      found.push({
        amount: ga,
        isRefund: false,
        source: 'items.gratuity_amount',
        staffId: item.employee_id || null,
        staffName: item.employee_name || null,
      });
    }
  }

  return found;
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
    const windowStart = addDays(from_date, -60);
    const windowEnd   = addDays(to_date, 1);
    const futureEnd   = addDays(to_date, 90);

    const [closedIds, openIds] = await Promise.all([
      fetchInvoiceIds(config.subdomain, config.key, windowStart, windowEnd, { complete: 'true' }),
      fetchInvoiceIdsSafe(config.subdomain, config.key, windowStart, futureEnd, { complete: 'false' }),
    ]);
    const allIds = [...new Set([...closedIds, ...openIds])];
    const transactions = await batchFetch(config.subdomain, config.key, allIds);

    let total_tips = 0;
    let refunded_tips = 0;
    let tip_count = 0;
    const debugItems = [];
    const debugSampleKeys = [];

    for (const tx of transactions) {
      if (!tx) continue;

      // Debug: capture structure of first few transactions (even those with no tips)
      if (isDebug && debugSampleKeys.length < 3) {
        const itemsSrc = tx.items;
        const itemsArr = itemsSrc ? (Array.isArray(itemsSrc) ? itemsSrc : Object.values(itemsSrc)) : [];
        debugSampleKeys.push({
          tx_id: tx.id,
          tx_keys: Object.keys(tx),
          has_gratuity_field: 'gratuity' in tx,
          gratuity_value: tx.gratuity,
          payment_item_types: tx.payment_items
            ? [...new Set(Object.values(tx.payment_items).map(p => p.payment_method_type))]
            : [],
          item_sample_keys: itemsArr[0] ? Object.keys(itemsArr[0]) : [],
          item_gratuity_sample: itemsArr[0] ? itemsArr[0].gratuity_amount : undefined,
        });
      }

      const tips = extractTipsFromTx(tx, from_date, to_date);
      for (const tip of tips) {
        if (tip.isRefund) {
          refunded_tips += tip.amount;
        } else {
          total_tips += tip.amount;
          tip_count++;
        }
        if (isDebug) debugItems.push(tip);
      }
    }

    total_tips     = Math.round(total_tips     * 100) / 100;
    refunded_tips  = Math.round(refunded_tips  * 100) / 100;
    const net_tips = Math.round((total_tips - refunded_tips) * 100) / 100;

    return res.status(200).json({
      success: true,
      facility,
      facilityName: config.name,
      from_date,
      to_date,
      invoices_fetched: allIds.length,
      tip_count,
      total_tips,
      refunded_tips,
      net_tips,
      ...(isDebug ? { debugTips: debugItems, debugSampleKeys } : {}),
    });
  } catch (err) {
    return res.status(502).json({ success: false, error: err.message });
  }
};
