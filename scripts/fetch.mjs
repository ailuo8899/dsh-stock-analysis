#!/usr/bin/env node
/**
 * fetch.mjs — 股票数据抓取（A股：实时行情 / 日K线 / 相关新闻 / 基本面 / 估值）
 *
 * 数据源（均免费、无需 key、UTF-8 JSON）：
 *  - 代码/名称解析：东方财富 suggest 接口
 *  - 实时行情     ：东方财富 push2.eastmoney.com/api/qt/stock/get
 *  - 日K线(前复权) ：东方财富 push2his.eastmoney.com/api/qt/stock/kline/get
 *  - 相关新闻     ：东方财富 7x24 快讯 + 腾讯个股新闻 + 东财公告（按股票名称/代码过滤）
 *  - 基本面       ：东方财富 F10 财务指标（营收/净利同比、ROE、毛利率、EPS）
 *  - 估值         ：东方财富 push2（动态PE/TTM PE/PB/总市值）
 *
 * 用法：
 *   node fetch.mjs <代码或名称> [--days 120] [--out out.json]
 *   node fetch.mjs 600519
 *   node fetch.mjs 贵州茅台 --days 250
 *   node fetch.mjs 1.600519   （直接传 secid，供 screen.mjs 复用）
 *
 * 输出（stdout 或 --out 文件）：
 *   { meta, quote, kline: [{date,open,close,high,low,volume,amount}], news: [{title,summary,url,time,kind}],
 *     fundamentals: [{reportDate,reportName,revenue,revenueYoy,netProfit,netProfitYoy,roe,grossMargin,eps}],
 *     valuation: {peDynamic,peTtm,peStatic,pb,totalMv,circMv,netProfitYoy} }
 */

const UA = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36", "Referer": "https://quote.eastmoney.com/" };

function parseArgs(argv) {
  const args = { days: 120, out: null, code: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") args.days = parseInt(argv[++i], 10) || 120;
    else if (a === "--out") args.out = argv[++i];
    else if (!a.startsWith("--")) args.code = a;
  }
  return args;
}

/** 东财 suggest：按代码或名称解析股票，返回 {code,name,secid,market,type} */
async function resolveStock(input) {
  const url = "https://searchapi.eastmoney.com/api/suggest/get?input=" + encodeURIComponent(input.trim()) +
    "&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=8";
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error("解析股票失败 HTTP " + r.status);
  const j = await r.json();
  const rows = (j.QuotationCodeTable && j.QuotationCodeTable.Data) || [];
  const hit = rows.find(x => x.Classify === "AStock") || rows[0];
  if (!hit) throw new Error("未找到股票：" + input);
  return {
    code: hit.Code,
    name: hit.Name,
    secid: hit.QuoteID,          // 如 "1.600519" / "0.000001"
    market: hit.SecurityTypeName || hit.Classify,
    unified: hit.UnifiedCode,
  };
}

/** 东财实时行情（失败时切腾讯/新浪兜底） */
async function fetchQuote(secid) {
  const fields = "f43,f44,f45,f46,f47,f48,f50,f57,f58,f60,f107,f168,f169,f170,f171,f292";
  const url = "https://push2.eastmoney.com/api/qt/stock/get?secid=" + secid +
    "&fields=" + fields + "&ut=fa5fd1943c7b386f172d6893dbfba10b";
  try {
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error("行情请求失败 HTTP " + r.status);
    const j = await r.json();
    const d = j.data;
    if (!d) throw new Error("行情数据为空：" + secid);
    // A股价格字段统一放大100倍（两位小数）；d.f292 不是可靠的小数位标记
    const S = 100;
    return {
      code: d.f57, name: d.f58,
      price: d.f43 / S, open: d.f46 / S, high: d.f44 / S, low: d.f45 / S,
      prevClose: d.f60 / S, change: d.f169 / S, pct: d.f170 / S,
      volume: d.f47, amount: d.f48, turnover: d.f168 / S, amplitude: d.f171 / S,
      ts: Date.now(),
    };
  } catch (e) {
    // 东财限流：腾讯/新浪实时行情兜底
    const { fetchQuoteOne } = await import("./quotes.mjs");
    const symbol = secidToSymbol(secid);
    const q = await fetchQuoteOne(symbol);
    if (!q) throw new Error("行情获取失败（东财+腾讯+新浪均不可用）: " + secid);
    return {
      code: q.code, name: q.name,
      price: q.price, open: q.open, high: q.high, low: q.low,
      prevClose: q.prevClose, change: q.change, pct: q.pct,
      volume: q.volume || 0, amount: q.amount || 0, turnover: q.turnover || null,
      amplitude: q.high && q.low && q.prevClose ? (q.high - q.low) / q.prevClose * 100 : null,
      ts: Date.now(),
    };
  }
}

/** 腾讯日K线（前复权）兜底 */
async function fetchKlineTencent(symbol, days) {
  const url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=" + symbol + ",day,,," + days + ",qfq";
  const r = await fetch(url, { headers: { ...UA, "Referer": "https://gu.qq.com/" } });
  if (!r.ok) throw new Error("腾讯K线 HTTP " + r.status);
  const j = await r.json();
  const d = j.data && j.data[symbol];
  const k = d && (d.qfqday || d.day);
  if (!k || !k.length) throw new Error("腾讯K线为空：" + symbol);
  return k.slice(-days).map(row => ({
    date: row[0], open: +row[1], close: +row[2], high: +row[3], low: +row[4],
    volume: +row[5], amount: 0,
  }));
}

/** 新浪日K线（不复权）兜底 */
async function fetchKlineSina(symbol, days) {
  const url = "https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=" + symbol + "&scale=240&ma=no&datalen=" + days;
  const r = await fetch(url, { headers: { ...UA, "Referer": "https://finance.sina.com.cn/" } });
  if (!r.ok) throw new Error("新浪K线 HTTP " + r.status);
  const j = await r.json();
  if (!Array.isArray(j) || !j.length) throw new Error("新浪K线为空：" + symbol);
  return j.map(row => ({
    date: row.day, open: +row.open, close: +row.close, high: +row.high, low: +row.low,
    volume: +row.volume, amount: 0,
  }));
}

/** 日K线（东财主 + 腾讯/新浪兜底，自动切换） */
async function fetchKline(secid, days) {
  const end = "20500101", beg = "19900101";
  const url = "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=" + secid +
    "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1&beg=" +
    beg + "&end=" + end + "&lmt=" + days + "&ut=fa5fd1943c7b386f172d6893dbfba10b";
  try {
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error("K线请求失败 HTTP " + r.status);
    const j = await r.json();
    const d = j.data;
    if (!d || !d.klines) throw new Error("K线数据为空：" + secid);
    return d.klines.slice(-days).map(line => {
      // date,open,close,high,low,volume,amount,amplitude,pct,change,turnover
      const p = line.split(",");
      return {
        date: p[0], open: +p[1], close: +p[2], high: +p[3], low: +p[4],
        volume: +p[5], amount: +p[6],
      };
    });
  } catch (e) {
    // 东财限流：切腾讯，再切新浪
    const symbol = secidToSymbol(secid);
    try {
      return await fetchKlineTencent(symbol, days);
    } catch (e2) {
      return await fetchKlineSina(symbol, days);
    }
  }
}

/** secid 转腾讯 symbol：1.600519 → sh600519；0.000001 → sz000001 */
function secidToSymbol(secid) {
  const [mkt, code] = String(secid).split(".");
  return (mkt === "1" ? "sh" : "sz") + code;
}

/** 腾讯个股新闻/研报 */
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
      url: n.url || "",
      time: n.create_time || n.time || "",
      src: n.src || "",
      kind: "related",
    }));
  } catch (e) { return []; }
}

/** 东财公司公告 */
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
      time: n.notice_date || n.display_time || "",
      kind: "announcement",
    }));
  } catch (e) { return []; }
}

/** 东财 7x24 快讯 → 按名称/代码过滤相关新闻 */
async function fetchFlashNews(name, code) {
  try {
    const url = "https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_50_1_.html";
    const r = await fetch(url, { headers: { ...UA, "Referer": "https://kuaixun.eastmoney.com/" } });
    if (!r.ok) return [];
    const text = await r.text();
    const m = text.match(/var ajaxResult=({.*})/s);
    if (!m) return [];
    const j = JSON.parse(m[1]);
    const list = (j.LivesList || []).map(item => {
      const content = item.content || item.summary || "";
      const title = item.title || content.slice(0, 60);
      return {
        title: String(title).replace(/<[^>]+>/g, ""),
        summary: String(content).replace(/<[^>]+>/g, ""),
        url: item.url_w || item.url_m || "",
        time: item.showtime || item.sort || "",
      };
    });
    const rel = list.filter(n => {
      const t = n.title + n.summary;
      return t.includes(name) || (code && t.includes(code));
    });
    return rel.slice(0, 5).map(n => ({ ...n, kind: "related" }));
  } catch (e) { return []; }
}

/** 东财 F10 主要财务指标：营收/净利同比、ROE、毛利率、EPS（近4期） */
async function fetchFundamentals(secid) {
  try {
    const code = String(secid).split(".")[1];
    const mkt = String(secid).startsWith("1") ? "SH" : "SZ";
    const secucode = code + "." + mkt;
    const url = "https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_F10_FINANCE_MAINFINADATA" +
      "&columns=SECUCODE,SECURITY_NAME_ABBR,REPORT_DATE,REPORT_DATE_NAME,TOTALOPERATEREVETZ,PARENTNETPROFITTZ," +
      "ROEJQ,XSMLL,EPSJB,TOTALOPERATEREVE,PARENTNETPROFIT&filter=(SECUCODE%3D%22" + secucode + "%22)" +
      "&pageNumber=1&pageSize=4&sortTypes=-1&sortColumns=REPORT_DATE&source=HSF10&client=PC";
    const r = await fetch(url, { headers: { ...UA, "Referer": "https://emweb.securities.eastmoney.com/" } });
    if (!r.ok) return null;
    const j = await r.json();
    const rows = (j.result && j.result.data) || [];
    return rows.map(x => ({
      reportDate: (x.REPORT_DATE || "").slice(0, 10),
      reportName: x.REPORT_DATE_NAME || "",
      revenue: x.TOTALOPERATEREVE,
      revenueYoy: x.TOTALOPERATEREVETZ,
      netProfit: x.PARENTNETPROFIT,
      netProfitYoy: x.PARENTNETPROFITTZ,
      roe: x.ROEJQ,
      grossMargin: x.XSMLL,
      eps: x.EPSJB,
    }));
  } catch (e) { return null; }
}

/** 东财估值：动态PE / 市净率 / 总市值 / 净利同比 */
async function fetchValuation(secid) {
  try {
    const url = "https://push2.eastmoney.com/api/qt/stock/get?secid=" + secid +
      "&fields=f43,f57,f58,f162,f167,f164,f163,f116,f117,f85,f184,f9,f23&ut=fa5fd1943c7b386f172d6893dbfba10b";
    const r = await fetch(url, { headers: UA });
    if (!r.ok) return null;
    const j = await r.json();
    const d = j.data;
    if (!d) return null;
    return {
      peDynamic: d.f162 !== undefined && d.f162 !== "-" ? d.f162 / 100 : null,     // 动态市盈率
      pb: d.f167 !== undefined && d.f167 !== "-" ? d.f167 / 100 : null,             // 市净率
      peTtm: d.f164 !== undefined && d.f164 !== "-" ? d.f164 / 100 : null,          // TTM市盈率
      peStatic: d.f163 !== undefined && d.f163 !== "-" ? d.f163 / 100 : null,       // 静态市盈率
      totalMv: d.f116,                                                              // 总市值
      circMv: d.f117,                                                               // 流通市值
      netProfitYoy: d.f184 !== undefined && d.f184 !== "-" ? d.f184 : null,          // 最新净利同比(%)
    };
  } catch (e) { return null; }
}

/** 汇总新闻：腾讯个股新闻 + 东财公告 + 快讯过滤，大盘快讯垫底 */
async function fetchNews(name, code, secid) {
  const [tNews, ann, flash] = await Promise.all([
    fetchTencentNews(secidToSymbol(secid)),
    fetchAnnouncements(code),
    fetchFlashNews(name, code),
  ]);
  // 快讯补足（仅当个股新闻不足 4 条时）
  const relCount = tNews.length + ann.length + flash.length;
  const market = relCount >= 4 ? [] : [];
  return [...tNews, ...ann, ...flash, ...market].slice(0, 12);
}

export async function run(argv) {
  const args = parseArgs(argv);
  if (!args.code) throw new Error("用法: node fetch.mjs <代码或名称> [--days N] [--out 文件]");
  // 支持直接传 secid（如 "1.600519" / "0.000001"），供 screen.mjs 复用免解析
  const stock = /^\d\.\d{6}$/.test(args.code)
    ? { code: args.code.split(".")[1], name: null, secid: args.code, market: "AStock" }
    : await resolveStock(args.code);
  const [quote, kline, news, fundamentals, valuation] = await Promise.all([
    fetchQuote(stock.secid),
    fetchKline(stock.secid, args.days),
    fetchNews(stock.name || "", stock.code, stock.secid),
    fetchFundamentals(stock.secid),
    fetchValuation(stock.secid),
  ]);
  stock.name = stock.name || quote.name || "";
  const result = {
    meta: { code: stock.code, name: stock.name, secid: stock.secid, market: stock.market, fetchedAt: new Date().toISOString() },
    quote, kline, news, fundamentals, valuation,
  };
  if (args.out) {
    const fs = await import("node:fs");
    fs.writeFileSync(args.out, JSON.stringify(result, null, 2));
    console.log("saved: " + args.out);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  return result;
}

// 直接运行时执行（import.meta.url 与 argv[1] 比较判断）
if (typeof process !== "undefined" && process.argv[1] && import.meta.url === "file://" + process.argv[1]) {
  run(process.argv.slice(2)).catch(e => { console.error("ERROR: " + e.message); process.exit(1); });
}
