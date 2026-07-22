// ============================================================
//  나염의뢰서 생성기 - 노션 제품DB 연동 (Vercel 서버 함수)
//  /api/products 를 부르면 서버가 노션을 조회해서 상품 목록을 돌려줍니다.
//  노션 토큰은 Vercel 환경변수(NOTION_TOKEN)에 넣습니다.
// ============================================================

// ===== 설정 (실제 노션 속성 이름 기준) =====
const DATABASE_ID    = "5d2ae3562c064494b6b1f0fc6469aa8a";
const CATEGORY_PROP  = "의류/슈즈/잡화";  // 카테고리 (select)
const CATEGORY_VALUE = "의류";            // 의류보드만
const TAG_VALUE      = "그래픽";          // 이 값을 가진 태그 속성이 있는 제품만
const STYLE_PROP     = "품번";            // -> STYLE NO.
const FACTORY_PROP   = "생산공장";        // -> 공장 거래처 / 나염 거래처
// ============================================

const NOTION_VERSION = "2022-06-28";

function norm(s) { return (s || "").toString().toLowerCase().replace(/\s+/g, ""); }

function findProp(props, needle) {
  const n = norm(needle);
  for (const key in props) { if (norm(key).includes(n)) return props[key]; }
  return null;
}

function propValue(prop) {
  if (!prop) return "";
  switch (prop.type) {
    case "title":        return (prop.title || []).map(t => t.plain_text).join("").trim();
    case "rich_text":    return (prop.rich_text || []).map(t => t.plain_text).join("").trim();
    case "number":       return prop.number == null ? "" : String(prop.number);
    case "select":       return prop.select ? prop.select.name : "";
    case "status":       return prop.status ? prop.status.name : "";
    case "multi_select": return (prop.multi_select || []).map(s => s.name).join(", ");
    case "formula": {
      const f = prop.formula || {};
      return f.string || (f.number != null ? String(f.number) : "") || (f.boolean != null ? String(f.boolean) : "");
    }
    case "rollup": {
      const r = prop.rollup || {};
      if (r.type === "array")  return (r.array || []).map(x => propValue(x)).filter(Boolean).join(", ");
      if (r.type === "number") return r.number != null ? String(r.number) : "";
      return "";
    }
    case "people":       return (prop.people || []).map(p => p.name).join(", ");
    case "date":         return prop.date ? prop.date.start : "";
    case "url":          return prop.url || "";
    case "email":        return prop.email || "";
    case "phone_number": return prop.phone_number || "";
    case "checkbox":     return prop.checkbox ? "true" : "";
    default:             return "";
  }
}

function propTags(prop) {
  if (!prop) return [];
  if (prop.type === "multi_select") return (prop.multi_select || []).map(s => s.name);
  if (prop.type === "select")       return prop.select ? [prop.select.name] : [];
  if (prop.type === "status")       return prop.status ? [prop.status.name] : [];
  return [];
}

// 모든 select/multi_select/status 속성값 중 value 를 포함하는 게 있으면 true
function hasTagValue(props, value) {
  const target = norm(value);
  for (const key in props) {
    for (const v of propTags(props[key])) {
      if (norm(v).includes(target)) return true;
    }
  }
  return false;
}

async function queryDB(token, filter) {
  let results = [], cursor = undefined, guard = 0;
  do {
    guard++;
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) { throw new Error(`Notion ${r.status}: ${await r.text()}`); }
    const j = await r.json();
    results = results.concat(j.results || []);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor && guard < 60);
  return results;
}

module.exports = async (req, res) => {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    res.status(500).json({ connected: false, error: "NOTION_TOKEN 환경변수가 설정되지 않았습니다." });
    return;
  }
  const debug = req.query && req.query.debug;

  try {
    if (debug === "1") {
      const pages = await queryDB(token, null);
      const props = pages[0] ? pages[0].properties : {};
      res.status(200).json({
        connected: true, totalPages: pages.length,
        schema: Object.keys(props).map(k => ({ name: k, type: props[k].type }))
      });
      return;
    }
    if (debug === "tags") {
      const pages = await queryDB(token, null);
      const map = {};
      for (const pg of pages) {
        for (const key in pg.properties) {
          const p = pg.properties[key];
          if (["select", "multi_select", "status"].includes(p.type)) {
            map[key] = map[key] || new Set();
            propTags(p).forEach(v => map[key].add(v));
          }
        }
      }
      const out = {};
      for (const k in map) out[k] = Array.from(map[k]);
      res.status(200).json({ connected: true, totalPages: pages.length, tagValues: out });
      return;
    }

    // 의류 카테고리만 서버에서 먼저 거름 → 빠름
    let pages;
    try {
      pages = await queryDB(token, { property: CATEGORY_PROP, select: { equals: CATEGORY_VALUE } });
    } catch (filterErr) {
      pages = await queryDB(token, null);
    }

    const products = [];
    for (const pg of pages) {
      const props = pg.properties;
      const catVal = propValue(findProp(props, CATEGORY_PROP));
      if (catVal && !catVal.includes(CATEGORY_VALUE)) continue;
      if (!hasTagValue(props, TAG_VALUE)) continue;

      const titleProp = Object.values(props).find(p => p.type === "title");
      const name = titleProp ? propValue(titleProp) : "";
      const style_no = propValue(findProp(props, STYLE_PROP));
      const factory = propValue(findProp(props, FACTORY_PROP));
      if (name) products.push({ name, style_no, factory });
    }

    products.sort((a, b) => a.name.localeCompare(b.name, "ko"));
    res.status(200).json({ connected: true, categoryFiltered: true, count: products.length, products });
  } catch (e) {
    res.status(500).json({ connected: false, error: String((e && e.message) || e) });
  }
};
