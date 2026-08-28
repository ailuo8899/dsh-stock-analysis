#!/usr/bin/env node
/**
 * real-trade.mjs — 真实交易账户管理（与模拟账户 sim.mjs 分离）
 *
 * 用法：
 *   node real-trade.mjs add <代码> <股数> <成本价> [--note "..."]   加入真实持仓
 *   node real-trade.mjs sell <代码> <股数> <卖出价> [--note "..."]   卖出真实持仓
 *   node real-trade.mjs analyze                                     实时分析所有真实持仓（DSH 信号）
 *   node real-trade.mjs snapshot [--note "..."]                     记录快照（含沪深300基准）
 *   node real-trade.mjs status                                      查看真实账户
 */
import { analyzeStock, fetchBenchmark, accountValue, fmt, today } from "./sim.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const REAL_DIR = path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "storages", "stock-sim");
const REAL_FILE = path.join(REAL_DIR, "real-account.json");

function loadReal() {
  try {
    if (fs.existsSync(REAL_FILE)) return JSON.parse(fs.readFileSync(REAL_FILE, "utf8"));
  } catch (e) { console.error("[real] 真实账户读取失败:", e.message); }
  return null;
}
function saveReal(acc) {
  fs.mkdirSync(REAL_DIR, { recursive: true });
  fs.writeFileSync(REAL_FILE, JSON.stringify(acc, null, 2), "utf8");
}

function parseArgs(argv) {
  const args = { cmd: null, code: null, shares: null, cost: null, price: null, note: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!args.cmd && ["add", "sell", "analyze", "snapshot", "status"].includes(a)) args.cmd = a;
    else if (!a.startsWith("--")) {
      if (!args.code) args.code = a;
      else if (args.shares === null) args.shares = parseFloat(a);
      else if (args.cost === null && args.cmd === "add") args.cost = parseFloat(a);
      else if (args.price === null && args.cmd === "sell") args.price = parseFloat(a);
    }
    else if (a === "--note") args.note = argv[++i];
  }
  return args;
}

export async function run(argv) {
  const args = parseArgs(argv);
  const acc = loadReal();
  if (!acc) { console.error("真实账户未初始化"); process.exit(1); }
  const date = today();

  if (args.cmd === "status") {
    console.log("=== 真实交易账户 ===");
    console.log("持仓 " + acc.holdings.length + " 只:");
    for (const h of acc.holdings) {
      console.log("  " + h.name + "(" + h.code + ") " + h.shares + "股 @ " + fmt(h.costPrice) + " 买入" + (h.buyDate || "-"));
    }
    const last = acc.daily[acc.daily.length - 1];
    if (last) console.log("最新快照: " + last.date + " 市值 " + fmt(last.holdingsValue, 0) + " 浮盈 " + (last.pnl >= 0 ? "+" : "") + fmt(last.pnl, 0) + "（" + (last.pnlPct >= 0 ? "+" : "") + fmt(last.pnlPct, 2) + "%）");
    return acc;
  }

  if (args.cmd === "add") {
    if (!args.code || args.shares === null || args.cost === null) { console.error("用法: real-trade.mjs add <代码> <股数> <成本价>"); process.exit(1); }
    let name = args.code;
    try { const { res } = await analyzeStock(args.code); name = res.meta.name; } catch (e) {}
    const existing = acc.holdings.find(h => h.code === args.code);
    if (existing) {
      const totalShares = existing.shares + args.shares;
      existing.costPrice = (existing.shares * existing.costPrice + args.shares * args.cost) / totalShares;
      existing.shares = totalShares;
      console.log("✅ 加仓 " + name + "(" + args.code + ") 共 " + totalShares + "股 平均成本 " + fmt(existing.costPrice));
    } else {
      acc.holdings.push({ code: args.code, name, shares: args.shares, costPrice: args.cost, buyDate: date, note: args.note || "真实买入" });
      console.log("✅ 加入真实持仓 " + name + "(" + args.code + ") " + args.shares + "股@" + fmt(args.cost));
    }
    acc.trades.push({ date, code: args.code, name, action: "BUY", price: args.cost, shares: args.shares, note: args.note || "真实买入" });
    saveReal(acc);
    return acc;
  }

  if (args.cmd === "sell") {
    if (!args.code || args.shares === null || args.price === null) { console.error("用法: real-trade.mjs sell <代码> <股数> <卖出价>"); process.exit(1); }
    const h = acc.holdings.find(x => x.code === args.code);
    if (!h) { console.error("未持有 " + args.code); process.exit(1); }
    const shares = Math.min(args.shares, h.shares);
    const pnl = (args.price - h.costPrice) * shares;
    const pnlPct = (args.price - h.costPrice) / h.costPrice * 100;
    if (shares >= h.shares) acc.holdings = acc.holdings.filter(x => x.code !== args.code);
    else h.shares -= shares;
    acc.trades.push({ date, code: args.code, name: h.name, action: "SELL", price: args.price, shares, pnl: Number(pnl.toFixed(2)), pnlPct: Number(pnlPct.toFixed(2)), note: args.note || "真实卖出" });
    saveReal(acc);
    console.log("✅ 卖出 " + h.name + "(" + args.code + ") " + shares + "股@" + fmt(args.price) + " 盈亏 " + (pnl >= 0 ? "+" : "") + fmt(pnl, 0) + "（" + (pnlPct >= 0 ? "+" : "") + fmt(pnlPct, 2) + "%）");
    return acc;
  }

  if (args.cmd === "analyze") {
    console.log("=== 真实持仓 DSH 实时分析 ===\n");
    for (const h of acc.holdings) {
      try {
        const { res } = await analyzeStock(h.code);
        const q = res.quote;
        const pl = (q.price - h.costPrice) * h.shares;
        const plPct = (q.price - h.costPrice) / h.costPrice * 100;
        console.log(h.name + "(" + h.code + ") 成本" + fmt(h.costPrice) + " 现价" + fmt(q.price) + "(" + (q.pct >= 0 ? "+" : "") + fmt(q.pct, 2) + "%)");
        console.log("  信号: " + res.signals.verdict + " " + res.signals.score + "/100 | 位置: " + res.positionAnalysis.zone + " 买" + res.positionAnalysis.buyScore + "/卖" + res.positionAnalysis.sellScore + " | 情绪: " + res.sentiment.label + " | 增长: " + res.growth.label);
        console.log("  浮盈: " + (pl >= 0 ? "+" : "") + fmt(pl, 0) + "元(" + (plPct >= 0 ? "+" : "") + fmt(plPct, 2) + "%) | 支撑: " + res.levels.supports.map(x => x.price).join("/") + " | 压力: " + res.levels.resistances.map(x => x.price).join("/"));
        console.log("");
      } catch (e) { console.warn("[real] 分析失败 " + h.code + ":", e.message); }
    }
    return acc;
  }

  if (args.cmd === "snapshot") {
    const quotes = {};
    for (const h of acc.holdings) {
      try { const { res } = await analyzeStock(h.code); quotes[h.code] = res.quote; } catch (e) { quotes[h.code] = { price: h.costPrice }; }
    }
    let holdingsValue = 0, costValue = 0;
    for (const h of acc.holdings) {
      const p = quotes[h.code] ? quotes[h.code].price : h.costPrice;
      holdingsValue += p * h.shares;
      costValue += h.costPrice * h.shares;
    }
    const pnl = holdingsValue - costValue;
    const pnlPct = costValue > 0 ? pnl / costValue * 100 : 0;
    const bench = await fetchBenchmark();
    let benchPct = null;
    if (bench && bench.history.length) {
      const startBar = bench.history.find(h2 => h2.date >= acc.startDate) || bench.history[0];
      if (startBar && bench.today && startBar.close > 0) benchPct = (bench.today.close - startBar.close) / startBar.close * 100;
    }
    acc.daily.push({
      date, holdingsValue: Number(holdingsValue.toFixed(2)), costValue: Number(costValue.toFixed(2)),
      pnl: Number(pnl.toFixed(2)), pnlPct: Number(pnlPct.toFixed(2)),
      benchPct: benchPct === null ? null : Number(benchPct.toFixed(2)),
      note: args.note || ""
    });
    acc.lastRunDate = date;
    saveReal(acc);
    console.log("📸 真实账户快照 " + date + ": 持仓市值 " + fmt(holdingsValue, 0) + " 成本 " + fmt(costValue, 0) + " 浮盈 " + (pnl >= 0 ? "+" : "") + fmt(pnl, 0) + "（" + (pnlPct >= 0 ? "+" : "") + fmt(pnlPct, 2) + "%）沪深300 " + (benchPct === null ? "—" : (benchPct >= 0 ? "+" : "") + fmt(benchPct, 2) + "%"));
    return acc;
  }

  console.log("用法: node real-trade.mjs add|sell|analyze|snapshot|status");
}

if (typeof process !== "undefined" && process.argv[1] && import.meta.url === "file://" + process.argv[1]) {
  run(process.argv.slice(2)).catch(e => { console.error("ERROR: " + e.message); process.exit(1); });
}
