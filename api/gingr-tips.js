// Gingr Tips/Gratuity Proxy - EOD Financial Dashboard

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
    const debugSample = [];

    for (const tx of transactions) {
      if (!tx) continue;
      const tip = parseFloat(tx.tip_amount || 0);
      const refund = parseFloat(tx.tip_refund || 0);
      if (tip > 0) total_tips += tip;
      if (refund > 0) refunded_tips += refund;

      if (isDebug && debugSample.length < 5) {
        const nested = tx.transaction || {};
        const pi = tx.payment_info || {};
        debugSample.push({
          tip_amount_raw: tx.tip_amount,
          tip_refund_raw: tx.tip_refund,
          nested_tx_keys: Object.keys(nested),
          nested_tip_amount: nested.tip_amount,
          nested_gratuity: nested.gratuity,
          payment_info_keys: Object.keys(pi),
          payment_info_tip: pi.tip_amount,
          payment_info_gratuity: pi.gratuity,
        });
      }
    }

    total_tips    = Math.round(total_tips    * 100) / 100;
    refunded_tips = Math.round(refunded_tips * 100) / 100;
    const net_tips = Math.round((total_tips - refunded_tips) * 100) / 100;

    return res.status(200).json({
      success: true, facility, facilityName: config.name, from_date, to_date,
      invoices_fetched: ids.length, total_tips, refunded_tips, net_tips,
      ...(isDebug ? { debugSample } : {}),
    });
  } catch (err) {
    return res.status(502).json({ success: false, error: err.message });
  }
};
