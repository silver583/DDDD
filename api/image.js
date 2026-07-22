// ============================================================
//  이미지 중계(proxy) - 노션 첨부 이미지를 우리 도메인을 통해 내려줌.
//  (브라우저가 같은 출처로 이미지를 받아야 캔버스에서 실제 그래픽 크기를
//   잴 수 있어서 필요합니다.)  사용: /api/image?url=<노션이미지주소>
// ============================================================
module.exports = async (req, res) => {
  const url = req.query && req.query.url ? String(req.query.url) : "";
  if (!url) { res.status(400).send("no url"); return; }
  // 보안: 노션/아마존 S3 이미지 주소만 허용
  if (!/(amazonaws\.com|notion\.so|notion-static\.com|notion\.com)/.test(url)) {
    res.status(403).send("host not allowed");
    return;
  }
  try {
    const r = await fetch(url);
    if (!r.ok) { res.status(r.status).send("fetch fail"); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", r.headers.get("content-type") || "image/png");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(200).send(buf);
  } catch (e) {
    res.status(500).send(String((e && e.message) || e));
  }
};
