// Europe PMC / PMC 批量 PDF 下载器
// 用法: node download_pdfs.js <ID列表文件> [输出目录]
// ID列表文件: 每行一个 PMID / PMCID(如PMC13527554) / DOI
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const listFile = process.argv[2];
const outDir = process.argv[3] || path.join(__dirname, '文献PDF');
if (!listFile) { console.error('用法: node download_pdfs.js <ID列表文件> [输出目录]'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });

const sleep = ms => new Promise(s => setTimeout(s, ms));
// 0) PMC 的 PoW 挑战求解(sha256前导零) + 简易cookie罐
const crypto = require('crypto');
let cookieJar = {};
function mergeCookies(res) {
  for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
    const [kv] = c.split(';'); const eq = kv.indexOf('='); if (eq > 0) cookieJar[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
}
function cookieHeader() { return Object.entries(cookieJar).map(([k, v]) => k + '=' + v).join('; '); }
function solvePow(challenge, difficulty) {
  const prefix = '0'.repeat(difficulty);
  for (let n = 0; ; n++) {
    const h = crypto.createHash('sha256').update(challenge + n).digest('hex');
    if (h.startsWith(prefix)) return n;
  }
}

const get = async (url, asBuffer = false, tries = 3) => {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, ...(cookieHeader() ? { Cookie: cookieHeader() } : {}), Referer: 'https://pmc.ncbi.nlm.nih.gov/' } });
      if (r.status === 429 || r.status === 503) {  // 限流：等5秒重试
        lastErr = new Error('HTTP ' + r.status + '(限流)'); await sleep(5000); continue;
      }
      mergeCookies(r);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return { buf, text: () => buf.toString('utf8'), ok: r.ok };
    } catch (e) { lastErr = e; await sleep(3000); }
  }
  throw lastErr;
};
const sanitize = s => s.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);

// 1) 通过 Europe PMC REST 解析 ID -> 元数据(含 PMCID)；太新的文章用 NCBI idconv 兜底
async function resolve(id) {
  const q = id.toUpperCase().startsWith('PMC') ? `PMCID:${id.toUpperCase()}`
    : id.includes('/') || id.startsWith('10.') ? `DOI:"${id}"`
    : `EXT_ID:${id} AND SRC:MED`;
  const url = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=' + encodeURIComponent(q) + '&format=json&pageSize=1&resultType=core';
  const d = JSON.parse((await get(url)).text());
  if (!d.resultList.result.length) throw new Error('Europe PMC 未找到');
  const r = d.resultList.result[0];
  const first = (r.authorString || 'Unknown').split(',')[0].replace(/\s+\d.*$/, '').trim();
  let pmcid = r.pmcid;
  if (!pmcid && /^\d+$/.test(id)) {  // Europe PMC 还没同步的新文章，走 NCBI idconv
    try {
      const conv = JSON.parse((await get(`https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?ids=${id}&format=json&tool=pdf_dl&email=lit.check@example.com`)).text());
      pmcid = conv.records?.[0]?.pmcid || null;
    } catch (e) { /* 忽略 */ }
  }
  return { pmcid, title: r.title, first, year: r.pubYear, journal: r.journalInfo?.journal?.title || '' };
}

// 2) 从 PMC 文章页提取 PDF 链接并下载（自动过 PoW 挑战）
async function downloadPdf(pmcid, filename) {
  const base = `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`;
  const page = (await get(base)).text();
  const m = page.match(/href="([^"]*pdf[^"]*)"/i);
  if (!m) throw new Error('PMC条目无PDF版本(可能为作者手稿)');
  let href = m[1].replace(/&amp;/g, '&');
  let pdfUrl = href.startsWith('http') ? href : href.startsWith('/') ? 'https://pmc.ncbi.nlm.nih.gov' + href : base + href;
  let r = await get(pdfUrl);
  let buf = r.buf;
  if (buf.slice(0, 5).toString() !== '%PDF-') {  // 命中"Preparing to download"中转页 → 解PoW再取
    const html = buf.toString('utf8');
    const ch = html.match(/POW_CHALLENGE = "([^"]+)"/), df = html.match(/POW_DIFFICULTY = "(\d+)"/);
    if (!ch) throw new Error('既不是PDF也无PoW挑战(' + buf.length + 'B)');
    console.log(`  ...解PoW挑战(难度${df ? df[1] : 4})`);
    cookieJar['cloudpmc-viewer-pow'] = ch[1] + ',' + solvePow(ch[1], df ? parseInt(df[1]) : 4);
    await sleep(300);
    r = await get(pdfUrl); buf = r.buf;
  }
  if (buf.length < 5000 || buf.slice(0, 5).toString() !== '%PDF-') throw new Error('下载的不是PDF(' + buf.length + 'B)');
  fs.writeFileSync(path.join(outDir, filename), buf);
  return buf.length;
}

(async () => {
  const ids = fs.readFileSync(listFile, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  console.log(`共 ${ids.length} 条，输出到 ${outDir}\n`);
  const ok = [], noPmc = [], fail = [];
  for (const id of ids) {
    try {
      const meta = await resolve(id);
      const fname = sanitize(`${meta.first} ${meta.year} - ${meta.title}`) + '.pdf';
      if (fs.existsSync(path.join(outDir, fname))) { ok.push(fname); console.log(`↷ 已存在  ${fname}`); continue; }
      if (!meta.pmcid) { noPmc.push(`${id}: ${meta.title} (无PMC免费版)`); console.log(`✗ 无PMC  ${id}`); continue; }
      const size = await downloadPdf(meta.pmcid, fname);
      ok.push(fname);
      console.log(`✓ 已下载 ${(size / 1024 / 1024).toFixed(2)}MB  ${fname}`);
    } catch (e) {
      fail.push(`${id}: ${e.message}`); console.log(`✗ 失败   ${id} — ${e.message}`);
    }
    await sleep(2000); // 对服务器友好，防限流
  }
  console.log(`\n===== 汇总 =====`);
  console.log(`成功 ${ok.length} | 无PMC免费版 ${noPmc.length} | 失败 ${fail.length}`);
  if (noPmc.length) { console.log('\n-- 无PMC免费版(需文献传递/邮件索要) --'); noPmc.forEach(x => console.log('  ' + x)); }
  if (fail.length) { console.log('\n-- 失败(可重跑) --'); fail.forEach(x => console.log('  ' + x)); }
})();
