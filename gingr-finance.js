// Gingr Finance Proxy
// Required Vercel env vars: HOW_SUBDOMAIN, HOW_API_KEY, RW_SUBDOMAIN, RW_API_KEY, FPI_SUBDOMAIN, FPI_API_KEY, DD_SUBDOMAIN, DD_API_KEY

const FACILITIES = {
  how: { subdomain: process.env.HOW_SUBDOMAIN, key: process.env.HOW_API_KEY, name: 'House of Woof' },
  rw:  { subdomain: process.env.RW_SUBDOMAIN,  key: process.env.RW_API_KEY,  name: 'Riverwalk' },
  fpi: { subdomain: process.env.FPI_SUBDOMAIN, key: process.env.FPI_API_KEY, name: 'Four Paws Inn' },
  dd:  { subdomain: process.env.DD_SUBDOMAIN,  key: process.env.DD_API_KEY,  name: 'Don Doggos' },
};

const PER_PAGE = 100;

async function fetchAllInvoices(subdomain, key, from_date, to_date) {
  const all = [];
  let pageStart = 1;
  while (true) {
    const params = new URLSearchParams({ key, from_date, to_date, complete: 'true', closed_only: 'true', per_page: String(PER_PAGE), page: String(pageStart) });
    const url = `https://${subdomain}.gingrapp.com/api/v1/list_invoices?${params}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gingr HTTP ${res.status} for ${subdomain}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Gingr API error');
    const page = Array.isArray(json.data) ? json.data : [];
    all.push(...page);
    if (page.length < PER_PAGE) break;
    pageStart += PER_PAGE;
  }
  return all;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { facility, from_date, to_date } = req.query;
  const config = FACILITIES[facility?.toLowerCase()];
  if (!config) return res.status(400).json({ error: `Unknown facility "${facility}"` });
  if (!config.key || !config.subdomain) return res.status(500).json({ error: `Env vars not set for "${facility}"` });
  if (!from_date || !to_date) return res.status(400).json({ error: 'from_date and to_date required (YYYY-MM-DD)' });

  try {
    const invoices = await fetchAllInvoices(config.subdomain, config.key, from_date, to_date);
    return res.status(200).json({ success: true, facility, facilityName: config.name, from_date, to_date, count: invoices.length, data: invoices });
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
}
