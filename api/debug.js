import { cors } from './_lib/air.js';

export default function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.status(200).json({
    ok: true,
    base: process.env.AIRTABLE_BASE || process.env.AIRTABLE_BASE_ID || null,
    token: (process.env.AIRTABLE_API_KEY ? 'set' : 'missing')
  });
}
