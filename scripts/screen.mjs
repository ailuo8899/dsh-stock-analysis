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

function parseArgs(argv) {
  const args = { top: 10, days: 60, out: null, fs: "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23", minPrice: 0, maxPrice: 1e9 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--top") args.top = parseInt(argv[++i]);
    else if (a === "--days") args.days = parseInt(argv[++i]);
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--fs") args.fs = argv[++i];
    else if (a === "--min-price") args.minPrice = parseFloat(argv[++i]);
    else if (a === "--max-price") args.maxPrice = parseFloat(argv[++i]);
  }
  return args;
}

/** 新浪行情榜：返回 [{code,name,price,pct,secid}]（node fetch 可直连，东财 clist 接口反爬不稳定） */
async function fetchRank(fs, pz) {
  const url = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData" +
    "?page=1&num=" + pz + "&sort=changepercent&asc=0&node=hs_a&symbol=&_s_r_a=init";
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

/** 综合四维 → 总分 0-100 */
function composite(sig, low, senti, growth) {
  const t = (sig.score + 100) / 2;        // 0-100
  const l = (low.score + 100) / 2;        // 0-100
  const e = (senti.score + 1) / 2 * 100;  // 0-100
  const g = (growth.score + 100) / 2;     // 0-100
  const total = Math.round(t * 0.40 + l * 0.25 + e * 0.20 + g * 0.15);
  return { tech: Math.round(t), low: Math.round(l), sentiment: Math.round(e), growth: Math.round(g), total };
}

export async function run(argv) {
  const args = parseArgs(argv);
  const fs = await import("node:fs");

  console.log("拉取行情榜（fs=" + args.fs + "，取前 " + Math.min(args.top * 3, 50) + " 只候选）…");
  const candidates = await fetchRank(args.fs, Math.min(args.top * 3, 50));
  const pool = candidates.filter(c => c.price >= args.minPrice && c.price <= args.maxPrice).slice(0, args.top);
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
        const comp = composite(res.signals, low, res.sentiment, res.growth);
        return {
          code: c.code, name: c.name, price: c.price, pct: c.pct,
          secid: c.secid,
          composite: comp,
          verdict: res.signals.verdict, signalScore: res.signals.score,
          lowScore: low.score, lowLabel: low.label, lowNotes: low.notes.slice(0, 3),
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
    args: { top: args.top, days: args.days, fs: args.fs },
    weights: { tech: 0.40, low: 0.25, sentiment: 0.20, growth: 0.15 },
    picks: ok,
    failed,
  };
  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(output, null, 2));
    console.log("saved: " + args.out);
  } else {
    console.log(JSON.stringify(output, null, 2));
  }

  // 控制台推荐榜
  console.log("\n========== 今日推荐（综合分排序） ==========");
  for (const p of ok.slice(0, 10)) {
    console.log(
      "[" + p.composite.total + "分] " + p.name + "(" + p.code + ") " + p.price + "元 " +
      (p.pct >= 0 ? "+" : "") + p.pct + "% | 技术" + p.composite.tech + " 低位" + p.composite.low +
      " 情绪" + p.composite.sentiment + " 增长" + p.composite.growth +
      " | " + p.verdict + " | 支撑" + (p.support ?? "-") + " 压力" + (p.resistance ?? "-")
    );
  }
  if (failed.length) console.log("\n跳过 " + failed.length + " 只（数据异常）：" + failed.map(f => f.name).join("、"));
  return output;
}

if (typeof process !== "undefined" && process.argv[1] && import.meta.url === "file://" + process.argv[1]) {
  run(process.argv.slice(2)).catch(e => { console.error("ERROR: " + e.message); process.exit(1); });
}
