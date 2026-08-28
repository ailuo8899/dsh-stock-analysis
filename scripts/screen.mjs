#!/usr/bin/env node
/**
 * screen.mjs — 多维度选股推荐（情绪 + 技术 + 低位 + 未来增长）
 *
 * 用法：
 *   node screen.mjs [--top 10] [--days 60] [--out screen.json]
 *   node screen.mjs --fs m:0+t:6,m:1+t:2 --top 15
 *
 * 股票池来源：东财行情榜（默认沪深A股涨幅榜，可按 fs 过滤行业/板块）
 * 四维评分：
 *   技术面 40%  — 复用 analyze 的信号分（均线/MACD/RSI/KDJ/量能/布林）
 *   低位  25%  — 距60日高点回撤 + 超卖/布林下轨 + 低位放量
 *   情绪  20%  — 新闻情绪分（利好/利空）
 *   增长  15%  — 净利/营收增速 + ROE + PEG
 * 输出：综合分排序的推荐列表 + 每只股票的四维明细
 */
import { run as analyzeRun } from "./analyze.mjs";
import { run as fetchRun } from "./fetch.mjs";

const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36", "Referer": "https://quote.eastmoney.com/" };

function fmt(v, d = 2) { return v === null || v === undefined || isNaN(v) ? "-" : Number(v).toFixed(d); }
function esc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

const STRATEGIES = {
  gain:      { sort: "changepercent", desc: "涨幅榜（默认，含追高惩罚）" },
  amount:    { sort: "amount",        desc: "成交额榜（大资金活跃）" },
  volume:    { sort: "volume",        desc: "成交量榜（放量关注）" },
  turnover:  { sort: "turnover",      desc: "换手率榜（短线活跃）" },
};

function parseArgs(argv) {
  const args = { top: 10, days: 60, out: null, html: null, strategy: "gain", minPrice: 0, maxPrice: 1e9 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--top") args.top = parseInt(argv[++i]);
    else if (a === "--days") args.days = parseInt(argv[++i]);
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--strategy") args.strategy = argv[++i];
    else if (a === "--html") args.html = argv[++i];
    else if (a === "--min-price") args.minPrice = parseFloat(argv[++i]);
    else if (a === "--max-price") args.maxPrice = parseFloat(argv[++i]);
  }
  if (!STRATEGIES[args.strategy]) throw new Error("未知策略: " + args.strategy + "（可选 " + Object.keys(STRATEGIES).join("/") + "）");
  return args;
}

/** 新浪行情榜：返回 [{code,name,price,pct,secid}]（node fetch 可直连，东财 clist 接口反爬不稳定） */
async function fetchRank(strategy, pz) {
  const s = STRATEGIES[strategy];
  const url = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData" +
    "?page=1&num=" + pz + "&sort=" + s.sort + "&asc=0&node=hs_a&symbol=&_s_r_a=init";
  const r = await fetch(url, { headers: { ...UA, "Referer": "https://finance.sina.com.cn/" } });
  if (!r.ok) throw new Error("行情榜请求失败 HTTP " + r.status);
  const text = await r.text();
  // 新浪返回 JSON 数组（偶有前后缀），容错解析
  const m = text.match(/\[.*\]/s);
  if (!m) throw new Error("行情榜返回格式异常");
  const rows = JSON.parse(m[0]);
  return rows.filter(x => x.code && x.name).map(x => {
    const code = String(x.code);
    // 北交所 bj / 沪 6,9,5 / 深 0,3
    let secid;
    if (code.startsWith("bj")) secid = "0." + code.slice(2); // 东财北交所按深市 secid 处理
    else if (code.startsWith("6") || code.startsWith("9") || code.startsWith("5")) secid = "1." + code;
    else secid = "0." + code;
    return {
      code: code.replace(/^(sh|sz|bj)/, ""),
      name: String(x.name),
      price: parseFloat(x.trade),
      pct: parseFloat(x.changepercent),
      secid,
    };
  });
}

/** 低位买入信号评分（独立于信号分，专注位置） */
function lowPositionScore(kline, ind) {
  const closes = kline.map(k => k.close);
  const close = closes[closes.length - 1];
  const win = kline.slice(-60);
  const hi60 = Math.max(...win.map(k => k.high));
  const lo60 = Math.min(...win.map(k => k.low));
  const dd = (close - hi60) / hi60 * 100;            // 距60日高点回撤%
  const pos = (close - lo60) / (hi60 - lo60) * 100;  // 60日区间位置 0-100
  const rsi = ind.rsi14;
  let score = 0;
  const notes = [];

  // 回撤深度
  if (dd <= -30) { score += 2.5; notes.push("距60日高点回撤 " + dd.toFixed(1) + "%，深度回调"); }
  else if (dd <= -20) { score += 2; notes.push("距60日高点回撤 " + dd.toFixed(1) + "%，超跌"); }
  else if (dd <= -10) { score += 1; notes.push("距60日高点回撤 " + dd.toFixed(1) + "%，回调较深"); }
  else if (dd > -3) { score -= 1.5; notes.push("接近60日高点（回撤仅 " + dd.toFixed(1) + "%），追高风险"); }

  // 区间位置（低位）
  if (pos <= 15) { score += 1.5; notes.push("位于60日区间低位（" + pos.toFixed(0) + "%）"); }
  else if (pos <= 30) { score += 1; notes.push("位于60日区间中低位（" + pos.toFixed(0) + "%）"); }
  else if (pos >= 85) { score -= 1; notes.push("位于60日区间高位（" + pos.toFixed(0) + "%）"); }

  // 布林下轨
  if (close <= ind.boll.lower * 1.01) { score += 1; notes.push("贴近布林下轨，均值回归机会"); }
  // 超卖
  if (rsi <= 30) { score += 1; notes.push("RSI " + rsi.toFixed(1) + " 超卖"); }
  else if (rsi >= 75) { score -= 1; notes.push("RSI " + rsi.toFixed(1) + " 超买"); }

  // 低位放量（当日涨幅>0 且量比>1.5）
  const volRatio = ind.lastVolume / (ind.volMa5 || 1);
  const lastK = kline[kline.length - 1], prevK = kline[kline.length - 2];
  if (lastK.close > prevK.close && volRatio > 1.5 && pos <= 40) {
    score += 1.5; notes.push("低位放量上涨（量比 " + volRatio.toFixed(1) + "x），资金进场");
  }

  const norm = Math.max(-100, Math.min(100, Math.round(score / 8.5 * 100)));
  const label = norm >= 35 ? "低位机会" : norm >= 12 ? "位置偏低" : norm > -12 ? "位置中性" : norm > -35 ? "位置偏高" : "高位风险";
  return { score: norm, label, notes, drawdown: Math.round(dd * 100) / 100, rangePos: Math.round(pos) };
}

/** 动量/追高风险评分：当日涨幅 + 5/10日涨幅，暴涨重罚（-100=涨停追高，+100=回调企稳） */
function momentumScore(kline, pct) {
  const closes = kline.map(k => k.close);
  const last = closes.length - 1;
  const c0 = closes[last];
  const pct5 = last >= 5 ? (c0 / closes[last - 5] - 1) * 100 : 0;
  const pct10 = last >= 10 ? (c0 / closes[last - 10] - 1) * 100 : 0;
  let score = 0;
  const notes = [];

  // 当日涨幅：涨停重罚
  const limit = pct >= 19.5; // 创业板/科创板 20cm
  if (limit || pct >= 9.8) {
    score -= 100;
    notes.push("当日" + (limit ? "涨停" : "接近涨停") + "（+" + fmt(pct, 1) + "%），追高风险极大");
  } else if (pct >= 7) { score -= 45; notes.push("当日大涨 +" + fmt(pct, 1) + "%，短线追高风险"); }
  else if (pct >= 5) { score -= 20; notes.push("当日上涨 +" + fmt(pct, 1) + "%，追高需谨慎"); }
  else if (pct >= 3) { score -= 6; notes.push("当日上涨 +" + fmt(pct, 1) + "%"); }
  else if (pct <= 0.5 && pct >= -2) { score += 12; notes.push("当日涨跌温和（" + fmt(pct, 1) + "%），非追高区"); }
  else if (pct < -2) { score += 18; notes.push("当日回调 " + fmt(pct, 1) + "%，逢低机会"); }

  // 5日涨幅
  if (pct5 >= 30) { score -= 35; notes.push("5日累计 +" + fmt(pct5, 1) + "%，短期涨幅过大"); }
  else if (pct5 >= 20) { score -= 15; notes.push("5日累计 +" + fmt(pct5, 1) + "%，短期偏热"); }
  else if (pct5 >= 10) { score -= 5; notes.push("5日累计 +" + fmt(pct5, 1) + "%"); }
  else if (pct5 <= -5) { score += 12; notes.push("5日回调 " + fmt(pct5, 1) + "%，消化获利盘"); }

  // 10日涨幅
  if (pct10 >= 50) { score -= 25; notes.push("10日累计 +" + fmt(pct10, 1) + "%，中期涨幅巨大"); }
  else if (pct10 >= 30) { score -= 10; notes.push("10日累计 +" + fmt(pct10, 1) + "%"); }
  else if (pct10 >= 15) { score -= 3; }
  else if (pct10 <= -8) { score += 10; notes.push("10日回调 " + fmt(pct10, 1) + "%，低位区间"); }

  const norm = Math.max(-100, Math.min(100, Math.round(score)));
  const label = norm <= -60 ? "严重追高" : norm <= -25 ? "追高风险" : norm < 5 ? "涨幅中性" : norm < 30 ? "回调企稳" : "低位安全";
  return { score: norm, label, notes: notes.slice(0, 4), pct5: Math.round(pct5 * 10) / 10, pct10: Math.round(pct10 * 10) / 10 };
}

/** 综合五维 → 总分 0-100（技术30% 低位20% 情绪15% 增长15% 动量20%） */
function composite(sig, low, senti, growth, momentum) {
  const t = (sig.score + 100) / 2;        // 0-100
  const l = (low.score + 100) / 2;        // 0-100
  const e = (senti.score + 1) / 2 * 100;  // 0-100
  const g = (growth.score + 100) / 2;     // 0-100
  const m = (momentum.score + 100) / 2;   // 0-100
  const total = Math.round(t * 0.30 + l * 0.20 + e * 0.15 + g * 0.15 + m * 0.20);
  return { tech: Math.round(t), low: Math.round(l), sentiment: Math.round(e), growth: Math.round(g), momentum: Math.round(m), total };
}

/** 渲染推荐榜 HTML 页面（含导航、每只股票四维详情） */
function renderBoardHTML(output) {
  const rows = (output.picks || []).map(p => {
    const pctCls = p.pct >= 0 ? "up" : "down";
    const verdictCls = { "买入": "buy", "关注": "watch", "观望": "neutral", "谨慎": "caution", "回避": "sell", "追高风险": "risk" }[p.verdict] || "neutral";
    const total = p.composite.total;
    const totalCls = total >= 70 ? "t-strong" : total >= 55 ? "t-good" : total >= 40 ? "t-mid" : "t-weak";
    const riskTag = p.momentumScore <= -25 ? '<span class="risk-flag">⚠ ' + esc(p.momentumLabel) + '</span>' : "";
    return [
      '<tr class="' + (p.momentumScore <= -25 ? "row-risk" : "") + '">',
      '<td><span class="total ' + totalCls + '">' + total + '</span></td>',
      '<td><span class="stock">' + esc(p.name) + '</span><span class="code">' + p.code + '</span>' + riskTag + '</td>',
      '<td>' + fmt(p.price) + '</td>',
      '<td class="' + pctCls + '">' + (p.pct >= 0 ? "+" : "") + fmt(p.pct, 2) + '%</td>',
      '<td><span class="badge ' + verdictCls + '">' + esc(p.verdict) + '</span></td>',
      '<td><div class="score-row"><span class="s-t">技' + p.composite.tech + '</span><span class="s-l">低' + p.composite.low + '</span><span class="s-e">情' + p.composite.sentiment + '</span><span class="s-g">增' + p.composite.growth + '</span><span class="s-m">动' + p.composite.momentum + '</span></div></td>',
      '<td><div class="reason">' + reasonFor(p) + '</div><div class="note">' + notesFor(p) + '</div></td>',
      '</tr>'
    ].join("");
  }).join("");

  const weightDesc = "技术30% + 低位20% + 情绪15% + 增长15% + 动量20%";
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>',
    '<title>今日推荐榜 · 多维度选股</title><style>',
    ':root{--bg:#0b0f1d;--panel:#121829;--panel2:#0e1424;--line:#232c47;--txt:#e6eaf5;--dim:#8a93b2;--up:#f0483e;--down:#2ebd85;--gold:#f5b942;--blue:#3b82f6;}',
    '*{box-sizing:border-box;margin:0;padding:0}',
    'body{background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;padding:26px;line-height:1.55}',
    '.wrap{max-width:1020px;margin:0 auto}',
    '.navbar{display:flex;gap:10px;align-items:center;margin-bottom:20px;flex-wrap:wrap}',
    '.navbar a{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:9px;font-size:13px;font-weight:600;text-decoration:none;border:1px solid var(--line);background:var(--panel);color:var(--txt)}',
    '.navbar a:hover{border-color:var(--blue);color:var(--blue)}',
    '.navbar a.nav-primary{background:var(--blue);border-color:var(--blue);color:#fff}',
    '.navbar a.nav-primary:hover{filter:brightness(1.15)}',
    '.navbar .nav-spacer{flex:1}',
    'h1{font-size:23px;margin-bottom:6px}',
    '.sub{color:var(--dim);font-size:13px;margin-bottom:20px}',
    'table{width:100%;border-collapse:collapse;font-size:13.5px}',
    'th{color:var(--dim);font-size:12px;font-weight:600;text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);letter-spacing:1px}',
    'td{padding:13px 12px;border-bottom:1px solid var(--line);vertical-align:top}',
    '.stock{font-weight:700;font-size:14.5px}',
    '.code{color:var(--dim);font-size:11.5px;font-weight:400;margin-left:6px}',
    '.total{font-size:19px;font-weight:700}',
    '.t-strong{color:var(--up)} .t-good{color:var(--gold)} .t-mid{color:var(--txt)} .t-weak{color:var(--dim)}',
    '.badge{display:inline-block;padding:3px 10px;border-radius:8px;font-size:11.5px;font-weight:600;white-space:nowrap}',
    '.buy{background:rgba(240,72,62,.16);color:var(--up);border:1px solid rgba(240,72,62,.4)}',
    '.watch{background:rgba(245,185,66,.14);color:var(--gold);border:1px solid rgba(245,185,66,.4)}',
    '.neutral{background:rgba(138,147,178,.14);color:var(--dim);border:1px solid rgba(138,147,178,.4)}',
    '.caution{background:rgba(59,130,246,.14);color:var(--blue);border:1px solid rgba(59,130,246,.4)}',
    '.sell{background:rgba(46,189,133,.16);color:var(--down);border:1px solid rgba(46,189,133,.4)}',
    '.risk{background:rgba(240,72,62,.22);color:#ff6b5e;border:1px solid rgba(240,72,62,.6)}',
    '.risk-flag{display:inline-block;margin-left:8px;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;color:#ff6b5e;background:rgba(240,72,62,.15);border:1px solid rgba(240,72,62,.4)}',
    '.row-risk td{background:rgba(240,72,62,.04)}',
    '.up{color:var(--up)} .down{color:var(--down)}',
    '.score-row{display:flex;gap:9px;font-size:11.5px;white-space:nowrap}',
    '.s-t{color:var(--blue)} .s-l{color:var(--down)} .s-e{color:var(--gold)} .s-g{color:var(--up)} .s-m{color:#a855f7}',
    '.reason{color:var(--txt);font-size:12.5px}',
    '.note{color:var(--dim);font-size:11px;margin-top:4px}',
    '.foot{color:var(--dim);font-size:11px;margin-top:20px}',
    '.strat{display:inline-block;padding:2px 10px;border-radius:6px;background:var(--panel2);border:1px solid var(--line);color:var(--dim);font-size:12px;margin-left:10px}',
    '</style></head><body><div class="wrap">',
    '<nav class="navbar">',
    '<a href="screen-board.html" class="nav-primary">📊 今日推荐榜</a>',
    "<a href=\"#\" onclick=\"window.open(location.href,'_blank');return false\">↗ 新窗口打开</a>",
    '<span class="nav-spacer"></span>',
    '<span class="nav-note">单股报告：运行 <b>render.mjs</b> 生成，报告顶部可跳回本页</span>',
    '</nav>',
    '<h1>📊 今日推荐榜</h1>',
    '<div class="sub">沪深A股 · 五维综合打分（' + weightDesc + '）· ' + new Date(output.generatedAt).toLocaleString("zh-CN", { hour12: false }) + '<span class="strat">策略：' + esc(output.args.strategy) + '</span></div>',
    '<table><tr><th>综合分</th><th>股票</th><th>现价</th><th>涨跌幅</th><th>建议</th><th>五维评分</th><th>推荐理由</th></tr>',
    rows,
    '</table>',
    '<div class="foot">⚠️ 数据由公开行情自动生成，仅供参考，不构成投资建议。追高风险标记（⚠）表示当日/近期涨幅过大，建议规避追高。</div>',
    '</div></body></html>'
  ].join("\n");
}

function reasonFor(p) {
  const parts = [];
  if (p.growthScore >= 60) parts.push("净利/营收高增长");
  if (p.lowScore >= 35) parts.push("低位机会");
  else if (p.lowLabel === "位置偏低" || p.lowLabel === "低位机会") parts.push("位置偏低");
  if (p.momentumScore >= 30) parts.push("回调企稳");
  if (p.momentumScore <= -25) parts.push("短期涨幅过大");
  if (p.sentimentScore >= 0.3) parts.push("消息面偏多");
  if (!parts.length) parts.push("综合中性");
  return parts.slice(0, 3).join(" · ");
}

function notesFor(p) {
  const n = [];
  if (p.momentumNotes && p.momentumNotes.length) n.push(p.momentumNotes[0]);
  if (p.lowNotes && p.lowNotes.length) n.push(p.lowNotes[0]);
  if (p.verdict === "追高风险") n.push("建议等待回调后再评估");
  return n.slice(0, 3).join("；");
}

export async function run(argv) {
  const args = parseArgs(argv);
  const fs = await import("node:fs");

  console.log("拉取行情榜（策略=" + args.strategy + " " + STRATEGIES[args.strategy].desc + "，取前 " + Math.min(args.top * 3, 50) + " 只候选）…");
  const candidates = await fetchRank(args.strategy, Math.min(args.top * 3, 50));
  // 过滤北交所（bj，东财 secid 不支持）与停牌/异常（pct 为 null 或价格无效）
  const pool = candidates
    .filter(c => c.price >= args.minPrice && c.price <= args.maxPrice && c.price > 0 && !isNaN(c.pct) && !String(c.code).startsWith("92"))
    .slice(0, args.top);
  console.log("候选 " + candidates.length + " 只，筛选后分析 " + pool.length + " 只（价格区间 " + args.minPrice + "~" + args.maxPrice + "）…");

  // 并发抓取 + 分析（每只独立，容错跳过）
  const results = [];
  const concurrency = 4;
  for (let i = 0; i < pool.length; i += concurrency) {
    const batch = pool.slice(i, i + concurrency);
    const done = await Promise.all(batch.map(async (c) => {
      try {
        const data = await fetchRun([c.secid, "--days", String(args.days)]);
        const res = await analyzeRun([JSON.stringify(data)]);
        const low = lowPositionScore(data.kline, {
          rsi14: res.indicators.rsi14, boll: res.indicators.boll,
          lastVolume: data.kline[data.kline.length - 1].volume,
          volMa5: res.indicators.volMa5,
        });
        const momentum = momentumScore(data.kline, c.pct);
        const comp = composite(res.signals, low, res.sentiment, res.growth, momentum);

        // 最终建议：动量追高时强制降级（涨停 → 追高风险/观望）
        let verdict = res.signals.verdict;
        if (momentum.score <= -60) verdict = "追高风险";
        else if (momentum.score <= -25 && (verdict === "买入" || verdict === "关注")) verdict = "观望";

        return {
          code: c.code, name: c.name, price: c.price, pct: c.pct,
          secid: c.secid,
          composite: comp,
          verdict, signalScore: res.signals.score,
          lowScore: low.score, lowLabel: low.label, lowNotes: low.notes.slice(0, 3),
          momentumScore: momentum.score, momentumLabel: momentum.label, momentumNotes: momentum.notes.slice(0, 3),
          sentimentLabel: res.sentiment.label, sentimentScore: res.sentiment.score,
          growthLabel: res.growth.label, growthScore: res.growth.score,
          support: res.levels.supports[0] ? res.levels.supports[0].price : null,
          resistance: res.levels.resistances[0] ? res.levels.resistances[0].price : null,
          pe: res.growth.valuation.peDynamic || res.growth.valuation.peTtm || null,
          error: null,
        };
      } catch (e) {
        return { code: c.code, name: c.name, error: e.message };
      }
    }));
    results.push(...done);
    // 简单进度
    process.stderr.write(".");
  }
  process.stderr.write("\n");

  const ok = results.filter(r => !r.error);
  ok.sort((a, b) => b.composite.total - a.composite.total);
  const failed = results.filter(r => r.error);

  const output = {
    generatedAt: new Date().toISOString(),
    args: { top: args.top, days: args.days, strategy: args.strategy },
    weights: { tech: 0.30, low: 0.20, sentiment: 0.15, growth: 0.15, momentum: 0.20 },
    picks: ok,
    failed,
  };
  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(output, null, 2));
    console.log("saved: " + args.out);
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
  if (args.html) {
    fs.writeFileSync(args.html, renderBoardHTML(output));
    console.log("saved: " + args.html);
  }

  // 控制台推荐榜
  console.log("\n========== 今日推荐（综合分排序） ==========");
  for (const p of ok.slice(0, 10)) {
    console.log(
      "[" + p.composite.total + "分] " + p.name + "(" + p.code + ") " + p.price + "元 " +
      (p.pct >= 0 ? "+" : "") + p.pct + "% | 技术" + p.composite.tech + " 低位" + p.composite.low +
      " 情绪" + p.composite.sentiment + " 增长" + p.composite.growth + " 动量" + p.composite.momentum +
      " | " + p.verdict + (p.momentumNotes.length ? " ⚠" + p.momentumNotes[0] : "") +
      " | 支撑" + (p.support ?? "-") + " 压力" + (p.resistance ?? "-")
    );
  }
  if (failed.length) console.log("\n跳过 " + failed.length + " 只（数据异常）：" + failed.map(f => f.name).join("、"));
  return output;
}

if (typeof process !== "undefined" && process.argv[1] && import.meta.url === "file://" + process.argv[1]) {
  run(process.argv.slice(2)).catch(e => { console.error("ERROR: " + e.message); process.exit(1); });
}
