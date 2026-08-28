#!/usr/bin/env node
/**
 * quotes.mjs — 多数据源实时行情（东财主 + 腾讯/新浪备源，自动切换）
 *
 * 单一数据源限流时自动切到备用源，保证行情可用性。
 *
 * 用法:
 *   node quotes.mjs 600519 002594 ...     批量查询实时行情
 *   node quotes.mjs --all                 查询自选（从 DSH watchlist）
 */
import os from "node:os";
import path from "node:path";

const fmt = (v, d = 2) => v === null || v === undefined || isNaN(v) ? "-" : Number(v).toFixed(d);

// 代码 → 腾讯/新浪符号
function toSymbol(code) {
  const c = String(code).replace(/^(sh|sz)/, "");
  if (c.startsWith("6") || c.startsWith("9") || c.startsWith("5")) return "sh" + c;
  return "sz" + c;
}

// 腾讯行情解析（~ 分隔）
function parseTencent(text) {
  const m = text.match(/="([^"]*)"/);
  if (!m) return null;
  const f = m[1].split("~");
  if (f.length < 40 || !f[3] || f[3] === "0.00") return null;
  return {
    source: "tencent",
    name: f[1], code: f[2],
    price: parseFloat(f[3]), prevClose: parseFloat(f[4]), open: parseFloat(f[5]),
    high: parseFloat(f[33]), low: parseFloat(f[34]),
    change: parseFloat(f[31]), pct: parseFloat(f[32]),
    volume: parseFloat(f[36]), amount: parseFloat(f[37]), turnover: parseFloat(f[38]),
    time: f[30],
  };
}

// 新浪行情解析（, 分隔）
function parseSina(text) {
  const m = text.match(/"([^"]*)"/);
  if (!m) return null;
  const f = m[1].split(",");
  if (f.length < 10 || !f[3] || f[3] === "0.000") return null;
  const price = parseFloat(f[3]);
  const prevClose = parseFloat(f[2]);
  return {
    source: "sina",
    name: f[0],
    price, prevClose, open: parseFloat(f[1]),
    high: parseFloat(f[4]), low: parseFloat(f[5]),
    change: prevClose > 0 ? price - prevClose : 0,
    pct: prevClose > 0 ? (price - prevClose) / prevClose * 100 : 0,
    volume: parseFloat(f[8]), amount: parseFloat(f[9]),
    turnover: null,
    time: (f[31] || "") + " " + (f[32] || ""),
  };
}

// 查询单只（腾讯优先，失败切新浪）
async function fetchQuoteOne(code) {
  const sym = toSymbol(code);
  // 腾讯
  try {
    const r = await fetch("https://qt.gtimg.cn/q=" + sym, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const text = await r.text();
      const q = parseTencent(text);
      if (q) return q;
    }
  } catch (e) { /* fallthrough */ }
  // 新浪
  try {
    const r = await fetch("https://hq.sinajs.cn/list=" + sym, {
      headers: { "Referer": "https://finance.sina.com.cn/", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const text = await r.text();
      const q = parseSina(text);
      if (q) return q;
    }
  } catch (e) { /* fallthrough */ }
  return null;
}

// 批量查询（并发，失败返回 null）
export async function fetchQuotes(codes) {
  const uniq = [...new Set(codes.map(c => String(c).replace(/^(sh|sz)/, "")))];
  const results = await Promise.all(uniq.map(async (code) => {
    try { return await fetchQuoteOne(code); } catch (e) { return null; }
  }));
  const map = {};
  for (let i = 0; i < uniq.length; i++) {
    if (results[i]) map[uniq[i]] = results[i];
  }
  return map;
}

export { fetchQuoteOne, toSymbol, parseTencent, parseSina, fmt };

// CLI
if (typeof process !== "undefined" && process.argv[1] && import.meta.url === "file://" + process.argv[1]) {
  const codes = process.argv.slice(2).filter(a => a !== "--all");
  if (process.argv.includes("--all")) {
    const DSH = "http://127.0.0.1:3080";
    const w = await fetch(DSH + "/api/stock/watchlist").then(r => r.json());
    codes.push(...(w.watchlist || []).map(x => x.code));
  }
  if (!codes.length) { console.log("用法: node quotes.mjs <代码...> 或 --all"); process.exit(0); }
  const quotes = await fetchQuotes(codes);
  for (const [code, q] of Object.entries(quotes)) {
    console.log(code + " " + q.name + " " + fmt(q.price) + " (" + (q.pct >= 0 ? "+" : "") + fmt(q.pct, 2) + "%) [来源:" + q.source + "] 昨收" + fmt(q.prevClose));
  }
}
