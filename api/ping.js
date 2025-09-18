export default (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  res.status(200).json({ pong: true, time: new Date().toISOString() });
};
