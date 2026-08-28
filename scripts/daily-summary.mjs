#!/usr/bin/env node
/**
 * daily-summary.mjs — 每日三合一汇总（模拟账户 + 真实账户 + 自选股票）
 * 一次运行：分析三部分 → 生成综合日报（markdown + HTML）
 *
 * 用法:
 *   node daily-summary.mjs [--out 目录]   输出日报到目录
 *   node daily-summary.mjs                控制台输出
 */
import { run as fetchRun } from "./fetch.mjs";
import { run as analyzeRun } from "./analyze.mjs";
import { run as simTradeRun } from "./sim-trade.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fmt = (v, d = 2) => v === null || v === undefined || isNaN(v) ? "-" : Number(v).toFixed(d);
const SIM_DIR = path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "storages", "stock-sim");

function loadJSON(f) {
  try { return JSON.parse(fs.readFileSync(path.join(SIM_DIR, f), "utf8")); } catch (e) { return null; }
}

async function analyzeOne(code) {
  const tmp = path.join(os.tmpdir(), "sum-" + code + "-" + Date.now() + ".json");
  await fetchRun([code, "--days", "90", "--out", tmp]);
  const res = await analyzeRun([tmp, "--out", tmp + ".res.json"]);
  return res;
}

// 判定买卖时机
function timing(res, q) {
  const s = res.signals, p = res.positionAnalysis, g = res.growth;
  if (s.verdict === "买入" && p && p.buyScore >= 40 && g && g.score >= 30 && q.pct < 5) return { label: "可买入", cls: "buy" };
  if (p && p.sellScore >= 55) return { label: "注意止盈", cls: "sell" };
  if (s.verdict === "买入" || s.verdict === "关注") return { label: "可关注", cls: "watch" };
  if (s.verdict === "回避" || s.verdict === "谨慎") return { label: "回避/谨慎", cls: "caution" };
  return { label: "观望", cls: "neutral" };
}

export async function run(argv) {
  const outDir = argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : null;
  const now2 = new Date();
  const date = now2.getFullYear() + "-" + String(now2.getMonth() + 1).padStart(2, "0") + "-" + String(now2.getDate()).padStart(2, "0");
  const now = new Date().toLocaleString("zh-CN", { hour12: false });

  const report = { date, now, sim: null, real: null, watchlist: [] };

  // ---------- 1. 模拟账户 ----------
  const sim = loadJSON("account.json");
  if (sim) {
    const holdings = [];
    for (const h of sim.holdings || []) {
      try {
        const res = await analyzeOne(h.code);
        const q = res.quote;
        const pl = (q.price - h.costPrice) * h.shares;
        holdings.push({ ...h, price: q.price, pct: q.pct, pl, plPct: (q.price - h.costPrice) / h.costPrice * 100, timing: timing(res, q), verdict: res.signals.verdict, score: res.signals.score });
      } catch (e) { holdings.push({ ...h, error: e.message }); }
    }
    const last = sim.daily && sim.daily.length ? sim.daily[sim.daily.length - 1] : null;
    report.sim = { capital: sim.capital, cash: sim.cash, holdings, last, tradeCount: (sim.trades || []).length };
  }

  // ---------- 2. 真实账户 ----------
  const real = loadJSON("real-account.json");
  if (real) {
    const holdings = [];
    for (const h of real.holdings || []) {
      try {
        const res = await analyzeOne(h.code);
        const q = res.quote;
        const pl = (q.price - h.costPrice) * h.shares;
        holdings.push({ ...h, price: q.price, pct: q.pct, pl, plPct: (q.price - h.costPrice) / h.costPrice * 100, timing: timing(res, q), verdict: res.signals.verdict, score: res.signals.score, zone: res.positionAnalysis.zone });
      } catch (e) { holdings.push({ ...h, error: e.message }); }
    }
    const last = real.daily && real.daily.length ? real.daily[real.daily.length - 1] : null;
    report.real = { holdings, last };
  }

  // ---------- 3. 自选股票 ----------
  try {
    const w = await fetch("http://127.0.0.1:3080/api/stock/watchlist").then(r => r.json());
    for (const item of w.watchlist || []) {
      try {
        const res = await analyzeOne(item.code);
        const q = res.quote;
        const t = timing(res, q);
        report.watchlist.push({
          code: item.code, name: res.meta.name, industry: item.industry,
          price: q.price, pct: q.pct, timing: t, verdict: res.signals.verdict, score: res.signals.score,
          zone: res.positionAnalysis.zone, buyScore: res.positionAnalysis.buyScore, sellScore: res.positionAnalysis.sellScore,
          sentiment: res.sentiment.label, growth: res.growth.label,
          supports: res.levels.supports.map(x => x.price).slice(0, 2), resistances: res.levels.resistances.map(x => x.price).slice(0, 2)
        });
      } catch (e) { /* skip */ }
    }
  } catch (e) { console.warn("自选接口不可用:", e.message); }

  // ---------- 输出 markdown ----------
  const md = buildMarkdown(report);
  // ---------- 输出 HTML ----------
  const html = buildHTML(report);

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const base = path.join(outDir, date + "-summary");
    fs.writeFileSync(base + ".md", md, "utf8");
    fs.writeFileSync(base + ".html", html, "utf8");
    console.log("📄 汇总日报: " + base + ".md / .html");
  } else {
    console.log(md);
  }
  return report;
}

function buildMarkdown(r) {
  const lines = [];
  lines.push("# 📊 每日股票汇总 " + r.date, "", "> 生成时间 " + r.now, "");

  // 模拟账户
  lines.push("## 💰 模拟账户");
  if (!r.sim) { lines.push("（未初始化）"); }
  else {
    const s = r.sim;
    lines.push("| 总资产 | 累计盈亏 | 现金 | 持仓 |", "|---|---|---|---|");
    if (s.last) {
      lines.push("| " + fmt(s.last.totalValue, 0) + " | " + (s.last.pnl >= 0 ? "+" : "") + fmt(s.last.pnl, 0) + "（" + (s.last.pnlPct >= 0 ? "+" : "") + fmt(s.last.pnlPct, 2) + "%） | " + fmt(s.cash, 0) + " | " + s.holdings.length + "/3 |");
    }
    if (s.holdings.length) {
      lines.push("", "**持仓**：");
      for (const h of s.holdings) {
        lines.push("- " + h.name + "(" + h.code + ") " + h.shares + "股 成本" + fmt(h.costPrice) + " 现价" + fmt(h.price) + " 浮盈" + (h.pl >= 0 ? "+" : "") + fmt(h.pl, 0) + "（" + (h.plPct >= 0 ? "+" : "") + fmt(h.plPct, 2) + "%）" + (h.timing ? " **[" + h.timing.label + "]**" : ""));
      }
    } else lines.push("", "（空仓）");
  }

  // 真实账户
  lines.push("", "## 💼 真实账户");
  if (!r.real || !r.real.holdings.length) { lines.push("（暂无真实持仓）"); }
  else {
    for (const h of r.real.holdings) {
      lines.push("- " + h.name + "(" + h.code + ") " + h.shares + "股 成本" + fmt(h.costPrice) + " 现价" + fmt(h.price) + " 浮盈" + (h.pl >= 0 ? "+" : "") + fmt(h.pl, 0) + "（" + (h.plPct >= 0 ? "+" : "") + fmt(h.plPct, 2) + "%） **[" + h.timing.label + "]** " + (h.zone ? "· " + h.zone : ""));
    }
  }

  // 自选
  lines.push("", "## ⭐ 自选股票");
  if (!r.watchlist.length) { lines.push("（无自选）"); }
  else {
    lines.push("| 股票 | 现价 | 买卖时机 | 信号 | 位置 | 情绪 | 增长 |", "|---|---|---|---|---|---|---|");
    for (const w of r.watchlist) {
      lines.push("| " + w.name + "(" + w.code + ") | " + fmt(w.price) + "(" + (w.pct >= 0 ? "+" : "") + fmt(w.pct, 2) + "%) | **" + w.timing.label + "** | " + w.verdict + " " + w.score + " | " + w.zone + " | " + w.sentiment + " | " + w.growth + " |");
    }
  }

  // 建议
  const buyList = r.watchlist.filter(w => w.timing.label === "可买入");
  const sellList = [...(r.sim ? r.sim.holdings : []), ...(r.real ? r.real.holdings : [])].filter(h => h.timing && h.timing.label === "注意止盈");
  lines.push("", "## 🎯 今日提示");
  if (buyList.length) lines.push("- ✅ 自选可买入：" + buyList.map(w => w.name).join("、"));
  else lines.push("- ✅ 自选暂无明确买入信号");
  if (sellList.length) lines.push("- ⚠️ 持仓注意止盈：" + sellList.map(h => h.name).join("、"));
  else lines.push("- ⚠️ 持仓暂无止盈信号");
  lines.push("", "> ⚠️ 模拟交易仅供策略研究，分析仅供参考，不构成投资建议。", "");
  return lines.join("\n");
}

function buildHTML(r) {
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const clsMap = { buy: "#f0483e", sell: "#2ebd85", watch: "#f5b942", caution: "#3b82f6", neutral: "#8a93b2" };
  const simRows = (r.sim ? r.sim.holdings : []).map(h => {
    return "<tr><td><b>" + esc(h.name) + "</b><br><span style='color:#6b7290;font-size:11px'>" + h.code + "</span></td><td>" + h.shares + "</td><td>" + fmt(h.costPrice) + "</td><td>" + fmt(h.price) + "</td><td style='color:" + (h.pl >= 0 ? "#f0483e" : "#2ebd85") + "'>" + (h.pl >= 0 ? "+" : "") + fmt(h.pl, 0) + "（" + (h.plPct >= 0 ? "+" : "") + fmt(h.plPct, 2) + "%）</td><td style='color:" + clsMap[h.timing ? h.timing.cls : "neutral"] + ";font-weight:700'>" + (h.timing ? h.timing.label : "-") + "</td></tr>";
  }).join("");
  const realRows = (r.real ? r.real.holdings : []).map(h => {
    return "<tr><td><b>" + esc(h.name) + "</b><br><span style='color:#6b7290;font-size:11px'>" + h.code + "</span></td><td>" + h.shares + "</td><td>" + fmt(h.costPrice) + "</td><td>" + fmt(h.price) + "</td><td style='color:" + (h.pl >= 0 ? "#f0483e" : "#2ebd85") + "'>" + (h.pl >= 0 ? "+" : "") + fmt(h.pl, 0) + "（" + (h.plPct >= 0 ? "+" : "") + fmt(h.plPct, 2) + "%）</td><td style='color:" + clsMap[h.timing ? h.timing.cls : "neutral"] + ";font-weight:700'>" + (h.timing ? h.timing.label : "-") + "</td></tr>";
  }).join("");
  const wlRows = r.watchlist.map(w => {
    return "<tr><td><b>" + esc(w.name) + "</b><br><span style='color:#6b7290;font-size:11px'>" + w.code + "</span></td><td>" + fmt(w.price) + "<br><span style='color:" + (w.pct >= 0 ? "#f0483e" : "#2ebd85") + ";font-size:11px'>" + (w.pct >= 0 ? "+" : "") + fmt(w.pct, 2) + "%</span></td><td style='color:" + clsMap[w.timing.cls] + ";font-weight:700'>" + w.timing.label + "</td><td>" + w.verdict + " " + w.score + "</td><td>" + w.zone + "</td><td>" + w.sentiment + "</td><td>" + w.growth + "</td></tr>";
  }).join("");
  const last = r.sim && r.sim.last;
  const html = [
    "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'/><title>每日股票汇总 " + r.date + "</title><style>",
    "body{background:#0b0f1d;color:#e6eaf5;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;padding:30px;line-height:1.5}",
    ".wrap{max-width:1000px;margin:0 auto} h1{font-size:24px;margin:0 0 4px} .sub{color:#8a93b2;font-size:13px;margin-bottom:20px}",
    "h2{font-size:17px;color:#3b82f6;margin:22px 0 10px}",
    "table{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:6px}",
    "th{color:#8a93b2;font-size:12px;text-align:left;padding:8px 10px;border-bottom:1px solid #232c47}",
    "td{padding:10px;border-bottom:1px solid #232c47;vertical-align:top}",
    ".summary{background:#121829;border:1px solid #232c47;border-radius:12px;padding:16px;margin-bottom:16px}",
    ".dim{color:#8a93b2;font-size:12px}",
    "</style></head><body><div class='wrap'>",
    "<h1>📊 每日股票汇总</h1><div class='sub'>" + r.date + " · " + r.now + " · 模拟/真实/自选 三合一</div>",
    (last ? "<div class='summary'><b>💰 模拟账户</b> 总资产 <b style='color:" + (last.pnl >= 0 ? "#f0483e" : "#2ebd85") + "'>" + fmt(last.totalValue, 0) + "</b>（" + (last.pnlPct >= 0 ? "+" : "") + fmt(last.pnlPct, 2) + "%）· 沪深300 " + (last.benchPct != null ? (last.benchPct >= 0 ? "+" : "") + fmt(last.benchPct, 2) + "%" : "—") + " · 超额 " + (last.excessPct != null ? (last.excessPct >= 0 ? "+" : "") + fmt(last.excessPct, 2) + "%" : "—") + "</div>" : ""),
    "<h2>💰 模拟账户持仓</h2><table><tr><th>股票</th><th>股数</th><th>成本</th><th>现价</th><th>浮盈亏</th><th>时机</th></tr>" + (simRows || "<tr><td colspan='6' style='color:#6b7290'>空仓</td></tr>") + "</table>",
    "<h2>💼 真实账户持仓</h2><table><tr><th>股票</th><th>股数</th><th>成本</th><th>现价</th><th>浮盈亏</th><th>时机</th></tr>" + (realRows || "<tr><td colspan='6' style='color:#6b7290'>暂无持仓</td></tr>") + "</table>",
    "<h2>⭐ 自选股票</h2><table><tr><th>股票</th><th>现价</th><th>买卖时机</th><th>信号</th><th>位置</th><th>情绪</th><th>增长</th></tr>" + wlRows + "</table>",
    "<div class='dim' style='margin-top:20px'>⚠️ 模拟交易仅供策略研究，分析仅供参考，不构成投资建议。</div>",
    "</div></body></html>"
  ].join("");
  return html;
}

if (typeof process !== "undefined" && process.argv[1] && import.meta.url === "file://" + process.argv[1]) {
  run(process.argv.slice(2)).catch(e => { console.error("ERROR: " + e.message); process.exit(1); });
}
