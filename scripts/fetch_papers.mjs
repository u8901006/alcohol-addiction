#!/usr/bin/env node
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const PUBMED_SEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_FETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
const HEADERS = { 'User-Agent': 'AlcoholAddictionResearchBot/1.0 (research aggregator)' };

const JOURNALS = [
  'Alcohol Clin Exp Res',
  'Alcohol Alcohol',
  'Addiction',
  'Drug Alcohol Depend',
  'J Stud Alcohol Drugs',
  'Addict Behav',
  'Alcohol',
  'Addict Biol',
  'Psychol Addict Behav',
  'Drug Alcohol Rev',
  'J Addict Med',
  'Am J Addict',
  'Subst Abuse Treat Prev Policy',
  'Addict Sci Clin Pract',
  'JAMA Psychiatry',
  'Am J Psychiatry',
  'Lancet Psychiatry',
  'Biol Psychiatry',
  'Psychol Med',
  'Neuropsychopharmacology',
  'J Clin Psychiatry',
  'Br J Psychiatry',
  'Mol Psychiatry',
  'Transl Psychiatry',
  'Pharmacol Biochem Behav',
  'Neuropharmacology',
  'Psychopharmacology (Berl)',
  'Hepatology',
  'J Hepatol',
  'Gut',
  'Nutrients',
  'Am J Clin Nutr',
  'Soc Sci Med',
  'Am J Public Health',
  'Implement Sci',
  'Health Policy',
  'J Adolesc Health',
  'Pediatrics',
  'J Child Psychol Psychiatry',
  'Behav Brain Res',
  'J Neurosci',
  'Neuroimage',
  'Cereb Cortex',
  'J Consult Clin Psychol',
  'Clin Psychol Rev',
  'Behav Res Ther',
  'Cochrane Database Syst Rev',
  'BMJ',
  'Lancet',
  'N Engl J Med',
  'JAMA',
  'Ann Intern Med',
  'World Psychiatry',
  'Eur Neuropsychopharmacol',
  'Exp Clin Psychopharmacol',
  'CNS Drugs',
  'Gen Hosp Psychiatry',
  'Prev Med',
  'Int J Drug Policy',
];

const CORE_AUD_TERMS = [
  '"Alcohol-Related Disorders"[Mesh]',
  '"Alcoholism"[Mesh]',
  '"Alcohol Use Disorder"[tiab]',
  'alcoholism[tiab]',
  '"alcohol dependence"[tiab]',
  '"alcohol addiction"[tiab]',
  '"alcohol abuse"[tiab]',
  '"alcohol misuse"[tiab]',
  '"harmful drinking"[tiab]',
  '"problem drinking"[tiab]',
  '"hazardous drinking"[tiab]',
  '"heavy drinking"[tiab]',
  '"Binge Drinking"[Mesh]',
  '"binge drinking"[tiab]',
];

function buildQuery(days) {
  const audSet = `(${CORE_AUD_TERMS.join(' OR ')})`;
  const now = new Date();
  const lookback = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const startDate = lookback.toISOString().slice(0, 10).replace(/-/g, '/');
  const datePart = `"${startDate}"[Date - Publication] : "3000"[Date - Publication]`;
  return `${audSet} AND ${datePart}`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 7, maxPapers: 50, output: resolve(ROOT, 'papers.json') };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) { opts.days = parseInt(args[++i], 10); }
    else if (args[i] === '--max-papers' && args[i + 1]) { opts.maxPapers = parseInt(args[++i], 10); }
    else if (args[i] === '--output' && args[i + 1]) { opts.output = resolve(ROOT, args[++i]); }
  }
  return opts;
}

async function fetchJSON(url, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeout = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractTextSafe(el, tag) {
  const found = el.getElementsByTagName(tag);
  if (found.length === 0) return '';
  return (found[0].textContent || '').trim();
}

function parseXML(xml) {
  const articles = [];
  const articleMatches = xml.split('<PubmedArticle>').slice(1);
  for (const block of articleMatches) {
    try {
      const titleMatch = block.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/);
      const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
      if (!title) continue;

      const abstractParts = [];
      const absRegex = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
      let absMatch;
      while ((absMatch = absRegex.exec(block)) !== null) {
        const labelMatch = absMatch[0].match(/Label="([^"]*)"/);
        const label = labelMatch ? labelMatch[1] : '';
        const text = absMatch[1].replace(/<[^>]+>/g, '').trim();
        if (text) {
          abstractParts.push(label ? `${label}: ${text}` : text);
        }
      }
      const abstract = abstractParts.join(' ').slice(0, 2000);

      const journalMatch = block.match(/<Title>([\s\S]*?)<\/Title>/);
      const journal = journalMatch ? journalMatch[1].trim() : '';

      const yearMatch = block.match(/<Year>(\d{4})<\/Year>/);
      const monthMatch = block.match(/<Month>([^<]+)<\/Month>/);
      const dayMatch = block.match(/<Day>(\d+)<\/Day>/);
      const dateParts = [yearMatch?.[1], monthMatch?.[1], dayMatch?.[1]].filter(Boolean);
      const dateStr = dateParts.join(' ');

      const pmidMatch = block.match(/<PMID[^>]*>(\d+)<\/PMID>/);
      const pmid = pmidMatch ? pmidMatch[1] : '';
      const url = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : '';

      const keywords = [];
      const kwRegex = /<Keyword>([\s\S]*?)<\/Keyword>/g;
      let kwMatch;
      while ((kwMatch = kwRegex.exec(block)) !== null) {
        const kw = kwMatch[1].trim();
        if (kw) keywords.push(kw);
      }

      articles.push({ pmid, title, journal, date: dateStr, abstract, url, keywords });
    } catch {
      continue;
    }
  }
  return articles;
}

function getDateStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function loadSummarizedPMIDs(docsDir) {
  const pmids = new Set();
  if (!existsSync(docsDir)) return pmids;
  try {
    const files = readFileSync(resolve(docsDir, '..', 'summarized_pmids.json'), 'utf-8');
    const data = JSON.parse(files);
    if (Array.isArray(data.pmids)) data.pmids.forEach(p => pmids.add(p));
  } catch {
    // file doesn't exist yet, that's fine
  }
  return pmids;
}

async function main() {
  const opts = parseArgs();
  const docsDir = resolve(ROOT, 'docs');
  const query = buildQuery(opts.days);

  console.error(`[INFO] Searching PubMed for alcohol papers from last ${opts.days} days...`);
  console.error(`[INFO] Query length: ${query.length} chars`);

  let pmids = [];
  try {
    const searchUrl = `${PUBMED_SEARCH}?db=pubmed&term=${encodeURIComponent(query)}&retmax=${opts.maxPapers}&sort=date&retmode=json`;
    const searchData = await fetchJSON(searchUrl);
    pmids = searchData?.esearchresult?.idlist || [];
  } catch (e) {
    console.error(`[ERROR] PubMed search failed: ${e.message}`);
  }

  console.error(`[INFO] Found ${pmids.length} papers`);

  if (pmids.length === 0) {
    const emptyResult = { date: getDateStr(), count: 0, papers: [] };
    writeFileSync(opts.output, JSON.stringify(emptyResult, null, 2), 'utf-8');
    console.error('[INFO] No papers found, saved empty result');
    return;
  }

  let papers = [];
  try {
    const fetchUrl = `${PUBMED_FETCH}?db=pubmed&id=${pmids.join(',')}&retmode=xml`;
    const xmlData = await fetchText(fetchUrl);
    papers = parseXML(xmlData);
  } catch (e) {
    console.error(`[ERROR] PubMed fetch failed: ${e.message}`);
  }

  console.error(`[INFO] Parsed ${papers.length} papers`);

  const result = {
    date: getDateStr(),
    count: papers.length,
    papers,
  };

  writeFileSync(opts.output, JSON.stringify(result, null, 2), 'utf-8');
  console.error(`[INFO] Saved ${papers.length} papers to ${opts.output}`);
}

main().catch(e => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
