import { cors } from './_lib/air.js';
export default (req,res)=>{ cors(res); if(req.method==='OPTIONS'){res.status(200).end();return;} res.status(200).json({ ok:true, time:new Date().toISOString() }); };
