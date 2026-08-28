#!/usr/bin/env node
/**
 * advisor.mjs — 理财师建议引擎
 * 从理财师视角，基于持仓/信号生成专业建议：仓位、风险、操作、配置
 *
 * 用法:
 *   node advisor.mjs sim      生成模拟账户理财建议
 *   node advisor.mjs real     生成真实账户理财建议
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SIM_DIR = path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "storages", "stock-sim");
const fmt = (v, d = 2) => v === null || v === undefined || isNaN(v) ? "-" : Number(v).toFixed(d);

function loadJSON(f) {
  try { return JSON.parse(fs.readFileSync(path.join(SIM_DIR, f), "utf8")); } catch (e) { return null; }
}

// 仓位风险度计算
function positionRisk(acc) {
  if (!acc || !acc.holdings || !acc.holdings.length) return { level: "空仓", pct: 0, note: "当前空仓，可等待机会建仓" };
  const total = acc.cash + acc.holdings.reduce((s, h) => s + h.costPrice * h.shares, 0);
  const invested = acc.holdings.reduce((s, h) => s + h.costPrice * h.shares, 0);
  const pct = total > 0 ? invested / total * 100 : 0;
  let level, note;
  if (pct >= 80) { level = "高仓位"; note = "仓位较重，建议控制风险，避免满仓操作"; }
  else if (pct >= 50) { level = "中高仓位"; note = "仓位适中偏重，注意留出机动资金"; }
  else if (pct >= 20) { level = "中仓位"; note = "仓位适中，进可攻退可守"; }
  else { level = "低仓位"; note = "仓位较轻，可关注低位机会"; }
  return { level, pct: Math.round(pct), note };
}

// 组合集中度
function concentration(acc) {
  const hs = acc.holdings || [];
  if (!hs.length) return { top: 0, note: "无持仓" };
  const total = hs.reduce((s, h) => s + h.costPrice * h.shares, 0);
  const top = Math.max(...hs.map(h => h.costPrice * h.shares));
  const pct = total > 0 ? top / total * 100 : 0;
  return {
    top: Math.round(pct),
    note: pct > 50 ? "单只占比过高，建议分散风险" : pct > 30 ? "有一定集中度，注意风险" : "持仓较为分散"
  };
}

// 组合风险等级（基于止损距离 + 集中度 + 仓位）
function riskLevel(acc, holdings) {
  let riskScore = 0;
  const hs = holdings || [];
  if (hs.length >= 3) riskScore += 2; else if (hs.length >= 2) riskScore += 1;
  const conc = concentration(acc);
  if (conc.top > 50) riskScore += 2; else if (conc.top > 30) riskScore += 1;
  const posRisk = positionRisk(acc);
  if (posRisk.pct > 70) riskScore += 2; else if (posRisk.pct > 40) riskScore += 1;
  const level = riskScore >= 5 ? "高风险" : riskScore >= 3 ? "中高风险" : riskScore >= 1 ? "中风险" : "低风险";
  return { level, score: riskScore, posRisk, conc };
}

// 生成持仓操作建议（理财师视角）
function holdingAdvice(h, res) {
  if (!res) return "暂无分析数据";
  const s = res.signals, p = res.positionAnalysis;
  const price = res.quote.price;
  const stopDist = h.stopLoss ? (price - h.stopLoss) / price * 100 : 0;
  const plPct = (price - h.costPrice) / h.costPrice * 100;

  let advice = "";
  if (s.verdict === "买入" || s.verdict === "关注") {
    advice = "技术面" + s.verdict + "，可继续持有" + (plPct >= 0 ? "，已有浮盈建议保护利润" : "，耐心等待价值回归");
  } else if (s.verdict === "观望") {
    advice = "信号中性，持有观察，跌破止损位（" + fmt(h.stopLoss) + "）减仓避险";
  } else {
    advice = "技术面" + s.verdict + "，建议逢反弹降低仓位控制风险";
  }
  if (p && p.sellScore >= 50) advice += "；位置偏高（卖出信号" + p.sellScore + "），可考虑部分止盈";
  if (stopDist > 0 && stopDist < 5) advice += "；距止损位较近（" + fmt(stopDist, 1) + "%），注意保护";
  return advice;
}

// 模拟账户理财建议
export function advisorSim(holdings) {
  const acc = loadJSON("account.json");
  const last = acc && acc.daily && acc.daily.length ? acc.daily[acc.daily.length - 1] : null;
  const posRisk = positionRisk(acc);
  const conc = concentration(acc);
  const rl = riskLevel(acc, holdings);

  let overall = "组合当前" + rl.level + "（仓位" + posRisk.pct + "%），" + conc.note + "。";
  if (last && last.pnlPct >= 0) overall += "累计" + (last.pnlPct >= 0 ? "盈利" : "亏损") + fmt(Math.abs(last.pnlPct), 2) + "%，" + (last.excessPct >= 0 ? "跑赢" : "跑输") + "沪深300（" + (last.excessPct >= 0 ? "+" : "") + fmt(last.excessPct, 2) + "%）。";
  overall += "建议" + (posRisk.pct > 70 ? "降低仓位至 50-60%，锁定部分利润" : posRisk.pct < 20 ? "关注低位优质标的，逐步建仓" : "维持现有仓位，严格止损纪律");

  return {
    riskLevel: rl.level,
    positionRisk: posRisk,
    concentration: conc,
    overall,
    advice: {
      keep: holdings.filter(h => h.advice && h.advice.includes("持有")).length,
      reduce: holdings.filter(h => h.advice && h.advice.includes("减仓")).length,
    }
  };
}

// 真实账户理财建议
export function advisorReal(holdings) {
  const acc = loadJSON("real-account.json");
  if (!acc || !(acc.holdings || []).length) return { overall: "暂无真实持仓", riskLevel: "低风险" };
  const costValue = acc.holdings.reduce((s, h) => s + h.costPrice * h.shares, 0);
  let marketValue = costValue;
  const last = acc.daily && acc.daily.length ? acc.daily[acc.daily.length - 1] : null;
  if (last) marketValue = last.holdingsValue;
  const pnl = marketValue - costValue;
  const pnlPct = costValue > 0 ? pnl / costValue * 100 : 0;
  const conc = concentration(acc);
  let overall = "真实持仓" + (pnl >= 0 ? "浮盈" : "浮亏") + fmt(Math.abs(pnl), 0) + "元（" + (pnlPct >= 0 ? "+" : "") + fmt(pnlPct, 2) + "%）。";
  overall += conc.note + "。";
  if (acc.holdings.length === 1) overall += "单只持仓风险集中，建议关注止损保护（参考止损位）";
  return { overall, pnl, pnlPct, conc, costValue, marketValue, riskLevel: acc.holdings.length >= 3 ? "中高风险" : "中风险" };
}

// 生成持仓分析数据（供门户使用）
export function buildHoldingView(h, res) {
  if (!res) return { ...h, error: true };
  const q = res.quote;
  const pl = (q.price - h.costPrice) * h.shares;
  const plPct = (q.price - h.costPrice) / h.costPrice * 100;
  return {
    ...h,
    price: q.price, pct: q.pct, pl, plPct,
    stopLoss: h.stopLoss, takeProfit: h.takeProfit,
    stopDist: h.stopLoss ? (q.price - h.stopLoss) / q.price * 100 : 0,
    takeDist: h.takeProfit ? (h.takeProfit - q.price) / q.price * 100 : 0,
    verdict: res.signals.verdict, score: res.signals.score,
    zone: res.positionAnalysis.zone, buyScore: res.positionAnalysis.buyScore, sellScore: res.positionAnalysis.sellScore,
    sentiment: res.sentiment.label, growth: res.growth.label,
    advice: holdingAdvice(h, res),
  };
}

export { loadJSON, positionRisk, concentration, riskLevel, holdingAdvice, fmt };

// CLI
if (typeof process !== "undefined" && process.argv[1] && import.meta.url === "file://" + process.argv[1]) {
  const cmd = process.argv[2];
  if (cmd === "sim") {
    const acc = loadJSON("account.json");
    const hs = (acc && acc.holdings || []).map(h => ({ ...h, advice: "持有" }));
    const a = advisorSim(hs);
    console.log("=== 模拟账户理财建议 ===");
    console.log("风险等级:", a.riskLevel);
    console.log("仓位:", a.positionRisk.level, a.positionRisk.pct + "%", "-", a.positionRisk.note);
    console.log("集中度:", a.concentration.note);
    console.log("整体建议:", a.overall);
  } else if (cmd === "real") {
    const a = advisorReal([]);
    console.log("=== 真实账户理财建议 ===");
    console.log("风险等级:", a.riskLevel);
    console.log("整体建议:", a.overall);
  } else {
    console.log("用法: node advisor.mjs sim|real");
  }
}
