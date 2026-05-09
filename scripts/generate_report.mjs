#!/usr/bin/env node
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const API_BASE = process.env.ZHIPU_API_BASE || 'https://open.bigmodel.cn/api/coding/paas/v4';
const MODELS = [
  process.env.ZHIPU_MODEL_PRIMARY || 'glm-5-turbo',
  'glm-4.7',
  'glm-4.7-flash',
];

const SYSTEM_PROMPT = `你是酒精成癮（Alcohol Use Disorder）領域的資深研究員與科學傳播者。你的任務是：
1. 從提供的醫學文獻中，篩選出最具臨床意義與研究價值的論文
2. 對每篇論文進行繁體中文摘要、分類、PICO 分析
3. 評估其臨床實用性（高/中/低）
4. 生成適合醫療專業人員閱讀的日報

輸出格式要求：
- 語言：繁體中文（台灣用語）
- 專業但易懂
- 每篇論文需包含：中文標題、一句話總結、PICO分析、臨床實用性、分類標籤
- 最後提供今日精選 TOP 3（最重要/最影響臨床實踐的論文）
回傳格式必須是純 JSON，不要用 markdown code block 包裹。`;

const AVAILABLE_TAGS = [
  '酒精使用疾患', '酒精戒斷', '藥物治療', '心理治療',
  '神經科學', '腦影像', '社會決定因素', '政策與公共衛生',
  '營養與代謝', '肝臟疾病', '共病症', '憂鬱症',
  '焦慮症', 'PTSD', '青少年', '女性與孕期',
  '復發與渴求', '篩檢與評估', '腸道菌相', 'GLP-1',
  '神經發炎', '家庭治療', '動機式訪談', '認知行為治療',
  '正念', '減害策略', '臨床試驗', '系統性回顧',
  '流行病學', '基因學', '表觀遺傳學',
];

function getDateStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function loadPapers(inputPath) {
  const raw = readFileSync(inputPath, 'utf-8');
  return JSON.parse(raw);
}

function buildUserPrompt(papersData) {
  const dateStr = papersData.date || getDateStr();
  const count = papersData.count || 0;
  const papersText = JSON.stringify(papersData.papers || [], null, 2);

  return `以下是 ${dateStr} 從 PubMed 抓取的最新酒精成癮（AUD）研究文獻（共 ${count} 篇）。

請進行以下分析，並以 JSON 格式回傳（不要用 markdown code block）：

{
  "date": "${dateStr}",
  "market_summary": "1-2句話總結今天文獻的整體趨勢與亮點",
  "top_picks": [
    {
      "rank": 1,
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結（繁體中文，點出核心發現與臨床意義）",
      "pico": {
        "population": "研究對象",
        "intervention": "介入措施",
        "comparison": "對照組",
        "outcome": "主要結果"
      },
      "clinical_utility": "高/中/低",
      "utility_reason": "為什麼實用的一句話說明",
      "tags": ["標籤1", "標籤2"],
      "url": "原文連結",
      "emoji": "相關emoji"
    }
  ],
  "all_papers": [
    {
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結",
      "clinical_utility": "高/中/低",
      "tags": ["標籤1"],
      "url": "連結",
      "emoji": "emoji"
    }
  ],
  "keywords": ["關鍵字1", "關鍵字2"],
  "topic_distribution": {
    "酒精使用疾患": 3,
    "藥物治療": 2
  }
}

原始文獻資料：
${papersText}

請篩選出最重要的 TOP 5-8 篇論文放入 top_picks（按重要性排序），其餘放入 all_papers。
每篇 paper 的 tags 請從以下選擇：${AVAILABLE_TAGS.join('、')}。
記住：回傳純 JSON，不要用 \`\`\`json\`\`\` 包裹。`;
}

function sanitizeJSON(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    const firstNewline = cleaned.indexOf('\n');
    cleaned = firstNewline >= 0 ? cleaned.slice(firstNewline + 1) : cleaned.slice(3);
    cleaned = cleaned.replace(/```+\s*$/, '');
  }
  cleaned = cleaned.trim();

  // Try to find JSON object boundaries
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  // Fix common issues
  cleaned = cleaned.replace(/[\x00-\x1f]/g, (ch) => {
    if (ch === '\n' || ch === '\r' || ch === '\t') return ch;
    return '';
  });

  return cleaned;
}

function safeParseJSON(text) {
  // First attempt: direct parse
  try {
    return JSON.parse(text);
  } catch {
    // continue
  }

  // Second attempt: try to fix trailing commas
  try {
    const fixed = text.replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(fixed);
  } catch {
    // continue
  }

  // Third attempt: try to fix unescaped quotes in strings
  try {
    const fixed = text.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
    return JSON.parse(fixed);
  } catch {
    // continue
  }

  // Fourth attempt: extract keys we need and build a minimal valid object
  console.error('[WARN] All JSON parse attempts failed, building fallback structure');
  return null;
}

async function callZhipuAPI(apiKey, model, messages, maxRetries = 3) {
  const payload = {
    model,
    messages,
    temperature: 0.3,
    top_p: 0.9,
    max_tokens: 50000,
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.error(`[INFO] Trying ${model} (attempt ${attempt}/${maxRetries})...`);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 480000);

      const resp = await fetch(`${API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (resp.status === 429) {
        const wait = 60 * attempt;
        console.error(`[WARN] Rate limited, waiting ${wait}s...`);
        await new Promise(r => setTimeout(r, wait * 1000));
        continue;
      }

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        console.error(`[ERROR] HTTP ${resp.status}: ${errText.slice(0, 200)}`);
        if (resp.status >= 500) {
          await new Promise(r => setTimeout(r, 10000 * attempt));
          continue;
        }
        throw new Error(`HTTP ${resp.status}`);
      }

      const data = await resp.json();
      let content = data?.choices?.[0]?.message?.content || '';
      if (!content) throw new Error('Empty response content');

      content = sanitizeJSON(content);
      const parsed = safeParseJSON(content);

      if (!parsed) {
        console.error(`[WARN] JSON parse failed on attempt ${attempt}`);
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        throw new Error('JSON parse failed after all retries');
      }

      return parsed;
    } catch (e) {
      if (e.name === 'AbortError') {
        console.error(`[ERROR] Request to ${model} timed out (480s) on attempt ${attempt}`);
      } else {
        console.error(`[ERROR] ${model} failed (attempt ${attempt}): ${e.message}`);
      }
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 5000 * attempt));
      }
    }
  }
  return null;
}

async function analyzePapers(apiKey, papersData) {
  const userPrompt = buildUserPrompt(papersData);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  for (const model of MODELS) {
    console.error(`[INFO] === Trying model: ${model} ===`);
    const result = await callZhipuAPI(apiKey, model, messages);
    if (result) {
      console.error(`[INFO] Analysis complete with ${model}: ${result.top_picks?.length || 0} top picks, ${result.all_papers?.length || 0} total`);
      result._model = model;
      return result;
    }
    console.error(`[WARN] Model ${model} failed, trying next fallback...`);
  }

  console.error('[ERROR] All models failed');
  return null;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function generateHtml(analysis) {
  const dateStr = analysis.date || getDateStr();
  const dateParts = dateStr.split('-');
  const dateDisplay = dateParts.length === 3
    ? `${dateParts[0]}年${parseInt(dateParts[1])}月${parseInt(dateParts[2])}日`
    : dateStr;

  const summary = escapeHtml(analysis.market_summary || '');
  const topPicks = analysis.top_picks || [];
  const allPapers = analysis.all_papers || [];
  const keywords = analysis.keywords || [];
  const topicDist = analysis.topic_distribution || {};
  const modelUsed = escapeHtml(analysis._model || MODELS[0]);
  const totalCount = topPicks.length + allPapers.length;

  const topPicksHtml = topPicks.map(pick => {
    const tagsHtml = (pick.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
    const util = pick.clinical_utility || '中';
    const utilityClass = util === '高' ? 'utility-high' : (util === '中' ? 'utility-mid' : 'utility-low');
    const pico = pick.pico || {};
    const picoHtml = Object.keys(pico).length > 0 ? `
            <div class="pico-grid">
              <div class="pico-item"><span class="pico-label">P</span><span class="pico-text">${escapeHtml(pico.population || '-')}</span></div>
              <div class="pico-item"><span class="pico-label">I</span><span class="pico-text">${escapeHtml(pico.intervention || '-')}</span></div>
              <div class="pico-item"><span class="pico-label">C</span><span class="pico-text">${escapeHtml(pico.comparison || '-')}</span></div>
              <div class="pico-item"><span class="pico-label">O</span><span class="pico-text">${escapeHtml(pico.outcome || '-')}</span></div>
            </div>` : '';

    return `
        <div class="news-card featured">
          <div class="card-header">
            <span class="rank-badge">#${escapeHtml(String(pick.rank || ''))}</span>
            <span class="emoji-icon">${escapeHtml(pick.emoji || '📄')}</span>
            <span class="${utilityClass}">${escapeHtml(util)}實用性</span>
          </div>
          <h3>${escapeHtml(pick.title_zh || pick.title_en || '')}</h3>
          <p class="journal-source">${escapeHtml(pick.journal || '')} &middot; ${escapeHtml(pick.title_en || '')}</p>
          <p>${escapeHtml(pick.summary || '')}</p>
          ${picoHtml}
          <div class="card-footer">
            ${tagsHtml}
            <a href="${escapeHtml(pick.url || '#')}" target="_blank" rel="noopener noreferrer">閱讀原文 →</a>
          </div>
        </div>`;
  }).join('');

  const allPapersHtml = allPapers.map(paper => {
    const tagsHtml = (paper.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
    const util = paper.clinical_utility || '中';
    const utilityClass = util === '高' ? 'utility-high' : (util === '中' ? 'utility-mid' : 'utility-low');
    return `
        <div class="news-card">
          <div class="card-header-row">
            <span class="emoji-sm">${escapeHtml(paper.emoji || '📄')}</span>
            <span class="${utilityClass} utility-sm">${escapeHtml(util)}</span>
          </div>
          <h3>${escapeHtml(paper.title_zh || paper.title_en || '')}</h3>
          <p class="journal-source">${escapeHtml(paper.journal || '')}</p>
          <p>${escapeHtml(paper.summary || '')}</p>
          <div class="card-footer">
            ${tagsHtml}
            <a href="${escapeHtml(paper.url || '#')}" target="_blank" rel="noopener noreferrer">PubMed →</a>
          </div>
        </div>`;
  }).join('');

  const keywordsHtml = keywords.map(k => `<span class="keyword">${escapeHtml(k)}</span>`).join('');

  const topicBarsHtml = (() => {
    if (!Object.keys(topicDist).length) return '';
    const maxCount = Math.max(...Object.values(topicDist), 1);
    return Object.entries(topicDist).map(([topic, count]) => `
            <div class="topic-row">
              <span class="topic-name">${escapeHtml(topic)}</span>
              <div class="topic-bar-bg"><div class="topic-bar" style="width:${Math.round((count / maxCount) * 100)}%"></div></div>
              <span class="topic-count">${count}</span>
            </div>`).join('');
  })();

  const topPicksSection = topPicksHtml ? `<div class='section'><div class='section-title'><span class='section-icon'>⭐</span>今日精選 TOP Picks</div>${topPicksHtml}</div>` : '';
  const allPapersSection = allPapersHtml ? `<div class='section'><div class='section-title'><span class='section-icon'>📚</span>其他值得關注的文獻</div>${allPapersHtml}</div>` : '';
  const topicSection = topicBarsHtml ? `<div class='topic-section section'><div class='section-title'><span class='section-icon'>📊</span>主題分佈</div>${topicBarsHtml}</div>` : '';
  const keywordsSection = keywordsHtml ? `<div class='keywords-section section'><div class='section-title'><span class='section-icon'>🏷️</span>關鍵字</div><div class='keywords'>${keywordsHtml}</div></div>` : '';

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Alcohol Addiction Research &middot; 酒癮研究文獻日報 &middot; ${dateDisplay}</title>
<meta name="description" content="${dateDisplay} 酒癮研究文獻日報，由 AI 自動彙整 PubMed 最新論文"/>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; --card-bg: color-mix(in srgb, var(--surface) 92%, white); }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; overflow-x: hidden; }
  .container { position: relative; z-index: 1; max-width: 880px; margin: 0 auto; padding: 60px 32px 80px; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 52px; animation: fadeDown 0.6s ease both; }
  .logo { width: 48px; height: 48px; border-radius: 14px; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; box-shadow: 0 4px 20px rgba(140,79,43,0.25); }
  .header-text h1 { font-size: 22px; font-weight: 700; color: var(--text); letter-spacing: -0.3px; }
  .header-meta { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; letter-spacing: 0.3px; }
  .badge-date { background: var(--accent-soft); border: 1px solid var(--line); color: var(--accent); }
  .badge-count { background: rgba(140,79,43,0.06); border: 1px solid var(--line); color: var(--muted); }
  .badge-source { background: transparent; color: var(--muted); font-size: 11px; padding: 0 4px; }
  .summary-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 28px 32px; margin-bottom: 32px; box-shadow: 0 20px 60px rgba(61,36,15,0.06); animation: fadeUp 0.5s ease 0.1s both; }
  .summary-card h2 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.6px; color: var(--accent); margin-bottom: 16px; }
  .summary-text { font-size: 15px; line-height: 1.8; color: var(--text); }
  .section { margin-bottom: 36px; animation: fadeUp 0.5s ease both; }
  .section-title { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 700; color: var(--text); margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .section-icon { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; background: var(--accent-soft); }
  .news-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 22px 26px; margin-bottom: 12px; box-shadow: 0 8px 30px rgba(61,36,15,0.04); transition: background 0.2s, border-color 0.2s, transform 0.2s; }
  .news-card:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .news-card.featured { border-left: 3px solid var(--accent); }
  .news-card.featured:hover { border-color: var(--accent); }
  .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .rank-badge { background: var(--accent); color: #fff7f0; font-weight: 700; font-size: 12px; padding: 2px 8px; border-radius: 6px; }
  .emoji-icon { font-size: 18px; }
  .card-header-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .emoji-sm { font-size: 14px; }
  .news-card h3 { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 8px; line-height: 1.5; }
  .journal-source { font-size: 12px; color: var(--accent); margin-bottom: 8px; opacity: 0.8; }
  .news-card p { font-size: 13.5px; line-height: 1.75; color: var(--muted); }
  .card-footer { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tag { padding: 2px 9px; background: var(--accent-soft); border-radius: 999px; font-size: 11px; color: var(--accent); }
  .news-card a { font-size: 12px; color: var(--accent); text-decoration: none; opacity: 0.7; margin-left: auto; }
  .news-card a:hover { opacity: 1; }
  .utility-high { color: #5a7a3a; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(90,122,58,0.1); border-radius: 4px; }
  .utility-mid { color: #9f7a2e; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(159,122,46,0.1); border-radius: 4px; }
  .utility-low { color: var(--muted); font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(118,100,83,0.08); border-radius: 4px; }
  .utility-sm { font-size: 10px; }
  .pico-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; padding: 12px; background: rgba(255,253,249,0.8); border-radius: 14px; border: 1px solid var(--line); }
  .pico-item { display: flex; gap: 8px; align-items: baseline; }
  .pico-label { font-size: 10px; font-weight: 700; color: #fff7f0; background: var(--accent); padding: 2px 6px; border-radius: 4px; flex-shrink: 0; }
  .pico-text { font-size: 12px; color: var(--muted); line-height: 1.4; }
  .keywords-section { margin-bottom: 36px; }
  .keywords { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .keyword { padding: 5px 14px; background: var(--accent-soft); border: 1px solid var(--line); border-radius: 20px; font-size: 12px; color: var(--accent); cursor: default; transition: background 0.2s; }
  .keyword:hover { background: rgba(140,79,43,0.18); }
  .topic-section { margin-bottom: 36px; }
  .topic-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .topic-name { font-size: 13px; color: var(--muted); width: 100px; flex-shrink: 0; text-align: right; }
  .topic-bar-bg { flex: 1; height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
  .topic-bar { height: 100%; background: linear-gradient(90deg, var(--accent), #c47a4a); border-radius: 4px; transition: width 0.6s ease; }
  .topic-count { font-size: 12px; color: var(--accent); width: 24px; }
  .clinic-banner { margin-top: 48px; animation: fadeUp 0.5s ease 0.4s both; }
  .clinic-link { display: flex; align-items: center; gap: 14px; padding: 18px 24px; background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; text-decoration: none; color: var(--text); transition: all 0.2s; box-shadow: 0 8px 30px rgba(61,36,15,0.04); }
  .clinic-link:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .clinic-icon { font-size: 28px; flex-shrink: 0; }
  .clinic-name { font-size: 15px; font-weight: 700; color: var(--text); flex: 1; }
  .clinic-desc { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .clinic-arrow { font-size: 18px; color: var(--accent); font-weight: 700; }
  .links-grid { display: grid; grid-template-columns: 1fr; gap: 12px; margin-top: 48px; animation: fadeUp 0.5s ease 0.4s both; }
  footer { margin-top: 32px; padding-top: 22px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; animation: fadeUp 0.5s ease 0.5s both; }
  footer a { color: var(--muted); text-decoration: none; }
  footer a:hover { color: var(--accent); }
  @keyframes fadeDown { from { opacity: 0; transform: translateY(-16px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  @media (max-width: 600px) { .container { padding: 36px 18px 60px; } .summary-card, .news-card { padding: 20px 18px; } .pico-grid { grid-template-columns: 1fr; } footer { flex-direction: column; gap: 6px; text-align: center; } .topic-name { width: 70px; font-size: 11px; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">🍷</div>
    <div class="header-text">
      <h1>Alcohol Addiction Research &middot; 酒癮研究文獻日報</h1>
      <div class="header-meta">
        <span class="badge badge-date">📅 ${dateDisplay}</span>
        <span class="badge badge-count">📊 ${totalCount} 篇文獻</span>
        <span class="badge badge-source">Powered by PubMed + Zhipu AI</span>
      </div>
    </div>
  </header>

  <div class="summary-card">
    <h2>📋 今日文獻趨勢</h2>
    <p class="summary-text">${summary}</p>
  </div>

  ${topPicksSection}
  ${allPapersSection}
  ${topicSection}
  ${keywordsSection}

  <div class="links-grid">
    <a href="https://www.leepsyclinic.com/" class="clinic-link" target="_blank" rel="noopener noreferrer">
      <span class="clinic-icon">🏥</span>
      <div>
        <div class="clinic-name">李政洋身心診所首頁</div>
        <div class="clinic-desc">www.leepsyclinic.com</div>
      </div>
      <span class="clinic-arrow">→</span>
    </a>
    <a href="https://blog.leepsyclinic.com/" class="clinic-link" target="_blank" rel="noopener noreferrer">
      <span class="clinic-icon">📬</span>
      <div>
        <div class="clinic-name">訂閱電子報</div>
        <div class="clinic-desc">blog.leepsyclinic.com</div>
      </div>
      <span class="clinic-arrow">→</span>
    </a>
    <a href="https://buymeacoffee.com/CYlee" class="clinic-link" target="_blank" rel="noopener noreferrer">
      <span class="clinic-icon">☕</span>
      <div>
        <div class="clinic-name">Buy Me a Coffee</div>
        <div class="clinic-desc">buymeacoffee.com/CYlee</div>
      </div>
      <span class="clinic-arrow">→</span>
    </a>
  </div>

  <footer>
    <span>資料來源：PubMed &middot; 分析模型：${modelUsed}</span>
    <span><a href="https://github.com/u8901006/alcohol-addiction">GitHub</a></span>
  </footer>
</div>
</body>
</html>`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    input: resolve(ROOT, 'papers.json'),
    output: resolve(ROOT, 'docs', `alcohol-${getDateStr()}.html`),
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) opts.input = resolve(ROOT, args[++i]);
    else if (args[i] === '--output' && args[i + 1]) opts.output = args[++i];
  }
  return opts;
}

async function main() {
  const opts = parseArgs();
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    console.error('[ERROR] ZHIPU_API_KEY environment variable is required');
    process.exit(1);
  }

  const papersData = loadPapers(opts.input);
  let analysis;

  if (!papersData || !papersData.papers || papersData.papers.length === 0) {
    console.error('[WARN] No papers found, generating empty report');
    analysis = {
      date: getDateStr(),
      market_summary: '今日 PubMed 暫無新的酒精成癮研究文獻更新。請明天再查看。',
      top_picks: [],
      all_papers: [],
      keywords: [],
      topic_distribution: {},
    };
  } else {
    analysis = await analyzePapers(apiKey, papersData);
    if (!analysis) {
      console.error('[ERROR] Analysis failed, cannot generate report');
      process.exit(1);
    }
  }

  const html = generateHtml(analysis);
  mkdirSync(dirname(opts.output), { recursive: true });
  writeFileSync(opts.output, html, 'utf-8');

  // Save summarized PMIDs for dedup tracking
  const summarizedFile = resolve(ROOT, 'summarized_pmids.json');
  const summarizedPMIDs = papersData?.papers?.map(p => p.pmid).filter(Boolean) || [];
  let existing = [];
  try {
    existing = JSON.parse(readFileSync(summarizedFile, 'utf-8')).pmids || [];
  } catch {
    // doesn't exist yet
  }
  const allPMIDs = [...new Set([...existing, ...summarizedPMIDs])];
  // Keep only last 7 days worth (max ~350 PMIDs)
  const trimmedPMIDs = allPMIDs.slice(-350);
  writeFileSync(summarizedFile, JSON.stringify({ pmids: trimmedPMIDs, updated: getDateStr() }, null, 2), 'utf-8');

  console.error(`[INFO] Report saved to ${opts.output}`);
}

main().catch(e => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
