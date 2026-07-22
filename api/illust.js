// ============================================================
//  나염의뢰서 생성기 - 노션 일러스트DB 연동 (Vercel 서버 함수)
//  /api/illust?name=상품명  -> 그 상품명과 "정확히 같은" 제품명의
//  "AI 파일" 칸에 첨부된 이미지(PNG) URL 들을 돌려줍니다.
//  /api/illust            -> (name 없이) 파일 있는 제품명 목록만 돌려줌 (배지용)
// ============================================================

const DATABASE_ID  = "03a6d2bba1334ecbadb39dd73071b714"; // 일러스트 DB
const YEAR_PROP    = "개발년도";   // 필터: 개발년도 = 2026
const YEAR_VALUE   = "2026";
const FILE_PROP    = "AI 파일";    // 이 칸에 첨부된 이미지를 읽음
const NOTION_VERSION = "2022-06-28";

function norm(s){ return (s||"").toString().toLowerCase().replace(/\s+/g,""); }

function findProp(props, needle){
  const n = norm(needle);
  for (const key in props){ if (norm(key).includes(n)) return props[key]; }
  return null;
}

function titleValue(props){
  const t = Object.values(props).find(p => p.type === "title");
  return t ? (t.title||[]).map(x=>x.plain_text).join("").trim() : "";
}

// files 속성에서 (이미지) 파일 URL + 파일명 뽑기
function fileEntries(prop){
  if (!prop || prop.type !== "files") return [];
  return (prop.files||[]).map(f => {
    const url = f.type === "file" ? (f.file && f.file.url) : (f.external && f.external.url);
    return { name: f.name || "", url: url || "" };
  }).filter(e => e.url);
}
function isImage(entry){
  const s = (entry.name + " " + entry.url).toLowerCase();
  return /\.(png|jpg|jpeg|webp|gif)(\?|$)/.test(s);
}

async function queryDB(token, filter){
  let results=[], cursor, guard=0;
  do {
    guard++;
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
      method:"POST",
      headers:{ "Authorization":`Bearer ${token}`, "Notion-Version":NOTION_VERSION, "Content-Type":"application/json" },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`Notion ${r.status}: ${await r.text()}`);
    const j = await r.json();
    results = results.concat(j.results||[]);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor && guard < 60);
  return results;
}

// 개발년도 필터 (select / multi_select / number / rich_text 어떤 타입이든 대응)
function yearFilter(type){
  if (type === "select")       return { property: YEAR_PROP, select: { equals: YEAR_VALUE } };
  if (type === "multi_select") return { property: YEAR_PROP, multi_select: { contains: YEAR_VALUE } };
  if (type === "number")       return { property: YEAR_PROP, number: { equals: Number(YEAR_VALUE) } };
  if (type === "rich_text")    return { property: YEAR_PROP, rich_text: { contains: YEAR_VALUE } };
  return null;
}

module.exports = async (req, res) => {
  const token = process.env.NOTION_TOKEN;
  if (!token){ res.status(500).json({ connected:false, error:"NOTION_TOKEN 환경변수가 없습니다." }); return; }

  const wantName = (req.query && req.query.name ? String(req.query.name) : "").trim();
  const debug = req.query && req.query.debug;

  try {
    // 개발년도 속성 타입 파악 후 그에 맞는 필터 구성
    let pages;
    try {
      const probe = await queryDB(token, null); // 첫 페이지들로 타입 파악
      const ytype = probe[0] ? (findProp(probe[0].properties, YEAR_PROP)||{}).type : null;
      const filt = yearFilter(ytype);
      pages = filt ? await queryDB(token, filt) : probe;
    } catch (e) {
      pages = await queryDB(token, null);
    }

    if (debug === "1"){
      const props = pages[0] ? pages[0].properties : {};
      res.status(200).json({ connected:true, totalPages:pages.length,
        schema: Object.keys(props).map(k=>({name:k,type:props[k].type})) });
      return;
    }

    // name 없이 호출: 파일이 있는 제품명 목록만 (검색창 "파일 있음" 배지용)
    if (!wantName){
      const names = [];
      for (const pg of pages){
        const imgs = fileEntries(findProp(pg.properties, FILE_PROP)).filter(isImage);
        if (imgs.length){ const nm = titleValue(pg.properties); if (nm) names.push(nm); }
      }
      res.status(200).json({ connected:true, count:names.length, names });
      return;
    }

    // name 지정: 제품명이 "정확히 같은" 것만
    const target = norm(wantName);
    const images = [];
    for (const pg of pages){
      if (norm(titleValue(pg.properties)) !== target) continue;
      fileEntries(findProp(pg.properties, FILE_PROP)).filter(isImage).forEach(e => images.push(e));
    }
    res.status(200).json({ connected:true, name:wantName, images });
  } catch (e){
    res.status(500).json({ connected:false, error:String((e&&e.message)||e) });
  }
};
