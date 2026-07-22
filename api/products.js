// ============================================================
//  나염의뢰서 생성기 - 노션 제품DB 연동 (Vercel 서버 함수)
//  브라우저가 이 주소(/api/products)를 부르면, 서버가 노션을 대신 조회해서
//  상품 목록을 돌려줍니다. 노션 토큰은 코드가 아니라 Vercel 환경변수에 넣습니다.
// ============================================================

// ===== 설정 (필요하면 이 부분만 수정) =====
const DATABASE_ID = "5d2ae3562c064494b6b1f0fc6469aa8a"; // 제품DB ID
const TAG_PROP     = "상품태그";   // 태그 속성 이름
const TAG_VALUE    = "그래픽";     // 이 태그인 것만 불러옴
const STYLE_PROP   = "품번";       // -> STYLE NO.
const FACTORY_PROP = "생산공장";   // -> 공장 거래처 / 나염 거래처
const CATEGORY_KEYWORD = "의류";   // "의류보드"만: select류 속성값에 이 글자가 있으면 그걸로 거름
// ==========================================

const NOTION_VERSION = "2022-06-28";

function norm(s) { return (s || "").toString().toLowerCase().replace(/\s+/g, ""); }

// 속성 이름을 (공백 무시, 부분일치)로 찾기
function findProp(props, needle) {
  const n = norm(needle);
  for (const key in props) { if (norm(key).includes(n)) return props[key]; }
  return null;
}

// 어떤 타입의 속성이든 문자열 값으로 뽑아내기
function propValue(prop) {
  if (!prop) return "";
  switch (prop.type) {
    case "title":       return (prop.title || []).map(t => t.plain_text).join("").trim();
    case "rich_text":   return (prop.rich_text || []).map(t => t.plain_text).join("").trim();
    case "number":      return prop.number == null ? "" : String(prop.number);
    case "select":      return prop.select ? prop.select.name : "";
    case "status":      return prop.status ? prop.status.name : "";
    case "multi_select":return (prop.multi_select || []).map(s => s.name).join(", ");
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

// select / multi_select / status 값들을 배열로
function propTags(prop) {
  if (!prop) return [];
  if (prop.type === "multi_select") return (prop.multi_select || []).map(s => s.name);
  if (prop.type === "select")       return prop.select ? [prop.select.name] : [];
  if (prop.type === "status")       return prop.status ? [prop.status.name] : [];
  const v = propValue(prop);
  return v ? [v] : [];
}

// 이 페이지에 카테고리(의류/슈즈/잡화 등) 성격의 select류 속성이 있는지 & 의류인지
function categoryInfo(props) {
  let hasCategoryProp = false, isClothing = false;
  for (const key in props) {
    const p = props[key];
    if (["select", "status", "multi_select"].includes(p.type)) {
      const vals = propTags(p);
      for (const v of vals) {
        if (/의류|슈즈|잡화/.test(v)) hasCategoryProp = true;
        if (v.includes(CATEGORY_KEYWORD)) isClothing = true;
      }
    }
  }
  return { hasCategoryProp, isClothing };
}

async function queryAll(token) {
  let results = [], cursor = undefined, guard = 0;
  do {
    guard++;
    const body = { page_size: 100 };
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
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Notion ${r.status}: ${t}`);
    }
    const j = await r.json();
    results = results.concat(j.results || []);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor && guard < 30);
  return results;
}

module.exports = async (req, res) => {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    res.status(500).json({ connected: false, error: "NOTION_TOKEN 환경변수가 설정되지 않았습니다." });
    return;
  }
  try {
    const pages = await queryAll(token);

    // 디버그: /api/products?debug=1 → 속성 이름/타입 확인용
    if (req.query && req.query.debug) {
      const props = pages[0] ? pages[0].properties : {};
      res.status(200).json({
        connected: true,
        totalPages: pages.length,
        schema: Object.keys(props).map(k => ({ name: k, type: props[k].type }))
      });
      return;
    }

    // 데이터에 카테고리 속성이 있으면 "의류"만, 없으면 카테고리 필터는 생략
    let hasCategoryProp = false;
    for (const pg of pages) { if (categoryInfo(pg.properties).hasCategoryProp) { hasCategoryProp = true; break; } }

    const products = [];
    for (const pg of pages) {
      const props = pg.properties;

      // 상품태그 = 그래픽 인 것만
      const tags = propTags(findProp(props, TAG_PROP));
      const isGraphic = tags.some(v => norm(v) === norm(TAG_VALUE));
      if (!isGraphic) continue;

      // 의류보드만 (카테고리 속성이 있을 때)
      if (hasCategoryProp && !categoryInfo(props).isClothing) continue;

      const titleProp = Object.values(props).find(p => p.type === "title");
      const name = titleProp ? propValue(titleProp) : "";
      const style_no = propValue(findProp(props, STYLE_PROP));
      const factory = propValue(findProp(props, FACTORY_PROP));

      if (name) products.push({ name, style_no, factory });
    }

    // 이름순 정렬
    products.sort((a, b) => a.name.localeCompare(b.name, "ko"));

    res.status(200).json({
      connected: true,
      categoryFiltered: hasCategoryProp,
      count: products.length,
      products
    });
  } catch (e) {
    res.status(500).json({ connected: false, error: String((e && e.message) || e) });
  }
};
