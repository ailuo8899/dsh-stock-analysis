#!/usr/bin/env node
/**
 * watchlist-analysis.mjs — 自选股票每日实时分析
 * 对自选列表批量分析：信号/位置/情绪/增长/支撑压力，标记买卖时机
 *
 * 用法:
 *   node watchlist-analysis.mjs                    分析全部自选（从 watchlist 接口）
 *   node watchlist-analysis.mjs --codes 600519,002594  分析指定代码
 *   node watchlist-analysis.mjs --out report.html  输出 HTML 报告
 */
import { run as fetchRun } from "./fetch.mjs";
import { run as analyzeRun } from "./analyze.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fmt = (v, d = 2) => v === null || v === undefined || isNaN(v) ? "-" : Number(v).toFixed(d);

function parseArgs(argv) {
  const args = { codes: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--codes") args.codes = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
  }
  return args;
}

async function analyzeOne(code) {
  const os = await import("node:os");
  const tmp = path.join(os.tmpdir(), "wl-" + code + "-" + Date.now() + ".json");
  try {
    // 东财 K 线（完整技术信号）
    await fetchRun([code, "--days", "90", "--out", tmp]);
    const res = await analyzeRun([tmp, "--out", tmp + ".res.json"]);
    return { code, res, full: true };
  } catch (e) {
    // 东财限流：用多源行情降级（腾讯/新浪）
    const { fetchQuoteOne } = await import("./quotes.mjs");
    const q = await fetchQuoteOne(code);
    if (!q) throw e;
    // 构造简化分析结果
    const res = {
      meta: { code, name: q.name },
      quote: { price: q.price, pct: q.pct, prevClose: q.prevClose, high: q.high, low: q.low },
      signals: { score: 0, verdict: "观望", factors: [] },
      positionAnalysis: { zone: "-", buyScore: 0, sellScore: 0, bias: "-" },
      sentiment: { label: "-", score: 0 },
      growth: { label: "-", score: 0 },
      levels: { supports: [], resistances: [] },
      degraded: true, source: q.source,
    };
    return { code, res, full: false };
  }
}

export async function run(argv) {
  const args = parseArgs(argv);
  // 获取自选列表
  let codes = [];
  if (args.codes) {
    codes = args.codes.split(",").map(s => s.trim()).filter(Boolean);
  } else {
    try {
      const r = await fetch("http://127.0.0.1:3080/api/stock/watchlist").then(r => r.json());
      codes = (r.watchlist || []).map(w => w.code);
    } catch (e) {
      console.error("无法获取自选列表（请确保 dsh web 运行或传 --codes）:", e.message);
      process.exit(1);
    }
  }
  if (!codes.length) { console.log("自选列表为空"); return []; }

  console.log("📋 自选股实时分析 " + codes.length + " 只：\n");
  const results = [];
  for (const code of codes) {
    try {
      const { res } = await analyzeOne(code);
      const q = res.quote, s = res.signals, p = res.positionAnalysis, se = res.sentiment, g = res.growth;
      // 买卖时机判定
      let signal = "观望";
      let signalCls = "neutral";
      if (s.verdict === "买入" && p && p.buyScore >= 40 && g && g.score >= 30 && q.pct < 5) {
        signal = "可买入"; signalCls = "buy";
      } else if (p && p.sellScore >= 55) {
        signal = "注意止盈"; signalCls = "sell";
      } else if (s.verdict === "买入" || s.verdict === "关注") {
        signal = "可关注"; signalCls = "watch";
      } else if (s.verdict === "回避" || s.verdict === "谨慎") {
        signal = "回避/谨慎"; signalCls = "caution";
      }
      const item = {
        code, name: res.meta.name, price: q.price, pct: q.pct,
        signal, signalCls,
        verdict: s.verdict, score: s.score,
        zone: p.zone, buyScore: p.buyScore, sellScore: p.sellScore, bias: p.bias,
        sentiment: se.label, sentimentScore: se.score,
        growth: g.label, growthScore: g.score,
        supports: res.levels.supports.map(x => x.price),
        resistances: res.levels.resistances.map(x => x.price),
      };
      results.push(item);
      console.log(
        "  " + item.name + "(" + code + ") " + fmt(q.price) + " (" + (q.pct >= 0 ? "+" : "") + fmt(q.pct, 2) + "%) [" + signal + "]\n" +
        "    信号" + s.verdict + " " + s.score + " | 位置" + p.zone + " 买" + p.buyScore + "/卖" + p.sellScore + " | 情绪" + se.label + " | 增长" + g.label + "\n" +
        "    支撑 " + item.supports.join("/") + " | 压力 " + item.resistances.join("/")
      );
    } catch (e) {
      console.warn("  分析失败 " + code + ": " + e.message);
    }
  }

  // HTML 报告
  if (args.out) {
    const rows = results.map(r2 => {
      const cls = r2.signalCls;
      const clsMap = { buy: "#f0483e", sell: "#2ebd85", watch: "#f5b942", caution: "#3b82f6", neutral: "#8a93b2" };
      return "<tr><td><b>" + r2.name + "</b><br><span style='color:#6b7290;font-size:11px'>" + r2.code + "</span></td>" +
        "<td>" + fmt(r2.price) + "<br><span style='color:" + (r2.pct >= 0 ? "#f0483e" : "#2ebd85") + "'>" + (r2.pct >= 0 ? "+" : "") + fmt(r2.pct, 2) + "%</span></td>" +
        "<td><span style='color:" + clsMap[cls] + ";font-weight:700'>" + r2.signal + "</span><br><span style='color:#6b7290;font-size:11px'>" + r2.verdict + " " + r2.score + "</span></td>" +
        "<td>" + r2.zone + "<br><span style='color:#6b7290;font-size:11px'>买" + r2.buyScore + "/卖" + r2.sellScore + "</span></td>" +
        "<td>" + r2.sentiment + " " + fmt(r2.sentimentScore) + "</td>" +
        "<td>" + r2.growth + " " + r2.growthScore + "</td>" +
        "<td style='color:#2ebd85'>" + r2.supports.join("/") + "</td>" +
        "<td style='color:#f0483e'>" + r2.resistances.join("/") + "</td></tr>";
    }).join("");
    const html = [
      "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'/><title>自选股分析 · " + new Date().toLocaleDateString("zh-CN") + "</title><style>",
      "body{background:#0b0f1d;color:#e6eaf5;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;padding:30px;line-height:1.5}",
      ".wrap{max-width:1000px;margin:0 auto} h1{font-size:22px;margin:0 0 6px} .sub{color:#8a93b2;font-size:13px;margin-bottom:18px}",
      "table{width:100%;border-collapse:collapse;font-size:13px}",
      "th{color:#8a93b2;font-size:12px;text-align:left;padding:8px 10px;border-bottom:1px solid #232c47}",
      "td{padding:10px;border-bottom:1px solid #232c47;vertical-align:top}",
      "a{color:#3b82f6;text-decoration:none;font-size:12px}",
      "</style></head><body><div class='wrap'>",
      "<h1>⭐ 自选股实时分析</h1>",
      "<div class='sub'>" + new Date().toLocaleString("zh-CN", { hour12: false }) + " · 信号/位置/情绪/增长 · 买卖时机提示</div>",
      "<table><tr><th>股票</th><th>现价</th><th>买卖时机</th><th>位置</th><th>情绪</th><th>增长</th><th>支撑</th><th>压力</th></tr>" + rows + "</table>",
      "<div style='color:#6b7290;font-size:11px;margin-top:16px'>⚠️ 分析仅供参考，不构成投资建议。</div>",
      "</div></body></html>"
    ].join("");
    fs.writeFileSync(args.out, html, "utf8");
    console.log("\n📄 报告已保存: " + args.out);
  }
  return results;
}

if (typeof process !== "undefined" && process.argv[1] && import.meta.url === "file://" + process.argv[1]) {
  run(process.argv.slice(2)).catch(e => { console.error("ERROR: " + e.message); process.exit(1); });
}
