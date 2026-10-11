// Tech Stack Scout — weekly refresh for one watchlist account.
// Pipeline: resolve -> collect (GitHub, ATS job board, blog RSS) -> extract (dictionary + Gemini P1, quotes verified)
// -> fuse into an evidence ledger -> score (tier, ICP fit, why-now, hypotheses) -> diff
// -> Gemini P2 writer (closed vocabulary, cited) -> code verifier -> P3 repair -> template fallback -> store.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SB = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
let GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
let GH_TOKEN = Deno.env.get("GITHUB_TOKEN") ?? "";
// Fallback: keys kept in the private app_config table (RLS on, no policies, so the public site cannot read them)
async function loadKeys() {
  if (GEMINI_KEY && GH_TOKEN) return;
  const { data } = await SB.from("app_config").select("key,value").in("key", ["gemini_api_key", "github_token"]);
  for (const r of data || []) { if (r.key === "gemini_api_key" && !GEMINI_KEY) GEMINI_KEY = r.value; if (r.key === "github_token" && !GH_TOKEN) GH_TOKEN = r.value; }
}
const MODELS = [Deno.env.get("GEMINI_MODEL"), "gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"].filter(Boolean) as string[];
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Everything below is a default. loadConfig() overrides it from the Supabase tables, so the team can change it without a deploy.
let PRODUCT = Deno.env.get("PRODUCT_ONE_LINER") ??
  "a developer productivity platform that cuts CI time with remote caching and test impact analysis, and gives every engineer reproducible preview environments";
let PROMPT_VERSION = "writer-v1";
let PROMPT_TEMPLATE: string | null = null;
let BANNED_LIST: string[] = [];
let ICP_W: any = { base: 0.15, per_hypothesis: 0.12, kubernetes: 0.12, measured_ci: 0.1, platform_roles: 0.1, tier_a: 0.1 };
let WHY_W: any = { base: 0.1, per_change: 0.08, migration: 0.3, platform_per_role: 0.06, platform_cap: 0.3, ci_slow: 0.15, ci_slow_min: 15 };
let ALERT_HOOKS: string[] = ["migration", "hiring_surge"];
let PLAYBOOKS: any[] = [];
let SOURCES: Record<string, boolean> = { github: true, job_board: true, blog: true, website: true, fingerprint: true, news: true };
let CUSTOM_SOURCES: any[] = [];
let HOOK_TYPES: string[] = ["measured_ci", "migration", "hiring_surge", "scale_threshold", "blog_reference", "oss_project"];
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };

let ghCalls = 0, gemCalls = 0;

// ---------- vocabulary (shared by extractor, writer and verifier) ----------
type Cat = "language" | "cloud" | "orchestration" | "ci" | "build" | "data" | "observability" | "infra";
const VOCAB: Record<string, { cat: Cat; aliases: string[] }> = {
  aws: { cat: "cloud", aliases: ["aws", "amazon web services", "ec2", "lambda", "s3"] },
  gcp: { cat: "cloud", aliases: ["gcp", "google cloud", "gke", "bigquery", "cloud run"] },
  azure: { cat: "cloud", aliases: ["azure", "aks"] },
  cloudflare: { cat: "cloud", aliases: ["cloudflare", "cloudflare workers"] },
  vercel: { cat: "cloud", aliases: ["vercel"] },
  kubernetes: { cat: "orchestration", aliases: ["kubernetes", "k8s", "eks", "gke", "aks", "helm"] },
  docker: { cat: "orchestration", aliases: ["docker", "containers", "containerd"] },
  nomad: { cat: "orchestration", aliases: ["nomad"] },
  terraform: { cat: "infra", aliases: ["terraform", "opentofu"] },
  pulumi: { cat: "infra", aliases: ["pulumi"] },
  "github actions": { cat: "ci", aliases: ["github actions"] },
  jenkins: { cat: "ci", aliases: ["jenkins"] },
  circleci: { cat: "ci", aliases: ["circleci"] },
  buildkite: { cat: "ci", aliases: ["buildkite"] },
  argocd: { cat: "ci", aliases: ["argo cd", "argocd"] },
  bazel: { cat: "build", aliases: ["bazel"] },
  nx: { cat: "build", aliases: ["nx monorepo", "nx.dev"] },
  turborepo: { cat: "build", aliases: ["turborepo", "turbo repo"] },
  monorepo: { cat: "build", aliases: ["monorepo"] },
  grpc: { cat: "infra", aliases: ["grpc", "protobuf", "protocol buffers"] },
  kafka: { cat: "data", aliases: ["kafka"] },
  postgres: { cat: "data", aliases: ["postgres", "postgresql"] },
  clickhouse: { cat: "data", aliases: ["clickhouse"] },
  redis: { cat: "data", aliases: ["redis"] },
  snowflake: { cat: "data", aliases: ["snowflake"] },
  prometheus: { cat: "observability", aliases: ["prometheus"] },
  grafana: { cat: "observability", aliases: ["grafana"] },
  datadog: { cat: "observability", aliases: ["datadog"] },
  opentelemetry: { cat: "observability", aliases: ["opentelemetry", "otel"] },
  go: { cat: "language", aliases: ["golang"] },
  typescript: { cat: "language", aliases: ["typescript"] },
  python: { cat: "language", aliases: ["python"] },
  rust: { cat: "language", aliases: ["rust"] },
  java: { cat: "language", aliases: ["java"] },
  kotlin: { cat: "language", aliases: ["kotlin"] },
  ruby: { cat: "language", aliases: ["ruby", "rails"] },
  elixir: { cat: "language", aliases: ["elixir"] },
  scala: { cat: "language", aliases: ["scala"] },
  "c++": { cat: "language", aliases: ["c++"] },
  php: { cat: "language", aliases: ["php"] },
  react: { cat: "language", aliases: ["react", "next.js", "nextjs"] },
};
const ALIAS = new Map<string, string>();
for (const [k, v] of Object.entries(VOCAB)) { ALIAS.set(k, k); v.aliases.forEach((a) => ALIAS.set(a, k)); }
const canon = (t: string) => ALIAS.get(t.toLowerCase().trim()) ?? null;
const normDomain = (d: string) => String(d || "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/[\/?#:].*$/, "");

async function loadConfig() {
  const [prof, dict, pbs, srcs, prompt] = await Promise.all([
    SB.from("seller_profile").select("*").eq("id", "default").maybeSingle(),
    SB.from("tech_dictionary").select("*").eq("enabled", true),
    SB.from("hook_playbooks").select("*").eq("enabled", true).order("sort"),
    SB.from("sources").select("*"),
    SB.from("prompt_versions").select("*").eq("role", "writer").eq("active", true).maybeSingle(),
  ]);
  if (prof.data) {
    PRODUCT = prof.data.product || PRODUCT; BANNED_LIST = (prof.data.banned_phrases || []).map((x: string) => x.toLowerCase());
    ICP_W = { ...ICP_W, ...(prof.data.icp_weights?.icp || {}) }; WHY_W = { ...WHY_W, ...(prof.data.icp_weights?.why_now || {}) };
    if (prof.data.alert_hooks) ALERT_HOOKS = prof.data.alert_hooks;
  }
  if (dict.data?.length) {
    for (const k of Object.keys(VOCAB)) delete VOCAB[k];
    ALIAS.clear();
    for (const d of dict.data) { VOCAB[d.tech] = { cat: d.category, aliases: d.aliases || [] }; ALIAS.set(d.tech, d.tech); (d.aliases || []).forEach((a: string) => ALIAS.set(a.toLowerCase(), d.tech)); }
  }
  if (pbs.data?.length) { PLAYBOOKS = pbs.data; HOOK_TYPES = [...new Set(pbs.data.map((p: any) => p.hook_type))] as string[]; }
  for (const x of srcs.data || []) { if (x.kind === "builtin") SOURCES[x.slug] = x.enabled; else if (x.enabled) CUSTOM_SOURCES.push(x); }
  if (prompt.data) { PROMPT_TEMPLATE = prompt.data.system_text; PROMPT_VERSION = prompt.data.version; }
}
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const termRe = (a: string) => new RegExp(`(^|[^a-z0-9+#.])${escRe(a)}(?![a-z0-9+#])`, "i");
const ALT_RE = /\b(or|such as|e\.g\.|for example|any of|one of|similar)\b/i;

// ---------- helpers ----------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url: string, headers: Record<string, string> = {}, timeout = 12000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { "User-Agent": "tech-stack-scout", ...headers }, signal: c.signal });
    if (!r.ok) return { ok: false, status: r.status, data: null as any };
    return { ok: true, status: r.status, data: await r.json() };
  } catch { return { ok: false, status: 0, data: null as any }; } finally { clearTimeout(t); }
}
async function getText(url: string, timeout = 10000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), timeout);
  try { const r = await fetch(url, { headers: { "User-Agent": "tech-stack-scout" }, signal: c.signal, redirect: "follow" }); return r.ok ? await r.text() : null; }
  catch { return null; } finally { clearTimeout(t); }
}
const gh = (path: string) => { ghCalls++; return getJSON(`https://api.github.com${path}`, { Accept: "application/vnd.github+json", ...(GH_TOKEN ? { Authorization: `Bearer ${GH_TOKEN}` } : {}) }); };
const stripHtml = (h: string) => h.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r2 = (n: number) => Math.round(n * 100) / 100;
async function sha(s: string) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 16); }
function sentenceAround(text: string, idx: number) {
  const start = Math.max(text.lastIndexOf(". ", idx) + 2, idx - 140, 0);
  let end = text.indexOf(". ", idx); if (end < 0 || end - idx > 160) end = Math.min(text.length, idx + 120);
  return text.slice(start, end).trim().slice(0, 220);
}

// ---------- v7: website crawl, link-based discovery, fingerprint, news ----------
const UA_BOT = "Mozilla/5.0 (compatible; TechStackScout/1.0; +https://tech-stack-scout.vercel.app)";
async function getPage(url: string, timeout = 9000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA_BOT, Accept: "text/html,application/xhtml+xml" }, signal: c.signal, redirect: "follow" });
    if (!r.ok) return { ok: false, status: r.status, url: r.url || url, headers: {} as Record<string, string>, html: "" };
    const ct = r.headers.get("content-type") || "";
    const headers: Record<string, string> = {}; r.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    if (!/html|xml|text/i.test(ct)) return { ok: false, status: 415, url: r.url || url, headers, html: "" };
    return { ok: true, status: r.status, url: r.url || url, headers, html: (await r.text()).slice(0, 700000) };
  } catch { return { ok: false, status: 0, url, headers: {} as Record<string, string>, html: "" }; } finally { clearTimeout(t); }
}
async function postJSON(url: string, body: any, timeout = 12000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), timeout);
  try {
    const r = await fetch(url, { method: "POST", headers: { "User-Agent": "tech-stack-scout", "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body), signal: c.signal });
    if (!r.ok) return { ok: false, data: null as any };
    return { ok: true, data: await r.json() };
  } catch { return { ok: false, data: null as any }; } finally { clearTimeout(t); }
}
const visibleText = (html: string) => stripHtml(html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")).slice(0, 14000);
const robotsBlocks = (txt: string | null) => {
  if (!txt) return false;
  let star = false;
  for (const raw of txt.split(/\r?\n/)) {
    const l = raw.replace(/#.*/, "").trim(); if (!l) continue;
    const m = l.match(/^([a-z-]+)\s*:\s*(.*)$/i); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === "user-agent") star = v === "*";
    else if (star && k === "disallow" && v === "/") return true;
  }
  return false;
};
const GH_RESERVED = new Set(["sponsors", "orgs", "features", "marketplace", "topics", "about", "pricing", "login", "join", "settings", "apps", "enterprise", "collections", "explore", "readme", "security", "site", "contact", "customer-stories", "solutions", "resources", "events", "trending", "notifications", "new", "organizations", "users", "team", "pulls", "issues", "codespaces", "copilot", "actions", "premium-support"]);
const ATS_PATTERNS: [string, RegExp, (m: RegExpMatchArray) => string][] = [
  ["greenhouse", /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)/i, (m) => m[1]],
  ["lever", /jobs\.lever\.co\/([a-z0-9_-]+)/i, (m) => m[1]],
  ["ashby", /jobs\.ashbyhq\.com\/([a-z0-9._%-]+)/i, (m) => decodeURIComponent(m[1])],
  ["workable", /apply\.workable\.com\/([a-z0-9_-]+)/i, (m) => m[1]],
  ["smartrecruiters", /(?:jobs|careers)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/i, (m) => m[1]],
  ["recruitee", /([a-z0-9-]+)\.recruitee\.com/i, (m) => m[1]],
  ["personio", /([a-z0-9-]+)\.jobs\.personio\.(?:de|com)/i, (m) => m[1]],
  ["bamboohr", /([a-z0-9-]+)\.bamboohr\.com\/(?:careers|jobs)/i, (m) => m[1]],
  ["workday", /([a-z0-9-]+\.wd\d+\.myworkdayjobs\.com)\/(?:[a-z]{2}-[A-Za-z]{2}\/)?([A-Za-z0-9_-]+)/i, (m) => `${m[1]}|${m[1].split(".")[0]}|${m[2]}`],
];
const NOT_SLUG = new Set(["embed", "jobs", "careers", "api", "www", "static", "assets"]);
function jsonldJobs(html: string, base: string) {
  const out: { title: string; url: string; text: string }[] = [];
  const walk = (n: any) => {
    if (!n) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n !== "object") return;
    const t = n["@type"]; if (t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"))) out.push({ title: String(n.title || ""), url: String(n.url || base), text: stripHtml(String(n.description || "")) });
    if (n["@graph"]) walk(n["@graph"]);
    if (n.itemListElement) walk(n.itemListElement);
    if (n.item) walk(n.item);
  };
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { walk(JSON.parse(m[1].trim())); } catch { /* ignore */ } }
  return out.filter((j) => j.title);
}
// Crawl the public website politely: homepage, then up to 6 pages found by link, and discover GitHub org / ATS / RSS from what the site itself links to.
async function collectWebsite(dom: string, careersHint: string | null) {
  const res: any = { ok: false, blocked: false, home: null, pages: [] as { kind: string; url: string; text: string }[], githubOrgs: [] as { org: string; n: number }[], ats: [] as { provider: string; slug: string }[], rss: [] as string[], careersUrl: careersHint || null, jsonld: [] as any[], fetched: 0 };
  const robots = await getText(`https://${dom}/robots.txt`, 6000);
  if (robotsBlocks(robots)) { res.blocked = true; return res; }
  let home = await getPage(`https://${dom}/`); if (!home.ok) home = await getPage(`https://www.${dom}/`);
  if (!home.ok) return res;
  res.ok = true; res.home = home; res.fetched = 1;
  let host = ""; try { host = new URL(home.url).hostname.replace(/^www\./, ""); } catch { host = dom; }
  const sameSite = (u: URL) => u.hostname === host || u.hostname.endsWith("." + host) || u.hostname === "www." + host;
  const links: { url: URL; text: string }[] = [];
  const collectLinks = (html: string, base: string) => {
    for (const m of html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      try { const u = new URL(m[1], base); if (/^https?:$/.test(u.protocol)) links.push({ url: u, text: stripHtml(m[2]).slice(0, 80).toLowerCase() }); } catch { /* skip */ }
    }
  };
  collectLinks(home.html, home.url);
  const KINDS: [string, RegExp][] = [
    ["careers", /(^|\/)(careers?|jobs?|join-us|join|work-with-us|work-for-us|vacancies|were-hiring|we-are-hiring|opportunities)(\/|$|-)/i],
    ["engineering", /(^|\/)(engineering|tech-blog|technology|developers?|dev-blog)(\/|$)/i],
    ["security", /(^|\/)(security|trust|trust-center)(\/|$)/i],
    ["blog", /(^|\/)(blog|news|insights|resources)(\/|$)/i],
  ];
  const pick: Record<string, string> = {};
  if (careersHint) pick.careers = careersHint;
  for (const l of links) {
    if (!sameSite(l.url)) continue;
    const path = l.url.pathname.toLowerCase();
    for (const [k, re] of KINDS) if (!pick[k] && (re.test(path) || (path.length < 3 && re.test("/" + l.text.replace(/\s+/g, "-"))) || (k === "careers" && /^(careers|jobs|we're hiring|join us)$/.test(l.text)))) pick[k] = l.url.href;
  }
  const guesses = pick.careers ? [] : [`https://${host}/careers`, `https://${host}/jobs`, `https://www.${host}/careers`];
  const toFetch: [string, string][] = Object.entries(pick).map(([k, u]) => [k, u] as [string, string]);
  const fetched = await Promise.all(toFetch.map(async ([k, u]) => ({ kind: k, page: await getPage(u) })));
  if (!pick.careers) for (const g of guesses) { const p = await getPage(g, 7000); if (p.ok && /career|job|position|opening|hiring/i.test(p.html.slice(0, 40000))) { fetched.push({ kind: "careers", page: p }); break; } }
  const htmls: { url: string; html: string }[] = [{ url: home.url, html: home.html }];
  for (const f of fetched) {
    if (!f.page.ok) continue;
    res.fetched++; htmls.push({ url: f.page.url, html: f.page.html }); collectLinks(f.page.html, f.page.url);
    if (f.kind === "careers" && !res.careersUrl) res.careersUrl = f.page.url;
    if (f.kind !== "blog") res.pages.push({ kind: f.kind, url: f.page.url, text: visibleText(f.page.html) });
    if (f.kind === "careers") res.jsonld.push(...jsonldJobs(f.page.html, f.page.url));
  }
  if (!res.careersUrl && pick.careers) res.careersUrl = pick.careers;
  // discovery by link, never by guess
  const gh = new Map<string, number>();
  const atsSeen = new Set<string>();
  const hay = [...htmls.map((h) => h.html), ...links.map((l) => l.url.href)];
  for (const s of hay) {
    for (const m of s.matchAll(/github\.com\/(?:orgs\/)?([A-Za-z0-9-]{2,39})(?=[\/"'\s?#<)]|$)/g)) { const o = m[1].toLowerCase(); if (!GH_RESERVED.has(o)) gh.set(o, (gh.get(o) || 0) + 1); }
    for (const [prov, re, slugOf] of ATS_PATTERNS) {
      const m = s.match(re); if (!m) continue; const slug = slugOf(m); if (!slug || NOT_SLUG.has(slug.toLowerCase())) continue;
      const key = prov + ":" + slug; if (!atsSeen.has(key)) { atsSeen.add(key); res.ats.push({ provider: prov, slug }); }
    }
  }
  res.githubOrgs = [...gh.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([org, n]) => ({ org, n }));
  const rss = new Set<string>();
  for (const h of htmls) for (const m of h.html.matchAll(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/gi)) { const href = m[0].match(/href=["']([^"']+)["']/i)?.[1]; if (href) { try { rss.add(new URL(href, h.url).href); } catch { /* skip */ } } }
  res.rss = [...rss].slice(0, 4);
  return res;
}

// What the public internet already shows without anyone publishing a stack: response headers, script hosts, DNS, certificate names.
async function doh(name: string, type: string) {
  const r = await getJSON(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { Accept: "application/dns-json" }, 6000);
  return ((r.data?.Answer || []) as any[]).map((a) => String(a.data || "")).filter(Boolean);
}
async function collectFingerprint(dom: string, home: any) {
  const out: { tech: string; quote: string; url: string }[] = [];
  const seen = new Set<string>();
  const add = (tech: string, quote: string, url: string) => { if (!VOCAB[tech] || seen.has(tech)) return; seen.add(tech); out.push({ tech, quote, url }); };
  const u = `https://${dom}`;
  if (home?.ok) {
    const h = home.headers as Record<string, string>, srv = (h["server"] || "").toLowerCase();
    if (h["cf-ray"] || srv.includes("cloudflare")) add("cloudflare", `response header from ${dom}: ${h["server"] ? "server: " + h["server"] : "cf-ray present"}`, u);
    if (h["x-vercel-id"] || srv.includes("vercel")) add("vercel", `response header from ${dom}: ${h["x-vercel-id"] ? "x-vercel-id present" : "server: " + h["server"]}`, u);
    if (h["x-nf-request-id"] || srv.includes("netlify")) add("netlify", `response header from ${dom}: ${h["x-nf-request-id"] ? "x-nf-request-id present" : "server: " + h["server"]}`, u);
    if (h["x-amz-cf-id"] || (h["via"] || "").toLowerCase().includes("cloudfront")) add("aws", `response header from ${dom}: ${h["x-amz-cf-id"] ? "x-amz-cf-id (CloudFront) present" : "via: " + h["via"]}`, u);
    if (h["fastly-debug-digest"] || /cache-[a-z]+/i.test(h["x-served-by"] || "")) add("fastly", `response header from ${dom}: x-served-by ${h["x-served-by"] || "fastly-debug-digest"}`, u);
    if (srv.includes("google frontend") || (h["via"] || "").includes("google")) add("gcp", `response header from ${dom}: ${h["server"] ? "server: " + h["server"] : "via: " + h["via"]}`, u);
    if (/azure|microsoft-iis/.test(srv) || h["x-azure-ref"] || h["x-ms-request-id"]) add("azure", `response header from ${dom}: ${h["x-azure-ref"] ? "x-azure-ref present" : "server: " + h["server"]}`, u);
    const html: string = home.html || "";
    const scripts = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)=["']([^"']+)["']/gi)].map((m) => m[1]).join(" ").toLowerCase();
    if (/cdn\.segment\.(com|io)|segment\.io/.test(scripts)) add("segment", `page loads a script from ${scripts.match(/[a-z.]*segment\.(?:com|io)/)?.[0]}`, u);
    if (/datadoghq|datadog-rum/.test(scripts)) add("datadog", `page loads a script from ${scripts.match(/[a-z.-]*datadog[a-z.-]*/)?.[0]}`, u);
    if (/sentry-cdn|browser\.sentry|sentry\.io/.test(scripts)) add("sentry", `page loads a script from ${scripts.match(/[a-z.-]*sentry[a-z.-]*/)?.[0]}`, u);
    if (/newrelic\.com|nr-data\.net/.test(scripts)) add("newrelic", `page loads a script from ${scripts.match(/[a-z.-]*(?:newrelic\.com|nr-data\.net)/)?.[0]}`, u);
  }
  const [cn, apexCn, txt, crt] = await Promise.all([doh("www." + dom, "CNAME"), doh(dom, "CNAME"), doh(dom, "TXT"), getJSON(`https://crt.sh/?q=%25.${dom}&output=json`, {}, 9000)]);
  for (const d of [...cn, ...apexCn]) {
    const l = d.toLowerCase();
    if (l.includes("cloudfront.net")) add("aws", `DNS: www.${dom} CNAME ${d}`, u);
    else if (l.includes("vercel-dns") || l.includes("vercel.app")) add("vercel", `DNS: www.${dom} CNAME ${d}`, u);
    else if (l.includes("netlify")) add("netlify", `DNS: www.${dom} CNAME ${d}`, u);
    else if (l.includes("herokudns") || l.includes("herokuapp")) add("heroku", `DNS: www.${dom} CNAME ${d}`, u);
    else if (l.includes("fastly")) add("fastly", `DNS: www.${dom} CNAME ${d}`, u);
    else if (/azurewebsites|azureedge|trafficmanager|cloudapp\.azure/.test(l)) add("azure", `DNS: www.${dom} CNAME ${d}`, u);
    else if (/googlehosted|ghs\.google|appspot\.com/.test(l)) add("gcp", `DNS: www.${dom} CNAME ${d}`, u);
    else if (l.includes("amazonaws.com") || l.includes("elb.")) add("aws", `DNS: www.${dom} CNAME ${d}`, u);
  }
  for (const t of txt) if (/amazonses/i.test(t)) add("aws", `DNS TXT record on ${dom} references amazonses`, u);
  const names = new Set<string>();
  for (const row of (Array.isArray(crt.data) ? crt.data : []).slice(0, 4000)) for (const n of String(row.name_value || "").split("\n")) names.add(n.toLowerCase().replace(/^\*\./, ""));
  const SUB: [RegExp, string][] = [[/(^|[.-])jenkins([.-]|$)/, "jenkins"], [/(^|[.-])gitlab([.-]|$)/, "gitlab"], [/(^|[.-])grafana([.-]|$)/, "grafana"], [/(^|[.-])argocd?([.-]|$)/, "argocd"], [/(^|[.-])sentry([.-]|$)/, "sentry"], [/(^|[.-])prometheus([.-]|$)/, "prometheus"], [/(^|[.-])nomad([.-]|$)/, "nomad"], [/(^|[.-])buildkite([.-]|$)/, "buildkite"], [/(^|[.-])(k8s|kube|kubernetes)([.-]|$)/, "kubernetes"]];
  for (const n of names) for (const [re, tech] of SUB) if (n !== dom && n.endsWith("." + dom) && re.test(n.slice(0, -dom.length - 1))) add(tech, `certificate transparency log lists subdomain ${n}`, `https://crt.sh/?q=${dom}`);
  return { items: out, dnsOk: cn.length + apexCn.length + txt.length > 0, crtOk: names.size > 0 };
}

// News: headlines are timing signals (funding, hires, launches, migrations), not proof of a stack.
async function collectNews(name: string, dom: string) {
  const q = encodeURIComponent(`"${name}" when:120d`);
  const xml = await getText(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`, 9000);
  if (!xml) return { ok: false, items: [] as { title: string; link: string; date: string; source: string }[] };
  const stem = normDomain(dom).split(".")[0], first = name.toLowerCase().split(/\s+/)[0];
  const items = xml.split(/<item[\s>]/i).slice(1, 15).map((it) => {
    const title = stripHtml((it.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/<!\[CDATA\[|\]\]>/g, ""));
    const link = (it.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || "").trim();
    const date = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || "").trim();
    const source = stripHtml(it.match(/<source[^>]*>([\s\S]*?)<\/source>/i)?.[1] || "");
    return { title, link, date, source };
  }).filter((x) => x.title && x.link && (x.title.toLowerCase().includes(first) || x.title.toLowerCase().includes(stem)));
  return { ok: true, items: items.slice(0, 8) };
}

// ---------- resolver ----------
// Discovery order: what the company's own website links to first (high precision), then name-based guesses (lower confidence).
async function resolve(acc: any, web: any) {
  const stem = normDomain(acc.domain).split(".")[0];
  const nameSlug = acc.name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const out: any = {};
  const dom = normDomain(acc.domain);
  const checkOrg = async (cand: string) => {
    const r = await gh(`/orgs/${cand}`);
    if (!r.ok) return null;
    const blog = String(r.data.blog || "").toLowerCase();
    return { org: r.data.login, conf: blog.includes(dom) || r.data.is_verified ? 0.95 : 0.55 };
  };
  if (acc.github_org && !(acc.mapping_confidence > 0)) {
    const c = await checkOrg(acc.github_org);
    if (c) { out.github_org = c.org; out.mapping_confidence = c.conf; } else { out.github_org = null; acc.github_org = null; }
  }
  if (!acc.github_org) {
    for (const o of web?.githubOrgs || []) {
      const r = await gh(`/orgs/${o.org}`); if (!r.ok) continue;
      const blog = String(r.data.blog || "").toLowerCase(), login = String(r.data.login).toLowerCase();
      const conf = blog.includes(dom) || r.data.is_verified ? 0.95 : (login.includes(stem) || login.includes(nameSlug)) ? 0.9 : o.n >= 2 ? 0.75 : 0;
      if (conf) { out.github_org = r.data.login; out.mapping_confidence = conf; break; }
    }
    if (!out.github_org) for (const cand of [...new Set([stem, nameSlug, "get" + stem, stem + "hq", nameSlug + "hq", stem + "io", stem + "labs", stem + "dev"])]) {
      const c = await checkOrg(cand);
      if (c) { out.github_org = c.org; out.mapping_confidence = c.conf; break; }
    }
  }
  if (!acc.ats_provider) {
    for (const c of (web?.ats || []).slice(0, 4)) {
      const j = await collectJobs(c.provider, c.slug);
      if (j.all > 0) { out.ats_provider = c.provider; out.ats_slug = c.slug; break; }
    }
    if (!out.ats_provider) {
      const slugs = [...new Set([stem, nameSlug, acc.name.toLowerCase().replace(/\s+/g, "-"), stem + "labs", stem + "hq"])];
      const probes = await Promise.all(slugs.map(async (slug) => {
        const [g, a, l, w, rc, sr] = await Promise.all([
          getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, {}, 9000),
          getJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, {}, 9000),
          getJSON(`https://api.lever.co/v0/postings/${slug}?mode=json&limit=5`, {}, 9000),
          getJSON(`https://apply.workable.com/api/v1/widget/accounts/${slug}`, {}, 9000),
          getJSON(`https://${slug}.recruitee.com/api/offers/`, {}, 9000),
          getJSON(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1`, {}, 9000),
        ]);
        if (g.ok && g.data?.jobs?.length) return { ats_provider: "greenhouse", ats_slug: slug };
        if (a.ok && a.data?.jobs?.length) return { ats_provider: "ashby", ats_slug: slug };
        if (l.ok && Array.isArray(l.data) && l.data.length) return { ats_provider: "lever", ats_slug: slug };
        if (w.ok && w.data?.jobs?.length) return { ats_provider: "workable", ats_slug: slug };
        if (rc.ok && rc.data?.offers?.length) return { ats_provider: "recruitee", ats_slug: slug };
        if (sr.ok && Number(sr.data?.totalFound) > 0) return { ats_provider: "smartrecruiters", ats_slug: slug };
        return null;
      }));
      const hit = probes.find(Boolean); if (hit) Object.assign(out, hit);
    }
  }
  if (!acc.blog_feed) {
    const cands = [...(web?.rss || []), `https://${dom}/blog/rss.xml`, `https://${dom}/rss.xml`, `https://${dom}/feed.xml`, `https://${dom}/blog/feed.xml`, `https://${dom}/atom.xml`, `https://${dom}/atom`, `https://${dom}/blog/rss`, `https://${dom}/feed`, `https://${dom}/blog/index.xml`, `https://${dom}/index.xml`, `https://${dom}/blog/feed`];
    const texts = await Promise.all(cands.map((u) => getText(u, 7000)));
    const i = texts.findIndex((t) => t && /<(rss|feed)[\s>]/i.test(t.slice(0, 3000)));
    if (i >= 0) out.blog_feed = cands[i];
  }
  if (!acc.careers_url && web?.careersUrl) out.careers_url = web.careersUrl;
  return out;
}

// ---------- collectors ----------
async function collectGitHub(org: string) {
  const res: any = { languages: {}, files: {} as Record<string, string[]>, active30: 0, publicRepos: 0, ci: null, ciRuns: 0, ciRepo: null, ok: false };
  const r = await gh(`/orgs/${org}/repos?per_page=100&sort=pushed&type=public`);
  if (!r.ok || !Array.isArray(r.data)) return res;
  res.ok = true;
  const repos = r.data.filter((x: any) => !x.fork && !x.archived);
  res.publicRepos = repos.length;
  const now = Date.now();
  res.active30 = repos.filter((x: any) => now - Date.parse(x.pushed_at) < 30 * 864e5).length;
  // language weight: repo size (KB) for repos pushed in last 365 days, demoting docs/examples/sdk repos
  const bytes: Record<string, number> = {};
  for (const x of repos) {
    if (!x.language || now - Date.parse(x.pushed_at) > 365 * 864e5) continue;
    const demote = /(docs?|example|demo|sample|sdk|template|website|blog)/i.test(x.name) ? 0.3 : 1;
    bytes[x.language] = (bytes[x.language] || 0) + Math.log10(10 + x.size) * (1 + Math.log10(1 + x.stargazers_count)) * demote;
  }
  const tot = Object.values(bytes).reduce((s, v) => s + v, 0) || 1;
  Object.entries(bytes).sort((a, b) => b[1] - a[1]).slice(0, 6).forEach(([k, v]) => (res.languages[k] = Math.round((v / tot) * 100)));
  // root files of the 5 most recently pushed, sizeable repos
  const top = repos.filter((x: any) => x.size > 200).slice(0, 5);
  await Promise.all(top.map(async (x: any) => {
    const c = await gh(`/repos/${org}/${x.name}/contents/`);
    const names: string[] = c.ok && Array.isArray(c.data) ? c.data.map((f: any) => f.name) : [];
    const w = names.includes(".github") ? await gh(`/repos/${org}/${x.name}/contents/.github/workflows`) : { ok: false, data: null };
    res.files[x.name] = [...names, ...(w.ok && Array.isArray(w.data) ? w.data.map((f: any) => ".github/workflows/" + f.name) : [])];
  }));
  // measured CI: median duration of recent successful runs in the busiest repo with workflows
  const ciRepo = top.find((x: any) => (res.files[x.name] || []).some((f: string) => f.startsWith(".github/workflows/")));
  if (ciRepo) {
    const runs = await gh(`/repos/${org}/${ciRepo.name}/actions/runs?per_page=40&status=success&branch=${ciRepo.default_branch}`);
    const d = (runs.data?.workflow_runs || []).map((w: any) => (Date.parse(w.updated_at) - Date.parse(w.run_started_at || w.created_at)) / 60000).filter((m: number) => m > 0.2 && m < 300);
    if (d.length >= 5) { res.ci = Math.round(median(d)! * 10) / 10; res.ciRuns = d.length; res.ciRepo = `${org}/${ciRepo.name}`; }
  }
  return res;
}

const ENG_RE = /(engineer|developer|sre|devops|platform|infrastructure|architect|data scientist|machine learning|ml |security|reliability|devex|developer experience|technical lead|tech lead)/i;
const PLAT_RE = /(platform|infrastructure|devops|sre|site reliability|developer experience|devex|developer productivity|build|release|tooling|reliability)/i;
type Job = { title: string; url: string; text: string; detail?: () => Promise<string> };
function classify(jobs: Job[]) {
  const eng = jobs.filter((j) => ENG_RE.test(j.title));
  return { all: jobs.length, eng, platform: eng.filter((j) => PLAT_RE.test(j.title)) };
}
async function collectJobs(provider: string, slug: string) {
  const jobs: Job[] = [];
  if (!provider || provider === "none" || !slug) return classify(jobs);
  if (provider === "greenhouse") {
    const r = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`, {}, 20000);
    for (const j of r.data?.jobs || []) jobs.push({ title: j.title, url: j.absolute_url, text: stripHtml(j.content || "") });
  } else if (provider === "ashby") {
    const r = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=false`, {}, 20000);
    for (const j of r.data?.jobs || []) jobs.push({ title: j.title, url: j.jobUrl, text: (j.descriptionPlain || stripHtml(j.descriptionHtml || "")).replace(/\s+/g, " ") });
  } else if (provider === "lever") {
    const r = await getJSON(`https://api.lever.co/v0/postings/${slug}?mode=json`, {}, 20000);
    for (const j of Array.isArray(r.data) ? r.data : []) jobs.push({ title: j.text, url: j.hostedUrl, text: (j.descriptionPlain || "") + " " + (j.lists || []).map((l: any) => stripHtml(l.content || "")).join(" ") + " " + (j.additionalPlain || "") });
  } else if (provider === "workable") {
    const r = await getJSON(`https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true`, {}, 20000);
    for (const j of r.data?.jobs || []) jobs.push({ title: j.title, url: j.url || j.shortlink || `https://apply.workable.com/${slug}`, text: stripHtml(j.description || "") });
  } else if (provider === "recruitee") {
    const r = await getJSON(`https://${slug}.recruitee.com/api/offers/`, {}, 20000);
    for (const j of r.data?.offers || []) jobs.push({ title: j.title, url: j.careers_url || `https://${slug}.recruitee.com`, text: stripHtml((j.description || "") + " " + (j.requirements || "")) });
  } else if (provider === "personio") {
    const xml = await getText(`https://${slug}.jobs.personio.de/xml`, 20000) || await getText(`https://${slug}.jobs.personio.com/xml`, 20000);
    for (const p of (xml || "").split(/<position>/i).slice(1)) {
      const title = stripHtml((p.match(/<name>([\s\S]*?)<\/name>/i)?.[1] || "").replace(/<!\[CDATA\[|\]\]>/g, ""));
      const id = p.match(/<id>(\d+)<\/id>/i)?.[1] || "";
      const text = [...p.matchAll(/<value>([\s\S]*?)<\/value>/gi)].map((m) => stripHtml(m[1].replace(/<!\[CDATA\[|\]\]>/g, ""))).join(" ");
      if (title) jobs.push({ title, url: `https://${slug}.jobs.personio.de/job/${id}`, text });
    }
  } else if (provider === "smartrecruiters") {
    const r = await getJSON(`https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100`, {}, 20000);
    for (const j of r.data?.content || []) jobs.push({
      title: j.name, url: `https://jobs.smartrecruiters.com/${slug}/${j.id}`, text: "",
      detail: async () => { const d = await getJSON(`https://api.smartrecruiters.com/v1/companies/${slug}/postings/${j.id}`, {}, 12000); const s = d.data?.jobAd?.sections || {}; return stripHtml(["jobDescription", "qualifications", "additionalInformation"].map((k) => s[k]?.text || "").join(" ")); },
    });
  } else if (provider === "bamboohr") {
    const r = await getJSON(`https://${slug}.bamboohr.com/careers/list`, {}, 20000);
    for (const j of r.data?.result || []) jobs.push({
      title: j.jobOpeningName, url: `https://${slug}.bamboohr.com/careers/${j.id}`, text: "",
      detail: async () => { const d = await getJSON(`https://${slug}.bamboohr.com/careers/${j.id}/detail`, {}, 12000); return stripHtml(d.data?.result?.jobOpening?.description || ""); },
    });
  } else if (provider === "workday") {
    const [host, tenant, site] = slug.split("|");
    if (host && tenant && site) {
      const base = `https://${host}/wday/cxs/${tenant}/${site}`;
      for (let off = 0; off < 60; off += 20) {
        const r = await postJSON(`${base}/jobs`, { appliedFacets: {}, limit: 20, offset: off, searchText: "engineer" }, 15000);
        const ps = r.data?.jobPostings || []; if (!ps.length) break;
        for (const j of ps) jobs.push({
          title: j.title, url: `https://${host}/${site}${j.externalPath || ""}`, text: "",
          detail: async () => { const d = await getJSON(`${base}${j.externalPath}`, {}, 12000); return stripHtml(d.data?.jobPostingInfo?.jobDescription || ""); },
        });
        if (ps.length < 20) break;
      }
    }
  }
  const res = classify(jobs);
  // providers that list titles only: fetch the description for the first six engineering roles
  const need = [...res.platform, ...res.eng.filter((j) => !res.platform.includes(j))].filter((j) => j.detail && !j.text).slice(0, 6);
  await Promise.all(need.map(async (j) => { try { j.text = await j.detail!(); } catch { /* skip */ } }));
  return res;
}
const atsUrl = (p: string, s: string, careers: string | null) => p === "greenhouse" ? `https://boards.greenhouse.io/${s}` : p === "ashby" ? `https://jobs.ashbyhq.com/${s}` : p === "lever" ? `https://jobs.lever.co/${s}` : p === "workable" ? `https://apply.workable.com/${s}` : p === "smartrecruiters" ? `https://jobs.smartrecruiters.com/${s}` : p === "recruitee" ? `https://${s}.recruitee.com` : p === "personio" ? `https://${s}.jobs.personio.de` : p === "bamboohr" ? `https://${s}.bamboohr.com/careers` : p === "workday" ? `https://${s.split("|")[0]}` : (careers || "https://" + s);

async function collectBlog(feed: string | null) {
  if (!feed) return [];
  const xml = await getText(feed, 9000); if (!xml) return [];
  const items = xml.split(/<item[\s>]|<entry[\s>]/i).slice(1, 9);
  return items.map((it) => {
    const title = stripHtml((it.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/<!\[CDATA\[|\]\]>/g, ""));
    const link = (it.match(/<link[^>]*href="([^"]+)"/i)?.[1] || it.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || "").trim();
    const date = (it.match(/<(pubDate|published|updated)>([\s\S]*?)<\/(pubDate|published|updated)>/i)?.[2] || "").trim();
    return { title, link, date };
  }).filter((x) => x.title);
}

// custom sources: fetch a templated URL, parse as rss or html, return text snippets the dictionary can scan
async function collectCustom(acc: any) {
  const out: { slug: string; url: string; text: string }[] = [];
  await Promise.all(CUSTOM_SOURCES.map(async (src) => {
    const url = String(src.url_template || "").replace(/\{domain\}/g, acc.domain).replace(/\{name\}/g, encodeURIComponent(acc.name)).replace(/\{github_org\}/g, acc.github_org || "").replace(/\{ats_slug\}/g, acc.ats_slug || "");
    if (!/^https:\/\//.test(url) || /\{[a-z_]+\}/.test(url)) return;
    const body = await getText(url, 9000); if (!body) return;
    if (src.parser === "rss") {
      for (const it of body.split(/<item[\s>]|<entry[\s>]/i).slice(1, 8)) {
        const title = stripHtml((it.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/<!\[CDATA\[|\]\]>/g, ""));
        const link = (it.match(/<link[^>]*href="([^"]+)"/i)?.[1] || it.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || url).trim();
        if (title) out.push({ slug: src.slug, url: link, text: title });
      }
    } else out.push({ slug: src.slug, url, text: stripHtml(body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")).slice(0, 8000) });
  }));
  return out;
}

// ---------- Gemini ----------
// Works with AI Studio keys (generativelanguage) and Vertex AI express-mode keys (aiplatform). Errors never echo the key.
async function gemini(system: string, user: string, schema: any, temperature = 0) {
  const key = (GEMINI_KEY || "").replace(/\s+/g, "");
  if (!key) throw new Error("GEMINI_API_KEY secret is not set");
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { temperature, responseMimeType: "application/json", responseSchema: schema },
  });
  const endpoints = (m: string) => [
    { name: "ai-studio", url: `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, headers: { "x-goog-api-key": key } },
    { name: "vertex-express", url: `https://aiplatform.googleapis.com/v1/publishers/google/models/${m}:generateContent?key=${encodeURIComponent(key)}`, headers: {} },
  ];
  const errs: string[] = [];
  for (const model of MODELS) {
    for (const ep of endpoints(model)) {
      gemCalls++;
      let r: Response;
      try { r = await fetch(ep.url, { method: "POST", headers: { "Content-Type": "application/json", ...ep.headers }, body }); }
      catch (e) { errs.push(`${ep.name}/${model}: network`); continue; }
      if (r.status === 429) { await sleep(4000); errs.push(`${ep.name}/${model}: 429`); continue; }
      if (!r.ok) { const t = (await r.text()).split(key).join("[key]"); errs.push(`${ep.name}/${model}: ${r.status} ${t.replace(/\s+/g, " ").slice(0, 90)}`); continue; }
      const j = await r.json();
      const txt = j.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "";
      return { model: `${model} (${ep.name})`, out: JSON.parse(txt) };
    }
  }
  throw new Error("Gemini failed: " + errs.slice(-3).join(" | "));
}

const P1_SYSTEM = `You extract technology evidence from job postings. You are a parser, not a writer.
Rules:
- Only report technologies literally named in the text.
- "quote" must be copied verbatim from the text, 4-25 words, containing the technology name.
- strength: "required" (must-have), "preferred" (nice to have), "alternative" (listed as one of several options such as "AWS, GCP or Azure"), "narrative" (describes what the team uses or is moving to).
- migration: true only if the text says the team is moving to/from it.
- Prefer infrastructure, cloud, CI/CD, build system, orchestration, data and observability tools. Skip soft skills.
- At most 25 items. If nothing qualifies return {"items": []}.`;
const P1_SCHEMA = { type: "OBJECT", properties: { items: { type: "ARRAY", items: { type: "OBJECT", properties: { tech: { type: "STRING" }, strength: { type: "STRING", enum: ["required", "preferred", "alternative", "narrative"] }, migration: { type: "BOOLEAN" }, quote: { type: "STRING" }, job: { type: "INTEGER" } }, required: ["tech", "strength", "quote", "job"] } } }, required: ["items"] };

const P2_DEFAULT = (persona: string) => `You write pre-call research for an enterprise account executive who sells ${PRODUCT}.
You may ONLY use facts in FACT_SHEET. Every sentence must cite the fact IDs it relies on (e.g. "F3").
Never name a technology, number, team, repository or project that is not in FACT_SHEET.
Facts with confidence below 0.6, or state "hiring_only"/"emerging", must be hedged ("job posts suggest", "appears to").
Never mention individual employees. Never invent customers, metrics or outcomes.
TASK
1. summary: exactly 2 paragraphs, each 2-3 sentences.
   Paragraph 1 = how they build: dominant languages, cloud/infrastructure, build and CI setup.
   Paragraph 2 = how actively they are building and what is changing: hiring, platform roles, CI time, recent posts.
2. opener: ONE sentence, max 30 words, written to a ${persona}. It must contain a specific noun or number from the chosen hypothesis evidence and connect it to that hypothesis's friction. No greeting, no product name, no question mark.
3. hook_type: the chosen hypothesis's hook type.
4. discovery: 3 short questions the AE should still ask on the call, about things the fact sheet does NOT answer.
BANNED words/phrases: "I noticed", "hope this finds you", "leverage", "synergy", "cutting-edge", "in today's", "streamline", "game-changer", "revolutionize", "seamless".`;
const P2_SYSTEM = (persona: string) => PROMPT_TEMPLATE
  ? PROMPT_TEMPLATE.split("{{product}}").join(PRODUCT).split("{{persona}}").join(persona).split("{{banned}}").join((BANNED_LIST.length ? BANNED_LIST : BANNED).map((b) => `"${b}"`).join(", "))
  : P2_DEFAULT(persona);
const P2_SCHEMA = () => ({
  type: "OBJECT",
  properties: {
    summary: { type: "ARRAY", items: { type: "ARRAY", items: { type: "OBJECT", properties: { text: { type: "STRING" }, cites: { type: "ARRAY", items: { type: "STRING" } } }, required: ["text", "cites"] } } },
    opener: { type: "OBJECT", properties: { text: { type: "STRING" }, cites: { type: "ARRAY", items: { type: "STRING" } }, hypothesis: { type: "STRING" }, hook_type: { type: "STRING", enum: HOOK_TYPES } }, required: ["text", "cites", "hook_type"] },
    discovery: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["summary", "opener", "discovery"],
});
const BANNED = ["i noticed", "hope this finds you", "leverage", "synergy", "cutting-edge", "in today's", "streamline", "game-changer", "revolutionize", "seamless"];

// ---------- verifier ----------
function verify(out: any, facts: any[], company = "") {
  const errors: string[] = [];
  const ids = new Set(facts.map((f) => f.fid));
  const known = new Set<string>(); facts.forEach((f) => { known.add(f.tech); });
  const factText = (id: string) => { const f = facts.find((x) => x.fid === id); return f ? `${f.tech} ${f.quote ?? ""} ${f.value ?? ""}` : ""; };
  const sentences = [...(out.summary || []).flat(), out.opener].filter(Boolean);
  if (!Array.isArray(out.summary) || out.summary.length !== 2) errors.push("summary must have exactly 2 paragraphs");
  for (const s of sentences) {
    const text: string = s.text || "";
    for (const [alias, key] of ALIAS) {
      if (alias.length < 3 && alias !== "go") continue;
      if (alias === "go" || alias === "react" || alias === "rust" || alias === "java" || alias === "build") continue; // too ambiguous in prose
      if (company.toLowerCase().includes(alias)) continue;
      if (termRe(alias).test(text) && !known.has(key)) { errors.push(`"${alias}" is not in FACT_SHEET`); }
    }
    for (const id of s.cites || []) if (!ids.has(id)) errors.push(`unknown cite ${id}`);
    if (!(s.cites || []).length) errors.push(`sentence has no cites: "${text.slice(0, 50)}"`);
    for (const n of text.match(/\d+(\.\d+)?/g) || []) if (!(s.cites || []).some((id: string) => factText(id).includes(n))) errors.push(`number ${n} is not supported by its cited facts`);
    const low = text.toLowerCase(); for (const b of (BANNED_LIST.length ? BANNED_LIST : BANNED)) if (low.includes(b)) errors.push(`banned phrase "${b}"`);
  }
  const words = (out.opener?.text || "").split(/\s+/).filter(Boolean).length;
  if (words > 30) errors.push(`opener is ${words} words (max 30)`);
  if ((out.opener?.text || "").includes("?")) errors.push("opener must not be a question");
  return [...new Set(errors)];
}

// feedback-tuned openers: what this team actually used, edited and rejected feeds the next prompt (few-shot)
async function feedbackShots() {
  try {
    const { data } = await SB.from("feedback").select("action, edited_opener, briefs(opener, hook_type)").order("created_at", { ascending: false }).limit(30);
    const rows = (data || []).map((r: any) => ({ a: r.action, hook: r.briefs?.hook_type, text: r.action.startsWith("edited") && r.edited_opener ? r.edited_opener : r.briefs?.opener })).filter((r: any) => r.text);
    const used = rows.filter((r) => r.a === "used_as_is" || r.a === "edited_tone").slice(0, 3);
    const bad = rows.filter((r) => r.a === "rejected" || r.a === "edited_fact").slice(0, 2);
    if (!used.length && !bad.length) return "";
    let t = "\n\nTEAM FEEDBACK (style signal only; do not copy wording or reuse any facts from these):";
    if (used.length) t += "\nOpeners the AEs sent or kept:\n" + used.map((r) => `- (${r.hook}) ${r.text}`).join("\n");
    if (bad.length) t += "\nOpeners the AEs rejected or had to correct for facts; avoid this style:\n" + bad.map((r) => `- (${r.hook}) ${r.text}`).join("\n");
    return t;
  } catch { return ""; }
}

// ---------- main ----------
async function refresh(accountId: string, trigger: string) {
  const t0 = Date.now(); ghCalls = 0; gemCalls = 0; CUSTOM_SOURCES = []; PLAYBOOKS = [];
  await loadKeys();
  await loadConfig();
  const { data: acc } = await SB.from("watchlist").select("*").eq("id", accountId).single();
  if (!acc) throw new Error("account not found");
  if (trigger === "manual" && acc.last_refreshed_at && Date.now() - Date.parse(acc.last_refreshed_at) < 5 * 60000 && acc.refresh_status === "ok") return { skipped: "refreshed less than 5 minutes ago" };
  await SB.from("watchlist").update({ refresh_status: "running", refresh_error: null }).eq("id", accountId);
  const { data: runRow } = await SB.from("pipeline_runs").insert({ account_id: accountId, trigger, status: "running" }).select().single();

  try {
    // 0 validate + crawl the website (also the source of discovery by link)
    const dom0 = normDomain(acc.domain);
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(dom0)) throw new Error(`"${acc.domain}" is not a valid domain. Use the company's website domain, for example example.com`);
    const web: any = SOURCES.website !== false ? await collectWebsite(dom0, acc.careers_url) : { ok: false, off: true, pages: [], githubOrgs: [], ats: [], rss: [], jsonld: [], careersUrl: null, fetched: 0 };
    // 1 resolve
    const resolved = await resolve(acc, web);
    if (Object.keys(resolved).length) { await SB.from("watchlist").update(resolved).eq("id", accountId); Object.assign(acc, resolved); }

    // 2 collect
    const [ghd, jobsA, posts, customRes, fp, news] = await Promise.all([
      acc.github_org && SOURCES.github !== false ? collectGitHub(acc.github_org) : Promise.resolve(null),
      acc.ats_provider && acc.ats_provider !== "none" && SOURCES.job_board !== false ? collectJobs(acc.ats_provider, acc.ats_slug) : Promise.resolve(null),
      SOURCES.blog !== false ? collectBlog(acc.blog_feed) : Promise.resolve([]),
      collectCustom(acc),
      SOURCES.fingerprint !== false ? collectFingerprint(dom0, web.home) : Promise.resolve(null),
      SOURCES.news !== false ? collectNews(acc.name, dom0) : Promise.resolve(null),
    ]);
    let jobs: { all: number; eng: Job[]; platform: Job[] } | null = jobsA, jobsVia: string = acc.ats_provider || "";
    if ((!jobs || !jobs.all) && SOURCES.job_board !== false && web.jsonld?.length) { jobs = classify(web.jsonld); jobsVia = "careers page"; }
    const webPages = (web.pages || []).filter((p: any) => ["careers", "engineering", "security"].includes(p.kind));

    // 3 extract -> raw evidence
    type Ev = { tech: string; category: string; source: string; strength: string; url: string; quote: string; migration?: boolean };
    const ev: Ev[] = [];
    if (ghd?.ok) {
      for (const [lang, pct] of Object.entries(ghd.languages)) ev.push({ tech: (canon(lang) ?? lang.toLowerCase()), category: "language", source: "github", strength: "narrative", url: `https://github.com/${acc.github_org}`, quote: `${pct}% weighted share across ${ghd.publicRepos} public non-fork repos` });
      const fileHits: [RegExp, string][] = [[/^(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/i, "docker"], [/^(charts|helm|k8s|kubernetes|deploy|manifests)$/i, "kubernetes"], [/^(terraform|.*\.tf|infra)$/i, "terraform"], [/^(BUILD|BUILD\.bazel|WORKSPACE|MODULE\.bazel|\.bazelrc)$/, "bazel"], [/^nx\.json$/, "nx"], [/^turbo\.json$/, "turborepo"], [/^(pnpm-workspace\.yaml|lerna\.json)$/, "monorepo"], [/^Jenkinsfile$/, "jenkins"], [/^\.circleci$/, "circleci"], [/^\.buildkite$/, "buildkite"], [/^\.github\/workflows\//, "github actions"], [/^(buf\.yaml|proto|protos)$/, "grpc"], [/^vercel\.json$/, "vercel"], [/^(wrangler\.toml|wrangler\.json)$/, "cloudflare"], [/^pulumi\.ya?ml$/i, "pulumi"]];
      const seen: Record<string, string[]> = {};
      for (const [repo, files] of Object.entries(ghd.files as Record<string, string[]>)) for (const f of files) for (const [re, tech] of fileHits) if (re.test(f)) (seen[tech] ||= []).includes(repo) || seen[tech].push(repo);
      for (const [tech, repos] of Object.entries(seen)) ev.push({ tech, category: VOCAB[tech]?.cat ?? "infra", source: "github", strength: "narrative", url: `https://github.com/${acc.github_org}/${repos[0]}`, quote: `${tech === "github actions" ? "workflow files" : "config"} found in ${repos.length} repo${repos.length > 1 ? "s" : ""}: ${repos.slice(0, 3).join(", ")}` });
      if (ghd.ci != null) ev.push({ tech: "github actions", category: "ci", source: "github", strength: "narrative", url: `https://github.com/${ghd.ciRepo}/actions`, quote: `median successful run ${ghd.ci} min over the last ${ghd.ciRuns} runs on ${ghd.ciRepo}` });
    }
    let p1Model = null;
    if (jobs?.eng.length) {
      // dictionary pass over every engineering posting
      jobs.eng.forEach((j) => {
        const low = j.text.toLowerCase();
        for (const [alias, key] of ALIAS) {
          if (VOCAB[key].cat === "language") continue;
          const m = low.match(termRe(alias)); if (!m || m.index == null) continue;
          const q = sentenceAround(j.text, m.index + m[1].length);
          ev.push({ tech: key, category: VOCAB[key].cat, source: "job_post", strength: ALT_RE.test(q) && /,|\bor\b/.test(q) ? "alternative" : "required", url: j.url, quote: q });
        }
      });
      // Gemini P1 over the most infra-heavy postings (platform first), quotes verified against source text
      const pick = [...jobs.platform, ...jobs.eng.filter((j) => !jobs.platform.includes(j))].slice(0, 6);
      try {
        const body = pick.map((j, i) => `### JOB ${i}: ${j.title}\n${j.text.slice(0, 2600)}`).join("\n\n");
        const { model, out } = await gemini(P1_SYSTEM, body, P1_SCHEMA);
        p1Model = model;
        for (const it of out.items || []) {
          const src = pick[it.job]; if (!src) continue;
          const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
          if (!norm(src.text).includes(norm(it.quote))) continue; // quote must be verbatim
          const key = canon(it.tech); if (!key || VOCAB[key].cat === "language") continue;
          ev.push({ tech: key, category: VOCAB[key].cat, source: "job_post", strength: it.strength, url: src.url, quote: it.quote, migration: !!it.migration });
        }
      } catch (_e) { /* extraction is best-effort; dictionary evidence stands */ }
    }
    for (const p of posts) for (const [alias, key] of ALIAS) if (alias.length > 3 && termRe(alias).test(p.title)) ev.push({ tech: key, category: VOCAB[key].cat, source: "blog", strength: "narrative", url: p.link, quote: p.title });
    for (const c of customRes) for (const [alias, key] of ALIAS) {
      if (alias.length <= 3 || VOCAB[key].cat === "language") continue;
      const m = c.text.toLowerCase().match(termRe(alias)); if (!m || m.index == null) continue;
      ev.push({ tech: key, category: VOCAB[key].cat, source: c.slug, strength: "narrative", url: c.url, quote: sentenceAround(c.text, m.index + m[1].length) });
    }

    // website pages (careers, engineering, security only: marketing pages overclaim) and the no-ATS Gemini pass
    for (const p of webPages) for (const [alias, key] of ALIAS) {
      if (alias.length <= 3 || VOCAB[key].cat === "language") continue;
      const m = p.text.toLowerCase().match(termRe(alias)); if (!m || m.index == null) continue;
      const q = sentenceAround(p.text, m.index + m[1].length);
      ev.push({ tech: key, category: VOCAB[key].cat, source: "website", strength: ALT_RE.test(q) && /,|\bor\b/.test(q) ? "alternative" : "narrative", url: p.url, quote: q });
    }
    if (!jobs?.eng.length && webPages.length) {
      const pick = webPages.slice(0, 4).map((p: any) => ({ title: p.kind + " page", url: p.url, text: p.text }));
      try {
        const body = pick.map((j: any, i: number) => `### JOB ${i}: ${j.title}\n${j.text.slice(0, 2600)}`).join("\n\n");
        const { model, out } = await gemini(P1_SYSTEM, body, P1_SCHEMA); p1Model = p1Model || model;
        const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
        for (const it of out.items || []) {
          const s = pick[it.job]; if (!s || !norm(s.text).includes(norm(it.quote))) continue;
          const key = canon(it.tech); if (!key || VOCAB[key].cat === "language") continue;
          ev.push({ tech: key, category: VOCAB[key].cat, source: "website", strength: it.strength === "alternative" ? "alternative" : "narrative", url: s.url, quote: it.quote });
        }
      } catch (_e) { /* best effort */ }
    }
    for (const f of fp?.items || []) ev.push({ tech: f.tech, category: VOCAB[f.tech].cat, source: "fingerprint", strength: "narrative", url: f.url, quote: f.quote });
    for (const n of news?.items || []) for (const [alias, key] of ALIAS) if (alias.length > 3 && VOCAB[key].cat !== "language" && termRe(alias).test(n.title)) ev.push({ tech: key, category: VOCAB[key].cat, source: "news", strength: "narrative", url: n.link, quote: n.title });

    // 4 fuse into ledger (one fact per tech+source, best evidence kept)
    const { data: ovr } = await SB.from("overrides").select("*").eq("account_id", accountId);
    const byTech = new Map<string, Ev[]>(); ev.forEach((e) => (byTech.get(e.tech) ?? byTech.set(e.tech, []).get(e.tech)!).push(e));
    const facts: any[] = []; let n = 1;
    const rank = (s: string) => ({ required: 3, narrative: 2, preferred: 1, alternative: 0 } as any)[s] ?? 0;
    for (const [tech, list] of byTech) {
      const sources = new Set(list.map((e) => e.source));
      const strong = list.filter((e) => e.strength !== "alternative");
      let state = "active", conf = 0.5;
      if (!strong.length) { state = "noise"; conf = 0.1; }
      else if (list.some((e) => e.migration)) { state = "migrating_to"; conf = 0.75; }
      else if (sources.has("github") && sources.size > 1) { conf = 0.95; }
      else if (sources.has("github")) { conf = 0.8; }
      else if (sources.has("job_post")) { state = strong.some((e) => e.strength === "required") ? "hiring_only" : "emerging"; conf = Math.min(0.85, 0.45 + 0.1 * strong.length); }
      else if ([...sources].every((s) => s === "fingerprint")) { conf = 0.55; }
      else if ([...sources].every((s) => s === "fingerprint" || s === "news")) { conf = 0.5; }
      else { conf = 0.6; }
      const o = (ovr || []).find((x: any) => x.tech === tech); if (o) { state = o.forced_state; conf = 1; }
      const per = new Map<string, Ev>(); for (const e of list.sort((a, b) => rank(b.strength) - rank(a.strength))) if (!per.has(e.source)) per.set(e.source, e);
      for (const e of per.values()) facts.push({ fid: `F${n++}`, tech, category: e.category, state, confidence: r2(conf), source: e.source, strength: e.strength, source_url: e.url, quote: e.quote });
    }
    const engRoles = jobs?.eng.length ?? null, platRoles = jobs?.platform.length ?? null;
    if (jobs?.all) facts.push({ fid: `F${n++}`, tech: "hiring", category: "activity", state: "active", confidence: 1, source: "job_post", strength: "narrative", source_url: jobsVia === "careers page" ? (acc.careers_url || web.careersUrl || `https://${dom0}`) : atsUrl(acc.ats_provider, acc.ats_slug, acc.careers_url), quote: `${engRoles} open engineering roles, ${platRoles} of them platform/infrastructure (${jobs.platform.slice(0, 3).map((j) => j.title).join("; ")})` });
    if (ghd?.ok) facts.push({ fid: `F${n++}`, tech: "github activity", category: "activity", state: "active", confidence: 1, source: "github", strength: "narrative", source_url: `https://github.com/${acc.github_org}`, quote: `${ghd.active30} of ${ghd.publicRepos} public repos pushed in the last 30 days` });
    posts.slice(0, 3).forEach((p) => facts.push({ fid: `F${n++}`, tech: "blog post", category: "narrative", state: "active", confidence: 1, source: "blog", strength: "narrative", source_url: p.link, quote: p.title }));

    const NEWS_RE = /(raises|funding|series [a-e]\b|acquir|appoint|new (cto|vp|head)|launch|migrat|moves to|expands|hires|layoff)/i;
    const newsSorted = [...(news?.items || [])].sort((a, b) => Number(NEWS_RE.test(b.title)) - Number(NEWS_RE.test(a.title)));
    newsSorted.slice(0, 4).forEach((nw) => facts.push({ fid: `F${n++}`, tech: "news item", category: "narrative", state: "active", confidence: 0.6, source: "news", strength: "narrative", source_url: nw.link, quote: nw.title }));

    // 5 score
    const coreFacts = facts.filter((f) => f.state !== "noise");
    const srcCount = new Set(coreFacts.map((f) => f.source)).size;
    const solidSrc = new Set(coreFacts.filter((f) => f.source !== "fingerprint" && f.source !== "news").map((f) => f.source));
    void srcCount;
    const tier = coreFacts.length >= 8 && solidSrc.size >= 2 ? "A" : coreFacts.length >= 3 && solidSrc.size >= 1 ? "B" : "C";
    const has = (t: string) => coreFacts.some((f) => f.tech === t);
    const fidOf = (t: string, src?: string) => coreFacts.filter((f) => f.tech === t && (!src || f.source === src)).map((f) => f.fid);
    const hyps: any[] = [];
    const mig = coreFacts.find((f) => f.state === "migrating_to");
    const metricVal: Record<string, number | null | undefined> = { ci: ghd?.ci, platform_roles: platRoles, eng_roles: engRoles, active30: ghd?.active30, public_repos: ghd?.publicRepos };
    const cmp = (a: number, op: string, b: number) => op === ">=" ? a >= b : op === ">" ? a > b : op === "<=" ? a <= b : op === "<" ? a < b : a === b;
    const holds = (c: any): boolean => {
      if (c.m === "migrating") return !!mig;
      if (c.m === "has") return (c.v || []).some((t: string) => has(t));
      if (c.m === "blog_match") { try { return posts.some((p) => new RegExp(c.v, "i").test(p.title)); } catch { return false; } }
      if (c.m === "no_other") return hyps.length === 0;
      if (c.m === "news_match") { try { return facts.some((f) => f.tech === "news item" && new RegExp(c.v, "i").test(f.quote)); } catch { return false; } }
      const val = metricVal[c.m]; if (val == null) return false;
      return cmp(val, c.op || ">=", Number(c.v));
    };
    for (const pb of PLAYBOOKS) {
      const conds = pb.rule?.all || [];
      if (!conds.length || !conds.every(holds)) continue;
      const ek = pb.evidence?.kind; let evid: string[] = [];
      if (ek === "ci") evid = fidOf("github actions", "github");
      else if (ek === "migrating") evid = mig ? [mig.fid] : [];
      else if (ek === "hiring") evid = facts.filter((f) => f.tech === "hiring").map((f) => f.fid);
      else if (ek === "tech") evid = (pb.evidence.techs || []).flatMap((t: string) => fidOf(t)).slice(0, pb.evidence.max || 3);
      else if (ek === "blog") { const re = conds.find((c: any) => c.m === "blog_match"); const bp = posts.find((p) => { try { return new RegExp(re.v, "i").test(p.title); } catch { return false; } }); const f = bp && facts.find((x) => x.tech === "blog post" && x.quote === bp.title); evid = f ? [f.fid] : []; }
      else if (ek === "news") { const re = conds.find((c: any) => c.m === "news_match"); try { evid = facts.filter((f) => f.tech === "news item" && new RegExp(re.v, "i").test(f.quote)).map((f) => f.fid).slice(0, 2); } catch { evid = []; } }
      else if (ek === "activity") evid = facts.filter((f) => f.tech === "github activity").map((f) => f.fid);
      if (!evid.length) continue; // a hypothesis without a citable fact is dropped
      const mv = pb.metric ? Number(metricVal[pb.metric] ?? 0) : 0;
      hyps.push({ id: `H${hyps.length + 1}`, playbook: pb.slug, hook_type: pb.hook_type, score: Math.min(1, Number(pb.base) + Number(pb.per) * mv), friction: pb.friction, evidence: evid });
    }
    hyps.sort((a, b) => b.score - a.score);
    const icp = r2(Math.min(1, ICP_W.base + ICP_W.per_hypothesis * hyps.length + (has("kubernetes") ? ICP_W.kubernetes : 0) + (ghd?.ci != null ? ICP_W.measured_ci : 0) + ((platRoles ?? 0) > 0 ? ICP_W.platform_roles : 0) + (tier === "A" ? ICP_W.tier_a : 0)));

    // 6 diff vs previous snapshot
    const { data: prev } = await SB.from("snapshots").select("*").eq("account_id", accountId).order("taken_at", { ascending: false }).limit(1).maybeSingle();
    const diff: string[] = [];
    if (!prev) diff.push("First snapshot");
    else {
      const soft = (s: string) => s === "fingerprint" || s === "news"; // best-effort sources never drive a diff on their own
      const SKIP = ["blog post", "hiring", "github activity", "news item"];
      const prevTech = new Set((prev.tech || []).filter((t: any) => !soft(t.source)).map((t: any) => t.tech)); const curTech = new Set(coreFacts.filter((f) => !soft(f.source)).map((f) => f.tech));
      for (const t of curTech) if (!prevTech.has(t) && !SKIP.includes(t as string)) diff.push(`New signal: ${t}`);
      for (const t of prevTech) if (!curTech.has(t as string) && !SKIP.includes(t as string)) diff.push(`Signal gone: ${t}`);
      const prevNews = new Set((prev.news || []).map((x: any) => x.title)); const freshNews = (news?.items || []).find((x) => NEWS_RE.test(x.title) && !prevNews.has(x.title));
      if (freshNews && (prev.news || []).length) diff.push(`In the news: ${freshNews.title.slice(0, 110)}`);
      if (engRoles != null && prev.eng_roles != null && Math.abs(engRoles - prev.eng_roles) >= 3) diff.push(`Engineering roles ${prev.eng_roles} → ${engRoles}`);
      if (platRoles != null && prev.platform_roles != null && platRoles !== prev.platform_roles) diff.push(`Platform roles ${prev.platform_roles} → ${platRoles}`);
      if (ghd?.ci != null && prev.ci_median_min != null && Math.abs(ghd.ci - prev.ci_median_min) / prev.ci_median_min >= 0.2) diff.push(`CI median ${prev.ci_median_min} → ${ghd.ci} min`);
      const prevPost = (prev.blog_posts || [])[0]?.title; if (posts[0] && posts[0].title !== prevPost) diff.push(`New post: ${posts[0].title}`);
    }
    const whyNow = r2(Math.min(1, WHY_W.base + WHY_W.per_change * diff.length + (mig ? WHY_W.migration : 0) + Math.min(WHY_W.platform_cap, WHY_W.platform_per_role * (platRoles ?? 0)) + (ghd?.ci != null && ghd.ci > WHY_W.ci_slow_min ? WHY_W.ci_slow : 0)));
    const factSheet = facts.map((f) => `[${f.fid}] ${f.tech} | ${f.category} | ${f.state} | conf ${f.confidence} | ${f.source}${f.strength !== "narrative" ? " " + f.strength : ""} | "${f.quote}"`).join("\n");
    const fsHash = await sha(factSheet + acc.persona + PROMPT_VERSION);
    const { data: lastBrief } = await SB.from("briefs").select("id, snapshot_id, used_fallback, model").eq("account_id", accountId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    const material = !prev || !lastBrief || lastBrief.used_fallback || lastBrief.model === "template" || diff.length > 0 || prev.fact_sheet_hash !== fsHash;

    const off = { ok: false, detail: "turned off in Settings" };
    const cov: any = {
      github: ghd ? { ok: !!ghd.ok, detail: ghd.ok ? `${acc.github_org} · ${ghd.publicRepos} public repos` : `org ${acc.github_org} could not be read` } : { ok: false, detail: SOURCES.github === false ? off.detail : "no GitHub org found" },
      jobs: jobs?.all ? { ok: true, detail: `${jobsVia} · ${jobs.all} open roles, ${jobs.eng.length} engineering` } : { ok: false, detail: acc.ats_provider && acc.ats_provider !== "none" ? `${acc.ats_provider} returned no roles` : "no job board found" },
      blog: { ok: posts.length > 0, detail: posts.length ? `${posts.length} recent posts` : acc.blog_feed ? "feed is empty" : "no RSS feed found" },
      website: web.off ? off : { ok: !!web.ok, detail: web.blocked ? "robots.txt asks crawlers to stay out" : web.ok ? `${web.fetched} pages read${web.careersUrl ? ", careers page found" : ""}` : "site did not load" },
      fingerprint: fp ? { ok: fp.items.length > 0, detail: fp.items.length ? `${fp.items.length} infrastructure hint${fp.items.length > 1 ? "s" : ""}` : "no public hints" } : off,
      news: news ? { ok: news.ok && news.items.length > 0, detail: news.ok ? `${news.items.length} recent headline${news.items.length === 1 ? "" : "s"}` : "news feed unavailable" } : off,
      tier, at: new Date().toISOString(), hints: [] as string[],
    };
    if (!cov.github.ok) cov.hints.push("No public GitHub org found. If the company publishes code, add the org in Fix sources.");
    if (!cov.jobs.ok) cov.hints.push("No job board found. Paste the careers page URL, or pick the ATS and its slug.");
    if (web.blocked) cov.hints.push("The website's robots.txt blocks crawlers, so Scout read only public APIs and feeds.");
    else if (!cov.website.ok && !web.off) cov.hints.push("The website did not load. Check the domain.");
    if (tier === "C") cov.hints.push("Evidence is thin, so no opener was written. Add a source above and refresh.");

    const { data: snap, error: snapErr } = await SB.from("snapshots").insert({
      account_id: accountId, languages: ghd?.languages ?? {}, tech: coreFacts.map((f) => ({ tech: f.tech, category: f.category, state: f.state, confidence: f.confidence, source: f.source })),
      ci_median_min: ghd?.ci ?? null, ci_runs_sampled: ghd?.ciRuns ?? null, ci_repo: ghd?.ciRepo ?? null, eng_roles: engRoles, platform_roles: platRoles,
      active_repos_30d: ghd?.active30 ?? null, public_repos: ghd?.publicRepos ?? null, blog_posts: posts.slice(0, 5), evidence_tier: tier, icp_fit: icp, why_now: whyNow,
      hypotheses: hyps, fact_sheet_hash: fsHash, material, diff, news: (news?.items || []).slice(0, 8),
    }).select().single();
    if (snapErr) throw snapErr;
    await SB.from("signals").insert(facts.map((f) => ({ ...f, account_id: accountId, snapshot_id: snap.id })));
    if (diff.length && prev) await SB.from("events").insert(diff.map((d) => ({ account_id: accountId, kind: "change", detail: d })));

    // 7 write (only on material change and when there is enough evidence)
    let verifierFailed = false, repaired = false, fallback = false;
    if (material) {
      let brief: any = null, model = null, errors: string[] = [];
      if (tier !== "C" && hyps.length) {
        const user = `FACT_SHEET (as of ${new Date().toISOString().slice(0, 10)}, evidence tier ${tier}, company ${acc.name}):\n${factSheet}\n\nHYPOTHESES (pre-scored; pick the best one that the facts support):\n${hyps.map((h) => `[${h.id}] score ${h.score.toFixed(2)} | hook ${h.hook_type} | friction: ${h.friction} | evidence: ${h.evidence.join(", ")}`).join("\n")}\n\nCHANGES SINCE LAST WEEK:\n${diff.join("\n") || "none"}`;
        const shots = await feedbackShots();
        const userP = user + shots;
        try {
          const r = await gemini(P2_SYSTEM(acc.persona), userP, P2_SCHEMA()); model = r.model; brief = r.out;
          errors = verify(brief, facts, acc.name);
          if (errors.length) {
            verifierFailed = true;
            const rr = await gemini(P2_SYSTEM(acc.persona), `${userP}\n\nYOUR PREVIOUS DRAFT:\n${JSON.stringify(brief)}\n\nIt failed these checks:\n- ${errors.join("\n- ")}\nReturn the full JSON again, changing only what is needed to pass. Same FACT_SHEET and rules.`, P2_SCHEMA());
            const e2 = verify(rr.out, facts, acc.name);
            if (!e2.length) { brief = rr.out; repaired = true; errors = []; } else { errors = e2; brief = null; }
          }
        } catch (e) { errors = [String((e as Error).message)]; brief = null; }
      }
      if (!brief) {
        // deterministic, always-true fallback built from the top facts
        fallback = tier !== "C";
        const langs = Object.entries(ghd?.languages ?? {}).slice(0, 3).map(([k, v]) => `${k} (${v}%)`).join(", ");
        const infra = coreFacts.filter((f) => ["cloud", "orchestration", "ci", "build", "infra"].includes(f.category)).slice(0, 4);
        const h = hyps[0];
        brief = tier === "C" ? {
          summary: [[{ text: `There is not enough public engineering signal for ${acc.name} to describe its stack with confidence.`, cites: [] }], [{ text: "No opener was generated; use the discovery questions on the first call.", cites: [] }]],
          opener: null,
          discovery: ["Which cloud and orchestration do your production workloads run on today?", "How long does a typical pull request wait for CI to go green?", "Is there a platform or developer-experience team, and what is it building this half?"],
        } : {
          summary: [
            [{ text: langs ? `Public repositories lean on ${langs}.` : `Few public repositories are available.`, cites: facts.filter((f) => f.category === "language").slice(0, 3).map((f) => f.fid) }, ...(infra.length ? [{ text: `Visible tooling includes ${infra.map((f) => f.tech).join(", ")}.`, cites: infra.map((f) => f.fid) }] : [])],
            facts.filter((f) => f.category === "activity").map((f) => ({ text: f.quote + ".", cites: [f.fid] })),
          ],
          opener: h ? { text: `Saw evidence of ${h.friction} at ${acc.name}; that is the exact loop we shorten.`, cites: h.evidence, hook_type: h.hook_type } : null,
          discovery: ["How long does a typical pull request wait for CI?", "How do engineers run the full system locally?", "Who owns build and CI tooling today?"],
        };
      }
      await SB.from("briefs").insert({
        account_id: accountId, snapshot_id: snap.id, summary: (brief.summary || []).map((p: any[]) => p.map((s) => ({ text: s.text, cites: s.cites }))),
        opener: brief.opener?.text ?? null, opener_cites: brief.opener?.cites ?? null, hook_type: brief.opener?.hook_type ?? null, persona: acc.persona,
        discovery: brief.discovery ?? [], model: model ?? "template", prompt_version: PROMPT_VERSION, verifier_passed: !fallback && tier !== "C", verifier_errors: errors, repaired, used_fallback: fallback,
      });
      if (prev) await SB.from("events").insert({ account_id: accountId, kind: "brief", detail: `New brief (${brief.opener?.hook_type ?? "no opener"})` });
    }

    try { await SB.rpc("compute_radar"); } catch (_e) { /* radar is derived; never fail a refresh on it */ }
    if (material && prev && trigger !== "added") {
      const top = hyps[0];
      if (top && ALERT_HOOKS.includes(top.hook_type)) {
        const pushUrl = `${SB_URL}/functions/v1/scout-push`;
        try { await fetch(pushUrl, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${SB_SERVICE}` }, body: JSON.stringify({ account_id: accountId, mode: "alert", reason: diff.slice(0, 3).join("; ") }) }); } catch (_e) { /* best effort */ }
      }
    }
    await SB.from("watchlist").update({ refresh_status: "ok", last_refreshed_at: new Date().toISOString(), refresh_error: null, coverage: cov }).eq("id", accountId);
    await SB.from("pipeline_runs").update({ finished_at: new Date().toISOString(), status: "ok", github_calls: ghCalls, gemini_calls: gemCalls, material, verifier_failed: verifierFailed, repaired, used_fallback: fallback, duration_ms: Date.now() - t0 }).eq("id", runRow.id);
    return { ok: true, tier, facts: facts.length, material, diff, p1Model, ghCalls, gemCalls };
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 500);
    await SB.from("watchlist").update({ refresh_status: "error", refresh_error: msg }).eq("id", accountId);
    await SB.from("pipeline_runs").update({ finished_at: new Date().toISOString(), status: "error", error: msg, github_calls: ghCalls, gemini_calls: gemCalls, duration_ms: Date.now() - t0 }).eq("id", runRow.id);
    throw e;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { account_id, trigger = "manual" } = await req.json();
    if (!account_id) return new Response(JSON.stringify({ error: "account_id required" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    const out = await refresh(account_id, trigger);
    return new Response(JSON.stringify(out), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message ?? e) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
