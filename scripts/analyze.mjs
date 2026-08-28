#!/usr/bin/env node
/**
 * analyze.mjs — 股票技术分析与信号引擎（无依赖）
 *
 * 输入：fetch.mjs 的输出 JSON（stdin 或文件），可选持仓参数
 * 用法：
 *   node analyze.mjs <data.json> [--shares 100 --cost 1300] [--out result.json]
 *   node fetch.mjs 600519 --days 120 --out d.json && node analyze.mjs d.json --shares 100 --cost 1300
 *
 * 输出：
 *   { indicators, signals, sentiment, levels, position? }
 *   - indicators: MA5/10/20/60, MACD, RSI, KDJ, BOLL, 量能
 *   - signals   : score(-100~100) + verdict + factors[] + summary
 *   - sentiment : score(-1~1) + label + news[] 逐条打分 + summary
 *   - levels    : 支撑/压力位（近期高低点 + 斐波那契 + 均线）
 *   - position  : 持仓盈亏（shares/cost 提供时）
 */

// ---------- 工具 ----------
function sma(vals, n) {
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    if (i < n - 1) { out.push(null); continue; }
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) s += vals[k];
    out.push(s / n);
  }
  return out;
}
function ema(vals, n) {
  const out = [];
  const k = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < vals.length; i++) {
    prev = (prev === null) ? vals[i] : vals[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
function stddev(vals, n, mean) {
  let s = 0;
  for (let k = vals.length - n; k < vals.length; k++) s += Math.pow(vals[k] - mean, 2);
  return Math.sqrt(s / n);
}
function round(v, d = 2) { return v === null || v === undefined || isNaN(v) ? null : Number(v.toFixed(d)); }
function fmt(v, d = 2) { return v === null || v === undefined ? "-" : Number(v).toFixed(d); }
function last(vals) { return vals[vals.length - 1]; }
function prev(vals) { return vals[vals.length - 2]; }

// ---------- 指标计算 ----------
function calcIndicators(kline) {
  const closes = kline.map(k => k.close);
  const highs = kline.map(k => k.high);
  const lows = kline.map(k => k.low);
  const vols = kline.map(k => k.volume);
  const n = kline.length;
  const i = n - 1;

  const ma5 = sma(closes, 5), ma10 = sma(closes, 10), ma20 = sma(closes, 20), ma60 = sma(closes, 60);

  // MACD (12,26,9)，A股惯例柱 = 2*(DIF-DEA)
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const dif = closes.map((_, idx) => e12[idx] - e26[idx]);
  const dea = ema(dif, 9);
  const hist = dif.map((v, idx) => (v - dea[idx]) * 2);

  // RSI (Wilder)
  function rsi(period) {
    let gain = 0, loss = 0;
    for (let k = 1; k <= period; k++) {
      const ch = closes[k] - closes[k - 1];
      if (ch >= 0) gain += ch; else loss -= ch;
    }
    let avgG = gain / period, avgL = loss / period;
    for (let k = period + 1; k < n; k++) {
      const ch = closes[k] - closes[k - 1];
      avgG = (avgG * (period - 1) + Math.max(ch, 0)) / period;
      avgL = (avgL * (period - 1) + Math.max(-ch, 0)) / period;
    }
    return avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  const rsi6 = rsi(6), rsi14 = rsi(14);

  // KDJ (9,3,3)
  let rsv = 50;
  const kArr = [], dArr = [];
  for (let k = 0; k < n; k++) {
    const s = Math.max(0, k - 8);
    const hh = Math.max(...highs.slice(s, k + 1));
    const ll = Math.min(...lows.slice(s, k + 1));
    rsv = hh === ll ? 50 : (closes[k] - ll) / (hh - ll) * 100;
    const kk = k === 0 ? 50 : (2 / 3) * (kArr[k - 1] ?? 50) + (1 / 3) * rsv;
    const dd = k === 0 ? 50 : (2 / 3) * (dArr[k - 1] ?? 50) + (1 / 3) * kk;
    kArr.push(kk); dArr.push(dd);
  }
  const jArr = kArr.map((k, idx) => 3 * k - 2 * dArr[idx]);
  const K = last(kArr), D = last(dArr), J = last(jArr);

  // BOLL (20,2)
  const mid = ma20[i];
  const sd = stddev(closes, 20, mid);
  const upper = mid + 2 * sd, lower = mid - 2 * sd;

  // 量能
  const volMa5 = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const volMa10 = vols.slice(-10).reduce((a, b) => a + b, 0) / 10;

  return {
    ma5: round(last(ma5)), ma10: round(last(ma10)), ma20: round(last(ma20)), ma60: round(last(ma60)),
    ma20Slope: round((last(ma20) - ma20[Math.max(0, n - 6)]) / (ma20[Math.max(0, n - 6)] || 1) * 100, 3),
    macd: {
      dif: round(last(dif)), dea: round(last(dea)), hist: round(last(hist)),
      goldenCross5d: diffCross(dif, dea, 5, true), deadCross5d: diffCross(dif, dea, 5, false),
      histTurnPos: prev(hist) <= 0 && last(hist) > 0,
    },
    rsi6: round(rsi6), rsi14: round(rsi14),
    kdj: { k: round(K), d: round(D), j: round(J), kPrev: round(kArr[n - 2] ?? 50), dPrev: round(dArr[n - 2] ?? 50) },
    boll: { upper: round(upper), mid: round(mid), lower: round(lower) },
    volMa5: round(volMa5), volMa10: round(volMa10),
    lastVolume: round(last(vols)),
    price: last(closes),
    maSeries: { ma5: ma5.slice(-n), ma10: ma10.slice(-n), ma20: ma20.slice(-n), ma60: ma60.slice(-n) },
  };
}
function diffCross(dif, dea, lookback, golden) {
  const start = Math.max(1, dif.length - lookback);
  for (let k = dif.length - 1; k >= start; k--) {
    if (golden && dif[k] > dea[k] && dif[k - 1] <= dea[k - 1]) return true;
    if (!golden && dif[k] < dea[k] && dif[k - 1] >= dea[k - 1]) return true;
  }
  return false;
}

// ---------- 买卖信号引擎 ----------
function calcSignals(kline, ind) {
  const close = last(kline.map(k => k.close));
  const factors = [];
  const add = (name, score, desc, dir) => factors.push({ name, score, desc, dir });

  // 1. 趋势：均线多空排列
  const bullArrange = ind.ma5 < ind.ma10 && ind.ma10 < ind.ma20 && ind.ma20 < ind.ma60 ? -1 : 0;
  if (ind.ma5 > ind.ma10 && ind.ma10 > ind.ma20) { add("均线排列", 2, "MA5>MA10>MA20 多头排列，趋势向上", "多"); }
  else if (ind.ma5 < ind.ma10 && ind.ma10 < ind.ma20) { add("均线排列", -2, "MA5<MA10<MA20 空头排列，趋势向下", "空"); }
  else add("均线排列", 0, "均线缠绕，方向不明", "中性");

  // 2. 价格相对 MA20/MA60
  if (close > ind.ma20 && close > ind.ma60) add("中期趋势", 1.5, "股价站上 MA20 与 MA60，中期趋势健康", "多");
  else if (close < ind.ma20 && close < ind.ma60) add("中期趋势", -1.5, "股价跌破 MA20 与 MA60，中期走弱", "空");
  else if (close > ind.ma20) add("中期趋势", 0.5, "股价位于 MA20 上方、MA60 下方", "多");
  else add("中期趋势", -0.5, "股价位于 MA20 下方、MA60 上方", "空");

  // 3. MACD
  if (ind.macd.goldenCross5d) add("MACD", 2, "近5日 MACD 金叉，动量转强", "多");
  else if (ind.macd.deadCross5d) add("MACD", -2, "近5日 MACD 死叉，动量转弱", "空");
  else if (ind.macd.histTurnPos) add("MACD", 1, "MACD 柱由负转正，动能回升", "多");
  else if (ind.macd.dif > ind.macd.dea) add("MACD", 0.5, "DIF 在 DEA 上方，多头占优", "多");
  else add("MACD", -0.5, "DIF 在 DEA 下方，空头占优", "空");

  // 4. RSI
  if (ind.rsi14 >= 80) add("RSI", -1.5, "RSI14=" + ind.rsi14 + " 严重超买，短线追高风险大", "空");
  else if (ind.rsi14 <= 20) add("RSI", 1.5, "RSI14=" + ind.rsi14 + " 超卖，或有反弹机会", "多");
  else if (ind.rsi14 > 60) add("RSI", 0.5, "RSI14=" + ind.rsi14 + " 偏强", "多");
  else if (ind.rsi14 < 40) add("RSI", -0.5, "RSI14=" + ind.rsi14 + " 偏弱", "空");
  else add("RSI", 0, "RSI14=" + ind.rsi14 + " 中性区域", "中性");

  // 5. KDJ（真实金叉/死叉：昨日 K<=D 今日 K>D 为金叉，反之死叉）
  const j = ind.kdj.j;
  const kdjGolden = ind.kdj.k > ind.kdj.d && ind.kdj.kPrev <= ind.kdj.dPrev;
  const kdjDead = ind.kdj.k < ind.kdj.d && ind.kdj.kPrev >= ind.kdj.dPrev;
  if (kdjGolden) add("KDJ", 2, "KDJ 金叉向上（K " + fmt(ind.kdj.k, 1) + " 上穿 D " + fmt(ind.kdj.d, 1) + "）", "多");
  else if (kdjDead) add("KDJ", -1.5, "KDJ 死叉向下（K " + fmt(ind.kdj.k, 1) + " 下穿 D " + fmt(ind.kdj.d, 1) + "）", "空");
  else if (ind.kdj.k > ind.kdj.d) add("KDJ", 0.5, "KDJ K 线在 D 线上方，多头占优", "多");
  else add("KDJ", -0.5, "KDJ K 线在 D 线下方，空头占优", "空");
  if (j > 100) add("KDJ超买", -1, "J=" + fmt(j) + " 超买，短线回落风险", "空");
  else if (j < 0) add("KDJ超卖", 1, "J=" + fmt(j) + " 超卖，短线或有反弹", "多");

  // 6. 量能
  const volRatio = ind.lastVolume / (ind.volMa5 || 1);
  const lastK = last(kline), prevK = kline[kline.length - 2];
  if (lastK.close > prevK.close && volRatio > 1.2) add("量能", 1, "放量上涨（量比均量 " + fmt(volRatio, 1) + "x），资金进场", "多");
  else if (lastK.close < prevK.close && volRatio < 0.8) add("量能", 0.5, "缩量下跌，抛压减轻，或近企稳", "多");
  else if (lastK.close < prevK.close && volRatio > 1.2) add("量能", -1, "放量下跌（量比均量 " + fmt(volRatio, 1) + "x），资金出逃", "空");
  else add("量能", 0, "量能平稳", "中性");

  // 7. BOLL 位置
  if (close >= ind.boll.upper) add("布林带", -0.5, "触及布林上轨，短线偏热", "空");
  else if (close <= ind.boll.lower) add("布林带", 0.5, "触及布林下轨，均值回归机会", "多");
  else add("布林带", 0, "位于布林通道中部", "中性");

  // 8. 位置：距60日高低点
  const win = kline.slice(-60);
  const hi60 = Math.max(...win.map(k => k.high));
  const lo60 = Math.min(...win.map(k => k.low));
  const drawdown = (close - hi60) / hi60 * 100;
  if (drawdown <= -20) add("超跌", 1.5, "距60日高点回撤 " + fmt(drawdown, 1) + "%，超跌区间", "多");
  else if (drawdown <= -10) add("超跌", 0.5, "距60日高点回撤 " + fmt(drawdown, 1) + "%，回调较深", "多");
  else if (drawdown >= -2) add("新高", -1, "接近60日高点，追高需谨慎", "空");

  // 汇总：多空相对强度 → -100..100（不受因子数量影响）
  // bullSum = 正分总和，bearSum = 负分绝对值总和
  // score = (bullSum - bearSum) / (bullSum + bearSum) * 100，天然落在 -100..100
  let bullSum = 0, bearSum = 0;
  for (const f of factors) { if (f.score > 0) bullSum += f.score; else if (f.score < 0) bearSum += -f.score; }
  const raw = bullSum - bearSum;
  const total = bullSum + bearSum;
  const score = total > 0
    ? Math.round(raw / total * 100)
    : 0;
  let verdict;
  if (score >= 35) verdict = "买入";
  else if (score >= 12) verdict = "关注";
  else if (score > -12) verdict = "观望";
  else if (score > -35) verdict = "谨慎";
  else verdict = "回避";

  const bullCount = factors.filter(f => f.dir === "多").length;
  const bearCount = factors.filter(f => f.dir === "空").length;
  const summary = "综合信号分 " + score + "/100（" + verdict + "）。多头因子 " + bullCount + " 个，空头因子 " + bearCount + " 个。"
    + (score >= 35 ? "技术面偏强，可关注回调买入机会。" : score <= -35 ? "技术面明显走弱，建议回避或减仓。" : score >= 12 ? "技术面温和偏多，等待放量确认。" : score <= -12 ? "技术面偏弱，不宜抄底。" : "多空交织，建议观望等待方向明确。");

  return { score, verdict, factors, summary, range: { hi60, lo60, drawdown: round(drawdown, 2) } };
}

// ---------- 新闻情绪 ----------
const POS_WORDS = ["增长", "上涨", "大涨", "涨停", "新高", "突破", "盈利", "净利", "预增", "超预期", "利好", "中标", "回购", "增持", "合作", "签约", "投产", "扩产", "涨价", "复苏", "景气", "创新高", "翻倍", "向好", "复苏", "放量上涨", "获准", "获批", "受益", "订单", "并购", "重组", "扭亏", "分红", "送转", "强势", "领涨", "流入"];
const NEG_WORDS = ["下跌", "大跌", "跌停", "新低", "跌破", "亏损", "预亏", "净亏", "下滑", "利空", "减持", "质押", "处罚", "违规", "诉讼", "立案", "调查", "退市", "风险", "预警", "下调", "被查", "爆雷", "违约", "诉讼", "流拍", "解禁", "承压", "低迷", "疲软", "萎缩", "缩水", "跑路", "崩盘", "恐慌", "流出", "被套", "造假", "问询", "警示"];

function sentimentForNews(text) {
  let pos = 0, neg = 0;
  for (const w of POS_WORDS) { if (text.includes(w)) pos++; }
  for (const w of NEG_WORDS) { if (text.includes(w)) neg++; }
  if (pos === 0 && neg === 0) return { score: 0, label: "中性" };
  const raw = (pos - neg) / (pos + neg);
  const score = Math.max(-1, Math.min(1, raw));
  return { score, label: score > 0.2 ? "利好" : score < -0.2 ? "利空" : "中性" };
}

function calcSentiment(news, quote) {
  const scored = news.map(n => {
    const s = sentimentForNews(n.title + " " + n.summary);
    return { ...n, senti: s };
  });
  let acc = 0, wsum = 0;
  for (const n of scored) {
    const w = n.kind === "related" ? 1 : 0.3; // 相关新闻权重更高
    acc += n.senti.score * w;
    wsum += w;
  }
  let score = wsum > 0 ? acc / wsum : 0;
  // 结合当日价格表现（±0.2）
  score = Math.max(-1, Math.min(1, score * 0.7 + (quote.pct > 0 ? 0.15 : quote.pct < 0 ? -0.15 : 0)));
  const label = score >= 0.25 ? "看多" : score <= -0.25 ? "看空" : "中性";
  const summary = "新闻情绪分 " + fmt(score, 2) + "/1.0（" + label + "）。相关新闻 " +
    scored.filter(n => n.kind === "related").length + " 条，大盘快讯 " +
    scored.filter(n => n.kind === "market").length + " 条。当日涨跌 " + fmt(quote.pct, 2) + "%。";
  return { score: round(score, 3), label, news: scored, summary };
}

// ---------- 支撑压力 ----------
function calcLevels(kline, ind) {
  const closes = kline.map(k => k.close);
  const win = kline.slice(-60);
  const hi60 = Math.max(...win.map(k => k.high));
  const lo60 = Math.min(...win.map(k => k.low));
  const price = last(closes);
  const range = hi60 - lo60;
  const fibs = [0.382, 0.5, 0.618].map(f => ({ pct: f, price: round(hi60 - range * f) }));
  const supports = [], resistances = [];
  // 支撑必须低于现价，压力必须高于现价（避免倒挂：压力 < 现价 < 支撑）
  const push = (arr, p, why) => {
    if (!p || isNaN(p)) return;
    if (arr === supports) { if (p < price * 0.999) arr.push({ price: round(p), why }); }
    else { if (p > price * 1.001) arr.push({ price: round(p), why }); }
  };
  // 均线：低于现价做支撑，高于现价做压力
  push(supports, ind.ma20, "MA20"); push(resistances, ind.ma20, "MA20");
  push(supports, ind.ma60, "MA60"); push(resistances, ind.ma60, "MA60");
  push(supports, ind.boll.lower, "布林下轨"); push(resistances, ind.boll.upper, "布林上轨");
  push(supports, lo60, "60日低点"); push(resistances, hi60, "60日高点");
  for (const f of fibs) { if (f.price < price) push(supports, f.price, "斐波那契 " + (f.pct * 100) + "%"); }
  for (const f of fibs) { if (f.price > price) push(resistances, f.price, "斐波那契 " + (f.pct * 100) + "%"); }
  const uniq = arr => [...new Map(arr.map(x => [x.price, x])).values()].sort((a, b) => a.price - b.price);
  const s = uniq(supports).slice(-3);
  const r = uniq(resistances).slice(0, 3);
  return { supports: s, resistances: r, recentHigh: hi60, recentLow: lo60 };
}

// ---------- 未来增长评分（基本面） ----------
function calcGrowth(data) {
  const fund = data.fundamentals || [];
  const val = data.valuation || {};
  const quote = data.quote || {};
  const factors = [];
  const add = (name, score, desc, dir) => factors.push({ name, score, desc, dir });

  const latest = fund[0] || null;
  const prev1 = fund[1] || null;
  const prev2 = fund[2] || null;

  // 1. 最新报告期净利同比
  const npy = latest && latest.netProfitYoy;
  if (npy !== null && npy !== undefined) {
    if (npy >= 30) add("净利增速", 2, "净利同比 " + fmt(npy, 1) + "%，高速增长", "多");
    else if (npy >= 15) add("净利增速", 1.5, "净利同比 " + fmt(npy, 1) + "%，稳健增长", "多");
    else if (npy >= 5) add("净利增速", 0.8, "净利同比 " + fmt(npy, 1) + "%，温和增长", "多");
    else if (npy >= 0) add("净利增速", 0.2, "净利同比 " + fmt(npy, 1) + "%，基本持平", "中性");
    else if (npy >= -10) add("净利增速", -0.8, "净利同比 " + fmt(npy, 1) + "%，小幅下滑", "空");
    else add("净利增速", -2, "净利同比 " + fmt(npy, 1) + "%，明显下滑", "空");
  } else add("净利增速", 0, "暂无净利增速数据", "中性");

  // 2. 营收同比
  const rvy = latest && latest.revenueYoy;
  if (rvy !== null && rvy !== undefined) {
    if (rvy >= 20) add("营收增速", 1.5, "营收同比 " + fmt(rvy, 1) + "%，增长强劲", "多");
    else if (rvy >= 10) add("营收增速", 1, "营收同比 " + fmt(rvy, 1) + "%，稳定增长", "多");
    else if (rvy >= 0) add("营收增速", 0.3, "营收同比 " + fmt(rvy, 1) + "%，平稳", "中性");
    else add("营收增速", -1, "营收同比 " + fmt(rvy, 1) + "%，收缩", "空");
  } else add("营收增速", 0, "暂无营收增速数据", "中性");

  // 3. 增长趋势：近三季净利同比是否改善
  if (latest && prev1 && prev2) {
    const seq = [prev2.netProfitYoy, prev1.netProfitYoy, latest.netProfitYoy].filter(v => v !== null && v !== undefined);
    if (seq.length === 3) {
      if (seq[2] > seq[1] && seq[1] > seq[0]) add("增长趋势", 1.5, "净利同比连续改善（" + seq.map(v => fmt(v, 0)).join("→") + "%），拐点向上", "多");
      else if (seq[2] > seq[1]) add("增长趋势", 0.8, "净利同比边际改善（" + fmt(seq[2], 0) + "%），动能回升", "多");
      else if (seq[2] < seq[0]) add("增长趋势", -1, "净利同比走弱（" + fmt(seq[2], 0) + "%），增长承压", "空");
      else add("增长趋势", 0, "增长趋势平稳", "中性");
    } else add("增长趋势", 0, "增长趋势数据不足", "中性");
  } else add("增长趋势", 0, "增长趋势数据不足", "中性");

  // 4. ROE 质量
  const roe = latest && latest.roe;
  if (roe !== null && roe !== undefined) {
    if (roe >= 15) add("盈利能力", 1.5, "ROE " + fmt(roe, 1) + "%，盈利质量优秀", "多");
    else if (roe >= 10) add("盈利能力", 1, "ROE " + fmt(roe, 1) + "%，盈利质量良好", "多");
    else if (roe >= 5) add("盈利能力", 0.3, "ROE " + fmt(roe, 1) + "%，盈利质量一般", "中性");
    else add("盈利能力", -1, "ROE " + fmt(roe, 1) + "%，盈利质量较差", "空");
  } else add("盈利能力", 0, "暂无 ROE 数据", "中性");

  // 5. 毛利率
  const gm = latest && latest.grossMargin;
  if (gm !== null && gm !== undefined) {
    if (gm >= 40) add("毛利率", 1, "毛利率 " + fmt(gm, 1) + "%，护城河深厚", "多");
    else if (gm >= 25) add("毛利率", 0.5, "毛利率 " + fmt(gm, 1) + "%，具备竞争力", "多");
    else if (gm >= 10) add("毛利率", 0, "毛利率 " + fmt(gm, 1) + "%，行业一般水平", "中性");
    else add("毛利率", -0.5, "毛利率 " + fmt(gm, 1) + "%，竞争激烈", "空");
  } else add("毛利率", 0, "暂无毛利率数据", "中性");

  // 6. 估值匹配：PE × 净利增速（PEG 思想，简化）
  const pe = val.peDynamic || val.peTtm || null;
  const growth = latest && latest.netProfitYoy;
  if (pe !== null && growth !== null && growth !== undefined) {
    if (growth > 0) {
      const peg = pe / growth;
      if (peg <= 1) add("估值匹配", 1.5, "PEG≈" + fmt(peg, 2) + "（PE " + fmt(pe, 1) + " / 增速 " + fmt(growth, 1) + "%），估值合理", "多");
      else if (peg <= 1.5) add("估值匹配", 0.8, "PEG≈" + fmt(peg, 2) + "，估值略高但可接受", "多");
      else if (peg <= 2.5) add("估值匹配", 0, "PEG≈" + fmt(peg, 2) + "，估值偏高", "中性");
      else add("估值匹配", -1, "PEG≈" + fmt(peg, 2) + "，估值明显偏高", "空");
    } else if (pe > 0) {
      add("估值匹配", -0.5, "盈利下滑但 PE " + fmt(pe, 1) + "，估值不便宜", "空");
    }
  } else add("估值匹配", 0, "估值/增速数据不足", "中性");

  // 汇总
  const raw = factors.reduce((s, f) => s + f.score, 0);
  const score = Math.max(-100, Math.min(100, Math.round(raw / 10 * 100)));
  let label;
  if (score >= 40) label = "高增长";
  else if (score >= 20) label = "稳健增长";
  else if (score > -20) label = "增长平稳";
  else if (score > -45) label = "增长承压";
  else label = "明显萎缩";
  const bullCount = factors.filter(f => f.dir === "多").length;
  const bearCount = factors.filter(f => f.dir === "空").length;
  const summary = "未来增长分 " + score + "/100（" + label + "）。多头因子 " + bullCount + " 个，空头因子 " + bearCount + " 个。"
    + (score >= 40 ? "基本面增长强劲，具备成长性。" : score >= 20 ? "基本面稳步增长，值得关注。" : score > -20 ? "基本面平稳，缺乏明确增长驱动。" : "基本面走弱，成长性存疑。");

  return {
    score, label, factors, summary,
    fundamentals: fund.slice(0, 4),
    valuation: val,
    quote,
  };
}

// ---------- 持仓盈亏 ----------
/** 双向位置分析（单股版）：低位买入信号 + 高位卖出信号
 *  buyScore  (0-100)：回撤深/区间低位/超卖/布林下轨/低位放量 → 越接近100越适合低吸
 *  sellScore (0-100)：区间高位/超买/接近高点/放量滞涨/高位放量下跌 → 越接近100越该止盈减仓
 */
function calcPositionAnalysis(kline, ind) {
  const closes = kline.map(k => k.close);
  const close = closes[closes.length - 1];
  const win = kline.slice(-60);
  const hi60 = Math.max(...win.map(k => k.high));
  const lo60 = Math.min(...win.map(k => k.low));
  const dd = (close - hi60) / hi60 * 100;
  const pos = (close - lo60) / (hi60 - lo60) * 100;
  const rsi = ind.rsi14;
  const volRatio = ind.lastVolume / (ind.volMa5 || 1);
  const lastK = kline[kline.length - 1], prevK = kline[kline.length - 2];
  const upDay = lastK.close > prevK.close;
  const volUp = volRatio > 1.3;

  let buy = 0, sell = 0;
  const buyNotes = [], sellNotes = [];

  if (dd <= -30) { buy += 2.5; buyNotes.push("距60日高点回撤 " + dd.toFixed(1) + "%，深度回调"); }
  else if (dd <= -20) { buy += 2; buyNotes.push("距60日高点回撤 " + dd.toFixed(1) + "%，超跌"); }
  else if (dd <= -10) { buy += 1; buyNotes.push("距60日高点回撤 " + dd.toFixed(1) + "%，回调较深"); }
  if (dd > -5) { sell += 2; sellNotes.push("接近60日高点（回撤仅 " + dd.toFixed(1) + "%）"); }
  else if (dd > -10) { sell += 0.8; sellNotes.push("距60日高点较近（回撤 " + dd.toFixed(1) + "%）"); }

  if (pos <= 15) { buy += 1.8; buyNotes.push("位于60日区间低位（" + pos.toFixed(0) + "%）"); }
  else if (pos <= 30) { buy += 1.2; buyNotes.push("位于60日区间中低位（" + pos.toFixed(0) + "%）"); }
  else if (pos <= 45) { buy += 0.5; buyNotes.push("位于60日区间中位偏下（" + pos.toFixed(0) + "%）"); }
  if (pos >= 85) { sell += 2.2; sellNotes.push("位于60日区间高位（" + pos.toFixed(0) + "%）"); }
  else if (pos >= 70) { sell += 1.2; sellNotes.push("位于60日区间中高位（" + pos.toFixed(0) + "%）"); }
  else if (pos >= 55) { sell += 0.4; sellNotes.push("位于60日区间中位偏上（" + pos.toFixed(0) + "%）"); }

  if (close <= ind.boll.lower * 1.01) { buy += 1.2; buyNotes.push("贴近布林下轨，均值回归机会"); }
  if (close >= ind.boll.upper * 0.99) { sell += 1.2; sellNotes.push("贴近布林上轨，短线偏热"); }

  if (rsi <= 30) { buy += 1.2; buyNotes.push("RSI " + rsi.toFixed(1) + " 超卖"); }
  else if (rsi >= 70) { sell += 1.5; sellNotes.push("RSI " + rsi.toFixed(1) + " 超买"); }
  else if (rsi >= 60) { sell += 0.5; sellNotes.push("RSI " + rsi.toFixed(1) + " 偏强"); }

  if (upDay && volUp && pos <= 40) { buy += 1.5; buyNotes.push("低位放量上涨（量比 " + volRatio.toFixed(1) + "x），资金进场"); }
  if (upDay && volUp && pos >= 60) { sell += 1; sellNotes.push("高位放量上涨（量比 " + volRatio.toFixed(1) + "x），警惕诱多"); }
  if (!upDay && volUp && pos >= 70) { sell += 1.8; sellNotes.push("高位放量下跌（量比 " + volRatio.toFixed(1) + "x），资金出逃"); }
  if (!upDay && !volUp && pos >= 80) { sell += 0.8; sellNotes.push("高位缩量滞涨，上涨乏力"); }

  const buyScore = Math.max(0, Math.min(100, Math.round(buy / 10 * 100)));
  const sellScore = Math.max(0, Math.min(100, Math.round(sell / 10 * 100)));

  let zone;
  if (pos >= 80) zone = "高位区";
  else if (pos >= 65) zone = "中高位";
  else if (pos >= 35) zone = "中位";
  else if (pos >= 18) zone = "中低位";
  else zone = "低位区";

  let bias;
  if (buyScore >= 55 && sellScore < 40) bias = "低位买入区";
  else if (sellScore >= 55 && buyScore < 40) bias = "高位卖出区";
  else if (buyScore >= sellScore + 15) bias = "偏低位·可低吸";
  else if (sellScore >= buyScore + 15) bias = "偏高·注意止盈";
  else bias = "位置中性";

  return {
    buyScore, sellScore, zone, bias,
    buyNotes: buyNotes.slice(0, 4), sellNotes: sellNotes.slice(0, 4),
    drawdown: Math.round(dd * 100) / 100, rangePos: Math.round(pos),
    hi60: Math.round(hi60 * 100) / 100, lo60: Math.round(lo60 * 100) / 100,
  };
}

function calcPosition(quote, levels, signals, shares, cost, position) {
  const price = quote.price;
  const value = price * shares;
  const pl = (price - cost) * shares;
  const plPct = (price - cost) / cost * 100;
  const stopLoss = levels.supports.length ? levels.supports[0].price : cost * 0.93;
  const takeProfit = levels.resistances.length ? levels.resistances[levels.resistances.length - 1].price : cost * 1.08;
  let advice;
  // 优先高位卖出信号：位置高位 + 卖出信号强 → 止盈/减仓建议
  if (position && position.sellScore >= 55) {
    advice = "持仓位于" + position.zone + "（卖出信号 " + position.sellScore + "/100）" +
      (position.sellNotes[0] ? "，" + position.sellNotes[0] + "。" : "。") +
      "建议考虑**止盈/减仓**锁定利润" + (pl > 0 ? "（当前浮盈 " + fmt(pl) + " 元）" : "（当前浮亏 " + fmt(pl) + " 元，高位承压建议降低仓位）") + "，跌破支撑 " + fmt(stopLoss) + " 严格离场。";
  }
  else if (signals.verdict === "买入" || signals.verdict === "关注") advice = "技术面" + signals.verdict + "，持仓可继续持有，跌破止损位（" + fmt(stopLoss) + "）再考虑离场。";
  else if (signals.verdict === "观望") advice = "信号中性，持有观察，突破压力位（" + fmt(takeProfit) + "）或跌破支撑位（" + fmt(stopLoss) + "）再做决策。";
  else advice = "技术面偏空（" + signals.verdict + "），建议逢反弹减仓控制风险，严格止损。";
  return {
    shares, cost, price, value: round(value), pl: round(pl), plPct: round(plPct, 2),
    stopLoss: round(stopLoss), takeProfit: round(takeProfit),
    costToNowPct: round(plPct, 2),
    advice,
  };
}

// ---------- 主流程 ----------
export async function run(argv) {
  const args = { data: null, out: null, shares: null, cost: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--shares") args.shares = parseFloat(argv[++i]);
    else if (a === "--cost") args.cost = parseFloat(argv[++i]);
    else if (!a.startsWith("--")) args.data = a;
  }
  if (!args.data) throw new Error("用法: node analyze.mjs <data.json> [--shares N --cost P] [--out result.json]");
  const fs = await import("node:fs");
  const data = args.data.trimStart().startsWith("{")
    ? JSON.parse(args.data)                                   // 内联 JSON（供 screen.mjs 复用）
    : JSON.parse(fs.readFileSync(args.data, "utf8"));
  if (!data.kline || data.kline.length < 30) throw new Error("K线数据不足（<30 根），请用 --days 增加数量");

  const kline = data.kline;
  const ind = calcIndicators(kline);
  const signals = calcSignals(kline, ind);
  const sentiment = calcSentiment(data.news || [], data.quote || { pct: 0 });
  const levels = calcLevels(kline, ind);
  const growth = calcGrowth(data);
  const position = calcPositionAnalysis(kline, ind);

  const result = {
    meta: data.meta,
    quote: data.quote,
    indicators: {
      ma5: ind.ma5, ma10: ind.ma10, ma20: ind.ma20, ma60: ind.ma60, ma20Slope: ind.ma20Slope,
      macd: ind.macd, rsi6: ind.rsi6, rsi14: ind.rsi14, kdj: ind.kdj,
      boll: ind.boll, volMa5: ind.volMa5, volMa10: ind.volMa10,
    },
    signals, sentiment, levels, growth,
    positionAnalysis: position,
  };

  if (args.shares && args.cost) {
    result.position = calcPosition(data.quote, levels, signals, args.shares, args.cost, position);
  }
  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
    console.log("saved: " + args.out);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  return result;
}

if (typeof process !== "undefined" && process.argv[1] && import.meta.url === "file://" + process.argv[1]) {
  run(process.argv.slice(2)).catch(e => { console.error("ERROR: " + e.message); process.exit(1); });
}
