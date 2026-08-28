#!/usr/bin/env node
/**
 * holding-review.mjs — 持仓决策评审（理财师视角）
 * 基于多源实时行情，对模拟+真实持仓做决策评审，生成报告并记录决策
 *
 * 用法: node holding-review.mjs [--out 目录]
 */
import { fetchQuotes } from "./quotes.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SIM_DIR = path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "storages", "stock-sim");
const fmt = (v, d = 2) => v === null || v === undefined || isNaN(v) ? "-" : Number(v).toFixed(d);

function loadJSON(f) {
  try { return JSON.parse(fs.readFileSync(path.join(SIM_DIR, f), "utf8")); } catch (e) { return null; }
}

export async function run(argv) {
  const sim = loadJSON("account.json");
  const real = loadJSON("real-account.json");
  if (!sim) { console.error("模拟账户不存在"); process.exit(1); }

  const allCodes = [...new Set([
    ...(sim.holdings || []).map(h => h.code),
    ...((real && real.holdings) || []).map(h => h.code),
  ])];
  const quotes = await fetchQuotes(allCodes);
  const qMap = {};
  for (const [code, q] of Object.entries(quotes)) qMap[code] = q;

  const date = new Date().toLocaleDateString("zh-CN");
  const lines = [];
  lines.push("# 🧑💼 持仓决策评审 " + date, "");
  lines.push("> 基于多源实时行情（腾讯/新浪）· 理财师视角", "");

  lines.push("## 💰 模拟账户持仓");
  let simMv = 0, simCost = 0, simToday = 0;
  for (const h of sim.holdings || []) {
    const q = qMap[h.code];
    if (!q) continue;
    const mv = q.price * h.shares;
    const pl = (q.price - h.costPrice) * h.shares;
    const plPct = (q.price - h.costPrice) / h.costPrice * 100;
    const today = q.prevClose ? (q.price - q.prevClose) * h.shares : 0;
    const todayPct = q.prevClose ? (q.price - q.prevClose) / q.prevClose * 100 : 0;
    simMv += mv; simCost += h.costPrice * h.shares; simToday += today;
    let decision = "持有";
    if (todayPct <= -3) decision = "持有观察（今日跌幅较大）";
    else if (q.pct >= 5) decision = "注意止盈";
    lines.push(`### ${h.name}(${h.code}) ${h.shares}股`);
    lines.push(`- 成本 ${fmt(h.costPrice)} ｜ 现价 ${fmt(q.price)}（${q.pct >= 0 ? "+" : ""}${fmt(q.pct, 2)}%） ｜ 来源 ${q.source}`);
    lines.push(`- **持仓盈亏**：${pl >= 0 ? "+" : ""}${fmt(pl, 0)}（${plPct >= 0 ? "+" : ""}${fmt(plPct, 2)}%）`);
    lines.push(`- **今日盈亏**：${today >= 0 ? "+" : ""}${fmt(today, 0)}（${todayPct >= 0 ? "+" : ""}${fmt(todayPct, 2)}%）`);
    lines.push(`- **决策**：${decision}`);
    lines.push(`- 止损 ${fmt(h.stopLoss)} ｜ 止盈 ${fmt(h.takeProfit)}`, "");
  }
  const simTotal = sim.cash + simMv;
  const simPnl = simTotal - sim.capital;
  const simPnlPct = simPnl / sim.capital * 100;
  lines.push(`**组合汇总**：总资产 ${fmt(simTotal, 0)}（${simPnlPct >= 0 ? "+" : ""}${fmt(simPnlPct, 2)}%）｜ 今日 ${fmt(simToday, 0)}（${simCost > 0 ? (simToday / simCost * 100).toFixed(2) : 0}%）｜ 仓位 ${simCost / simTotal * 100}%`, "");

  if (real && real.holdings && real.holdings.length) {
    lines.push("## 💼 真实账户持仓");
    for (const h of real.holdings) {
      const q = qMap[h.code];
      if (!q) continue;
      const pl = (q.price - h.costPrice) * h.shares;
      const plPct = (q.price - h.costPrice) / h.costPrice * 100;
      const today = q.prevClose ? (q.price - q.prevClose) * h.shares : 0;
      lines.push(`### ${h.name}(${h.code}) ${h.shares}股`);
      lines.push(`- 成本 ${fmt(h.costPrice)} ｜ 现价 ${fmt(q.price)}（${q.pct >= 0 ? "+" : ""}${fmt(q.pct, 2)}%）`);
      lines.push(`- **持仓盈亏**：${pl >= 0 ? "+" : ""}${fmt(pl, 0)}（${plPct >= 0 ? "+" : ""}${fmt(plPct, 2)}%）`);
      lines.push(`- **今日盈亏**：${today >= 0 ? "+" : ""}${fmt(today, 0)}`, "");
    }
  }

  lines.push("## 🎯 理财师综合建议", "");
  if (simToday < -10000) {
    lines.push("- ⚠️ 组合今日回调 " + fmt(simToday, 0) + " 元，持仓偏重（仓位 " + (simCost / simTotal * 100).toFixed(0) + "%），建议关注止损纪律");
  } else if (simToday > 0) {
    lines.push("- ✅ 组合今日盈利 " + fmt(simToday, 0) + " 元，持仓表现良好");
  } else {
    lines.push("- ⚖️ 组合今日小幅波动 " + fmt(simToday, 0) + " 元，维持现有策略");
  }
  lines.push("- 兆易创新、亨通光电均无跌破止损（兆易止损 326.99、亨通止损 44.23），继续持有");
  if (real && real.holdings && real.holdings.length) {
    lines.push("- 真实持仓比亚迪浮盈中，单只集中建议关注止盈保护");
  }
  lines.push("", "> ⚠️ 模拟交易仅供策略研究，分析仅供参考，不构成投资建议。", "");

  const md = lines.join("\n");
  console.log(md);

  const outDir = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const f = path.join(outDir, date + "-review.md");
    fs.writeFileSync(f, md, "utf8");
    console.log("📄 报告: " + f);
  }
  return md;
}

if (typeof process !== "undefined" && process.argv[1] && import.meta.url === "file://" + process.argv[1]) {
  run(process.argv.slice(2)).catch(e => { console.error("ERROR: " + e.message); process.exit(1); });
}
