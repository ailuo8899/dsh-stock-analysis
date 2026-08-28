#!/usr/bin/env node
/**
 * real-advice.mjs — 真实账户深度分析（理财师视角）
 * 为每只真实持仓计算：止损/止盈参考位、操作建议、风险提示
 *
 * 用法: node real-advice.mjs
 */
import { fetchQuoteOne } from "./quotes.mjs";
import { advisorReal, fmt } from "./advisor.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SIM_DIR = path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "storages", "stock-sim");

function loadJSON(f) {
  try { return JSON.parse(fs.readFileSync(path.join(SIM_DIR, f), "utf8")); } catch (e) { return null; }
}

export async function run(argv) {
  const real = loadJSON("real-account.json");
  if (!real || !(real.holdings || []).length) {
    console.log("真实账户暂无持仓");
    return { holdings: [], advisor: null };
  }

  const results = [];
  for (const h of real.holdings) {
    const q = await fetchQuoteOne(h.code);
    if (!q) { results.push({ ...h, error: "行情获取失败" }); continue; }
    const price = q.price;
    const pl = (price - h.costPrice) * h.shares;
    const plPct = (price - h.costPrice) / h.costPrice * 100;
    const todayPl = q.prevClose ? (price - q.prevClose) * h.shares : 0;
    const stopLoss = h.costPrice * 0.92;
    const takeProfit = q.high ? q.high * 1.05 : h.costPrice * 1.15;
    let advice, risk = "中";
    if (plPct >= 10) { advice = "浮盈可观（" + fmt(plPct, 1) + "%），建议考虑部分止盈锁定利润"; risk = "中高"; }
    else if (plPct <= -8) { advice = "浮亏超 8%，触及止损位（" + fmt(stopLoss) + "），建议减仓控制风险"; risk = "高"; }
    else if (q.pct >= 5) { advice = "今日大涨（" + fmt(q.pct, 1) + "%），短线注意追高，可关注止盈"; risk = "中高"; }
    else if (q.pct <= -3) { advice = "今日回调（" + fmt(q.pct, 1) + "%），关注支撑位，不破持有"; risk = "中"; }
    else { advice = "走势平稳，维持持有，跌破止损（" + fmt(stopLoss) + "）再减仓"; risk = "中"; }

    results.push({
      code: h.code, name: h.name, shares: h.shares, costPrice: h.costPrice,
      price, pl, plPct, todayPl, pct: q.pct,
      stopLoss: Number(stopLoss.toFixed(2)), takeProfit: Number(takeProfit.toFixed(2)),
      advice, risk, source: q.source,
    });
    console.log(h.name + "(" + h.code + ") " + h.shares + "股 成本" + fmt(h.costPrice));
    console.log("  现价 " + fmt(price) + "（" + (q.pct >= 0 ? "+" : "") + fmt(q.pct, 2) + "%） 来源:" + q.source);
    console.log("  持仓盈亏 " + (pl >= 0 ? "+" : "") + fmt(pl, 0) + "（" + (plPct >= 0 ? "+" : "") + fmt(plPct, 2) + "%） 今日 " + (todayPl >= 0 ? "+" : "") + fmt(todayPl, 0));
    console.log("  止损 " + fmt(stopLoss) + " ｜ 止盈 " + fmt(takeProfit) + " ｜ 风险:" + risk);
    console.log("  💡 " + advice);
    console.log("");
  }

  const adv = advisorReal(results);
  console.log("🧑‍💼 理财师综合建议: " + adv.overall);
  return { holdings: results, advisor: adv };
}

if (typeof process !== "undefined" && process.argv[1] && import.meta.url === "file://" + process.argv[1]) {
  run(process.argv.slice(2)).catch(e => { console.error("ERROR: " + e.message); process.exit(1); });
}
