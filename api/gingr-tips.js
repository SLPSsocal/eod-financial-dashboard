// Gingr Tips/Gratuity Proxy - EOD Financial Dashboard
// Checks tx.gratuity, items[].gratuity_amount, and payment_items gratuity types

const FACILITIES = {
  how: { subdomain: process.env.HOW_SUBDOMAIN, key: process.env.HOW_API_KEY, name: 'House of Woof' },
  rw:  { subdomain: process.env.RW_SUBDOMAIN,  key: process.env.RW_API_KEY,  name: 'Riverwalk' },
  fpi: { subdomain: process.env.FPI_SUBDOMAIN, key: process.env.FPI_API_KEY, name: 'Four Paws Inn' },
  dd:  { subdomain: process.env.DD_SUBDOMAIN,  key: process.env.DD_API_KEY,  name: 'Don Doggos' },
};

const PER_PAGE = 100;
const CONCURRENCY = 30;

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

async function fetchInvoiceIds(subdomain, key, from_date, to_date, extraParams = {}) {
  const all = [];
  let pageStart = 1;
  while (true) {
    const params = new URLSearchParams({ key, from_date, to_date, per_page: String(PER_PAGE), page: String(pageStart), ...extraParams });
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

function extractTips(tx) {
  let tips = 0, refunds = 0;

  // Strategy 1: tx.gratuity top-level field
  const g = parseFloat(tx.gratuity || 0);
  if (g > 0) tips += g;

  // Strategy 2: items[].gratuity_amount
  const itemsSrc = tx.items;
  if (itemsSrc) {
    const itemsArr = Array.isArray(itemsSrc) ? itemsSrc : Object.values(itemsSrc);
    for (const item of itemsArr) {
      const ga = parseFloat(item.gratuity_amount || 0);
      if (ga > 0) tips += ga;
    }
  }

  // Strategy 3: payment_items where type contains 'gratuity' or 'tip'
  if (tx.payment_items && typeof tx.payment_items === 'object') {
    for (const item of Object.values(tx.payment_items)) {
      const type = (item.payment_method_type || '').toLowerCase();
      if (!type.includes('gratuity') && !type.includes('tip')) continue;
      const amount = parseFloat(item.total_balance || 0);
      if (amount > 0) {
        if (item.payment_allocation_refund === '1') refunds += amount;
        else tips += amount;
      }
    }
  }

  return { tips, refunds };
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
    const windowEnd = addDays(to_date, 1);
    const ids = await fetchInvoiceIds(config.subdomain, config.key, from_date, windowEnd, { complete: 'true' });
    const transactions = await batchFetch(config.subdomain, config.key, ids);

    let total_tips = 0;
    let refunded_tips = 0;
    const debugSamples = [];

    for (const tx of transactions) {
      if (!tx) continue;

      if (isDebug && debugSamples.length < 3) {
        const itemsSrc = tx.items;
        const itemsArr = itemsSrc ? (Array.isArray(itemsSrc) ? itemsSrc : Object.values(itemsSrc)) : [];
        const firstItem = itemsArr[0] || {};
        debugSamples.push({
          tx_keys: Object.keys(tx),
          gratuity: tx.gratuity,
          tip_amount: tx.tip_amount,
          detailed_payments: tx.detailed_payments,
          payment_item_types: tx.payment_items
            ? [...new Set(Object.values(tx.payment_items).map(p => p.payment_method_type))]
            : [],
          first_item_keys: Object.keys(firstItem),
          first_item_gratuity_amount: firstItem.gratuity_amount,
          first_item_modifiers: firstItem.modifiers,
        });
      }

      const { tips, refunds } = extractTips(tx);
      total_tips += tips;
      refunded_tips += refunds;
    }

    total_tips    = Math.round(total_tips    * 100) / 100;
    refunded_tips = Math.round(refunded_tips * 100) / 100;
    const net_tips = Math.round((total_tips - refunded_tips) * 100) / 100;

    return res.status(200).json({
      success: true, facility, facilityName: config.name, from_date, to_date,
      invoices_fetched: ids.length, total_tips, refunded_tips, net_tips,
      ...(isDebug ? { debugSamples } : {}),
    });
  } catch (err) {
    return res.status(502).json({ success: false, error: err.message });
  }
};
