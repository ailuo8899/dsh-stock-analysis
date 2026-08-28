#!/usr/bin/env node
/**
 * sim.mjs — A股模拟交易引擎（虚拟资金，最多持有3只）
 *
 * 基于 dsh-stock-analysis 的多维信号自动决策：
 *   买入：信号分>=60 或 verdict=买入 + 位置非高位 + 增长>=30 + 当日涨幅<5%
 *   卖出：信号分<=-20 | 卖出信号>=60 | 跌破止损(-8%) | 达到止盈(压力*1.05)
 *   仓位：单只<=1/3资金，最多3只
 *
 * 用法：
 *   node sim.mjs init [--capital 1000000]           初始化账户
 *   node sim.mjs daily [--out 日报目录]             每日流程：分析→决策→交易→日报
 *   node sim.mjs status                             查看账户状态
 */
import { run as fetchRun } from "./fetch.mjs";
import { run as analyzeRun } from "./analyze.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SIM_DIR = path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "storages", "stock-sim");
const ACCOUNT_FILE = path.join(SIM_DIR, "account.json");

// ---------- 账户 ----------
function defaultAccount(capital) {
  return {
    capital,                    // 初始资金
    cash: capital,              // 当前现金
    holdings: [],               // [{code,name,shares,costPrice,buyDate,stopLoss,takeProfit}]
    trades: [],                 // [{date,code,name,action,price,shares,amount,pnl,pnlPct,reason}]
    daily: [],                  // [{date,totalValue,cash,holdingsValue,pnl,pnlPct,benchmark}]
    startDate: new Date().toISOString().slice(0, 10),
    lastRunDate: null,
    rules: { maxHoldings: 3, perPosition: 0.33, stopLossPct: 8, takeProfitResist: 1.05, buyScoreMin: 60, buyGrowMin: 30, buyDayPctMax: 5, sellScoreMax: -20, sellSignalMin: 60 }
  };
}
function loadAccount() {
  try {
    if (fs.existsSync(ACCOUNT_FILE)) return JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf8"));
  } catch (e) { console.error("[sim] 账户读取失败:", e.message); }
  return null;
}
function saveAccount(acc) {
  fs.mkdirSync(SIM_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(acc, null, 2), "utf8");
}

// ---------- 工具 ----------
function fmt(v, d = 2) { return v === null || v === undefined || isNaN(v) ? "-" : Number(v).toFixed(d); }
function pctOf(v, p) { return v * p / 100; }
function today() { return new Date().toISOString().slice(0, 10); }

// ---------- 分析一只股票（完整信号，静默：用临时文件避免 stdout 污染） ----------
async function analyzeStock(code) {
  const os = await import("node:os");
  const tmp = path.join(os.tmpdir(), "sim-" + code + "-" + Date.now() + ".json");
  await fetchRun([code, "--days", "90", "--out", tmp]);
  const res = await analyzeRun([tmp, "--out", tmp + ".res.json"]);
  return { data: null, res };
}

// ---------- 沪深300基准（东财指数日K） ----------
// 返回 { today, history: [{date,close}] }；失败返回 null
async function fetchBenchmark() {
  try {
    const end = "20500101", beg = "20250101";
    const url = "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000300" +
      "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&beg=" + beg +
      "&end=" + end + "&lmt=500&ut=fa5fd1943c7b386f172d6893dbfba10b";
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/" } });
    if (!r.ok) return null;
    const j = await r.json();
    const rows = (j.data && j.data.klines) || [];
    if (!rows.length) return null;
    const history = rows.map(line => {
      const p = line.split(",");
      return { date: p[0], close: Number(p[2]) };
    });
    return { today: history[history.length - 1], history };
  } catch (e) { return null; }
}

// ---------- 决策：当前持仓是否卖出 ----------
function shouldSell(holding, res) {
  const s = res.signals, pos = res.positionAnalysis;
  const reasons = [];
  // 1. 技术转弱
  if (s.score <= res.quote ? -20 : -20) reasons.push("信号分 " + s.score + " 转弱");
  // 2. 高位卖出信号
  if (pos && pos.sellScore >= 60) reasons.push("卖出信号 " + pos.sellScore + "（" + pos.zone + "）");
  // 3. 止损：现价跌破持仓成本 -8% 或支撑位 -3%
  const price = res.quote.price;
  const stopHard = holding.costPrice * (1 - res ? 0.08 : 0.08);
  if (price <= stopHard) reasons.push("触发硬止损（-" + 8 + "%）");
  else if (holding.stopLoss && price <= holding.stopLoss * 0.97) reasons.push("跌破参考支撑 " + fmt(holding.stopLoss));
  return reasons;
}

// ---------- 决策：是否买入新股票 ----------
function shouldBuy(res) {
  const s = res.signals, pos = res.positionAnalysis, g = res.growth;
  const q = res.quote;
  const reasons = [];
  const scoreOk = s.score >= 60 || s.verdict === "买入";
  const posOk = !pos || (pos.buyScore >= 40 || pos.zone === "低位区" || pos.zone === "中低位" || pos.bias === "低位买入区");
  const growOk = !g || g.score >= 30;
  const dayOk = q.pct < 5;
  const verdictOk = s.verdict === "买入" || s.verdict === "关注";
  if (!scoreOk) reasons.push("信号分 " + s.score + " 不足");
  if (!posOk) reasons.push("位置 " + (pos ? pos.zone + "/买" + pos.buyScore : "无") + " 不佳");
  if (!growOk) reasons.push("增长 " + (g ? g.score : "无") + " 不足");
  if (!dayOk) reasons.push("当日涨幅 " + q.pct + "% 过高");
  if (!verdictOk) reasons.push("建议 " + s.verdict + " 非买入/关注");
  return { ok: scoreOk && posOk && growOk && dayOk && verdictOk, reasons, score: s.score, verdict: s.verdict, pos: pos && pos.zone, grow: g && g.score };
}

// ---------- 执行买入 ----------
function executeBuy(acc, stockInfo, res, date) {
  if (acc.holdings.length >= acc.rules.maxHoldings) return { done: false, reason: "已达持仓上限" };
  if (acc.holdings.some(h => h.code === stockInfo.code)) return { done: false, reason: "已持有" };
  const price = res.quote.price;
  const budget = acc.cash * acc.rules.perPosition;
  if (budget < price * 100) return { done: false, reason: "现金不足买 100 股" };
  const shares = Math.floor(budget / price / 100) * 100;
  if (shares < 100) return { done: false, reason: "资金不足 100 股" };
  const amount = shares * price;
  acc.cash -= amount;
  const stopLoss = res.levels.supports && res.levels.supports[0] ? res.levels.supports[0].price * 0.97 : price * 0.92;
  const takeProfit = res.levels.resistances && res.levels.resistances[0] ? res.levels.resistances[0].price * 1.05 : price * 1.15;
  acc.holdings.push({
    code: stockInfo.code, name: stockInfo.name,
    shares, costPrice: price, buyDate: date,
    stopLoss: Number(stopLoss.toFixed(2)), takeProfit: Number(takeProfit.toFixed(2)),
    reason: "买入：信号" + res.signals.score + "(" + res.signals.verdict + ") 位置" + (res.positionAnalysis ? res.positionAnalysis.zone : "?")
  });
  acc.trades.push({ date, code: stockInfo.code, name: stockInfo.name, action: "BUY", price: Number(price.toFixed(2)), shares, amount: Number(amount.toFixed(2)), pnl: 0, pnlPct: 0, reason: acc.holdings[acc.holdings.length - 1].reason });
  return { done: true, shares, price };
}

// ---------- 执行卖出 ----------
function executeSell(acc, holding, price, date, reason) {
  const amount = holding.shares * price;
  const pnl = (price - holding.costPrice) * holding.shares;
  const pnlPct = (price - holding.costPrice) / holding.costPrice * 100;
  acc.cash += amount;
  acc.holdings = acc.holdings.filter(h => h.code !== holding.code);
  acc.trades.push({ date, code: holding.code, name: holding.name, action: "SELL", price: Number(price.toFixed(2)), shares: holding.shares, amount: Number(amount.toFixed(2)), pnl: Number(pnl.toFixed(2)), pnlPct: Number(pnlPct.toFixed(2)), reason });
  return { pnl, pnlPct };
}

// ---------- 账户市值 ----------
function accountValue(acc, quotes) {
  let holdingsValue = 0;
  for (const h of acc.holdings) {
    const q = quotes[h.code] || { price: h.costPrice };
    holdingsValue += q.price * h.shares;
  }
  return { totalValue: acc.cash + holdingsValue, holdingsValue, cash: acc.cash };
}

export { loadAccount, saveAccount, defaultAccount, analyzeStock, shouldSell, shouldBuy, executeBuy, executeSell, accountValue, fetchBenchmark, SIM_DIR, ACCOUNT_FILE, fmt, today };

// ---------- CLI ----------
if (typeof process !== "undefined" && process.argv[1] && import.meta.url === "file://" + process.argv[1]) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (cmd === "init") {
    const capIdx = args.indexOf("--capital");
    const capital = capIdx !== -1 ? parseFloat(args[capIdx + 1]) : 1000000;
    const acc = defaultAccount(capital);
    saveAccount(acc);
    console.log("✅ 模拟账户初始化：初始资金 " + fmt(capital, 0) + " 元，账户文件 " + ACCOUNT_FILE);
  } else if (cmd === "status") {
    const acc = loadAccount();
    if (!acc) { console.log("账户未初始化，先运行: node sim.mjs init"); process.exit(0); }
    console.log("=== 模拟账户状态 ===");
    console.log("初始资金: " + fmt(acc.capital, 0) + " | 现金: " + fmt(acc.cash, 0));
    console.log("持仓 " + acc.holdings.length + "/" + acc.rules.maxHoldings + ":");
    for (const h of acc.holdings) {
      console.log("  " + h.name + "(" + h.code + ") " + h.shares + "股 @ " + fmt(h.costPrice) + " 买入" + h.buyDate);
    }
    console.log("交易笔数: " + acc.trades.length);
    if (acc.daily.length) {
      const last = acc.daily[acc.daily.length - 1];
      console.log("最新净值: " + fmt(last.totalValue, 0) + " (" + (last.pnlPct >= 0 ? "+" : "") + fmt(last.pnlPct, 2) + "%)");
    }
  } else {
    console.log("用法: node sim.mjs init | status | daily");
  }
}
