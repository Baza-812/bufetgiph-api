/** Человекочитаемое время отсечки из поля Organizations «Cutoff Time» (строка HH:mm или значение из Airtable). */
function formatOrgCutoffTimeLabel(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw === 'string') {
    const m = raw.trim().match(/^(\d{1,2}):(\d{2})/);
    if (m) return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
  }
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) {
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  return String(raw).trim();
}

module.exports = { formatOrgCutoffTimeLabel };
