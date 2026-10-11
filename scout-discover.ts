// Tech Stack Scout: automatic lead discovery.
// Finds candidate companies from free public sources (HN "Who is hiring", GitHub topics, news, competitor mentions),
// scores them against the won-account profile, auto-adds the best (capped per week), queues the borderline ones for review,
// and pauses auto-added accounts whose full refresh shows weak evidence.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
const SB = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
let GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
let GH_TOKEN = Deno.env.get("GITHUB_TOKEN") ?? "";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const MODELS = [Deno.env.get("GEMINI_MODEL"), "gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"].filter(Boolean) as string[];
const UA = "Mozilla/5.0 (compatible; TechStackScout/1.0; +https://tech-stack-scout.vercel.app)";
async function loadKeys() {
  if (GEMINI_KEY && GH_TOKEN) return;
  const { data } = await SB.from("app_config").select("key,value").in("key", ["gemini_api_key", "github_token"]);
  for (const r of data || []) { if (r.key === "gemini_api_key" && !GEMINI_KEY) GEMINI_KEY = r.value; if (r.key === "github_token" && !GH_TOKEN) GH_TOKEN = r.value; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function http(url: string, headers: Record<string, string> = {}, timeout = 12000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), timeout);
  try { const r = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: c.signal, redirect: "follow" }); return { ok: r.ok, status: r.status, text: r.ok ? await r.text() : "" }; }
  catch { return { ok: false, status: 0, text: "" }; } finally { clearTimeout(t); }
}
async function jget(url: string, headers: Record<string, string> = {}, timeout = 12000) {
  const r = await http(url, headers, timeout); if (!r.ok) return null; try { return JSON.parse(r.text); } catch { return null; }
}
const gh = (path: string) => jget(`https://api.github.com${path}`, { Accept: "application/vnd.github+json", ...(GH_TOKEN ? { Authorization: `Bearer ${GH_TOKEN}` } : {}) });
const strip = (h: string) => h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<p>/gi, "\n").replace(/&#x2F;/g, "/").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").trim();
const normDomain = (d: string) => String(d || "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/[\/?#:].*$/, "");
const VALID = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const BLOCK = new Set(["github.com", "gitlab.com", "linkedin.com", "twitter.com", "x.com", "facebook.com", "youtube.com", "medium.com", "notion.so", "google.com", "docs.google.com", "ycombinator.com", "news.ycombinator.com", "greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "smartrecruiters.com", "recruitee.com", "bamboohr.com", "myworkdayjobs.com", "wellfound.com", "angel.co", "indeed.com", "glassdoor.com", "apple.com", "microsoft.com", "amazon.com", "meta.com", "bit.ly", "t.co", "wikipedia.org", "npmjs.com", "pypi.org", "readthedocs.io", "gitbook.io", "vercel.app", "netlify.app", "herokuapp.com", "github.io", "pages.dev", "workers.dev", "substack.com", "wordpress.com", "blogspot.com", "grnh.se", "nordictechjobs.com", "remoteok.com", "weworkremotely.com", "workatastartup.com", "ycombinator.com", "crunchbase.com", "techcrunch.com"]);
const blocked = (d: string) => /\.(gov|edu|mil)(\.[a-z]{2})?$/.test(d) || /\.(js|py|rs)\.org$/.test(d) || [...BLOCK].some((b) => d === b || d.endsWith("." + b));
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const termRe = (a: string) => new RegExp(`(^|[^a-z0-9+#.])${esc(a)}(?![a-z0-9+#])`, "i");

async function gemini(system: string, user: string, schema: any) {
  const key = (GEMINI_KEY || "").replace(/\s+/g, ""); if (!key) throw new Error("no gemini key");
  const body = JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: schema } });
  for (const m of MODELS) for (const ep of [{ url: `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, h: { "x-goog-api-key": key } }, { url: `https://aiplatform.googleapis.com/v1/publishers/google/models/${m}:generateContent?key=${encodeURIComponent(key)}`, h: {} }]) {
    try {
      const r = await fetch(ep.url, { method: "POST", headers: { "Content-Type": "application/json", ...ep.h }, body });
      if (r.status === 429) { await sleep(3000); continue; } if (!r.ok) continue;
      const j = await r.json(); return JSON.parse(j.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "{}");
    } catch { /* next */ }
  }
  throw new Error("gemini failed");
}

type Cand = { name: string; domain: string; source: "hiring" | "oss" | "news"; text: string; url: string; stars?: number; roles?: number };
const INTENT_RE = /(platform|devops|sre\b|site reliability|infrastructure|developer (experience|productivity)|devex|build (system|engineer)|ci\/cd|release engineer)/i;
const GROWTH_RE = /(raises|raised|series [a-e]\b|funding|launch|migrat|moves to|expands|new (cto|vp|head)|acquir)/i;
const BAD_RE = /(recruit|staffing|consult|agency|bootcamp|outsourc|headhunt|for hire|freelanc|job board|foundation|cncf|linux foundation|open[- ]source project|community[- ]driven)/i;

// ---- sources ----
async function hnHiring(queries: string[]): Promise<Cand[]> {
  const th = await jget("https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=6");
  const story = (th?.hits || []).find((h: any) => /who is hiring/i.test(h.title || "") && !/freelancer|wants to be hired/i.test(h.title));
  if (!story) return [];
  const out = new Map<string, Cand>();
  const results = await Promise.all(queries.slice(0, 10).map((q) => jget(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=comment,story_${story.objectID}&hitsPerPage=40`)));
  for (const r of results) for (const h of r?.hits || []) {
    const txt = strip(String(h.comment_text || "")); if (txt.length < 60) continue;
    const head = txt.split("\n")[0]; if (!head.includes("|")) continue;
    const name = head.split("|")[0].replace(/\(.*?\)/g, "").trim().slice(0, 60); if (!name || name.length < 2 || /^https?:/i.test(name)) continue;
    const urls = [...txt.matchAll(/https?:\/\/[^\s<>"')]+/g)].map((m) => normDomain(m[0])).filter((d) => VALID.test(d) && !blocked(d));
    if (!urls.length) continue;
    const d = urls[0]; const prev = out.get(d);
    if (prev) { prev.roles = (prev.roles || 1) + 1; prev.text += " " + txt.slice(0, 600); } else out.set(d, { name, domain: d, source: "hiring", text: txt.slice(0, 1400), url: `https://news.ycombinator.com/item?id=${h.objectID}`, roles: 1 });
  }
  return [...out.values()];
}
async function ossOrgs(topics: string[]): Promise<Cand[]> {
  const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const out = new Map<string, Cand & { login: string }>();
  const res = await Promise.all(topics.slice(0, 8).map((t) => gh(`/search/repositories?q=${encodeURIComponent(`topic:${t} stars:>150 pushed:>${since}`)}&sort=updated&per_page=15`)));
  for (const r of res) for (const repo of r?.items || []) {
    if (repo.owner?.type !== "Organization") continue;
    const login = repo.owner.login; const prev = out.get(login);
    const txt = `${repo.name}: ${repo.description || ""} topics: ${(repo.topics || []).join(" ")}`;
    if (prev) { prev.text += " " + txt; prev.stars = Math.max(prev.stars || 0, repo.stargazers_count); } else out.set(login, { name: login, domain: "", source: "oss", text: txt, url: repo.owner.html_url, stars: repo.stargazers_count, login });
  }
  const list = [...out.values()].sort((a, b) => (b.stars || 0) - (a.stars || 0)).slice(0, 30);
  await Promise.all(list.map(async (o) => { const org = await gh(`/orgs/${o.login}`); if (org) { o.name = org.name || o.login; o.domain = normDomain(org.blog || ""); o.text += " " + (org.description || ""); } }));
  return list.filter((o) => VALID.test(o.domain) && !blocked(o.domain));
}
async function newsLeads(queries: string[]): Promise<Cand[]> {
  const titles: { t: string; link: string }[] = [];
  const feeds = await Promise.all(queries.slice(0, 6).map((q) => http(`https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:30d")}&hl=en-US&gl=US&ceid=US:en`, {}, 9000)));
  for (const f of feeds) for (const it of f.text.split(/<item[\s>]/i).slice(1, 10)) {
    const t = strip((it.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/<!\[CDATA\[|\]\]>/g, ""));
    const link = (it.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || "").trim();
    if (t && !titles.some((x) => x.t === t)) titles.push({ t, link });
  }
  if (!titles.length) return [];
  const list = titles.slice(0, 45);
  let items: any[] = [];
  try {
    const r = await gemini("You read news headlines and list the company that each headline is about, only when it is a software or technology company that builds a product (not a news site, bank, or agency). Give the company's primary website domain only if you are certain of it, otherwise leave domain empty. Never invent.",
      list.map((x, i) => `${i}: ${x.t}`).join("\n"),
      { type: "OBJECT", properties: { items: { type: "ARRAY", items: { type: "OBJECT", properties: { i: { type: "INTEGER" }, company: { type: "STRING" }, domain: { type: "STRING" } }, required: ["i", "company", "domain"] } } }, required: ["items"] });
    items = r.items || [];
  } catch { return []; }
  const out: Cand[] = [];
  await Promise.all(items.slice(0, 25).map(async (it) => {
    const d = normDomain(it.domain || ""); if (!VALID.test(d) || blocked(d) || !it.company) return;
    const src = list[it.i]; if (!src) return;
    const p = await http(`https://${d}/`, {}, 8000); const html = p.text.slice(0, 60000).toLowerCase();
    const first = String(it.company).toLowerCase().split(/\s+/)[0];
    if (!p.ok || !html.includes(first)) return; // the domain must really belong to the company
    out.push({ name: String(it.company).slice(0, 60), domain: d, source: "news", text: src.t, url: src.link });
  }));
  return out;
}

// ---- main ----
async function run(trigger: string) {
  await loadKeys();
  const { data: cfg } = await SB.from("discovery_config").select("*").eq("id", "default").single();
  if (!cfg) throw new Error("discovery_config missing");
  if (!cfg.enabled && trigger !== "manual") return { skipped: "discovery is turned off" };
  const S = cfg.sources || {};
  const { data: dict } = await SB.from("tech_dictionary").select("tech,category,aliases").eq("enabled", true);
  const ALIAS = new Map<string, { tech: string; cat: string }>();
  for (const d of dict || []) { ALIAS.set(d.tech, { tech: d.tech, cat: d.category }); for (const a of d.aliases || []) ALIAS.set(String(a).toLowerCase(), { tech: d.tech, cat: d.category }); }
  const techsIn = (text: string) => { const s = new Set<string>(); for (const [a, v] of ALIAS) if (v.cat !== "language" && a.length > 2 && termRe(a).test(text)) s.add(v.tech); return s; };

  // existing universe
  const { data: wl } = await SB.from("watchlist").select("id,domain,stage,competitor,is_demo,lead_source,created_at,active");
  const seen = new Set<string>((wl || []).map((w: any) => normDomain(w.domain)));
  const { data: oldLeads } = await SB.from("leads").select("domain,status");
  for (const l of oldLeads || []) seen.add(l.domain);
  for (const d of cfg.exclude_domains || []) seen.add(normDomain(d));

  // ICP profile from won / advanced live accounts
  const live = (wl || []).filter((w: any) => !w.is_demo);
  const won = live.filter((w: any) => ["Won", "Opportunity", "Meeting"].includes(w.stage));
  const freq = new Map<string, number>();
  if (won.length) {
    const { data: acc } = await SB.from("v_accounts_ws").select("id,snapshot_id").in("id", won.map((w: any) => w.id));
    const ids = (acc || []).map((a: any) => a.snapshot_id).filter(Boolean);
    if (ids.length) { const { data: sg } = await SB.from("signals").select("tech,category").in("snapshot_id", ids); for (const s of sg || []) if (!["language", "narrative", "activity"].includes(s.category) && ALIAS.has(s.tech)) freq.set(s.tech, (freq.get(s.tech) || 0) + 1); }
  }
  let terms = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t]) => t);
  const profileFrom = terms.length ? "won accounts" : "default ICP";
  if (!terms.length) terms = ["kubernetes", "github actions", "monorepo", "bazel", "docker", "terraform"];
  for (const t of cfg.extra_terms || []) if (!terms.includes(t.toLowerCase())) terms.push(t.toLowerCase());
  const competitors = [...new Set(live.map((w: any) => String(w.competitor || "").trim().toLowerCase()).filter(Boolean))];
  if (!competitors.length) competitors.push("jenkins", "circleci", "travis ci");

  // gather
  const tasks: Promise<Cand[]>[] = [];
  const hnQ = ["platform engineer", "devops", "infrastructure engineer", "site reliability", "developer experience", "build engineer", ...terms.slice(0, 3)];
  if (S.hiring !== false || S.lookalike !== false) tasks.push(hnHiring(hnQ).catch(() => []));
  if (S.competitor !== false) tasks.push(hnHiring(competitors.slice(0, 4)).then((c) => c.map((x) => ({ ...x, text: x.text + " [competitor-query]" }))).catch(() => []));
  if (S.oss !== false || S.lookalike !== false) tasks.push(ossOrgs(terms.map((t) => t.replace(/\s+/g, "-"))).catch(() => []));
  if (S.hiring !== false || S.lookalike !== false) tasks.push(newsLeads(["raises Series developer platform infrastructure", "engineering team migrating to Kubernetes", "appoints new VP of Engineering platform", ...terms.slice(0, 2).map((t) => `company adopts ${t}`)]).catch(() => []));
  const raw = (await Promise.all(tasks)).flat();

  // merge by domain
  const by = new Map<string, Cand[]>();
  for (const c of raw) { const d = normDomain(c.domain); if (!VALID.test(d) || blocked(d) || seen.has(d)) continue; (by.get(d) ?? by.set(d, []).get(d)!).push({ ...c, domain: d }); }
  const merged = [...by.entries()].map(([domain, cs]) => ({ domain, cs, name: cs[0].name }));
  // verify the domain loads and read a short description (also filters agencies)
  const verified = (await Promise.all(merged.slice(0, 80).map(async (m) => {
    const p = await http(`https://${m.domain}/`, {}, 7000); if (!p.ok) return null;
    const title = strip(p.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").slice(0, 120);
    const desc = (p.text.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] || "").slice(0, 240);
    return { ...m, title, desc };
  }))).filter(Boolean) as any[];

  // score
  const scored = verified.map((m) => {
    const text = m.cs.map((c: Cand) => c.text).join(" ") + " " + m.title + " " + m.desc;
    const techs = techsIn(text); const overlap = terms.filter((t) => techs.has(t)).length;
    const sources = [...new Set(m.cs.map((c: Cand) => c.source))] as string[];
    const compHit = competitors.some((c) => termRe(c).test(text)) || /\[competitor-query\]/.test(text);
    const stars = Math.max(0, ...m.cs.map((c: Cand) => c.stars || 0));
    const roles = m.cs.reduce((s: number, c: Cand) => s + (c.roles || 0), 0);
    let s = 0.18 + 0.3 * Math.min(1, overlap / 2) + 0.1 * Math.min(1, techs.size / 4) + (INTENT_RE.test(text) ? 0.2 : 0) + (GROWTH_RE.test(text) ? 0.08 : 0) + (compHit ? 0.12 : 0) + (stars ? 0.12 * Math.min(1, Math.log10(stars) / 4) : 0) + (roles > 1 ? 0.06 : 0) + (sources.length > 1 ? 0.1 : 0);
    if (BAD_RE.test(m.title + " " + m.desc)) s -= 0.3;
    if (sources.length === 1 && sources[0] === "oss" && !INTENT_RE.test(text)) s -= 0.2; // a popular repo alone is not a buying signal
    s = Math.max(0, Math.min(1, s));
    const why: string[] = [];
    if (overlap) why.push(`uses ${terms.filter((t) => techs.has(t)).slice(0, 3).join(", ")} like your ${profileFrom}`);
    if (INTENT_RE.test(text)) why.push("hiring for platform / infrastructure work");
    if (compHit) why.push("mentions an incumbent you replace");
    if (stars) why.push(`open-source org (${stars}★ repo)`);
    if (GROWTH_RE.test(text)) why.push("recent growth or change signal");
    if (sources.length > 1) why.push(`seen in ${sources.length} sources`);
    const source = compHit ? "competitor" : overlap && sources.includes("oss") ? "lookalike" : sources[0];
    return { name: m.name, domain: m.domain, source, score: Math.round(s * 100) / 100, reason: why.join("; ") || "weak match", evidence: { sources, techs: [...techs], urls: m.cs.map((c: Cand) => c.url).slice(0, 3), title: m.title, snippet: m.cs[0].text.slice(0, 280) } };
  }).sort((a, b) => b.score - a.score);

  // decide
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const { count: usedC } = await SB.from("leads").select("id", { count: "exact", head: true }).eq("status", "auto_added").gte("found_at", weekAgo);
  let remaining = Math.max(0, Number(cfg.weekly_cap) - (usedC || 0));
  const sum = { found: scored.length, auto_added: 0, review: 0, rejected: 0, pruned: 0, terms, profile: profileFrom, by_source: {} as Record<string, number>, added: [] as string[] };
  for (const c of scored.slice(0, 60)) {
    sum.by_source[c.source] = (sum.by_source[c.source] || 0) + 1;
    let status = "rejected"; let wid: string | null = null;
    if (c.score >= Number(cfg.auto_threshold) && remaining > 0) {
      const { data: w, error } = await SB.from("watchlist").insert({ name: c.name, domain: c.domain, persona: "VP Engineering", stage: "Prospect", active: true, notes: `Auto-discovered (${c.source}, fit ${c.score}): ${c.reason}`, lead_source: c.source, lead_score: c.score }).select("id").single();
      if (!error && w) { wid = w.id; status = "auto_added"; remaining--; sum.auto_added++; sum.added.push(c.name); try { await SB.rpc("queue_refresh_now", { p_account: w.id }); } catch { /* weekly refresh will pick it up */ } }
      else status = "review";
    } else if (c.score >= Number(cfg.review_threshold)) status = "review";
    if (status === "review") sum.review++; if (status === "rejected") sum.rejected++;
    await SB.from("leads").upsert({ name: c.name, domain: c.domain, source: c.source, evidence: c.evidence, fit_score: c.score, status, reason: c.reason, watchlist_id: wid, decided_at: status === "auto_added" ? new Date().toISOString() : null }, { onConflict: "domain" });
  }

  // prune: auto-added accounts that, once fully read, show weak evidence are paused (not deleted)
  const { data: autos } = await SB.from("leads").select("watchlist_id").eq("status", "auto_added").lt("found_at", new Date(Date.now() - 6 * 864e5).toISOString());
  const old = (autos || []).map((l: any) => l.watchlist_id).filter(Boolean);
  if (old.length) {
    const { data: v } = await SB.from("v_accounts_ws").select("id,evidence_tier,icp_fit,refresh_status,active").in("id", old);
    for (const a of v || []) {
      if (a.active && a.refresh_status === "ok" && a.evidence_tier === "C" && Number(a.icp_fit || 0) < Number(cfg.min_keep)) {
        await SB.from("watchlist").update({ active: false, notes: "Paused automatically: weak public evidence after a full read. Re-enable to keep." }).eq("id", a.id);
        await SB.from("leads").update({ status: "pruned", decided_at: new Date().toISOString() }).eq("watchlist_id", a.id);
        sum.pruned++;
      }
    }
  }
  await SB.from("discovery_config").update({ last_run_at: new Date().toISOString(), last_summary: sum }).eq("id", "default");
  return sum;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const b = await req.json().catch(() => ({}));
    const out = await run(b.trigger || "manual");
    return new Response(JSON.stringify(out), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message ?? e) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
