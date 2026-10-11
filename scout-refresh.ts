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
let SOURCES: Record<string, boolean> = { github: true, job_board: true, blog: true };
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

// ---------- resolver ----------
async function resolve(acc: any) {
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
    for (const cand of [...new Set([stem, nameSlug, "get" + stem, stem + "hq", nameSlug + "hq", stem + "io", stem + "labs", stem + "dev"])]) {
      const c = await checkOrg(cand);
      if (c) { out.github_org = c.org; out.mapping_confidence = c.conf; break; }
    }
  }
  if (!acc.ats_provider) {
    const slugs = [...new Set([stem, nameSlug, acc.name.toLowerCase().replace(/\s+/g, "-"), stem + "labs", stem + "hq"])];
    const probes = await Promise.all(slugs.map(async (slug) => {
      const [g, a, l] = await Promise.all([
        getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, {}, 9000),
        getJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, {}, 9000),
        getJSON(`https://api.lever.co/v0/postings/${slug}?mode=json&limit=5`, {}, 9000),
      ]);
      if (g.ok && g.data?.jobs?.length) return { ats_provider: "greenhouse", ats_slug: slug };
      if (a.ok && a.data?.jobs?.length) return { ats_provider: "ashby", ats_slug: slug };
      if (l.ok && Array.isArray(l.data) && l.data.length) return { ats_provider: "lever", ats_slug: slug };
      return null;
    }));
    const hit = probes.find(Boolean); if (hit) Object.assign(out, hit);
  }
  if (!acc.blog_feed) {
    const cands = [`https://${dom}/blog/rss.xml`, `https://${dom}/rss.xml`, `https://${dom}/feed.xml`, `https://${dom}/blog/feed.xml`, `https://${dom}/atom.xml`, `https://${dom}/atom`, `https://${dom}/blog/rss`, `https://${dom}/feed`, `https://${dom}/blog/index.xml`, `https://${dom}/index.xml`, `https://${dom}/blog/feed`];
    const texts = await Promise.all(cands.map((u) => getText(u, 7000)));
    const i = texts.findIndex((t) => t && /<(rss|feed)[\s>]/i.test(t.slice(0, 3000)));
    if (i >= 0) out.blog_feed = cands[i];
  }
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
async function collectJobs(provider: string, slug: string) {
  const jobs: { title: string; url: string; text: string }[] = [];
  if (provider === "greenhouse") {
    const r = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`, {}, 20000);
    for (const j of r.data?.jobs || []) jobs.push({ title: j.title, url: j.absolute_url, text: stripHtml(j.content || "") });
  } else if (provider === "ashby") {
    const r = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=false`, {}, 20000);
    for (const j of r.data?.jobs || []) jobs.push({ title: j.title, url: j.jobUrl, text: (j.descriptionPlain || stripHtml(j.descriptionHtml || "")).replace(/\s+/g, " ") });
  } else if (provider === "lever") {
    const r = await getJSON(`https://api.lever.co/v0/postings/${slug}?mode=json`, {}, 20000);
    for (const j of Array.isArray(r.data) ? r.data : []) jobs.push({ title: j.text, url: j.hostedUrl, text: (j.descriptionPlain || "") + " " + (j.lists || []).map((l: any) => stripHtml(l.content || "")).join(" ") + " " + (j.additionalPlain || "") });
  }
  const eng = jobs.filter((j) => ENG_RE.test(j.title));
  return { all: jobs.length, eng, platform: eng.filter((j) => PLAT_RE.test(j.title)) };
}

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
    // 1 resolve
    const resolved = await resolve(acc);
    if (Object.keys(resolved).length) { await SB.from("watchlist").update(resolved).eq("id", accountId); Object.assign(acc, resolved); }

    // 2 collect
    const [ghd, jobs, posts, customRes] = await Promise.all([
      acc.github_org && SOURCES.github !== false ? collectGitHub(acc.github_org) : Promise.resolve(null),
      acc.ats_provider && SOURCES.job_board !== false ? collectJobs(acc.ats_provider, acc.ats_slug) : Promise.resolve(null),
      SOURCES.blog !== false ? collectBlog(acc.blog_feed) : Promise.resolve([]),
      collectCustom(acc),
    ]);

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
      else { conf = 0.6; }
      const o = (ovr || []).find((x: any) => x.tech === tech); if (o) { state = o.forced_state; conf = 1; }
      const per = new Map<string, Ev>(); for (const e of list.sort((a, b) => rank(b.strength) - rank(a.strength))) if (!per.has(e.source)) per.set(e.source, e);
      for (const e of per.values()) facts.push({ fid: `F${n++}`, tech, category: e.category, state, confidence: r2(conf), source: e.source, strength: e.strength, source_url: e.url, quote: e.quote });
    }
    const engRoles = jobs?.eng.length ?? null, platRoles = jobs?.platform.length ?? null;
    if (jobs) facts.push({ fid: `F${n++}`, tech: "hiring", category: "activity", state: "active", confidence: 1, source: "job_post", strength: "narrative", source_url: acc.ats_provider === "greenhouse" ? `https://boards.greenhouse.io/${acc.ats_slug}` : acc.ats_provider === "ashby" ? `https://jobs.ashbyhq.com/${acc.ats_slug}` : `https://jobs.lever.co/${acc.ats_slug}`, quote: `${engRoles} open engineering roles, ${platRoles} of them platform/infrastructure (${jobs.platform.slice(0, 3).map((j) => j.title).join("; ")})` });
    if (ghd?.ok) facts.push({ fid: `F${n++}`, tech: "github activity", category: "activity", state: "active", confidence: 1, source: "github", strength: "narrative", source_url: `https://github.com/${acc.github_org}`, quote: `${ghd.active30} of ${ghd.publicRepos} public repos pushed in the last 30 days` });
    posts.slice(0, 3).forEach((p) => facts.push({ fid: `F${n++}`, tech: "blog post", category: "narrative", state: "active", confidence: 1, source: "blog", strength: "narrative", source_url: p.link, quote: p.title }));

    // 5 score
    const coreFacts = facts.filter((f) => f.state !== "noise");
    const srcCount = new Set(coreFacts.map((f) => f.source)).size;
    const tier = coreFacts.length >= 8 && srcCount >= 2 ? "A" : coreFacts.length >= 3 ? "B" : "C";
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
      const prevTech = new Set((prev.tech || []).map((t: any) => t.tech)); const curTech = new Set(coreFacts.map((f) => f.tech));
      for (const t of curTech) if (!prevTech.has(t) && !["blog post", "hiring", "github activity"].includes(t)) diff.push(`New signal: ${t}`);
      for (const t of prevTech) if (!curTech.has(t as string) && !["blog post", "hiring", "github activity"].includes(t as string)) diff.push(`Signal gone: ${t}`);
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

    const { data: snap, error: snapErr } = await SB.from("snapshots").insert({
      account_id: accountId, languages: ghd?.languages ?? {}, tech: coreFacts.map((f) => ({ tech: f.tech, category: f.category, state: f.state, confidence: f.confidence, source: f.source })),
      ci_median_min: ghd?.ci ?? null, ci_runs_sampled: ghd?.ciRuns ?? null, ci_repo: ghd?.ciRepo ?? null, eng_roles: engRoles, platform_roles: platRoles,
      active_repos_30d: ghd?.active30 ?? null, public_repos: ghd?.publicRepos ?? null, blog_posts: posts.slice(0, 5), evidence_tier: tier, icp_fit: icp, why_now: whyNow,
      hypotheses: hyps, fact_sheet_hash: fsHash, material, diff,
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
    await SB.from("watchlist").update({ refresh_status: "ok", last_refreshed_at: new Date().toISOString(), refresh_error: null }).eq("id", accountId);
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
