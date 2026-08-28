/**
 * dsh-stock-panel — Node 半端
 * 抓取 A 股数据（东财公开接口），通过 harness.handle 暴露给 Client 半端。
 * 方法与技能 dsh-stock-analysis 共享同一套数据源逻辑。
 */
"use strict";

import { renderReport } from "./report.js";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const UA = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
  "Referer": "https://quote.eastmoney.com/"
};

// ---------- 数据抓取（与技能 scripts/fetch.mjs 同源） ----------

async function resolveStock(input) {
  const url = "https://searchapi.eastmoney.com/api/suggest/get?input=" + encodeURIComponent(input.trim()) +
    "&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=8";
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error("解析股票失败 HTTP " + r.status);
  const j = await r.json();
  const rows = (j.QuotationCodeTable && j.QuotationCodeTable.Data) || [];
  const hit = rows.find(x => x.Classify === "AStock") || rows[0];
  if (!hit) throw new Error("未找到股票：" + input);
  return { code: hit.Code, name: hit.Name, secid: hit.QuoteID, market: hit.SecurityTypeName || hit.Classify };
}

async function fetchQuote(secid) {
  const fields = "f43,f44,f45,f46,f47,f48,f50,f57,f58,f60,f107,f168,f169,f170,f171,f292";
  const url = "https://push2.eastmoney.com/api/qt/stock/get?secid=" + secid +
    "&fields=" + fields + "&ut=fa5fd1943c7b386f172d6893dbfba10b";
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error("行情请求失败 HTTP " + r.status);
  const j = await r.json();
  const d = j.data;
  if (!d) throw new Error("行情数据为空：" + secid);
  const S = 100;
  return {
    code: d.f57, name: d.f58,
    price: d.f43 / S, open: d.f46 / S, high: d.f44 / S, low: d.f45 / S,
    prevClose: d.f60 / S, change: d.f169 / S, pct: d.f170 / S,
    volume: d.f47, amount: d.f48, turnover: d.f168 / S, amplitude: d.f171 / S,
    ts: Date.now()
  };
}

async function fetchKline(secid, days) {
  const end = "20500101", beg = "19900101";
  const url = "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=" + secid +
    "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&beg=" +
    beg + "&end=" + end + "&lmt=" + days + "&ut=fa5fd1943c7b386f172d6893dbfba10b";
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error("K线请求失败 HTTP " + r.status);
  const j = await r.json();
  const d = j.data;
  if (!d || !d.klines) throw new Error("K线数据为空：" + secid);
  return d.klines.slice(-days).map(line => {
    const p = line.split(",");
    return { date: p[0], open: +p[1], close: +p[2], high: +p[3], low: +p[4], volume: +p[5], amount: +p[6] };
  });
}

function secidToSymbol(secid) {
  const [mkt, code] = String(secid).split(".");
  return (mkt === "1" ? "sh" : "sz") + code;
}

async function fetchTencentNews(symbol) {
  try {
    const url = "https://proxy.finance.qq.com/ifzqgtimg/appstock/news/info/search?symbol=" + symbol + "&type=1&page=0&n=6";
    const r = await fetch(url, { headers: { ...UA, "Referer": "https://gu.qq.com/" } });
    if (!r.ok) return [];
    const j = await r.json();
    const list = (j.data && j.data.data) || [];
    return list.map(n => ({
      title: String(n.title || "").replace(/<[^>]+>/g, ""),
      summary: String(n.summary || n.title || "").replace(/<[^>]+>/g, ""),
      url: n.url || "", time: n.create_time || n.time || "", src: n.src || "", kind: "related"
    }));
  } catch (e) { return []; }
}

async function fetchAnnouncements(code) {
  try {
    const url = "https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=5&page_index=1&ann_type=A&client_source=web&stock_list=" + code;
    const r = await fetch(url, { headers: { ...UA, "Referer": "https://data.eastmoney.com/notices.html" } });
    if (!r.ok) return [];
    const j = await r.json();
    const list = (j.data && j.data.list) || [];
    return list.map(n => ({
      title: String(n.title || "").replace(/<[^>]+>/g, ""),
      summary: (n.title_ch || n.title || "").replace(/<[^>]+>/g, ""),
      url: "https://data.eastmoney.com/notices/detail/" + code + "/" + (n.art_code || "") + ".html",
      time: n.notice_date || n.display_time || "", kind: "announcement"
    }));
  } catch (e) { return []; }
}

// ---------- 指标与信号（与技能 scripts/analyze.mjs 同源，精简为面板需要） ----------

function smaArr(vals, n) {
  const out = []; let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= n) sum -= vals[i - n];
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}
function emaArr(vals, n) {
  const out = []; let prev = null;
  const k = 2 / (n + 1);
  for (const v of vals) { prev = prev === null ? v : v * k + prev * (1 - k); out.push(prev); }
  return out;
}

function analyze(kline) {
  const closes = kline.map(k => k.close);
  const highs = kline.map(k => k.high);
  const lows = kline.map(k => k.low);
  const vols = kline.map(k => k.volume);
  const n = kline.length;
  const i = n - 1;
  const r2 = v => v === null || isNaN(v) ? null : Number(v.toFixed(2));

  const ma5 = smaArr(closes, 5), ma10 = smaArr(closes, 10), ma20 = smaArr(closes, 20), ma60 = smaArr(closes, 60);
  const e12 = emaArr(closes, 12), e26 = emaArr(closes, 26);
  const dif = closes.map((_, idx) => e12[idx] - e26[idx]);
  const dea = emaArr(dif, 9);
  const hist = dif.map((v, idx) => (v - dea[idx]) * 2);

  // RSI14 (Wilder)
  let gain = 0, loss = 0;
  for (let k = 1; k <= 14; k++) {
    const ch = closes[k] - closes[k - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgG = gain / 14, avgL = loss / 14;
  for (let k = 15; k < n; k++) {
    const ch = closes[k] - closes[k - 1];
    avgG = (avgG * 13 + Math.max(ch, 0)) / 14;
    avgL = (avgL * 13 + Math.max(-ch, 0)) / 14;
  }
  const rsi14 = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);

  // KDJ
  let rsv = 50; const kArr = [], dArr = [];
  for (let k = 0; k < n; k++) {
    const s = Math.max(0, k - 8);
    const hh = Math.max(...highs.slice(s, k + 1));
    const ll = Math.min(...lows.slice(s, k + 1));
    rsv = hh === ll ? 50 : (closes[k] - ll) / (hh - ll) * 100;
    const kk = k === 0 ? 50 : (2 / 3) * (kArr[k - 1] ?? 50) + (1 / 3) * rsv;
    const dd = k === 0 ? 50 : (2 / 3) * (dArr[k - 1] ?? 50) + (1 / 3) * kk;
    kArr.push(kk); dArr.push(dd);
  }
  const J = 3 * kArr[i] - 2 * dArr[i];

  // BOLL
  const mid = ma20[i];
  const sd = Math.sqrt(closes.slice(-20).reduce((s, v) => s + Math.pow(v - mid, 2), 0) / 20);
  const upper = mid + 2 * sd, lower = mid - 2 * sd;

  // 信号因子
  const factors = [];
  if (ma5[i] > ma10[i] && ma10[i] > ma20[i]) factors.push({ name: "均线排列", score: 2, dir: "多", desc: "MA5>MA10>MA20 多头排列" });
  else if (ma5[i] < ma10[i] && ma10[i] < ma20[i]) factors.push({ name: "均线排列", score: -2, dir: "空", desc: "MA5<MA10<MA20 空头排列" });
  else factors.push({ name: "均线排列", score: 0, dir: "中性", desc: "均线缠绕" });

  const c = closes[i];
  if (c > ma20[i] && c > ma60[i]) factors.push({ name: "中期趋势", score: 1.5, dir: "多", desc: "站上 MA20/MA60" });
  else if (c < ma20[i] && c < ma60[i]) factors.push({ name: "中期趋势", score: -1.5, dir: "空", desc: "跌破 MA20/MA60" });
  else factors.push({ name: "中期趋势", score: 0, dir: "中性", desc: "均线间运行" });

  const golden = dif[i] > dea[i] && dif[i - 1] <= dea[i - 1];
  const dead = dif[i] < dea[i] && dif[i - 1] >= dea[i - 1];
  if (golden) factors.push({ name: "MACD", score: 2, dir: "多", desc: "MACD 金叉" });
  else if (dead) factors.push({ name: "MACD", score: -2, dir: "空", desc: "MACD 死叉" });
  else if (dif[i] > dea[i]) factors.push({ name: "MACD", score: 0.5, dir: "多", desc: "DIF 在 DEA 上方" });
  else factors.push({ name: "MACD", score: -0.5, dir: "空", desc: "DIF 在 DEA 下方" });

  if (rsi14 >= 80) factors.push({ name: "RSI", score: -1.5, dir: "空", desc: "RSI " + rsi14.toFixed(1) + " 超买" });
  else if (rsi14 <= 20) factors.push({ name: "RSI", score: 1.5, dir: "多", desc: "RSI " + rsi14.toFixed(1) + " 超卖" });
  else if (rsi14 > 60) factors.push({ name: "RSI", score: 0.5, dir: "多", desc: "RSI " + rsi14.toFixed(1) + " 偏强" });
  else if (rsi14 < 40) factors.push({ name: "RSI", score: -0.5, dir: "空", desc: "RSI " + rsi14.toFixed(1) + " 偏弱" });
  else factors.push({ name: "RSI", score: 0, dir: "中性", desc: "RSI " + rsi14.toFixed(1) + " 中性" });

  if (kArr[i] > dArr[i]) factors.push({ name: "KDJ", score: 1.5, dir: "多", desc: "KDJ 金叉向上" });
  else factors.push({ name: "KDJ", score: -0.5, dir: "空", desc: "KDJ 死叉向下" });
  if (J > 100) factors.push({ name: "KDJ超买", score: -1, dir: "空", desc: "J=" + J.toFixed(1) + " 超买" });
  else if (J < 0) factors.push({ name: "KDJ超卖", score: 1, dir: "多", desc: "J=" + J.toFixed(1) + " 超卖" });

  const volRatio = vols[i] / (vols.slice(-5).reduce((a, b) => a + b, 0) / 5 || 1);
  if (c > kline[i - 1].close && volRatio > 1.2) factors.push({ name: "量能", score: 1, dir: "多", desc: "放量上涨 " + volRatio.toFixed(1) + "x" });
  else if (c < kline[i - 1].close && volRatio > 1.2) factors.push({ name: "量能", score: -1, dir: "空", desc: "放量下跌 " + volRatio.toFixed(1) + "x" });
  else if (c < kline[i - 1].close && volRatio < 0.8) factors.push({ name: "量能", score: 0.5, dir: "多", desc: "缩量下跌，抛压减轻" });
  else factors.push({ name: "量能", score: 0, dir: "中性", desc: "量能平稳" });

  if (c >= upper) factors.push({ name: "布林带", score: -0.5, dir: "空", desc: "触及上轨" });
  else if (c <= lower) factors.push({ name: "布林带", score: 0.5, dir: "多", desc: "触及下轨" });
  else factors.push({ name: "布林带", score: 0, dir: "中性", desc: "通道中部" });

  const win = kline.slice(-60);
  const hi60 = Math.max(...win.map(k => k.high));
  const drawdown = (c - hi60) / hi60 * 100;
  if (drawdown <= -20) factors.push({ name: "超跌", score: 1.5, dir: "多", desc: "距60日高点 " + drawdown.toFixed(1) + "%" });
  else if (drawdown <= -10) factors.push({ name: "超跌", score: 0.5, dir: "多", desc: "回调 " + drawdown.toFixed(1) + "%" });
  else if (drawdown >= -2) factors.push({ name: "新高", score: -1, dir: "空", desc: "接近60日高点" });

  const raw = factors.reduce((s, f) => s + f.score, 0);
  const score = Math.max(-100, Math.min(100, Math.round(raw / 14 * 100)));
  let verdict;
  if (score >= 35) verdict = "买入";
  else if (score >= 12) verdict = "关注";
  else if (score > -12) verdict = "观望";
  else if (score > -35) verdict = "谨慎";
  else verdict = "回避";

  // 支撑压力
  const lo60 = Math.min(...win.map(k => k.low));
  const range = hi60 - lo60;
  const fibs = [0.382, 0.5, 0.618].map(f => ({ price: hi60 - range * f }));
  const supports = [], resistances = [];
  const pushS = p => { if (p && p < c) supports.push(p); };
  const pushR = p => { if (p && p > c) resistances.push(p); };
  pushS(ma20[i]); pushS(ma60[i]); pushS(lower); pushS(lo60);
  for (const f of fibs) if (f.price < c) pushS(f.price);
  pushR(ma20[i]); pushR(upper); pushR(hi60);
  for (const f of fibs) if (f.price > c) pushR(f.price);
  const uniq = arr => [...new Set(arr.map(v => v.toFixed(2)))].map(v => Number(v)).sort((a, b) => a - b);
  const sup = uniq(supports).slice(-3);
  const res = uniq(resistances).slice(0, 3);

  return {
    indicators: {
      ma5: r2(ma5[i]), ma10: r2(ma10[i]), ma20: r2(ma20[i]), ma60: r2(ma60[i]),
      macd: { dif: r2(dif[i]), dea: r2(dea[i]), hist: r2(hist[i]) },
      rsi14: Number(rsi14.toFixed(1)),
      kdj: { k: Number(kArr[i].toFixed(1)), d: Number(dArr[i].toFixed(1)), j: Number(J.toFixed(1)) },
      boll: { upper: r2(upper), mid: r2(mid), lower: r2(lower) }
    },
    signals: { score, verdict, factors, summary: "综合信号分 " + score + "/100（" + verdict + "）" },
    levels: {
      supports: sup.map(p => ({ price: r2(p), why: "支撑" })),
      resistances: res.map(p => ({ price: r2(p), why: "压力" }))
    },
    series: {
      ma5: ma5.slice(-90).map(v => v === null ? null : r2(v)),
      ma10: ma10.slice(-90).map(v => v === null ? null : r2(v)),
      ma20: ma20.slice(-90).map(v => v === null ? null : r2(v)),
      ma60: ma60.slice(-90).map(v => v === null ? null : r2(v))
    }
  };
}

// ---------- 新闻情绪 ----------
const POS = ["增长", "上涨", "大涨", "涨停", "新高", "突破", "盈利", "净利", "预增", "超预期", "利好", "中标", "回购", "增持", "合作", "签约", "投产", "扩产", "涨价", "复苏", "景气", "翻倍", "获批", "受益", "订单", "并购", "重组", "扭亏", "分红", "强势", "领涨", "流入"];
const NEG = ["下跌", "大跌", "跌停", "新低", "跌破", "亏损", "预亏", "净亏", "下滑", "利空", "减持", "质押", "处罚", "违规", "诉讼", "立案", "调查", "退市", "风险", "预警", "下调", "被查", "爆雷", "违约", "解禁", "承压", "低迷", "疲软", "萎缩", "缩水", "恐慌", "流出", "造假", "问询", "警示"];

function sentiment(news, pct) {
  const scored = news.map(n => {
    const text = n.title + " " + (n.summary || "");
    let pos = 0, neg = 0;
    for (const w of POS) if (text.includes(w)) pos++;
    for (const w of NEG) if (text.includes(w)) neg++;
    const s = pos === 0 && neg === 0 ? 0 : Math.max(-1, Math.min(1, (pos - neg) / (pos + neg)));
    return { ...n, senti: { score: Number(s.toFixed(3)), label: s > 0.2 ? "利好" : s < -0.2 ? "利空" : "中性" } };
  });
  let acc = 0, wsum = 0;
  for (const n of scored) {
    const w = n.kind === "related" ? 1 : 0.3;
    acc += n.senti.score * w; wsum += w;
  }
  let score = wsum > 0 ? acc / wsum : 0;
  score = Math.max(-1, Math.min(1, score * 0.7 + (pct > 0 ? 0.15 : pct < 0 ? -0.15 : 0)));
  const label = score >= 0.25 ? "看多" : score <= -0.25 ? "看空" : "中性";
  return { score: Number(score.toFixed(3)), label, news: scored };
}

// ---------- 主分析入口 ----------
async function analyzeStock(input, opts) {
  const stock = await resolveStock(input);
  const days = (opts && opts.days) || 90;
  const [quote, kline, tNews, ann] = await Promise.all([
    fetchQuote(stock.secid),
    fetchKline(stock.secid, days),
    fetchTencentNews(secidToSymbol(stock.secid)),
    fetchAnnouncements(stock.code)
  ]);
  const news = [...tNews, ...ann].slice(0, 12);
  const a = analyze(kline);
  const senti = sentiment(news, quote.pct);
  // 持仓盈亏
  let position = null;
  if (opts && opts.shares && opts.cost) {
    const price = quote.price, shares = opts.shares, cost = opts.cost;
    const pl = (price - cost) * shares;
    const plPct = (price - cost) / cost * 100;
    const stopLoss = a.levels.supports.length ? a.levels.supports[0].price : cost * 0.93;
    const takeProfit = a.levels.resistances.length ? a.levels.resistances[a.levels.resistances.length - 1].price : cost * 1.08;
    position = {
      shares, cost, price,
      value: Number((price * shares).toFixed(2)),
      pl: Number(pl.toFixed(2)),
      plPct: Number(plPct.toFixed(2)),
      stopLoss: Number(stopLoss.toFixed(2)),
      takeProfit: Number(takeProfit.toFixed(2))
    };
  }
  // 最近 90 根 K 线（面板渲染用，精简字段）
  const kline90 = kline.slice(-90).map(k => ({
    date: k.date, open: k.open, close: k.close, high: k.high, low: k.low, volume: k.volume
  }));
  return {
    meta: { code: stock.code, name: stock.name, market: stock.market, fetchedAt: new Date().toISOString() },
    quote, kline: kline90, news, analysis: a, sentiment: senti, position
  };
}

// ---------- 自选股：A股各行业龙头清单 + 持久化存储 ----------
const INDUSTRY_LEADERS = [
  { industry: "白酒", name: "贵州茅台", code: "600519" },
  { industry: "白酒", name: "五粮液", code: "000858" },
  { industry: "银行", name: "招商银行", code: "600036" },
  { industry: "银行", name: "工商银行", code: "601398" },
  { industry: "保险", name: "中国平安", code: "601318" },
  { industry: "券商", name: "中信证券", code: "600030" },
  { industry: "新能源车", name: "比亚迪", code: "002594" },
  { industry: "新能源车", name: "宁德时代", code: "300750" },
  { industry: "光伏", name: "隆基绿能", code: "601012" },
  { industry: "锂电", name: "亿纬锂能", code: "300014" },
  { industry: "半导体", name: "中芯国际", code: "688981" },
  { industry: "半导体", name: "北方华创", code: "002371" },
  { industry: "芯片", name: "韦尔股份", code: "603501" },
  { industry: "医药", name: "恒瑞医药", code: "600276" },
  { industry: "医药", name: "药明康德", code: "603259" },
  { industry: "医疗器械", name: "迈瑞医疗", code: "300760" },
  { industry: "白酒", name: "山西汾酒", code: "600809" },
  { industry: "家电", name: "美的集团", code: "000333" },
  { industry: "家电", name: "格力电器", code: "000651" },
  { industry: "食品饮料", name: "海天味业", code: "603288" },
  { industry: "乳业", name: "伊利股份", code: "600887" },
  { industry: "军工", name: "中航沈飞", code: "600760" },
  { industry: "军工", name: "航发动力", code: "600893" },
  { industry: "房地产", name: "万科A", code: "000002" },
  { industry: "基建", name: "中国建筑", code: "601668" },
  { industry: "有色金属", name: "紫金矿业", code: "601899" },
  { industry: "有色金属", name: "北方稀土", code: "600111" },
  { industry: "钢铁", name: "宝钢股份", code: "600019" },
  { industry: "煤炭", name: "中国神华", code: "601088" },
  { industry: "石油", name: "中国石油", code: "601857" },
  { industry: "电力", name: "长江电力", code: "600900" },
  { industry: "电力", name: "中国核电", code: "601985" },
  { industry: "通信", name: "中国移动", code: "600941" },
  { industry: "通信", name: "中兴通讯", code: "000063" },
  { industry: "计算机", name: "科大讯飞", code: "002230" },
  { industry: "软件", name: "金山办公", code: "688111" },
  { industry: "互联网", name: "东方财富", code: "300059" },
  { industry: "航运", name: "中远海控", code: "601919" },
  { industry: "消费电子", name: "立讯精密", code: "002475" },
  { industry: "消费电子", name: "工业富联", code: "601138" },
  { industry: "免税", name: "中国中免", code: "601888" },
  { industry: "猪肉", name: "牧原股份", code: "002714" },
  { industry: "机械", name: "三一重工", code: "600031" },
  { industry: "化工", name: "万华化学", code: "600309" },
  { industry: "建材", name: "海螺水泥", code: "600585" },
  { industry: "航空", name: "中国国航", code: "601111" },
  { industry: "汽车", name: "长城汽车", code: "601633" },
  { industry: "汽车", name: "上汽集团", code: "600104" },
  { industry: "地产服务", name: "保利发展", code: "600048" },
  { industry: "快递", name: "顺丰控股", code: "002352" },
  { industry: "白酒", name: "泸州老窖", code: "000568" },
  { industry: "医药商业", name: "上海医药", code: "601607" }
];

const fsMod = await import("node:fs");
const pathMod = await import("node:path");
const osMod = await import("node:os");
const WATCHLIST_FILE = pathMod.join(process.env.DSH_HOME || (osMod.homedir() + "/.dsh"), "storages", "stock-watchlist.json");

function readWatchlist() {
  try {
    if (!fsMod.existsSync(WATCHLIST_FILE)) return [];
    const raw = fsMod.readFileSync(WATCHLIST_FILE, "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function writeWatchlist(list) {
  try {
    fsMod.mkdirSync(pathMod.dirname(WATCHLIST_FILE), { recursive: true });
    fsMod.writeFileSync(WATCHLIST_FILE, JSON.stringify(list, null, 2), "utf8");
    return true;
  } catch (e) { return false; }
}
function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => resolve(body));
  });
}
function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

// ---------- 每日推荐：情绪选股 + 定时调度 ----------
const PICKS_FILE = pathMod.join(process.env.DSH_HOME || (osMod.homedir() + "/.dsh"), "storages", "stock-picks.json");

function readPicks() {
  try {
    if (!fsMod.existsSync(PICKS_FILE)) return { morning: null, afternoon: null };
    const raw = fsMod.readFileSync(PICKS_FILE, "utf8");
    const j = JSON.parse(raw);
    return { morning: j.morning || null, afternoon: j.afternoon || null };
  } catch (e) { return { morning: null, afternoon: null }; }
}
function writePicks(slot, data) {
  try {
    const all = readPicks();
    all[slot] = data;
    fsMod.mkdirSync(pathMod.dirname(PICKS_FILE), { recursive: true });
    fsMod.writeFileSync(PICKS_FILE, JSON.stringify(all, null, 2), "utf8");
    return true;
  } catch (e) { return false; }
}

// 判断是否交易日（周一~周五）
function isTradingDay(d = new Date()) {
  const day = d.getDay();
  return day >= 1 && day <= 5;
}
// 判断当前是否处于选股窗口：上午 9:25~9:45，下午 14:20~14:40
function windowSlot(d = new Date()) {
  const h = d.getHours(), m = d.getMinutes();
  const t = h * 60 + m;
  if (t >= 565 && t <= 585) return "morning";   // 9:25-9:45
  if (t >= 860 && t <= 880) return "afternoon"; // 14:20-14:40
  return null;
}
// 是否已为今天的 slot 生成过推荐
function alreadyPicked(slot, todayStr) {
  const all = readPicks();
  const cur = all[slot];
  return cur && cur.date === todayStr;
}

// 汇总最近 N 天已选股票代码（去重用；只排除近期，避免候选不足时选空）
function allPickedCodes(days = 3) {
  const all = readPicks();
  const codes = new Set();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const today = new Date().toLocaleDateString("zh-CN");
  for (const slot of ["morning", "afternoon"]) {
    const cur = all[slot];
    if (!cur || !Array.isArray(cur.picks)) continue;
    // 用 pickedAt 判断是否在近 N 天内；无 pickedAt 时按 date 兜底（当天也算）
    const t = cur.pickedAt ? new Date(cur.pickedAt).getTime() : 0;
    if (t < cutoff && cur.date !== today) continue;
    for (const p of cur.picks) codes.add(String(p.code));
  }
  return codes;
}

let pickLock = false;
async function runPick(slot, force) {
  if (pickLock) return { skipped: true, reason: "busy" };
  pickLock = true;
  try {
    const todayStr = new Date().toLocaleDateString("zh-CN");
    if (!force && alreadyPicked(slot, todayStr)) {
      return { skipped: true, reason: "already picked today" };
    }
    // 动态导入选股引擎（避免模块级 import 循环）
    const picker = await import("./picker.js");
    // 换一批：排除近期已选过的股票
    const exclude = allPickedCodes();
    const result = await picker.pickDaily(slot, exclude);
    // 候选为空（接口限流/风控）时视为失败，不覆盖已有推荐
    if (!result.picks || result.picks.length === 0) {
      console.warn("[stock-panel] 选股结果为空 slot=" + slot + " scanned=" + (result.market ? result.market.scanned : 0) + "（可能接口限流）");
      return { error: "行情数据暂不可用（可能限流），请稍后再试" };
    }
    writePicks(slot, result);
    console.log("[stock-panel] 每日推荐生成 slot=" + slot + " picks=" + result.picks.length + " excluded=" + result.excluded);
    return result;
  } catch (e) {
    console.error("[stock-panel] 选股失败 slot=" + slot, e.message);
    return { error: e.message };
  } finally {
    pickLock = false;
  }
}

// 启动时立即检查：若当前处于窗口且未生成，补跑一次
function maybePickNow() {
  const slot = windowSlot();
  if (!slot) return;
  if (!isTradingDay()) return;
  runPick(slot).then(() => {});
}

// ---------- Cordis 插件 ----------
const inject = ["webServer", "timer"];
const apply = (ctx) => {
  // 每日定时选股：9:30 / 14:30（用 timer 服务，每 30 秒检查一次窗口）
  const timer = ctx.get("timer");
  if (timer !== undefined) {
    ctx.interval(() => {
      const slot = windowSlot();
      if (slot && isTradingDay() && !alreadyPicked(slot, new Date().toLocaleDateString("zh-CN"))) {
        runPick(slot).then(() => {});
      }
    }, 30 * 1000);
    // 启动时补跑
    maybePickNow();
  }

  // 动态双半端通道（保留，供 dynamic 包复用）
  const harness = ctx.get("harness");
  if (harness !== undefined) {
    harness.handle("stock.analyze", async (args) => {
      if (!args || typeof args.input !== "string") throw new Error("缺少股票代码/名称参数 input");
      const result = await analyzeStock(args.input, args.opts || {});
      return JSON.parse(JSON.stringify(result));
    });
  }
  // 静态 Client 半端走 HTTP 路由（webServer 服务，同源 fetch）
  const webServer = ctx.get("webServer");
  if (webServer !== undefined) {
    webServer.register({
      kind: "exact",
      path: "/api/stock/analyze",
      handler: async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        let args;
        try { args = JSON.parse(body || "{}"); }
        catch { args = {}; }
        try {
          if (!args || typeof args.input !== "string") throw new Error("缺少股票代码/名称参数 input");
          const result = await analyzeStock(args.input, args.opts || {});
          const payload = JSON.stringify(result);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(payload);
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      }
    });

    // 自选股：行业龙头清单
    webServer.register({
      kind: "exact",
      path: "/api/stock/leaders",
      handler: async (req, res) => {
        sendJson(res, 200, { leaders: INDUSTRY_LEADERS });
      }
    });

    // 自选股：读取列表
    webServer.register({
      kind: "exact",
      path: "/api/stock/watchlist",
      handler: async (req, res) => {
        try {
          const list = readWatchlist();
          sendJson(res, 200, { watchlist: list });
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    });

    // 自选股：添加
    webServer.register({
      kind: "exact",
      path: "/api/stock/watchlist/add",
      handler: async (req, res) => {
        try {
          const body = await readBody(req);
          const args = JSON.parse(body || "{}");
          if (!args || typeof args.code !== "string" || typeof args.name !== "string") {
            throw new Error("缺少 code/name 参数");
          }
          const list = readWatchlist();
          if (!list.some(x => x.code === args.code)) {
            list.push({ code: args.code, name: args.name, industry: args.industry || "", addedAt: Date.now() });
          }
          writeWatchlist(list);
          sendJson(res, 200, { watchlist: list });
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    });

    // 自选股：移除
    webServer.register({
      kind: "exact",
      path: "/api/stock/watchlist/remove",
      handler: async (req, res) => {
        try {
          const body = await readBody(req);
          const args = JSON.parse(body || "{}");
          if (!args || typeof args.code !== "string") throw new Error("缺少 code 参数");
          const list = readWatchlist().filter(x => x.code !== args.code);
          writeWatchlist(list);
          sendJson(res, 200, { watchlist: list });
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    });

    // 每日推荐：读取
    webServer.register({
      kind: "exact",
      path: "/api/stock/picks",
      handler: async (req, res) => {
        try {
          const picks = readPicks();
          sendJson(res, 200, { picks });
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    });

    // 每日推荐：手动触发（调试用）
    webServer.register({
      kind: "exact",
      path: "/api/stock/picks/run",
      handler: async (req, res) => {
        try {
          const body = await readBody(req);
          const args = JSON.parse(body || "{}");
          const slot = args.slot === "afternoon" ? "afternoon" : "morning";
          const force = !!args.force;
          const result = await runPick(slot, force);
          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    });

    // 账户数据：模拟账户 + 真实账户（顶部 tab 查看）
    webServer.register({
      kind: "exact",
      path: "/api/stock/accounts",
      handler: async (req, res) => {
        try {
          const dir = pathMod.join(process.env.DSH_HOME || (osMod.homedir() + "/.dsh"), "storages", "stock-sim");
          const read = (f) => {
            try { return JSON.parse(fsMod.readFileSync(pathMod.join(dir, f), "utf8")); } catch (e) { return null; }
          };
          const sim = read("account.json");
          const real = read("real-account.json");
          sendJson(res, 200, { sim, real });
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    });

    // 账户展示页：模拟账户（新标签打开）
    webServer.register({
      kind: "exact",
      path: "/api/stock/accounts/sim",
      handler: async (req, res) => {
        try {
          const dir = pathMod.join(process.env.DSH_HOME || (osMod.homedir() + "/.dsh"), "storages", "stock-sim");
          let acc = null;
          try { acc = JSON.parse(fsMod.readFileSync(pathMod.join(dir, "account.json"), "utf8")); } catch (e) {}
          const rows = (acc && acc.holdings || []).map(function (h) {
            return "<tr><td>" + esc(h.name) + " (" + h.code + ")</td><td>" + h.shares + "</td><td>" + Number(h.costPrice).toFixed(2) + "</td><td>" + (h.buyDate || "-") + "</td></tr>";
          }).join("");
          const last = acc && acc.daily && acc.daily.length ? acc.daily[acc.daily.length - 1] : null;
          const html = [
            "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'/><title>模拟账户 · 股票分析</title><style>",
            "body{background:#0b0f1d;color:#e6eaf5;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;margin:0;padding:30px;line-height:1.6}",
            ".wrap{max-width:760px;margin:0 auto} h1{font-size:24px} .dim{color:#8a93b2;font-size:13px}",
            ".cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:20px 0}",
            ".card{background:#121829;border:1px solid #232c47;border-radius:12px;padding:16px}",
            ".card .k{color:#8a93b2;font-size:12px;margin-bottom:6px} .card .v{font-size:22px;font-weight:700}",
            ".up{color:#f0483e} .down{color:#2ebd85}",
            "table{width:100%;border-collapse:collapse;font-size:14px}",
            "th{color:#8a93b2;font-size:12px;text-align:left;padding:8px 10px;border-bottom:1px solid #232c47}",
            "td{padding:10px;border-bottom:1px solid #232c47}",
            "a{color:#3b82f6;text-decoration:none} .back{margin-bottom:16px;display:inline-block}",
            "</style></head><body><div class='wrap'>",
            "<a class='back' href='/api/stock/report'>← 返回门户</a>",
            "<h1>💰 模拟账户</h1>",
            "<div class='dim'>虚拟资金 " + (acc ? Number(acc.capital || 0).toLocaleString() : "-") + " 元 · 最多持仓 " + (acc && acc.rules ? acc.rules.maxHoldings : 3) + " 只</div>",
            "<div class='cards'>",
            "<div class='card'><div class='k'>总资产</div><div class='v'>" + (last ? Number(last.totalValue).toLocaleString() : "-") + "</div></div>",
            "<div class='card'><div class='k'>累计盈亏</div><div class='v " + (last && last.pnl >= 0 ? "up" : "down") + "'>" + (last ? (last.pnl >= 0 ? "+" : "") + Number(last.pnl).toLocaleString() + "（" + (last.pnlPct >= 0 ? "+" : "") + last.pnlPct.toFixed(2) + "%）" : "-") + "</div></div>",
            "<div class='card'><div class='k'>现金</div><div class='v'>" + (acc ? Number(acc.cash || 0).toLocaleString() : "-") + "</div></div>",
            "</div>",
            "<table><tr><th>股票</th><th>股数</th><th>成本价</th><th>买入日</th></tr>" + (rows || "<tr><td colspan='4' style='color:#6b7290'>空仓</td></tr>") + "</table>",
            "<div class='dim' style='margin-top:16px'>交易 " + (acc && acc.trades ? acc.trades.length : 0) + " 笔 · 快照 " + (acc && acc.daily ? acc.daily.length : 0) + " 日 · 沪深300同期 " + (last && last.benchPct != null ? (last.benchPct >= 0 ? "+" : "") + last.benchPct.toFixed(2) + "%" : "—") + "</div>",
            "</div></body></html>"
          ].join("");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<!DOCTYPE html><html><body style='background:#0b0f1d;color:#f0483e;padding:40px;font-family:sans-serif'>模拟账户页面错误：" + esc(err.message) + "</body></html>");
        }
      }
    });

    // 账户展示页：真实账户（新标签打开）
    webServer.register({
      kind: "exact",
      path: "/api/stock/accounts/real",
      handler: async (req, res) => {
        try {
          const dir = pathMod.join(process.env.DSH_HOME || (osMod.homedir() + "/.dsh"), "storages", "stock-sim");
          let acc = null;
          try { acc = JSON.parse(fsMod.readFileSync(pathMod.join(dir, "real-account.json"), "utf8")); } catch (e) {}
          const rows = (acc && acc.holdings || []).map(function (h) {
            return "<tr><td>" + esc(h.name) + " (" + h.code + ")</td><td>" + h.shares + "</td><td>" + Number(h.costPrice).toFixed(2) + "</td><td>" + (h.buyDate || "-") + "</td></tr>";
          }).join("");
          const last = acc && acc.daily && acc.daily.length ? acc.daily[acc.daily.length - 1] : null;
          const html = [
            "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'/><title>真实账户 · 股票分析</title><style>",
            "body{background:#0b0f1d;color:#e6eaf5;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;margin:0;padding:30px;line-height:1.6}",
            ".wrap{max-width:760px;margin:0 auto} h1{font-size:24px} .dim{color:#8a93b2;font-size:13px}",
            ".cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:20px 0}",
            ".card{background:#121829;border:1px solid #232c47;border-radius:12px;padding:16px}",
            ".card .k{color:#8a93b2;font-size:12px;margin-bottom:6px} .card .v{font-size:22px;font-weight:700}",
            ".up{color:#f0483e} .down{color:#2ebd85}",
            "table{width:100%;border-collapse:collapse;font-size:14px}",
            "th{color:#8a93b2;font-size:12px;text-align:left;padding:8px 10px;border-bottom:1px solid #232c47}",
            "td{padding:10px;border-bottom:1px solid #232c47}",
            "a{color:#3b82f6;text-decoration:none} .back{margin-bottom:16px;display:inline-block}",
            "</style></head><body><div class='wrap'>",
            "<a class='back' href='/api/stock/report'>← 返回门户</a>",
            "<h1>💼 真实账户</h1>",
            "<div class='dim'>用户真实交易持仓 · 与模拟账户分离</div>",
            "<div class='cards'>",
            "<div class='card'><div class='k'>持仓市值</div><div class='v'>" + (last ? Number(last.holdingsValue).toLocaleString() : "-") + "</div></div>",
            "<div class='card'><div class='k'>浮动盈亏</div><div class='v " + (last && last.pnl >= 0 ? "up" : "down") + "'>" + (last ? (last.pnl >= 0 ? "+" : "") + Number(last.pnl).toLocaleString() + "（" + (last.pnlPct >= 0 ? "+" : "") + last.pnlPct.toFixed(2) + "%）" : "-") + "</div></div>",
            "<div class='card'><div class='k'>持仓成本</div><div class='v'>" + (last ? Number(last.costValue).toLocaleString() : "-") + "</div></div>",
            "</div>",
            "<table><tr><th>股票</th><th>股数</th><th>成本价</th><th>买入日</th></tr>" + (rows || "<tr><td colspan='4' style='color:#6b7290'>暂无持仓</td></tr>") + "</table>",
            "<div class='dim' style='margin-top:16px'>交易 " + (acc && acc.trades ? acc.trades.length : 0) + " 笔 · 快照 " + (acc && acc.daily ? acc.daily.length : 0) + " 日 · 沪深300同期 " + (last && last.benchPct != null ? (last.benchPct >= 0 ? "+" : "") + last.benchPct.toFixed(2) + "%" : "—") + "</div>",
            "</div></body></html>"
          ].join("");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<!DOCTYPE html><html><body style='background:#0b0f1d;color:#f0483e;padding:40px;font-family:sans-serif'>真实账户页面错误：" + esc(err.message) + "</body></html>");
        }
      }
    });

    // 完整报告：新标签页打开（GET ?input=代码或名称；无 input 时显示输入首页）
    webServer.register({
      kind: "exact",
      path: "/api/stock/report",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url || "/", "http://localhost");
          const input = url.searchParams.get("input") || "";
          if (!input) {
            const page = [
              "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'/><title>股票分析 · 门户</title><style>",
              "body{background:#0b0f1d;color:#e6eaf5;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;margin:0;line-height:1.6}",
              ".topbar{display:flex;align-items:center;gap:18px;padding:14px 24px;background:#121829;border-bottom:1px solid #232c47;position:sticky;top:0;z-index:10}",
              ".topbar .logo{font-size:18px;font-weight:700}",
              ".topbar nav{display:flex;gap:4px;flex:1;flex-wrap:wrap}",
              ".topbar nav button{padding:8px 16px;font-size:14px;font-weight:600;cursor:pointer;background:none;border:none;color:#8a93b2;border-radius:8px}",
              ".topbar nav button:hover{color:#e6eaf5;background:#0e1424}",
              ".topbar nav button.active{color:#3b82f6;background:rgba(59,130,246,.12)}",
              ".wrap{max-width:1100px;margin:0 auto;padding:24px}",
              ".view{display:none} .view.active{display:block}",
              "h1{font-size:22px;margin-bottom:6px} .sub{color:#8a93b2;font-size:13px;margin-bottom:20px}",
              ".cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:20px}",
              ".card{background:#121829;border:1px solid #232c47;border-radius:12px;padding:16px}",
              ".card .k{color:#8a93b2;font-size:12px;margin-bottom:6px} .card .v{font-size:22px;font-weight:700}",
              ".up{color:#f0483e} .down{color:#2ebd85}",
              ".advice{background:rgba(59,130,246,.08);border:1px solid rgba(59,130,246,.3);border-radius:12px;padding:14px;margin-bottom:16px}",
              ".advice.green{background:rgba(46,189,133,.08);border-color:rgba(46,189,133,.3)}",
              ".advice .ah{font-size:13px;font-weight:700;color:#3b82f6;margin-bottom:6px}",
              ".advice.green .ah{color:#2ebd85}",
              ".advice .at{font-size:13px;margin-bottom:4px}",
              ".advice .an{font-size:12px;color:#8a93b2;margin-bottom:4px}",
              "table{width:100%;border-collapse:collapse;font-size:13px;background:#121829;border-radius:12px;overflow:hidden}",
              "th{color:#8a93b2;font-size:12px;text-align:left;padding:10px 12px;background:#0e1424;border-bottom:1px solid #232c47;white-space:nowrap}",
              "td{padding:10px 12px;border-bottom:1px solid #232c47;white-space:nowrap;text-align:left}",
              ".badge{display:inline-block;padding:2px 10px;border-radius:6px;font-size:11.5px;font-weight:600}",
              ".b-buy{background:rgba(240,72,62,.15);color:#f0483e} .b-sell{background:rgba(46,189,133,.15);color:#2ebd85}",
              ".b-watch{background:rgba(245,185,66,.14);color:#f5b942} .b-caution{background:rgba(59,130,246,.14);color:#3b82f6} .b-neutral{background:rgba(138,147,178,.14);color:#8a93b2}",
              ".search-row{display:flex;gap:10px;margin-bottom:20px}",
              ".search-row input{flex:1;max-width:400px;padding:12px 16px;border-radius:8px;border:1px solid #232c47;background:#0e1424;color:#e6eaf5;font-size:15px;outline:none}",
              ".search-row input:focus{border-color:#3b82f6}",
              ".search-row button,.btn{padding:12px 22px;border-radius:8px;border:none;background:#3b82f6;color:#fff;font-size:14px;font-weight:600;cursor:pointer}",
              ".btn:hover{filter:brightness(1.15)}",
              ".features{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:6px}",
              ".feature{background:#0e1424;border:1px solid #232c47;border-radius:10px;padding:14px;font-size:13px;display:block;color:inherit;text-decoration:none}.feature:hover{border-color:#3b82f6;transform:translateY(-1px)}",
              ".feature b{color:#e6eaf5;display:block;margin-bottom:4px} .feature span{color:#8a93b2;font-size:12px}",
              ".empty{color:#6b7290;font-size:13px;padding:24px;text-align:center}",
              ".err{color:#f0483e;font-size:13px;padding:16px}",
              "@media(max-width:600px){.features{grid-template-columns:1fr}.cards{grid-template-columns:1fr}.wrap{padding:16px}.topbar{padding:12px 14px}}",
              "</style></head><body>",
              "<div class='topbar'><div class='logo'>📈 股票分析</div><nav>",
              "<button data-view='analyze' class='active'>🔍 分析</button>",
              "<button data-view='sim'>💰 模拟账户</button>",
              "<button data-view='real'>💼 真实账户</button>",
              "<button data-view='daily'>📊 每日汇总</button>",
              "</nav></div>",
              "<div class='wrap'>",
              "<div class='view active' id='view-analyze'>",
              "<h1>🔍 股票分析</h1>",
              "<div class='sub'>输入代码或名称，实时生成完整分析（信号/位置/情绪/增长/支撑压力/理财师点评）</div>",
              "<div class='search-row'><input id='q' placeholder='如 600519 / 贵州茅台 / 002594' onkeydown='if(event.key===String.fromCharCode(13))go()'/><button onclick='go()'>分析</button></div>",
              "<div class='sub' style='margin-top:24px'>📂 功能入口</div>",
              "<div class='features'>",
              "<a class='feature' href='/api/stock/report?input=600519'><b>📊 个股分析</b><span>实时行情、K线、技术信号、位置研判、支撑压力、未来增长、理财师点评</span></a>",
              "<a class='feature' href='/api/stock/picks' target='_blank'><b>🎯 今日推荐</b><span>五维选股（技术/低位/情绪/增长/动量）输出推荐榜</span></a>",
              "<a class='feature' href='/api/stock/accounts/sim' target='_blank'><b>💰 模拟账户</b><span>100万虚拟资金自动交易，跟踪盈亏与沪深300对比</span></a>",
              "<a class='feature' href='/api/stock/accounts/real' target='_blank'><b>💼 真实账户</b><span>跟踪真实持仓，实时分析与浮盈亏</span></a>",
              "<a class='feature' href='/api/stock/daily-summary' target='_blank'><b>📊 每日汇总</b><span>模拟/真实/自选三合一日报，含沪深300基准对比</span></a>",
              "</div></div>",
              "<div class='view' id='view-sim'><h1>💰 模拟账户</h1><div id='simContent' class='empty'>加载中…</div></div>",
              "<div class='view' id='view-real'><h1>💼 真实账户</h1><div id='realContent' class='empty'>加载中…</div></div>",
              "<div class='view' id='view-daily'><h1>📊 每日汇总</h1><div id='dailyContent' class='empty'>加载中…</div></div>",
              "</div>",
              "<script>",
              "function go(){var v=document.getElementById('q').value.trim();if(!v)return;location.href='/api/stock/report?input='+encodeURIComponent(v);}",
              "document.querySelectorAll('.topbar nav button').forEach(function(b){b.addEventListener('click',function(){",
              "document.querySelectorAll('.topbar nav button').forEach(function(x){x.classList.remove('active')});",
              "document.querySelectorAll('.view').forEach(function(v){v.classList.remove('active')});",
              "b.classList.add('active');document.getElementById('view-'+b.dataset.view).classList.add('active');",
              "if(b.dataset.view==='sim')loadSim();if(b.dataset.view==='real')loadReal();if(b.dataset.view==='daily')loadDaily();",
              "});});",
              "var fmt=function(v,d){d=d||2;return (v===null||v===undefined||isNaN(v))?'-':Number(v).toFixed(d);};",
              "var esc=function(s){return String(s==null?'':s).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c];});};",
              "var pnlCls=function(v){return v>=0?'up':'down';};",
              "var pnlTxt=function(v,p){return (v>=0?'+':'')+fmt(v,0)+'（'+(p>=0?'+':'')+fmt(p,2)+'%）';};",
              "async function loadSim(){var el=document.getElementById('simContent');el.innerHTML='<div class=\"empty\">加载中…</div>';try{",
              "var j=await fetch('/api/stock/accounts').then(function(r){return r.json()});var a=j.sim;if(!a){el.innerHTML='<div class=\"empty\">模拟账户未初始化</div>';return;}",
              "var last=a.daily&&a.daily.length?a.daily[a.daily.length-1]:null;",
              "var advice='';",
              "try{var ar=await fetch('/api/stock/advisor/sim').then(function(r){return r.json()});",
              "advice='<div class=\"advice\"><div class=\"ah\">🧑‍💼 理财师建议</div><div class=\"at\"><b>风险等级：</b>'+esc(ar.riskLevel||'-')+' ｜ <b>仓位：</b>'+esc(ar.positionRisk&&ar.positionRisk.level||'-')+' '+(ar.positionRisk&&ar.positionRisk.pct!=null?ar.positionRisk.pct+'%':'')+'</div>'+(ar.concentration&&ar.concentration.note?'<div class=\"an\">'+esc(ar.concentration.note)+'</div>':'')+'<div>'+esc(ar.overall||'-')+'</div></div>';",
              "}catch(e2){}",
              "var cash=a.cash!=null?a.cash:0;",
              "var mv=(a.holdings||[]).reduce(function(s,h){return s+(h.costPrice||0)*h.shares;},0);",
              "var total=cash+mv;",
              "var rows=(a.holdings||[]).map(function(h){",
              "var price=h.price!=null?h.price:h.costPrice;var pl=(price-h.costPrice)*h.shares;var plPct=h.costPrice>0?(price-h.costPrice)/h.costPrice*100:0;",
              "var todayPl=(price-(h.prevClose!=null?h.prevClose:h.costPrice))*h.shares;var todayPlPct=h.prevClose>0?(price-h.prevClose)/h.prevClose*100:0;",
              "var sharePct=total>0?price*h.shares/total*100:0;",
              "return '<tr style=\"cursor:pointer\" onclick=\"window.open('/api/stock/report?input='+h.code+'','_blank')\"><td><a href=\"/api/stock/report?input='+h.code+'\" target=\"_blank\" style=\"color:inherit;text-decoration:none\"><b>'+esc(h.name)+'</b><br><span style=\"color:#8a93b2;font-size:11px\">'+h.code+'</span></a></td><td>'+h.shares+'</td><td>'+fmt(h.costPrice)+'</td><td>'+fmt(price)+'</td>'",
              "+'<td style=\"color:'+pnlCls(pl)+'\">'+pnlTxt(pl,plPct)+'</td>'",
              "+'<td style=\"color:'+pnlCls(todayPl)+'\">'+pnlTxt(todayPl,todayPlPct)+'</td>'",
              "+'<td>'+fmt(sharePct,1)+'%</td>'",
              "+'<td style=\"color:#2ebd85;font-size:12px\">'+(h.stopLoss?fmt(h.stopLoss):'-')+'</td>'",
              "+'<td style=\"color:#f0483e;font-size:12px\">'+(h.takeProfit?fmt(h.takeProfit):'-')+'</td>'",
              "+'<td style=\"font-size:12px\">'+esc(h.verdict||'-')+' '+fmt(h.score!=null?h.score:0)+'</td>'",
              "+'<td style=\"font-size:11px;color:#8a93b2\">'+(h.source||'-')+'</td></tr>';}).join('');",
              "el.innerHTML=advice",
              "+'<div class=\"cards\">'",
              "+'<div class=\"card\"><div class=\"k\">总资产</div><div class=\"v '+(last&&last.pnl>=0?'up':'down')+'\">'+(last?fmt(last.totalValue,0):fmt(total,0))+'</div></div>'",
              "+'<div class=\"card\"><div class=\"k\">累计盈亏</div><div class=\"v '+(last&&last.pnl>=0?'up':'down')+'\">'+(last?pnlTxt(last.pnl,last.pnlPct):'-')+'</div></div>'",
              "+'<div class=\"card\"><div class=\"k\">现金</div><div class=\"v\">'+fmt(cash,0)+'</div></div>'",
              "+'<div class=\"card\"><div class=\"k\">持仓数</div><div class=\"v\">'+(a.holdings||[]).length+'/3</div></div></div>'",
              "+'<table><tr><th>股票</th><th>股数</th><th>成本</th><th>现价</th><th>持仓盈亏</th><th>今日盈亏</th><th>占比</th><th>止损</th><th>止盈</th><th>信号</th><th>来源</th></tr>'+(rows||'<tr><td colspan=\"11\" class=\"empty\">空仓</td></tr>')+'</table>';",
              "}catch(e){el.innerHTML='<div class=\"err\">'+esc(e.message)+'</div>';}}",
              "async function loadReal(){var el=document.getElementById('realContent');el.innerHTML='<div class=\"empty\">加载中…</div>';try{",
              "var j=await fetch('/api/stock/accounts').then(function(r){return r.json()});var a=j.real;if(!a){el.innerHTML='<div class=\"empty\">真实账户未创建</div>';return;}",
              "var last=a.daily&&a.daily.length?a.daily[a.daily.length-1]:null;",
              "var advice='';",
              "try{var ar=await fetch('/api/stock/advisor/real').then(function(r){return r.json()});",
              "advice='<div class=\"advice green\"><div class=\"ah\">🧑‍💼 理财师建议</div><div class=\"at\"><b>风险等级：</b>'+esc(ar.riskLevel||'-')+'</div><div>'+esc(ar.overall||'-')+'</div></div>';",
              "}catch(e2){}",
              "var rows=(a.holdings||[]).map(function(h){",
              "var price=h.price!=null?h.price:h.costPrice;var pl=(price-h.costPrice)*h.shares;var plPct=h.costPrice>0?(price-h.costPrice)/h.costPrice*100:0;",
              "return '<tr style=\"cursor:pointer\" onclick=\"window.open('/api/stock/report?input='+h.code+'','_blank')\"><td><a href=\"/api/stock/report?input='+h.code+'\" target=\"_blank\" style=\"color:inherit;text-decoration:none\"><b>'+esc(h.name)+'</b><br><span style=\"color:#8a93b2;font-size:11px\">'+h.code+'</span></a></td><td>'+h.shares+'</td><td>'+fmt(h.costPrice)+'</td><td>'+fmt(price)+'</td><td style=\"color:'+pnlCls(pl)+'\">'+pnlTxt(pl,plPct)+'</td><td>'+(h.buyDate||'-')+'</td></tr>';}).join('');",
              "el.innerHTML=advice",
              "+'<div class=\"cards\">'",
              "+'<div class=\"card\"><div class=\"k\">持仓市值</div><div class=\"v '+(last&&last.pnl>=0?'up':'down')+'\">'+(last?fmt(last.holdingsValue,0):'-')+'</div></div>'",
              "+'<div class=\"card\"><div class=\"k\">浮动盈亏</div><div class=\"v '+(last&&last.pnl>=0?'up':'down')+'\">'+(last?pnlTxt(last.pnl,last.pnlPct):'-')+'</div></div>'",
              "+'<div class=\"card\"><div class=\"k\">持仓成本</div><div class=\"v\">'+(last?fmt(last.costValue,0):'-')+'</div></div>'",
              "+'<div class=\"card\"><div class=\"k\">沪深300</div><div class=\"v\">'+(last&&last.benchPct!=null?(last.benchPct>=0?'+':'')+fmt(last.benchPct,2)+'%':'—')+'</div></div></div>'",
              "+'<table><tr><th>股票</th><th>股数</th><th>成本</th><th>现价</th><th>浮盈亏</th><th>买入日</th></tr>'+(rows||'<tr><td colspan=\"6\" class=\"empty\">暂无持仓</td></tr>')+'</table>';",
              "}catch(e){el.innerHTML='<div class=\"err\">'+esc(e.message)+'</div>';}}",
              "async function loadDaily(){var el=document.getElementById('dailyContent');el.innerHTML='<div class=\"empty\">汇总加载中…</div>';try{",
              "var j=await fetch('/api/stock/summary').then(function(r){return r.json()});if(j.error){el.innerHTML='<div class=\"err\">'+esc(j.error)+'</div>';return;}",
              "var html='';",
              "if(j.index){html+='<div class=\"card\" style=\"margin-bottom:14px;font-size:13px\">📊 沪深300：<b>'+fmt(j.index.price)+'</b>（'+(j.index.pct>=0?'+':'')+fmt(j.index.pct,2)+'%）· 来源:'+esc(j.index.source)+'</div>';}",
              "html+='<h1 style=\"font-size:16px;color:#3b82f6;margin:16px 0 8px\">💰 模拟账户</h1>';",
              "var sl=j.sim&&j.sim.last,sh=j.sim&&j.sim.holdings||[];",
              "if(sl){html+='<div class=\"cards\"><div class=\"card\"><div class=\"k\">总资产</div><div class=\"v\">'+fmt(sl.totalValue,0)+'</div></div><div class=\"card\"><div class=\"k\">累计盈亏</div><div class=\"v '+(sl.pnl>=0?'up':'down')+'\">'+(sl.pnl>=0?'+':'')+fmt(sl.pnl,0)+'（'+(sl.pnlPct>=0?'+':'')+fmt(sl.pnlPct,2)+'%）</div></div><div class=\"card\"><div class=\"k\">沪深300</div><div class=\"v\">'+(sl.benchPct!=null?(sl.benchPct>=0?'+':'')+fmt(sl.benchPct,2)+'%':'—')+'</div></div></div>';}",
              "if(sh.length){html+='<table><tr><th>股票</th><th>股数</th><th>成本</th><th>现价</th><th>持仓盈亏</th><th>今日盈亏</th><th>占比</th><th>止损</th><th>止盈</th></tr>'+sh.map(function(h){var todayPl=(h.price-(h.prevClose!=null?h.prevClose:h.costPrice))*h.shares;var todayPlPct=h.prevClose>0?(h.price-h.prevClose)/h.prevClose*100:0;var sharePct=sl&&sl.totalValue>0?h.price*h.shares/sl.totalValue*100:0;return '<tr style=\"cursor:pointer\" onclick=\"window.open('/api/stock/report?input='+h.code+'','_blank')\"><td><a href=\"/api/stock/report?input='+h.code+'\" target=\"_blank\" style=\"color:inherit;text-decoration:none\"><b>'+esc(h.name)+'</b> '+h.code+'</a></td><td>'+h.shares+'</td><td>'+fmt(h.costPrice)+'</td><td>'+fmt(h.price)+'</td><td style=\"color:'+pnlCls(h.pl)+'\">'+pnlTxt(h.pl,h.plPct)+'</td><td style=\"color:'+pnlCls(todayPl)+'\">'+pnlTxt(todayPl,todayPlPct)+'</td><td>'+fmt(sharePct,1)+'%</td><td style=\"color:#2ebd85\">'+(h.stopLoss?fmt(h.stopLoss):'-')+'</td><td style=\"color:#f0483e\">'+(h.takeProfit?fmt(h.takeProfit):'-')+'</td></tr>';}).join('')+'</table>';}",
              "html+='<h1 style=\"font-size:16px;color:#2ebd85;margin:16px 0 8px\">💼 真实账户</h1>';",
              "var rl=j.real&&j.real.last,rh=j.real&&j.real.holdings||[];",
              "if(rl){html+='<div class=\"cards\"><div class=\"card\"><div class=\"k\">持仓市值</div><div class=\"v\">'+fmt(rl.holdingsValue,0)+'</div></div><div class=\"card\"><div class=\"k\">浮动盈亏</div><div class=\"v '+(rl.pnl>=0?'up':'down')+'\">'+(rl.pnl>=0?'+':'')+fmt(rl.pnl,0)+'（'+(rl.pnlPct>=0?'+':'')+fmt(rl.pnlPct,2)+'%）</div></div><div class=\"card\"><div class=\"k\">沪深300</div><div class=\"v\">'+(rl.benchPct!=null?(rl.benchPct>=0?'+':'')+fmt(rl.benchPct,2)+'%':'—')+'</div></div></div>';}",
              "if(rh.length){html+='<table><tr><th>股票</th><th>股数</th><th>成本</th><th>现价</th><th>浮盈亏</th></tr>'+rh.map(function(h){return '<tr style=\"cursor:pointer\" onclick=\"window.open('/api/stock/report?input='+h.code+'','_blank')\"><td><a href=\"/api/stock/report?input='+h.code+'\" target=\"_blank\" style=\"color:inherit;text-decoration:none\"><b>'+esc(h.name)+'</b> '+h.code+'</a></td><td>'+h.shares+'</td><td>'+fmt(h.costPrice)+'</td><td>'+fmt(h.price)+'</td><td style=\"color:'+pnlCls(h.pl)+'\">'+pnlTxt(h.pl,h.plPct)+'</td></tr>';}).join('')+'</table>';}",
              "html+='<h1 style=\"font-size:16px;color:#f5b942;margin:16px 0 8px\">⭐ 自选股票</h1>';",
              "if(j.watchlist&&j.watchlist.length){html+='<table><tr><th>股票</th><th>现价</th><th>涨跌</th><th>时机</th></tr>'+j.watchlist.map(function(w){var t=w.timing||{label:'观望',cls:'neutral'};var cm={buy:'b-buy',sell:'b-sell',watch:'b-watch',caution:'b-caution',neutral:'b-neutral'};return '<tr style=\"cursor:pointer\" onclick=\"window.open('/api/stock/report?input='+w.code+'','_blank')\"><td><a href=\"/api/stock/report?input='+w.code+'\" target=\"_blank\" style=\"color:inherit;text-decoration:none\"><b>'+esc(w.name)+'</b> '+w.code+'</a></td><td>'+fmt(w.price)+'</td><td style=\"color:'+(w.pct>=0?'#f0483e':'#2ebd85')+'\">'+(w.pct>=0?'+':'')+fmt(w.pct,2)+'%</td><td><span class=\"badge '+cm[t.cls]+'\">'+esc(t.label)+'</span></td></tr>';}).join('')+'</table>';}else{html+='<div class=\"empty\">暂无自选</div>';}",
              "el.innerHTML=html;",
              "}catch(e){el.innerHTML='<div class=\"err\">'+esc(e.message)+'</div>';}}",
              "</script>",
              "</div></body></html>"
            ];
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(page.join(""));
            return;
          }
          const data = await analyzeStock(input, {});
          const html = renderReport(data);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(html);
        } catch (err) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end('<!DOCTYPE html><html><body style="background:#0b0f1d;color:#f0483e;font-family:sans-serif;padding:40px">' +
            "报告生成失败：" + esc(err instanceof Error ? err.message : String(err)) +
            "</body></html>");
        }
      }
    });

    // 理财师建议（模拟账户）
    webServer.register({
      kind: "exact",
      path: "/api/stock/advisor/sim",
      handler: async (req, res) => {
        try {
          const { advisorSim } = await import("/Users/luochangdong/.dsh/skills/dsh-stock-analysis/scripts/advisor.mjs");
          const a = advisorSim([]);
          sendJson(res, 200, a);
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    });

    // 理财师建议（真实账户）
    webServer.register({
      kind: "exact",
      path: "/api/stock/advisor/real",
      handler: async (req, res) => {
        try {
          const { advisorReal } = await import("/Users/luochangdong/.dsh/skills/dsh-stock-analysis/scripts/advisor.mjs");
          const a = advisorReal([]);
          sendJson(res, 200, a);
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    });

    // 每日汇总 JSON（侧边栏面板用）
    webServer.register({
      kind: "exact",
      path: "/api/stock/summary",
      handler: async (req, res) => {
        try {
          const dir = pathMod.join(process.env.DSH_HOME || (osMod.homedir() + "/.dsh"), "storages", "stock-sim");
          const read = (f) => { try { return JSON.parse(fsMod.readFileSync(pathMod.join(dir, f), "utf8")); } catch (e) { return null; } };
          const sim = read("account.json");
          const real = read("real-account.json");
          const simLast = sim && sim.daily && sim.daily.length ? sim.daily[sim.daily.length - 1] : null;
          const realLast = real && real.daily && real.daily.length ? real.daily[real.daily.length - 1] : null;
          const { fetchQuotes, fetchIndex } = await import("/Users/luochangdong/.dsh/skills/dsh-stock-analysis/scripts/quotes.mjs");
          const simCodes = (sim && sim.holdings || []).map(h => h.code);
          const realCodes = (real && real.holdings || []).map(h => h.code);
          const allCodes = [...new Set([...simCodes, ...realCodes])];
          const q = allCodes.length ? await fetchQuotes(allCodes) : {};
          const fmtH = (h) => { const qq = q[String(h.code).replace(/^(sh|sz)/, "")]; const price = qq ? qq.price : h.costPrice; const pct = qq ? qq.pct : 0; const pl = (price - h.costPrice) * h.shares; const plPct = h.costPrice > 0 ? (price - h.costPrice) / h.costPrice * 100 : 0; return { code: h.code, name: h.name, shares: h.shares, costPrice: h.costPrice, price, pct, pl, plPct }; };
          const idx = await fetchIndex("000300").catch(() => null);
          // 自选（含五维信号，走完整管线尽力而为）
          let watchlist = [];
          try {
            const wlFile = pathMod.join(dir, "..", "stock-watchlist.json");
            const wlRaw = fsMod.existsSync(wlFile) ? JSON.parse(fsMod.readFileSync(wlFile, "utf8")) : [];
            const codes = (wlRaw || []).map(it => it.code);
            const wQ = codes.length ? await fetchQuotes(codes) : {};
            watchlist = (wlRaw || []).map(it => {
              const qq = wQ[String(it.code).replace(/^(sh|sz)/, "")];
              if (!qq) return null;
              let label = "观望", cls = "neutral";
              if (qq.pct >= 5) { label = "追高风险"; cls = "caution"; }
              else if (qq.pct >= 2) { label = "可关注"; cls = "watch"; }
              else if (qq.pct <= -3) { label = "回调关注"; cls = "watch"; }
              return { code: it.code, name: qq.name, price: qq.price, pct: qq.pct, timing: { label, cls } };
            }).filter(Boolean);
          } catch (e) {}
          sendJson(res, 200, {
            generatedAt: new Date().toISOString(),
            index: idx ? { price: idx.price, pct: idx.pct, source: idx.source } : null,
            sim: { last: simLast, holdings: (sim && sim.holdings || []).map(fmtH) },
            real: { last: realLast, holdings: (real && real.holdings || []).map(fmtH) },
            watchlist
          });
        } catch (err) {
          sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    });

    // 每日汇总（三合一：模拟/真实/自选 + 沪深300）
    webServer.register({
      kind: "exact",
      path: "/api/stock/daily-summary",
      handler: async (req, res) => {
        try {
          const dir = pathMod.join(process.env.DSH_HOME || (osMod.homedir() + "/.dsh"), "storages", "stock-sim");
          const read = (f) => { try { return JSON.parse(fsMod.readFileSync(pathMod.join(dir, f), "utf8")); } catch (e) { return null; } };
          const sim = read("account.json");
          const real = read("real-account.json");
          const simLast = sim && sim.daily && sim.daily.length ? sim.daily[sim.daily.length - 1] : null;
          const realLast = real && real.daily && real.daily.length ? real.daily[real.daily.length - 1] : null;
          // 实时行情（腾讯/新浪）
          const { fetchQuotes, fetchIndex } = await import("/Users/luochangdong/openclawWorkspace/dsh-stock-panel/../../.dsh/skills/dsh-stock-analysis/scripts/quotes.mjs");
          const simCodes = (sim && sim.holdings || []).map(h => h.code);
          const realCodes = (real && real.holdings || []).map(h => h.code);
          const allCodes = [...new Set([...simCodes, ...realCodes])];
          const q = allCodes.length ? await fetchQuotes(allCodes) : {};
          const fmtH = (h) => { const qq = q[String(h.code).replace(/^(sh|sz)/, "")]; const price = qq ? qq.price : h.costPrice; const pl = (price - h.costPrice) * h.shares; const plPct = h.costPrice > 0 ? (price - h.costPrice) / h.costPrice * 100 : 0; return { code: h.code, name: h.name, shares: h.shares, costPrice: h.costPrice, price, pl, plPct }; };
          const idx = await fetchIndex("000300").catch(() => null);
          const rows = [
            "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'/><title>每日汇总 · 股票分析</title><style>",
            "body{background:#0b0f1d;color:#e6eaf5;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;margin:0;padding:30px;line-height:1.6}",
            ".wrap{max-width:860px;margin:0 auto} h1{font-size:24px;margin:0 0 6px} .sub{color:#8a93b2;font-size:13px;margin-bottom:20px}",
            ".card{background:#121829;border:1px solid #232c47;border-radius:14px;padding:20px;margin-bottom:16px}",
            ".card h2{font-size:15px;color:#3b82f6;margin:0 0 12px;font-weight:600}",
            ".up{color:#f0483e} .down{color:#2ebd85}",
            ".cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}",
            ".cardx{background:#0e1424;border:1px solid #232c47;border-radius:10px;padding:12px}",
            ".cardx .k{color:#8a93b2;font-size:11px;margin-bottom:4px} .cardx .v{font-size:17px;font-weight:700}",
            "table{width:100%;border-collapse:collapse;font-size:13.5px}",
            "th{color:#8a93b2;font-size:12px;text-align:left;padding:8px 10px;border-bottom:1px solid #232c47}",
            "td{padding:9px 10px;border-bottom:1px solid #1b2440}",
            "a{color:#3b82f6;text-decoration:none} .back{margin-bottom:16px;display:inline-block}",
            "</style></head><body><div class='wrap'>",
            "<a class='back' href='/api/stock/report'>← 返回门户</a>",
            "<h1>📊 每日汇总</h1>",
            "<div class='sub'>" + new Date().toLocaleString("zh-CN") + " · 数据源：多源实时（腾讯/新浪）</div>",
            "<div class='card'><h2>📈 大盘基准</h2>",
            "<div>沪深300：<b>" + (idx ? Number(idx.price).toFixed(2) : "—") + "</b>（" + (idx ? (idx.pct >= 0 ? "+" : "") + Number(idx.pct).toFixed(2) + "%" : "—") + "）· 来源 " + (idx ? idx.source : "—") + "</div></div>",
            "<div class='card'><h2>💰 模拟账户</h2>",
            "<div class='cards'>",
            "<div class='cardx'><div class='k'>总资产</div><div class='v'>" + (simLast ? Number(simLast.totalValue).toLocaleString() : "-") + "</div></div>",
            "<div class='cardx'><div class='k'>累计盈亏</div><div class='v " + (simLast && simLast.pnl >= 0 ? "up" : "down") + "'>" + (simLast ? (simLast.pnl >= 0 ? "+" : "") + Number(simLast.pnl).toLocaleString() + "（" + (simLast.pnlPct >= 0 ? "+" : "") + Number(simLast.pnlPct).toFixed(2) + "%）" : "-") + "</div></div>",
            "<div class='cardx'><div class='k'>沪深300</div><div class='v'>" + (simLast && simLast.benchPct != null ? (simLast.benchPct >= 0 ? "+" : "") + Number(simLast.benchPct).toFixed(2) + "%" : "—") + "</div></div>",
            "</div>",
            "<table><tr><th>股票</th><th>股数</th><th>成本</th><th>现价</th><th>浮盈亏</th></tr>" + ((sim && sim.holdings || []).map(h => { const f = fmtH(h); return "<tr><td>" + esc(f.name) + " (" + f.code + ")</td><td>" + f.shares + "</td><td>" + Number(f.costPrice).toFixed(2) + "</td><td>" + Number(f.price).toFixed(2) + "</td><td class='" + (f.pl >= 0 ? "up" : "down") + "'>" + (f.pl >= 0 ? "+" : "") + Number(f.pl).toLocaleString() + "（" + (f.plPct >= 0 ? "+" : "") + Number(f.plPct).toFixed(2) + "%）</td></tr>"; }).join("") || "<tr><td colspan='5' style='color:#6b7290'>空仓</td></tr>") + "</table></div>",
            "<div class='card'><h2>💼 真实账户</h2>",
            "<div class='cards'>",
            "<div class='cardx'><div class='k'>持仓市值</div><div class='v'>" + (realLast ? Number(realLast.holdingsValue).toLocaleString() : "-") + "</div></div>",
            "<div class='cardx'><div class='k'>浮动盈亏</div><div class='v " + (realLast && realLast.pnl >= 0 ? "up" : "down") + "'>" + (realLast ? (realLast.pnl >= 0 ? "+" : "") + Number(realLast.pnl).toLocaleString() + "（" + (realLast.pnlPct >= 0 ? "+" : "") + Number(realLast.pnlPct).toFixed(2) + "%）" : "-") + "</div></div>",
            "<div class='cardx'><div class='k'>沪深300</div><div class='v'>" + (realLast && realLast.benchPct != null ? (realLast.benchPct >= 0 ? "+" : "") + Number(realLast.benchPct).toFixed(2) + "%" : "—") + "</div></div>",
            "</div>",
            "<table><tr><th>股票</th><th>股数</th><th>成本</th><th>现价</th><th>浮盈亏</th></tr>" + ((real && real.holdings || []).map(h => { const f = fmtH(h); return "<tr><td>" + esc(f.name) + " (" + f.code + ")</td><td>" + f.shares + "</td><td>" + Number(f.costPrice).toFixed(2) + "</td><td>" + Number(f.price).toFixed(2) + "</td><td class='" + (f.pl >= 0 ? "up" : "down") + "'>" + (f.pl >= 0 ? "+" : "") + Number(f.pl).toLocaleString() + "（" + (f.plPct >= 0 ? "+" : "") + Number(f.plPct).toFixed(2) + "%）</td></tr>"; }).join("") || "<tr><td colspan='5' style='color:#6b7290'>暂无持仓</td></tr>") + "</table></div>",
            "<div class='card'><h2>⭐ 自选股票</h2>",
            "<div class='dim' style='color:#6b7290;font-size:12px'>前往门户查看完整五维分析（信号/位置/情绪/增长）</div></div>",
            "</div></body></html>"
          ];
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(rows.join(""));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<!DOCTYPE html><html><body style='background:#0b0f1d;color:#f0483e;padding:40px;font-family:sans-serif'>每日汇总错误：" + esc(err.message) + "</body></html>");
        }
      }
    });
  }
};

export { apply, inject, analyzeStock };
