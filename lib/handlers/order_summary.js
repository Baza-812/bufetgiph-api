// /lib/handlers/order_summary.js
// Поиск заказа менеджера по дате/организации без запроса "левых" полей

const { json, atGet, TABLE, F } = require('../utils');

const PAGE_SIZE = 100;

function lower(v){ return String(v||'').toLowerCase(); }
function isCancelled(st){ const s=lower(st); return s==='cancelled'||s==='canceled'; }

// все заказы на дату (без fields[] — чтобы не словить UNKNOWN_FIELD_NAME)
async function fetchOrdersByDate(date){
  const r = await atGet(TABLE.ORDERS, {
    pageSize: PAGE_SIZE,
    filterByFormula: `{${F.ORDER_DATE}}='${date}'`
  });
  return r.records || [];
}

// карта employeeId -> OrgID (по луккапу в Employees)
async function buildEmpOrgMap(empIds){
  if (!empIds.length) return {};
  const or = `OR(${empIds.map(id=>`RECORD_ID()='${id}'`).join(',')})`;
  const r = await atGet(TABLE.EMPLOYEES, {
    pageSize: PAGE_SIZE,
    filterByFormula: or
  });
  const map = {};
  for (const rec of (r.records||[])) {
    const f = rec.fields || {};
    const orgFromLookup = Array.isArray(f[F.EMP_ORG_LOOKUP]) ? f[F.EMP_ORG_LOOKUP][0] : f[F.EMP_ORG_LOOKUP];
    map[rec.id] = orgFromLookup || null;
  }
  return map;
}

module.exports = async (req,res)=>{
  if (req.method==='OPTIONS') return json(res,200,{ok:true});
  if (req.method!=='GET')     return json(res,405,{error:'GET only'});

  try{
    const { org, employeeID, date, scope, debug } = req.query || {};
    if (!org || !date) return json(res,400,{error:'org and date required'});

    const orders = await fetchOrdersByDate(date);

    // режим по сотруднику
    if (lower(scope) !== 'org') {
      if (!employeeID) return json(res,400,{error:'employeeID required (scope != org)'});
      const mine = orders.find(o=>{
        const f=o.fields||{};
        const emp = Array.isArray(f[F.ORDER_EMPLOYEE]) ? f[F.ORDER_EMPLOYEE][0] : f[F.ORDER_EMPLOYEE];
        return emp===employeeID && !isCancelled(f[F.ORDER_STATUS]);
      });
      if (!mine) return json(res,200,{ok:true, summary:null});
      const f = mine.fields||{};
      return json(res,200,{
        ok:true,
        summary:{ orderId: mine.id, date: f[F.ORDER_DATE]||'', status: f[F.ORDER_STATUS]||'', lines: [] },
        ...(debug ? { diag:{ mode:'employee', ordersCount: orders.length } } : {})
      });
    }

    // режим по организации
    const empIds = [];
    for (const o of orders){
      const emp = Array.isArray(o.fields?.[F.ORDER_EMPLOYEE]) ? o.fields[F.ORDER_EMPLOYEE][0] : o.fields?.[F.ORDER_EMPLOYEE];
      if (emp) empIds.push(emp);
    }
    const empOrgMap = await buildEmpOrgMap([...new Set(empIds)]);

    // если у тебя есть поле "Order Type" и оно используется — оставим мягкую проверку
    const suitable = orders.filter(o=>{
      const f=o.fields||{};
      const emp = Array.isArray(f[F.ORDER_EMPLOYEE]) ? f[F.ORDER_EMPLOYEE][0] : f[F.ORDER_EMPLOYEE];
      const empOrg = empOrgMap[emp] || null;
      if (isCancelled(f[F.ORDER_STATUS])) return false;
      if (empOrg !== org) return false;
      // мягкая проверка типа заказа (если поле есть и заполнено)
      const type = lower(f['Order Type']);
      if (type && type !== 'manager') return false;
      return true;
    });

    const first = suitable[0] || null;
    if (!first){
      return json(res,200,{
        ok:true, summary:null,
        ...(debug ? { diag:{ mode:'org', ordersCount: orders.length, suitableCount: 0, empOrgMap } } : {})
      });
    }

    const ff = first.fields||{};
    return json(res,200,{
      ok:true,
      summary:{ orderId:first.id, date: ff[F.ORDER_DATE]||'', status: ff[F.ORDER_STATUS]||'', lines: [] },
      ...(debug ? {
        diag:{ mode:'org', ordersCount: orders.length, suitableCount: suitable.length, matchedOrderId:first.id, empOrgMap }
      } : {})
    });
  }catch(e){
    return json(res,500,{ error: e.message || String(e) });
  }
};
