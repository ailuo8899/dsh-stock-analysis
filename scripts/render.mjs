#!/usr/bin/env node
/**
 * render.mjs — K线图 SVG + 完整 HTML 报告 + 对话内嵌摘要（无依赖）
 *
 * 用法：
 *   node render.mjs <data.json> <result.json> [--out report.html] [--svg chart.svg] [--summary]
 *   node fetch.mjs 600519 --days 120 --out d.json
 *   node analyze.mjs d.json --shares 100 --cost 1300 --out a.json
 *   node render.mjs d.json a.json --out report.html --summary
 *
 * 输出：
 *   report.html       完整分析报告（深色科技风，含盈亏计算器）
 *   chart.svg         K线图（可单独保存）
 *   --summary         stdout 输出 markdown 摘要（含内嵌 SVG data URI，供对话直接使用）
 */

const fs = await import("node:fs");

// ---------- 小工具 ----------
const fmt = (v, d = 2) => v === null || v === undefined || isNaN(v) ? "-" : Number(v).toFixed(d);
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const emaArr = (vals, n) => {
  const out = []; let prev = null;
  const k = 2 / (n + 1);
  for (const v of vals) { prev = prev === null ? v : v * k + prev * (1 - k); out.push(prev); }
  return out;
};
const smaArr = (vals, n) => {
  const out = []; let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= n) sum -= vals[i - n];
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
};

// ---------- SVG K线图 ----------
function renderChartSVG(data, signals) {
  const kline = data.kline;
  const n = kline.length;
  const W = 940, H = 560;
  const left = 64, right = 16, top = 14, bottom = 30;
  const mainTop = top, mainH = 372;
  const volTop = mainTop + mainH + 14, volH = 96;
  const plotW = W - left - right;
  const step = plotW / Math.max(n - 1, 1);

  const highs = kline.map(k => k.high), lows = kline.map(k => k.low);
  const closes = kline.map(k => k.close), opens = kline.map(k => k.open);
  const vols = kline.map(k => k.volume);
  let maxP = Math.max(...highs), minP = Math.min(...lows);
  const pad = (maxP - minP) * 0.04 || 1;
  maxP += pad; minP -= pad;
  const maxV = Math.max(...vols, 1);

  const x = i => left + i * step + step / 2;
  const y = p => mainTop + (maxP - p) / (maxP - minP) * mainH;
  const vy = v => volTop + volH - (v / maxV) * volH;

  const ma5 = smaArr(closes, 5), ma10 = smaArr(closes, 10), ma20 = smaArr(closes, 20), ma60 = smaArr(closes, 60);
  const maLine = (arr, color) => {
    const pts = [];
    for (let i = 0; i < n; i++) if (arr[i] !== null) pts.push(x(i).toFixed(1) + "," + y(arr[i]).toFixed(1));
    return pts.length > 1 ? '<polyline fill="none" stroke="' + color + '" stroke-width="1.4" points="' + pts.join(" ") + '"/>' : "";
  };

  let grid = "", labels = "";
  const gridN = 5;
  for (let g = 0; g <= gridN; g++) {
    const p = maxP - (maxP - minP) * g / gridN;
    const gy = y(p).toFixed(1);
    grid += '<line x1="' + left + '" y1="' + gy + '" x2="' + (W - right) + '" y2="' + gy + '" stroke="#2a3350" stroke-width="0.6"/>';
    labels += '<text x="' + (left - 8) + '" y="' + (parseFloat(gy) + 4) + '" text-anchor="end" font-size="11" fill="#8a93b2">' + fmt(p, 2) + "</text>";
  }
  const idxs = [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor(3 * n / 4), n - 1];
  for (const i of idxs) {
    labels += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11" fill="#8a93b2">' + kline[i].date.slice(5) + "</text>";
  }
  for (let g = 0; g <= 2; g++) {
    const gv = volTop + volH * g / 2;
    grid += '<line x1="' + left + '" y1="' + gv.toFixed(1) + '" x2="' + (W - right) + '" y2="' + gv.toFixed(1) + '" stroke="#2a3350" stroke-width="0.6"/>';
  }

  let candles = "";
  const cw = Math.max(1.5, step * 0.62);
  for (let i = 0; i < n; i++) {
    const up = closes[i] >= opens[i];
    const color = up ? "#f0483e" : "#2ebd85";
    const cx = x(i).toFixed(1);
    const yTop = y(Math.max(opens[i], closes[i])).toFixed(1);
    const yBot = y(Math.min(opens[i], closes[i])).toFixed(1);
    const yHi = y(highs[i]).toFixed(1);
    const yLo = y(lows[i]).toFixed(1);
    const bodyH = Math.max(1, parseFloat(yBot) - parseFloat(yTop));
    candles += '<line x1="' + cx + '" y1="' + yHi + '" x2="' + cx + '" y2="' + yLo + '" stroke="' + color + '" stroke-width="1"/>';
    candles += '<rect x="' + (parseFloat(cx) - cw / 2).toFixed(1) + '" y="' + yTop + '" width="' + cw.toFixed(1) + '" height="' + bodyH.toFixed(1) + '" fill="' + color + '"/>';
    const vx = x(i).toFixed(1);
    const vY1 = vy(vols[i]).toFixed(1);
    candles += '<rect x="' + (parseFloat(vx) - cw / 2).toFixed(1) + '" y="' + vY1 + '" width="' + cw.toFixed(1) + '" height="' + (volTop + volH - parseFloat(vY1)).toFixed(1) + '" fill="' + color + '" opacity="0.55"/>';
  }

  let levelLines = "";
  if (signals && signals.levels) {
    for (const s of signals.levels.supports) {
      const ly = y(s.price).toFixed(1);
      levelLines += '<line x1="' + left + '" y1="' + ly + '" x2="' + (W - right) + '" y2="' + ly + '" stroke="#2ebd85" stroke-width="1" stroke-dasharray="5 4" opacity="0.75"/>';
      levelLines += '<text x="' + (W - right - 4) + '" y="' + (parseFloat(ly) - 4) + '" text-anchor="end" font-size="10" fill="#2ebd85">支 ' + fmt(s.price) + "</text>";
    }
    for (const r of signals.levels.resistances) {
      const ly = y(r.price).toFixed(1);
      levelLines += '<line x1="' + left + '" y1="' + ly + '" x2="' + (W - right) + '" y2="' + ly + '" stroke="#f0483e" stroke-width="1" stroke-dasharray="5 4" opacity="0.75"/>';
      levelLines += '<text x="' + (W - right - 4) + '" y="' + (parseFloat(ly) - 4) + '" text-anchor="end" font-size="10" fill="#f0483e">压 ' + fmt(r.price) + "</text>";
    }
  }

  let crossMarks = "";
  try {
    const e12 = emaArr(closes, 12), e26 = emaArr(closes, 26);
    const dif = closes.map((v, i) => e12[i] - e26[i]);
    const dea = emaArr(dif, 9);
    const start = Math.max(1, n - 15);
    for (let i = start; i < n; i++) {
      const golden = dif[i] > dea[i] && dif[i - 1] <= dea[i - 1];
      const dead = dif[i] < dea[i] && dif[i - 1] >= dea[i - 1];
      if (golden || dead) {
        const bx = x(i), by = y(lows[i]) + 8;
        const label = golden ? "B" : "S";
        const color = golden ? "#f0483e" : "#2ebd85";
        crossMarks += '<text x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" text-anchor="middle" font-size="13" font-weight="bold" fill="' + color + '" opacity="0.9">' + label + "</text>";
      }
    }
  } catch (e) { /* 忽略标注失败 */ }

  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + " " + H + '" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,PingFang SC,Hiragino Sans GB,Microsoft YaHei,sans-serif">' +
    '<rect width="' + W + '" height="' + H + '" fill="#0f1424"/>' +
    grid + labels + candles +
    maLine(ma5, "#f5b942") + maLine(ma10, "#3b82f6") + maLine(ma20, "#a855f7") + maLine(ma60, "#f97316") +
    levelLines + crossMarks +
    '<rect x="' + left + '" y="' + volTop + '" width="' + plotW + '" height="' + volH + '" fill="none" stroke="#232c47" stroke-width="0.6"/>' +
    '<rect x="' + left + '" y="' + mainTop + '" width="' + plotW + '" height="' + mainH + '" fill="none" stroke="#232c47" stroke-width="0.6"/>' +
    '<g font-size="11">' +
    '<text x="' + (left + 6) + '" y="' + (mainTop + 16) + '" fill="#f5b942">MA5</text>' +
    '<text x="' + (left + 44) + '" y="' + (mainTop + 16) + '" fill="#3b82f6">MA10</text>' +
    '<text x="' + (left + 90) + '" y="' + (mainTop + 16) + '" fill="#a855f7">MA20</text>' +
    '<text x="' + (left + 136) + '" y="' + (mainTop + 16) + '" fill="#f97316">MA60</text>' +
    "</g></svg>";
}

// ---------- HTML 报告 ----------
function renderHTML(data, result, svg) {
  const q = data.quote, m = data.meta;
  const s = result.signals, se = result.sentiment, lv = result.levels, ind = result.indicators;
  const up = q.pct >= 0;
  const pctCls = up ? "up" : "down";
  const pctSign = q.pct > 0 ? "+" : "";
  const verdictCls = { "买入": "buy", "关注": "watch", "观望": "neutral", "谨慎": "caution", "回避": "sell" }[s.verdict] || "neutral";

  const factorItems = s.factors.map(f => {
    const icon = f.dir === "多" ? "▲" : f.dir === "空" ? "▼" : "◆";
    const cls = f.dir === "多" ? "f-bull" : f.dir === "空" ? "f-bear" : "f-neu";
    const sc = f.score > 0 ? "+" + f.score : fmt(f.score, 0);
    return '<div class="factor ' + cls + '"><span class="f-icon">' + icon + '</span><div><div class="f-name">' + esc(f.name) + ' <span class="f-score">' + sc + '</span></div><div class="f-desc">' + esc(f.desc) + '</div></div></div>';
  }).join("");

  const newsItems = (se.news || []).map(n => {
    const nc = n.senti.label === "利好" ? "up" : n.senti.label === "利空" ? "down" : "neu";
    const tag = n.kind === "related" ? "相关" : "大盘";
    const link = n.url ? '<a class="n-link" href="' + esc(n.url) + '" target="_blank" rel="noopener">原文 ↗</a>' : "";
    return '<div class="news-item"><div class="n-head"><span class="n-tag tag-' + nc + '">' + esc(n.senti.label) + '</span><span class="n-kind">' + tag + '</span><span class="n-time">' + esc(n.time) + '</span></div><div class="n-title">' + esc(n.title) + '</div><div class="n-sum">' + esc(n.summary.slice(0, 120)) + (n.summary.length > 120 ? "…" : "") + '</div>' + link + '</div>';
  }).join("") || '<div class="empty">暂无相关新闻（可在交易时段后重试）</div>';

  const suppItems = (lv.supports || []).map(x => '<div class="lv-item lv-s"><span class="lv-price">' + fmt(x.price) + '</span><span class="lv-why">' + esc(x.why) + '</span></div>').join("");
  const resItems = (lv.resistances || []).map(x => '<div class="lv-item lv-r"><span class="lv-price">' + fmt(x.price) + '</span><span class="lv-why">' + esc(x.why) + '</span></div>').join("");

  const pos = result.position;
  const posAn = result.positionAnalysis || null;
  const scoreBarPos = Math.max(0, Math.min(100, (s.score + 100) / 2));

  // 未来增长（基本面）
  const gr = result.growth || null;
  const grLabelCls = gr ? (gr.score >= 20 ? "up" : gr.score <= -20 ? "down" : "neu") : "neu";
  const growthItems = (gr && gr.factors || []).map(f => {
    const icon = f.dir === "多" ? "▲" : f.dir === "空" ? "▼" : "◆";
    const cls = f.dir === "多" ? "f-bull" : f.dir === "空" ? "f-bear" : "f-neu";
    const sc = f.score > 0 ? "+" + f.score : fmt(f.score, 0);
    return '<div class="factor ' + cls + '"><span class="f-icon">' + icon + '</span><div><div class="f-name">' + esc(f.name) + ' <span class="f-score">' + sc + '</span></div><div class="f-desc">' + esc(f.desc) + '</div></div></div>';
  }).join("");
  const fundRows = (gr && gr.fundamentals || []).map(x => {
    const revCls = x.revenueYoy >= 0 ? "up" : "down";
    const npCls = x.netProfitYoy >= 0 ? "up" : "down";
    return '<tr><td>' + esc(x.reportName) + '</td><td class="' + revCls + '">' + (x.revenueYoy === null || x.revenueYoy === undefined ? "-" : fmt(x.revenueYoy, 1) + "%") + '</td><td class="' + npCls + '">' + (x.netProfitYoy === null || x.netProfitYoy === undefined ? "-" : fmt(x.netProfitYoy, 1) + "%") + '</td><td>' + fmt(x.roe, 1) + '</td><td>' + fmt(x.grossMargin, 1) + '%</td><td>' + fmt(x.eps) + '</td></tr>';
  }).join("");
  const v = (gr && gr.valuation) || {};
  const valItems = [
    ["动态 PE", fmt(v.peDynamic, 1) + (v.peDynamic ? "" : "")],
    ["TTM PE", fmt(v.peTtm, 1)],
    ["市净率 PB", fmt(v.pb, 2)],
    ["总市值", v.totalMv ? (v.totalMv >= 1e12 ? fmt(v.totalMv / 1e12, 2) + " 万亿" : fmt(v.totalMv / 1e8, 0) + " 亿") : "-"],
  ].map(([k, val]) => '<div class="card"><div class="k">' + k + '</div><div class="v">' + val + '</div></div>').join("");

  const indicatorRows = [
    ["MA5 / MA10", fmt(ind.ma5) + " / " + fmt(ind.ma10)],
    ["MA20 / MA60", fmt(ind.ma20) + " / " + fmt(ind.ma60)],
    ["MACD (DIF/DEA/柱)", fmt(ind.macd.dif) + " / " + fmt(ind.macd.dea) + " / " + fmt(ind.macd.hist)],
    ["RSI6 / RSI14", fmt(ind.rsi6, 1) + " / " + fmt(ind.rsi14, 1)],
    ["KDJ (K/D/J)", fmt(ind.kdj.k, 1) + " / " + fmt(ind.kdj.d, 1) + " / " + fmt(ind.kdj.j, 1)],
    ["BOLL 上/中/下", fmt(ind.boll.upper) + " / " + fmt(ind.boll.mid) + " / " + fmt(ind.boll.lower)],
    ["5日均量 / 10日均量", fmt(ind.volMa5, 0) + " / " + fmt(ind.volMa10, 0)],
  ].map(([k, v]) => "<tr><td>" + k + "</td><td>" + v + "</td></tr>").join("");

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(m.name)} ${m.code} · 股票分析报告</title>
<style>
:root{--bg:#0b0f1d;--panel:#121829;--panel2:#0e1424;--line:#232c47;--txt:#e6eaf5;--dim:#8a93b2;--up:#f0483e;--down:#2ebd85;--gold:#f5b942;--blue:#3b82f6;}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;padding:24px;line-height:1.55}
.wrap{max-width:1080px;margin:0 auto}
.head{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.head h1{font-size:26px;letter-spacing:.5px}
.head .sub{color:var(--dim);font-size:14px;margin-top:4px}
.price-big{font-size:38px;font-weight:700;margin-left:auto;text-align:right}
.price-big .pct{font-size:18px;margin-left:8px}
.up{color:var(--up)} .down{color:var(--down)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:18px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.card .k{color:var(--dim);font-size:12px;margin-bottom:4px}
.card .v{font-size:17px;font-weight:600}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:18px}
.panel h2{font-size:15px;color:var(--dim);font-weight:600;margin-bottom:14px;letter-spacing:1px}
.chart{width:100%;height:auto;display:block;background:#0f1424;border-radius:10px}
.vgrid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
@media(max-width:860px){.vgrid{grid-template-columns:1fr}}
.verdict{display:flex;align-items:center;gap:16px;margin-bottom:16px}
.vbadge{font-size:20px;font-weight:700;padding:8px 20px;border-radius:10px}
.vbadge.buy{background:rgba(240,72,62,.16);color:var(--up);border:1px solid rgba(240,72,62,.4)}
.vbadge.watch{background:rgba(245,185,66,.14);color:var(--gold);border:1px solid rgba(245,185,66,.4)}
.vbadge.neutral{background:rgba(138,147,178,.14);color:var(--dim);border:1px solid rgba(138,147,178,.4)}
.vbadge.caution{background:rgba(59,130,246,.14);color:var(--blue);border:1px solid rgba(59,130,246,.4)}
.vbadge.sell{background:rgba(46,189,133,.16);color:var(--down);border:1px solid rgba(46,189,133,.4)}
.scorebar{flex:1;height:10px;background:linear-gradient(90deg,var(--down),#6b7280 50%,var(--up));border-radius:6px;position:relative}
.scorebar .pin{position:absolute;top:-4px;width:4px;height:18px;background:#fff;border-radius:2px;transform:translateX(-2px)}
.vsum{color:var(--dim);font-size:14px}
.factors{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media(max-width:860px){.factors{grid-template-columns:1fr}}
.factor{display:flex;gap:10px;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--panel2)}
.f-icon{font-size:14px;width:18px;text-align:center;flex:none}
.f-bull .f-icon{color:var(--up)} .f-bear .f-icon{color:var(--down)} .f-neu .f-icon{color:var(--dim)}
.f-name{font-size:13px;font-weight:600}
.f-score{color:var(--dim);font-weight:400;margin-left:6px}
.f-desc{color:var(--dim);font-size:12px;margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:13px}
td{padding:8px 10px;border-bottom:1px solid var(--line)}
td:last-child{text-align:right;font-weight:600}
tr:last-child td{border-bottom:none}
.news-item{padding:12px 0;border-bottom:1px solid var(--line)}
.news-item:last-child{border-bottom:none}
.n-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.n-tag{font-size:11px;padding:1px 8px;border-radius:4px;font-weight:600}
.tag-up{background:rgba(240,72,62,.15);color:var(--up)} .tag-down{background:rgba(46,189,133,.15);color:var(--down)} .tag-neu{background:rgba(138,147,178,.15);color:var(--dim)}
.n-kind{font-size:11px;color:var(--dim);border:1px solid var(--line);padding:1px 6px;border-radius:4px}
.n-time{font-size:11px;color:var(--dim);margin-left:auto}
.n-title{font-size:14px;font-weight:600}
.n-sum{font-size:12px;color:var(--dim);margin-top:4px}
.n-link{font-size:12px;color:var(--blue);text-decoration:none;margin-top:6px;display:inline-block}
.empty{color:var(--dim);font-size:13px;text-align:center;padding:20px}
.lvgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.lv-item{display:flex;justify-content:space-between;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--panel2)}
.lv-s{border-left:3px solid var(--down)} .lv-r{border-left:3px solid var(--up)}
.lv-price{font-weight:700;font-size:15px}
.lv-why{color:var(--dim);font-size:12px;align-self:center}
.calc{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.calc input{background:var(--panel2);border:1px solid var(--line);border-radius:8px;color:var(--txt);padding:10px 12px;font-size:15px;width:160px;outline:none}
.calc input:focus{border-color:var(--blue)}
.calc button{background:var(--blue);border:none;color:#fff;border-radius:8px;padding:10px 22px;font-size:15px;font-weight:600;cursor:pointer}
.calc button:hover{filter:brightness(1.15)}
.calc-res{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.calc-res .card .v.big{font-size:22px}
.pos-advice{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:12px 14px;font-size:13px;color:var(--dim);margin-top:12px}
.pos-advice b{color:var(--txt)}
.disc{color:var(--dim);font-size:12px;margin-top:24px;padding-top:14px;border-top:1px solid var(--line)}
.senti-head{display:flex;align-items:center;gap:14px;margin-bottom:12px}
.navbar{display:flex;gap:10px;align-items:center;margin-bottom:18px;flex-wrap:wrap}
.navbar a{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:9px;font-size:13px;font-weight:600;text-decoration:none;border:1px solid var(--line);background:var(--panel);color:var(--txt)}
.navbar a:hover{border-color:var(--blue);color:var(--blue)}
.navbar a.nav-primary{background:var(--blue);border-color:var(--blue);color:#fff}
.navbar a.nav-primary:hover{filter:brightness(1.15)}
.navbar .nav-spacer{flex:1}
.navbar .nav-note{color:var(--dim);font-size:12px}
.senti-score{font-size:30px;font-weight:700}
.senti-label{font-size:14px;padding:3px 12px;border-radius:6px}
</style>
</head>
<body><div class="wrap">
  <nav class="navbar">
    <a href="screen-board.html" target="_blank" class="nav-primary">📊 今日推荐榜</a>
    <a href="#" onclick="window.open(location.href,'_blank');return false">↗ 新窗口打开</a>
    <span class="nav-spacer"></span>
    <span class="nav-note">单股分析报告</span>
  </nav>
  <div class="head">
    <div>
      <h1>${esc(m.name)} <span style="color:var(--dim);font-size:20px">${m.code}</span></h1>
      <div class="sub">${esc(m.market)} · 数据时间 ${esc(q.ts ? new Date(q.ts).toLocaleString("zh-CN", {hour12:false}) : "—")} · 共 ${data.kline.length} 个交易日</div>
    </div>
    <div class="price-big">
      <span>${fmt(q.price)}</span>
      <span class="pct ${pctCls}">${pctSign}${fmt(q.pct,2)}%</span>
    </div>
  </div>

  <div class="cards">
    <div class="card"><div class="k">今开</div><div class="v">${fmt(q.open)}</div></div>
    <div class="card"><div class="k">最高 / 最低</div><div class="v">${fmt(q.high)} / ${fmt(q.low)}</div></div>
    <div class="card"><div class="k">昨收</div><div class="v">${fmt(q.prevClose)}</div></div>
    <div class="card"><div class="k">涨跌额</div><div class="v ${pctCls}">${q.change > 0 ? "+" : ""}${fmt(q.change)}</div></div>
    <div class="card"><div class="k">成交量</div><div class="v">${fmt(q.volume / 10000, 2)} 万手</div></div>
    <div class="card"><div class="k">成交额</div><div class="v">${fmt(q.amount / 1e8, 2)} 亿</div></div>
    <div class="card"><div class="k">换手率</div><div class="v">${fmt(q.turnover, 2)}%</div></div>
    <div class="card"><div class="k">振幅</div><div class="v">${fmt(q.amplitude, 2)}%</div></div>
  </div>

  <div class="panel"><h2>K 线走势（前复权 · 红涨绿跌 · B/S 为 MACD 金叉/死叉）</h2>
    ${svg}
  </div>

  <div class="vgrid">
    <div class="panel">
      <h2>买卖时机信号</h2>
      <div class="verdict">
        <span class="vbadge ${verdictCls}">${s.verdict}</span>
        <div style="flex:1">
          <div class="scorebar"><div class="pin" style="left:${scoreBarPos.toFixed(1)}%"></div></div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--dim);margin-top:6px"><span>偏空 -100</span><span>信号分 ${s.score}</span><span>偏多 +100</span></div>
        </div>
      </div>
      <div class="vsum">${esc(s.summary)}</div>
      <div style="margin:14px 0;border-top:1px solid var(--line)"></div>
      <div class="factors">${factorItems}</div>
    </div>

    <div>
      <div class="panel"><h2>技术指标</h2>
        <table>${indicatorRows}</table>
      </div>
      <div class="panel"><h2>支撑 / 压力位</h2>
        <div class="lvgrid">
          <div><div style="color:var(--down);font-size:12px;margin-bottom:8px;font-weight:600">▼ 支撑位</div>${suppItems}</div>
          <div><div style="color:var(--up);font-size:12px;margin-bottom:8px;font-weight:600">▲ 压力位</div>${resItems}</div>
        </div>
      </div>
    </div>
  </div>

      <div class="panel"><h2>位置研判（双向）</h2>
        <div class="senti-head">
          <span class="zone-badge ${posAn ? (posAn.zone === '高位区' ? 'z-high' : posAn.zone === '低位区' ? 'z-low' : posAn.zone === '中低位' ? 'z-midlow' : posAn.zone === '中高位' ? 'z-midhigh' : 'z-mid') : ''}">${posAn ? esc(posAn.zone) : '-'}</span>
          <span class="senti-label" style="color:var(--txt)">${posAn ? esc(posAn.bias) : '暂无'}</span>
          <span style="color:var(--dim);font-size:12px">买${posAn ? posAn.buyScore : '-'} / 卖${posAn ? posAn.sellScore : '-'}</span>
        </div>
        <div class="vsum">${posAn ? (posAn.sellScore >= 55 ? '⚠ 高位卖出信号强，持仓者可考虑止盈/减仓。' : posAn.buyScore >= 55 ? '✅ 低位买入信号强，可关注低吸机会。' : '位置中性，等待方向明确。') : '暂无位置数据'}</div>
        ${posAn && posAn.sellNotes.length ? '<div style="margin:10px 0;border-top:1px solid var(--line)"></div><div style="font-size:12px;color:var(--dim)">' + posAn.sellNotes.map(n => '<div>⚠ ' + esc(n) + '</div>').join('') + '</div>' : ''}
        ${posAn && posAn.buyNotes.length ? '<div style="margin:10px 0;border-top:1px solid var(--line)"></div><div style="font-size:12px;color:var(--dim)">' + posAn.buyNotes.map(n => '<div>✅ ' + esc(n) + '</div>').join('') + '</div>' : ''}
      </div>
  <div class="vgrid">
    <div class="panel">
      <h2>市场情绪</h2>
      <div class="senti-head">
        <span class="senti-score ${se.score >= 0 ? "up" : "down"}">${se.score >= 0 ? "+" : ""}${fmt(se.score,2)}</span>
        <span class="senti-label tag-${se.label === "看多" ? "up" : se.label === "看空" ? "down" : "neu"}">${se.label}</span>
        <span style="color:var(--dim);font-size:12px">范围 -1.0 ~ +1.0（新闻 + 当日走势）</span>
      </div>
      <div class="vsum">${esc(se.summary)}</div>
      <div style="margin:14px 0;border-top:1px solid var(--line)"></div>
      ${newsItems}
    </div>

    <div class="panel">
      <h2>持仓盈亏计算</h2>
      <div class="calc">
        <input id="shares" type="number" placeholder="持股数量（股）" min="0"/>
        <input id="cost" type="number" placeholder="买入成本价（元）" min="0" step="0.01"/>
        <button onclick="calcPos()">计算盈亏</button>
      </div>
      <div class="calc-res" id="calcRes">
        <div class="card"><div class="k">当前市值</div><div class="v" id="rValue">—</div></div>
        <div class="card"><div class="k">浮动盈亏</div><div class="v big" id="rPl">—</div></div>
        <div class="card"><div class="k">盈亏比例</div><div class="v big" id="rPct">—</div></div>
        <div class="card"><div class="k">参考止损位</div><div class="v" id="rStop">${pos ? fmt(pos.stopLoss) : "—"}</div></div>
        <div class="card"><div class="k">参考止盈位</div><div class="v" id="rTake">${pos ? fmt(pos.takeProfit) : "—"}</div></div>
      </div>
      <div class="pos-advice" id="rAdvice">${pos ? esc(pos.advice) : "输入持股数量与成本价，即可计算当前浮盈浮亏、参考止损/止盈位。"}</div>
      <script>
      const _PRICE = ${q.price}, _STOP = ${pos ? pos.stopLoss : 0}, _TAKE = ${pos ? pos.takeProfit : 0};
      const _SUPP = ${JSON.stringify((lv.supports || []).map(x => x.price))};
      const _RESI = ${JSON.stringify((lv.resistances || []).map(x => x.price))};
      function calcPos() {
        const sh = parseFloat(document.getElementById("shares").value) || 0;
        const co = parseFloat(document.getElementById("cost").value) || 0;
        const val = _PRICE * sh;
        const pl = (_PRICE - co) * sh;
        const pct = co ? (_PRICE - co) / co * 100 : 0;
        const stop = (_SUPP.length ? _SUPP[0] : _PRICE * 0.93);
        const take = (_RESI.length ? _RESI[_RESI.length - 1] : _PRICE * 1.08);
        const upFlag = pl >= 0;
        document.getElementById("rValue").textContent = val.toFixed(2) + " 元";
        const plEl = document.getElementById("rPl");
        plEl.textContent = (pl >= 0 ? "+" : "") + pl.toFixed(2) + " 元";
        plEl.className = "v big " + (upFlag ? "up" : "down");
        const pctEl = document.getElementById("rPct");
        pctEl.textContent = (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%";
        pctEl.className = "v big " + (upFlag ? "up" : "down");
        document.getElementById("rStop").textContent = stop.toFixed(2);
        document.getElementById("rTake").textContent = take.toFixed(2);
        let adv = "当前价 " + _PRICE.toFixed(2) + " 元，";
        if (sh > 0 && co > 0) {
          adv += "持仓 " + sh + " 股 × 成本 " + co.toFixed(2) + "，浮盈 " + (pl >= 0 ? "+" : "") + pl.toFixed(2) + " 元（" + (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%）。";
          adv += "建议：跌破支撑 " + stop.toFixed(2) + " 考虑止损，突破压力 " + take.toFixed(2) + " 考虑止盈或减仓。";
        } else {
          adv += "输入持仓后给出具体建议。";
        }
        document.getElementById("rAdvice").innerHTML = "<b>操作参考：</b>" + adv;
      }
      </script>
    </div>
  </div>

  <div class="panel">
    <h2>📈 未来增长（基本面）</h2>
    <div class="senti-head">
      <span class="senti-score ${grLabelCls}">${gr ? gr.score : "-"}</span>
      <span class="senti-label tag-${grLabelCls}">${gr ? esc(gr.label) : "暂无"}</span>
      <span style="color:var(--dim);font-size:12px">基于最新财报（净利/营收增速、ROE、毛利率、PEG）</span>
    </div>
    <div class="vsum">${gr ? esc(gr.summary) : "基本面数据暂不可用"}</div>
    <div style="margin:14px 0;border-top:1px solid var(--line)"></div>
    <div class="factors">${growthItems}</div>
    <div style="margin:14px 0;border-top:1px solid var(--line)"></div>
    <div style="font-size:12px;color:var(--dim);margin-bottom:8px">近四期财务（营收同比 / 净利同比 / ROE / 毛利率 / EPS）</div>
    <table>
      <tr><th>报告期</th><th>营收同比</th><th>净利同比</th><th>ROE</th><th>毛利率</th><th>EPS</th></tr>
      ${fundRows || '<tr><td colspan="6" style="color:var(--dim)">暂无财务数据</td></tr>'}
    </table>
    <div style="margin:14px 0;border-top:1px solid var(--line)"></div>
    <div class="cards" style="margin-bottom:0">${valItems}</div>
  </div>

  <div class="disc">⚠️ 免责声明：本报告由公开行情数据自动生成，仅供参考，不构成任何投资建议。股市有风险，入市需谨慎。</div>
</div></body></html>`;
  return html;
}

// ---------- markdown 摘要（对话用） ----------
function renderSummary(data, result, svg) {
  const q = data.quote, m = data.meta, s = result.signals, se = result.sentiment;
  const pctSign = q.pct > 0 ? "+" : "";
  const b64 = Buffer.from(svg).toString("base64");
  const pos = result.position;
  const posLine = pos
    ? "\n- **持仓盈亏**：持有 " + pos.shares + " 股 × 成本 " + fmt(pos.cost) + "，现价 " + fmt(q.price) +
      "，浮盈 **" + (pos.pl >= 0 ? "+" : "") + fmt(pos.pl) + " 元（" + (pos.plPct >= 0 ? "+" : "") + fmt(pos.plPct, 2) + "%）**。参考止损 " + fmt(pos.stopLoss) + "，参考止盈 " + fmt(pos.takeProfit) + "。"
    : "";
  const relNews = (se.news || []).filter(n => n.kind === "related").slice(0, 3)
    .map(n => "[" + n.senti.label + "] " + n.title).join("；") || "暂无直接相关新闻";
  // 当日涨幅过大 → 追高风险提示（与 screen.mjs 动量惩罚口径一致）
  const pct = q.pct;
  let chaseRiskLine = null;
  if (pct >= 19.5) chaseRiskLine = "当日涨停（+" + fmt(pct, 1) + "%），追高风险极大";
  else if (pct >= 9.8) chaseRiskLine = "当日接近涨停（+" + fmt(pct, 1) + "%），追高风险极大";
  else if (pct >= 7) chaseRiskLine = "当日大涨 +" + fmt(pct, 1) + "%，短线追高风险";
  else if (pct >= 5) chaseRiskLine = "当日上涨 +" + fmt(pct, 1) + "%，追高需谨慎";
  return [
    "### 📈 " + m.name + "（" + m.code + "）股票分析",
    "",
    "**现价 " + fmt(q.price) + " 元**（" + (q.pct >= 0 ? "🟢" : "🔴") + " " + pctSign + fmt(q.pct, 2) + "%），今开 " + fmt(q.open) + "，最高 " + fmt(q.high) + "，最低 " + fmt(q.low) + "，成交 " + fmt(q.volume / 10000, 2) + " 万手 / " + fmt(q.amount / 1e8, 2) + " 亿。",
    "",
    "![K线图](data:image/svg+xml;base64," + b64 + ")",
    "",
    "#### 买卖时机：" + s.verdict + "（信号分 " + s.score + "/100）" + (chaseRiskLine ? " ⚠ " + chaseRiskLine : ""),
    "",
    s.summary,
    "",
    "关键因子：" + s.factors.map(f => (f.dir === "多" ? "✅" : f.dir === "空" ? "⚠️" : "➖") + f.name + "(" + (f.score > 0 ? "+" : "") + f.score + ")").join("、"),
    "",
    "**支撑位**：" + (result.levels.supports || []).map(x => fmt(x.price) + "(" + x.why + ")").join("、"),
    "**压力位**：" + (result.levels.resistances || []).map(x => fmt(x.price) + "(" + x.why + ")").join("、"),
    "",
    "#### 📍 位置研判：" + (result.positionAnalysis ? result.positionAnalysis.zone + " · " + result.positionAnalysis.bias + "（买" + result.positionAnalysis.buyScore + "/卖" + result.positionAnalysis.sellScore + "）" : "暂无"),
    "",
    "#### 🧠 市场情绪：" + se.label + "（" + (se.score >= 0 ? "+" : "") + fmt(se.score, 2) + "）",
    "",
    se.summary,
    "",
    "相关新闻：" + relNews,
    "",
    "#### 📈 未来增长：" + (result.growth ? result.growth.label + "（" + result.growth.score + "/100）" : "暂无数据"),
    "",
    result.growth ? result.growth.summary : "",
    posLine,
    "",
    "> 详细报告（完整 K 线图、技术指标表、盈亏计算器）见 HTML 文件。⚠️ 分析仅供参考，不构成投资建议。",
    "",
    "> 📅 数据时效：" + (isMarketHours() ? "**盘中数据**（约延迟数十秒，信号可能随交易变化）" : "**收盘数据**（当日最终值，信号稳定）") + "。技术指标基于历史行情，不预测未来，请结合自身风险承受能力决策。",
  ].join("\n");
}

/** 是否处于 A 股交易时段（工作日 9:30-11:30, 13:00-15:00） */
function isMarketHours() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const h = now.getHours(), m = now.getMinutes();
  const t = h * 60 + m;
  return (t >= 9 * 60 + 30 && t <= 11 * 60 + 30) || (t >= 13 * 60 && t <= 15 * 60);
}

// ---------- 主流程 ----------
export async function run(argv) {
  const args = { data: null, result: null, out: "stock-report.html", svg: null, summary: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--svg") args.svg = argv[++i];
    else if (a === "--summary") args.summary = true;
    else if (!a.startsWith("--")) {
      if (!args.data) args.data = a; else if (!args.result) args.result = a;
    }
  }
  if (!args.data || !args.result) throw new Error("用法: node render.mjs <data.json> <result.json> [--out report.html] [--svg chart.svg] [--summary]");
  const data = JSON.parse(fs.readFileSync(args.data, "utf8"));
  const result = JSON.parse(fs.readFileSync(args.result, "utf8"));
  const svg = renderChartSVG(data, result);
  if (args.svg) fs.writeFileSync(args.svg, svg);
  const html = renderHTML(data, result, svg);
  fs.writeFileSync(args.out, html);
  console.log("saved: " + args.out);
  if (args.summary) console.log("\n---SUMMARY---\n" + renderSummary(data, result, svg));
  return { html, svg, summary: renderSummary(data, result, svg) };
}

if (typeof process !== "undefined" && process.argv[1] && import.meta.url === "file://" + process.argv[1]) {
  run(process.argv.slice(2)).catch(e => { console.error("ERROR: " + e.message); process.exit(1); });
}

