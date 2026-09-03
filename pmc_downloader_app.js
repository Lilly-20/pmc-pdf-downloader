// PMC 全文批量下载器 - 本地版（单文件，无第三方依赖）
// 双击运行后自动打开浏览器操作页面；关闭窗口或按 Ctrl+C 退出。
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');

// ---------- 配置 ----------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const sleep = ms => new Promise(s => setTimeout(s, ms));

// 平台探测（用于跨平台打开浏览器/文件夹）
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
function openUrl(url) { exec(IS_WIN ? `start "" "${url}"` : IS_MAC ? `open "${url}"` : `xdg-open "${url}"`); }
function openFolder(dir) { exec(IS_WIN ? `explorer "${dir}"` : IS_MAC ? `open "${dir}"` : `xdg-open "${dir}"`); }
function isValidPath(p) { return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/'); }

// ---------- 下载核心（复用自 download_pdfs.js） ----------
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
const get = async (url, tries = 3) => {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, ...(cookieHeader() ? { Cookie: cookieHeader() } : {}), Referer: 'https://pmc.ncbi.nlm.nih.gov/' } });
      if (r.status === 429 || r.status === 503) { lastErr = new Error('HTTP ' + r.status + '(限流)'); await sleep(5000); continue; }
      mergeCookies(r);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return { buf, text: () => buf.toString('utf8') };
    } catch (e) { lastErr = e; await sleep(3000); }
  }
  throw lastErr;
};
const sanitize = s => s.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);

// 从任意混合文本（如 Zotero 复制的参考文献表）中提取文献编号
function extractIds(text) {
  const ids = [], seen = new Set();
  const push = x => { const k = x.toLowerCase(); if (!seen.has(k)) { seen.add(k); ids.push(x); } };
  // DOI：10.xxxx/xxx，去掉尾部句号逗号等标点
  for (const m of text.matchAll(/\b10\.\d{4,9}\/[^\s"'<>，。；、]+/g)) push(m[0].replace(/[.,;:)\]」』]+$/, ''));
  // PMCID
  for (const m of text.matchAll(/\bPMC\d{6,9}\b/gi)) push(m[0].toUpperCase());
  // PMID：整行只有6-9位数字才算（避免误吞年份、页码、期卷号）
  for (const line of text.split(/\r?\n/)) { const t = line.trim(); if (/^\d{6,9}$/.test(t)) push(t); }
  return ids;
}

async function resolve(id) {
  const q = id.toUpperCase().startsWith('PMC') ? `PMCID:${id.toUpperCase()}`
    : id.includes('/') || id.startsWith('10.') ? `DOI:"${id}"`
    : `EXT_ID:${id} AND SRC:MED`;
  const url = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=' + encodeURIComponent(q) + '&format=json&pageSize=1&resultType=core';
  const d = JSON.parse((await get(url)).text());
  if (!d.resultList.result.length) throw new Error('Europe PMC 未找到该编号');
  const r = d.resultList.result[0];
  const first = (r.authorString || 'Unknown').split(',')[0].replace(/\s+\d.*$/, '').trim();
  let pmcid = r.pmcid;
  if (!pmcid && /^\d+$/.test(id)) {
    try {
      const conv = JSON.parse((await get(`https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/?ids=${id}&format=json&tool=pdf_dl&email=lit.check@example.com`)).text());
      pmcid = conv.records?.[0]?.pmcid || null;
    } catch (e) { /* 忽略 */ }
  }
  return { pmcid, title: r.title || '(无标题)', first, year: r.pubYear, journal: r.journalInfo?.journal?.title || '' };
}

async function downloadPdf(pmcid, outDir, filename) {
  const base = `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`;
  const page = (await get(base)).text();
  const m = page.match(/href="([^"]*pdf[^"]*)"/i);
  if (!m) throw new Error('PMC 条目无 PDF 版本（可能为作者手稿，仅网页版）');
  let href = m[1].replace(/&amp;/g, '&');
  let pdfUrl = href.startsWith('http') ? href : href.startsWith('/') ? 'https://pmc.ncbi.nlm.nih.gov' + href : base + href;
  let r = await get(pdfUrl);
  let buf = r.buf;
  if (buf.slice(0, 5).toString() !== '%PDF-') {
    const html = buf.toString('utf8');
    const ch = html.match(/POW_CHALLENGE = "([^"]+)"/), df = html.match(/POW_DIFFICULTY = "(\d+)"/);
    if (!ch) throw new Error('既不是PDF也无挑战(' + buf.length + 'B)');
    cookieJar['cloudpmc-viewer-pow'] = ch[1] + ',' + solvePow(ch[1], df ? parseInt(df[1]) : 4);
    await sleep(300);
    r = await get(pdfUrl); buf = r.buf;
  }
  if (buf.length < 5000 || buf.slice(0, 5).toString() !== '%PDF-') throw new Error('下载到的不是PDF(' + buf.length + 'B)');
  fs.writeFileSync(path.join(outDir, filename), buf);
  return buf.length;
}

// ---------- 历史路径持久化 ----------
const HISTORY_FILE = path.join(os.homedir(), '.pmc-downloader', 'history.json');
function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) || []; }
  catch (e) { return []; }
}
function saveHistory(arr) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(arr.slice(0, 10), null, 2));
  } catch (e) { /* 忽略 */ }
}
function addHistory(dir) {
  const arr = loadHistory().filter(d => d !== dir);
  arr.unshift(dir);
  saveHistory(arr);
  return arr;
}

// ---------- 任务状态 ----------
let job = { running: false, log: [], done: 0, total: 0, stopFlag: false };
function log(msg) { job.log.push({ t: new Date().toLocaleTimeString(), msg }); if (job.log.length > 500) job.log.shift(); }

async function runJob(ids, outDir, forceOverwrite) {
  job = { running: true, log: [], done: 0, total: ids.length, stopFlag: false };
  const ok = [], noPmc = [], fail = [];
  log(`任务开始：共 ${ids.length} 篇，保存到 ${outDir}${forceOverwrite ? '（强制覆盖已下载）' : '（已下载自动跳过）'}`);
  for (const id of ids) {
    if (job.stopFlag) { log('已手动停止'); break; }
    try {
      log(`[${job.done + 1}/${ids.length}] 正在查询 ${id} ...`);
      const meta = await resolve(id);
      const fname = sanitize(`${meta.first} ${meta.year} - ${meta.title}`) + '.pdf';
      const fpath = path.join(outDir, fname);
      if (!forceOverwrite && fs.existsSync(fpath)) { ok.push(fname); log(`↷ 已存在，跳过：${fname}`); }
      else if (!meta.pmcid) { noPmc.push(`${id}: ${meta.title}`); log(`✗ 无 PMC 免费版：《${meta.title.slice(0, 60)}》— 请走 NSTL 文献传递或邮件向作者索要`); }
      else {
        if (forceOverwrite && fs.existsSync(fpath)) log(`⟳ 覆盖更新：${fname}`);
        const size = await downloadPdf(meta.pmcid, outDir, fname);
        ok.push(fname);
        log(`✓ 已下载 ${(size / 1024 / 1024).toFixed(2)}MB：${fname}`);
      }
    } catch (e) {
      fail.push(`${id}: ${e.message}`); log(`✗ 失败 ${id} — ${e.message}`);
    }
    job.done++;
    await sleep(2000);
  }
  log(`===== 汇总：成功 ${ok.length} | 无免费版 ${noPmc.length} | 失败 ${fail.length} =====`);
  job.running = false;
}

// ---------- 网页界面 ----------
const PAGE = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>PMC 全文批量下载器</title>
<style>
*{box-sizing:border-box} body{font-family:"Microsoft YaHei",system-ui,sans-serif;max-width:780px;margin:24px auto;padding:0 16px;color:#1a1a1a;background:#f7f8fa}
h1{font-size:20px} .card{background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:18px;margin-bottom:14px}
label{display:block;font-weight:600;font-size:14px;margin:10px 0 6px}
textarea,input[type=text]{width:100%;border:1px solid #ccd2d9;border-radius:8px;padding:10px;font-size:14px;font-family:inherit}
textarea{height:140px;resize:vertical} .row{display:flex;gap:10px;align-items:flex-end}
button{background:#2f6fed;color:#fff;border:none;border-radius:8px;padding:11px 26px;font-size:15px;cursor:pointer}
button.gray{background:#8a919c} button:disabled{background:#b9c2cf;cursor:not-allowed}
#log{background:#0f1520;color:#cde3d2;font-family:Consolas,monospace;font-size:13px;border-radius:8px;padding:12px;height:300px;overflow-y:auto;white-space:pre-wrap}
.hint{font-size:12.5px;color:#68707a;margin-top:6px;line-height:1.6}
.bar{height:8px;background:#e6e9ee;border-radius:4px;overflow:hidden;margin:10px 0}
.bar>div{height:100%;background:#2f6fed;width:0;transition:width .4s}
.ok{color:#1a7f37}.bad{color:#c62828}
.opt{font-weight:400;display:flex;align-items:center;gap:6px;margin-top:8px;font-size:13.5px}
.opt input{margin:0}
</style></head><body>
<h1>📚 PMC 全文批量下载器</h1>
<div class="card">
  <label>文献列表（每行一个 PMID / PMCID / DOI，或直接粘贴 Zotero 复制的参考文献表，自动识别其中的 DOI）</label>
  <textarea id="ids" placeholder="可整段粘贴参考文献表，例如：&#10;Austin, Peter C., et al. "Graphical Calibration Curves..." Diagnostic and Prognostic Research 6, no. 1 (2022): 2. https://doi.org/10.1186/s41512-021-00114-6.&#10;&#10;也支持每行一个编号：&#10;42670262&#10;PMC13527554&#10;10.1002/sim.70722"></textarea>
  <label>保存位置（PDF 都存在这个文件夹；可从下拉选择上次用过的路径）</label>
  <input type="text" id="outdir" list="dir-history" placeholder="例如 C:\\Users\\你\\Desktop\\文献PDF">
  <datalist id="dir-history"></datalist>
  <label class="opt"><input type="checkbox" id="force"> 强制覆盖已下载的同名文件（用于更新旧版本 PDF；不勾则自动跳过已下载）</label>
  <div class="hint">提示：从 Zotero 全选条目 → 右键"由所选条目创建参考文献表"→ 复制后直接粘贴到上面即可。<b>中断后再跑一遍会自动跳过已下载的，无需手动筛选</b>。下载完的 PDF 拖进 Zotero 对应条目。工具只能下载 PMC 上有免费版的文献，纯付费墙的仍需文献传递或邮件索要。</div>
  <div class="row" style="margin-top:14px">
    <button id="start" onclick="start()">开始下载</button>
    <button id="stop" class="gray" onclick="stop()" disabled>停止</button>
    <button class="gray" onclick="openFolder()">打开文件夹</button>
  </div>
  <div class="bar"><div id="fill"></div></div>
  <div id="prog" class="hint">待机中</div>
</div>
<div class="card"><div id="log">（日志）</div></div>
<script>
let timer=null;
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;')}
async function start(){
  const text=document.getElementById('ids').value;
  const outdir=document.getElementById('outdir').value.trim();
  const force=document.getElementById('force').checked;
  if(!text.trim()){alert('请先填入文献列表');return}
  if(!outdir){alert('请填写保存位置');return}
  document.getElementById('start').disabled=true;document.getElementById('stop').disabled=false;
  const r=await fetch('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,outdir,forceOverwrite:force})});
  if(!r.ok){alert(await r.text());document.getElementById('start').disabled=false;document.getElementById('stop').disabled=true;return}
  // 记忆当前路径到 localStorage + 后端历史
  localStorage.setItem('pmc-outdir',outdir);
  fetch('/api/history',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dir:outdir})});
  timer=setInterval(poll,1500);poll();
}
async function stop(){await fetch('/api/stop',{method:'POST'});}
function openFolder(){const d=document.getElementById('outdir').value.trim();if(d)fetch('/api/open?dir='+encodeURIComponent(d))}
async function poll(){
  const s=await(await fetch('/api/status')).json();
  const el=document.getElementById('log');
  el.innerHTML=s.log.map(l=>'<div>'+esc(l.t)+'  '+esc(l.msg).replace(/✓/g,'<span class="ok">✓</span>').replace(/✗/g,'<span class="bad">✗</span>')+'</div>').join('');
  el.scrollTop=el.scrollHeight;
  document.getElementById('fill').style.width=(s.total?s.done/s.total*100:0)+'%';
  document.getElementById('prog').textContent=s.running?('进度 '+s.done+' / '+s.total):(s.total?('完成 '+s.done+' / '+s.total):'待机中');
  if(!s.running&&s.total>0){document.getElementById('start').disabled=false;document.getElementById('stop').disabled=true;clearInterval(timer)}
}
// 加载历史路径到 datalist；优先用 localStorage 上次的，其次历史第一条，最后默认桌面
fetch('/api/history').then(r=>r.json()).then(arr=>{
  const dl=document.getElementById('dir-history');
  dl.innerHTML=arr.map(d=>'<option value="'+esc(d)+'">').join('');
  const last=localStorage.getItem('pmc-outdir');
  if(last)document.getElementById('outdir').value=last;
  else if(arr.length)document.getElementById('outdir').value=arr[0];
  else fetch('/api/defaultdir').then(r=>r.text()).then(d=>document.getElementById('outdir').value=d);
}).catch(()=>{fetch('/api/defaultdir').then(r=>r.text()).then(d=>document.getElementById('outdir').value=d);});
</script></body></html>`;

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const send = (code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
  if (req.method === 'GET' && u.pathname === '/') return send(200, PAGE, 'text/html; charset=utf-8');
  if (req.method === 'GET' && u.pathname === '/api/defaultdir') {
    const desk = path.join(os.homedir(), IS_WIN ? 'Desktop' : 'Desktop');
    const dir = path.join(fs.existsSync(desk) ? desk : os.homedir(), '文献PDF');
    return send(200, JSON.stringify(dir));
  }
  if (req.method === 'GET' && u.pathname === '/api/history') return send(200, JSON.stringify(loadHistory()));
  if (req.method === 'POST' && u.pathname === '/api/history') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      try { const { dir } = JSON.parse(body); return send(200, JSON.stringify(addHistory(dir))); }
      catch (e) { return send(400, 'Bad request'); }
    });
    return;
  }
  if (req.method === 'GET' && u.pathname === '/api/status') return send(200, JSON.stringify({ running: job.running, log: job.log, done: job.done, total: job.total }));
  if (req.method === 'POST' && u.pathname === '/api/stop') { job.stopFlag = true; return send(200, '{"ok":true}'); }
  if (req.method === 'GET' && u.pathname === '/api/open') {
    const dir = u.searchParams.get('dir') || '';
    if (isValidPath(dir) && fs.existsSync(dir)) openFolder(dir.replace(/"/g, ''));
    return send(200, '{"ok":true}');
  }
  if (req.method === 'POST' && u.pathname === '/api/start') {
    if (job.running) return send(409, '任务正在运行中，请等待完成或先停止');
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { text, ids: rawIds, outdir, forceOverwrite } = JSON.parse(body);
        const ids = Array.isArray(rawIds) ? rawIds.map(x => String(x).trim()).filter(Boolean) : extractIds(String(text || ''));
        if (!ids.length) return send(400, '未识别到任何 DOI / PMCID / PMID，请检查粘贴的内容');
        if (!outdir) return send(400, '参数不完整');
        if (!isValidPath(outdir)) return send(400, '保存位置必须是本机文件夹路径，例如 C:\\Users\\你\\Desktop\\文献PDF 或 /Users/你/Desktop/文献PDF');
        fs.mkdirSync(outdir, { recursive: true });
        log(`已识别 ${ids.length} 条文献编号`);
        runJob(ids, outdir, !!forceOverwrite); // 后台跑，不阻塞响应
        send(200, '{"ok":true}');
      } catch (e) { send(400, '请求解析失败: ' + e.message); }
    });
    return;
  }
  send(404, 'Not Found');
});

// 找一个空闲端口启动，然后自动打开浏览器
function listen(port) {
  server.once('error', () => { if (port < 3741) listen(port + 1); else { console.error('端口被占用'); process.exit(1); } });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`PMC 全文批量下载器已启动：${url}`);
    console.log('保持本窗口开启即可使用；关闭窗口即退出。');
    if (process.env.PMC_NO_BROWSER !== '1') openUrl(url);
  });
}
listen(3737);
