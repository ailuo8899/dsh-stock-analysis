#!/usr/bin/env node
/**
 * sim-trade.mjs — DSH Agent 驱动的模拟交易执行器
 *
 * 理念：交易决策由 DSH Agent（分析实时数据后）显式下达，
 * 本脚本只负责「执行 + 记账」，不做任何自动判断。
 *
 * 用法：
 *   node sim-trade.mjs buy <code> [--shares N] [--note "..."]      买入
 *   node sim-trade.mjs sell <code> [--shares N] [--note "..."]     卖出（默认全部）
 *   node sim-trade.mjs snapshot [--note "..."]                     记录每日快照（含沪深300基准）
 *   node sim-trade.mjs status                                      查看账户
 */
import { loadAccount, saveAccount, analyzeStock, executeBuy, executeSell, accountValue, fetchBenchmark, SIM_DIR, fmt, today } from "./sim.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SIM_DIR2 = path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "storages", "stock-sim");
const DECISIONS_FILE = path.join(SIM_DIR2, "decisions.json");

function readDecisions() {
  try {
    if (fs.existsSync(DECISIONS_FILE)) return JSON.parse(fs.readFileSync(DECISIONS_FILE, "utf8"));
  } catch (e) {}
  return [];
}
function appendDecision(dec) {
  const list = readDecisions();
  list.push(dec);
  fs.mkdirSync(SIM_DIR2, { recursive: true });
  fs.writeFileSync(DECISIONS_FILE, JSON.stringify(list, null, 2), "utf8");
}

function parseArgs(argv) {
  const args = { cmd: null, code: null, shares: null, note: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!args.cmd && ["buy", "sell", "snapshot", "status"].includes(a)) args.cmd = a;
    else if (!a.startsWith("--") && !args.code) args.code = a;
    else if (a === "--shares") args.shares = parseInt(argv[++i]);
    else if (a === "--note") args.note = argv[++i];
  }
  return args;
}

export async function run(argv) {
  const args = parseArgs(argv);
  const acc = loadAccount();
  if (!acc) { console.error("账户未初始化"); process.exit(1); }
  const date = today();

  if (args.cmd === "status") {
    console.log("=== 模拟账户（DSH 驱动）===");
    console.log("现金: " + fmt(acc.cash, 0) + " | 持仓 " + acc.holdings.length + "/" + acc.rules.maxHoldings);
    for (const h of acc.holdings) console.log("  " + h.name + "(" + h.code + ") " + h.shares + "股 @ " + fmt(h.costPrice));
    const last = acc.daily[acc.daily.length - 1];
    if (last) console.log("最新净值: " + fmt(last.totalValue, 0) + "（" + (last.pnlPct >= 0 ? "+" : "") + fmt(last.pnlPct, 2) + "%）基准 " + (last.benchPct === null ? "—" : fmt(last.benchPct, 2) + "%"));
    console.log("决策记录: " + readDecisions().length + " 条");
    return acc;
  }

  if (args.cmd === "buy") {
    if (!args.code) { console.error("缺少代码"); process.exit(1); }
    // 实时分析确认（数据实时性保证）
    const { res } = await analyzeStock(args.code);
    const price = res.quote.price;
    const pct = res.quote.pct || 0;
    // 理财师风控：追高防护 / 信号门槛 / 高位拒绝（--force 可绕过）
    const force = args.note && args.note.includes("--force");
    const riskChecks = [];
    if (pct >= 5) riskChecks.push("当日涨幅 " + fmt(pct, 1) + "% ≥5%（追高风险）");
    if (res.signals.score < 60) riskChecks.push("信号分 " + res.signals.score + " <60");
    if (res.positionAnalysis && res.positionAnalysis.buyScore < 40) riskChecks.push("位置买" + res.positionAnalysis.buyScore + " <40");
    if (riskChecks.length && !force) {
      console.error("🚫 风控拦截买入 " + args.code + "：" + riskChecks.join(";"));
      console.error("   若确需买入请加 --force 参数（需人工确认）");
      process.exit(1);
    }
    if (riskChecks.length) console.log("⚠️ 已绕过风控：" + riskChecks.join(";"));
    const budget = args.shares ? args.shares * price : acc.cash * acc.rules.perPosition;
    let shares = args.shares || Math.floor(budget / price / 100) * 100;
    if (shares < 100) { console.error("资金不足 100 股"); process.exit(1); }
    if (acc.holdings.length >= acc.rules.maxHoldings) { console.error("已达持仓上限 " + acc.rules.maxHoldings); process.exit(1); }
    if (acc.holdings.some(h => h.code === args.code)) { console.error("已持有 " + args.code); process.exit(1); }
    const amount = shares * price;
    if (amount > acc.cash) { console.error("现金不足: 需要 " + fmt(amount, 0) + " 现金 " + fmt(acc.cash, 0)); process.exit(1); }
    acc.cash -= amount;
    const stopLoss = res.levels.supports[0] ? res.levels.supports[0].price * 0.97 : price * 0.92;
    const takeProfit = res.levels.resistances[res.levels.resistances.length - 1] ? res.levels.resistances[res.levels.resistances.length - 1].price * 1.02 : price * 1.15;
    acc.holdings.push({ code: args.code, name: res.meta.name, shares, costPrice: price, buyDate: date, stopLoss: Number(stopLoss.toFixed(2)), takeProfit: Number(takeProfit.toFixed(2)), reason: "DSH决策" });
    acc.trades.push({ date, code: args.code, name: res.meta.name, action: "BUY", price: Number(price.toFixed(2)), shares, amount: Number(amount.toFixed(2)), pnl: 0, pnlPct: 0, reason: args.note || "DSH Agent 决策买入" });
    appendDecision({ date, action: "BUY", code: args.code, name: res.meta.name, price: Number(price.toFixed(2)), shares, reason: args.note, analysis: { signal: res.signals.score, verdict: res.signals.verdict, zone: res.positionAnalysis.zone, buyScore: res.positionAnalysis.buyScore, growth: res.growth.score } });
    saveAccount(acc);
    console.log("✅ 买入 " + res.meta.name + "(" + args.code + ") " + fmt(price) + " × " + shares + " = " + fmt(amount, 0) + " 元");
    console.log("   实时信号: " + res.signals.verdict + " " + res.signals.score + " | 位置: " + res.positionAnalysis.zone + " 买" + res.positionAnalysis.buyScore + " | 止损 " + fmt(stopLoss) + " 止盈 " + fmt(takeProfit));
    return acc;
  }

  if (args.cmd === "sell") {
    if (!args.code) { console.error("缺少代码"); process.exit(1); }
    const h = acc.holdings.find(x => x.code === args.code);
    if (!h) { console.error("未持有 " + args.code); process.exit(1); }
    const shares = args.shares && args.shares < h.shares ? args.shares : h.shares;
    const { res } = await analyzeStock(args.code);
    const price = res.quote.price;
    const amount = shares * price;
    const pnl = (price - h.costPrice) * shares;
    const pnlPct = (price - h.costPrice) / h.costPrice * 100;
    acc.cash += amount;
    if (shares >= h.shares) acc.holdings = acc.holdings.filter(x => x.code !== args.code);
    else h.shares -= shares;
    acc.trades.push({ date, code: args.code, name: h.name, action: "SELL", price: Number(price.toFixed(2)), shares, amount: Number(amount.toFixed(2)), pnl: Number(pnl.toFixed(2)), pnlPct: Number(pnlPct.toFixed(2)), reason: args.note || "DSH Agent 决策卖出" });
    appendDecision({ date, action: "SELL", code: args.code, name: h.name, price: Number(price.toFixed(2)), shares, pnl: Number(pnl.toFixed(2)), pnlPct: Number(pnlPct.toFixed(2)), reason: args.note, analysis: { signal: res.signals.score, verdict: res.signals.verdict, zone: res.positionAnalysis.zone, sellScore: res.positionAnalysis.sellScore } });
    saveAccount(acc);
    console.log("✅ 卖出 " + h.name + "(" + args.code + ") " + fmt(price) + " × " + shares + " = " + fmt(amount, 0) + " 元");
    console.log("   盈亏: " + (pnl >= 0 ? "+" : "") + fmt(pnl, 0) + "（" + (pnlPct >= 0 ? "+" : "") + fmt(pnlPct, 2) + "%）");
    return acc;
  }

  if (args.cmd === "snapshot") {
    const quotes = {};
    for (const h of acc.holdings) {
      try { const { res } = await analyzeStock(h.code); quotes[h.code] = res.quote; } catch (e) { quotes[h.code] = { price: h.costPrice }; }
    }
    const { totalValue, holdingsValue, cash } = accountValue(acc, quotes);
    const totalPnl = totalValue - acc.capital;
    const totalPnlPct = totalPnl / acc.capital * 100;
    const bench = await fetchBenchmark();
    let benchPct = null;
    if (bench && bench.history.length) {
      const startBar = bench.history.find(h2 => h2.date >= acc.startDate) || bench.history[0];
      if (startBar && bench.today && startBar.close > 0) benchPct = (bench.today.close - startBar.close) / startBar.close * 100;
    }
    acc.daily.push({
      date, totalValue: Number(totalValue.toFixed(2)), cash: Number(cash.toFixed(2)), holdingsValue: Number(holdingsValue.toFixed(2)),
      pnl: Number(totalPnl.toFixed(2)), pnlPct: Number(totalPnlPct.toFixed(2)),
      benchPct: benchPct === null ? null : Number(benchPct.toFixed(2)),
      excessPct: benchPct === null ? null : Number((totalPnlPct - benchPct).toFixed(2)),
      note: args.note || "", actions: []
    });
    saveAccount(acc);
    console.log("📸 快照 " + date + ": 总资产 " + fmt(totalValue, 0) + "（" + (totalPnlPct >= 0 ? "+" : "") + fmt(totalPnlPct, 2) + "%）沪深300 " + (benchPct === null ? "—" : (benchPct >= 0 ? "+" : "") + fmt(benchPct, 2) + "%") + " 超额 " + (benchPct === null ? "—" : (totalPnlPct - benchPct >= 0 ? "+" : "") + fmt(totalPnlPct - benchPct, 2) + "%"));
    return acc;
  }

  console.log("用法: node sim-trade.mjs buy|sell|snapshot|status <code> [--shares N] [--note '...']");
}

if (typeof process !== "undefined" && process.argv[1] && import.meta.url === "file://" + process.argv[1]) {
  run(process.argv.slice(2)).catch(e => { console.error("ERROR: " + e.message); process.exit(1); });
}
