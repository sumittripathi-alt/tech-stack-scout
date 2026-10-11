insert into public.tech_dictionary(tech,category,aliases) values
('aws','cloud',array['aws','amazon web services','ec2','lambda','s3']),
('gcp','cloud',array['gcp','google cloud','gke','bigquery','cloud run']),
('azure','cloud',array['azure','aks']),
('cloudflare','cloud',array['cloudflare','cloudflare workers']),
('vercel','cloud',array['vercel']),
('kubernetes','orchestration',array['kubernetes','k8s','eks','gke','aks','helm']),
('docker','orchestration',array['docker','containers','containerd']),
('nomad','orchestration',array['nomad']),
('terraform','infra',array['terraform','opentofu']),
('pulumi','infra',array['pulumi']),
('github actions','ci',array['github actions']),
('jenkins','ci',array['jenkins']),
('circleci','ci',array['circleci']),
('buildkite','ci',array['buildkite']),
('argocd','ci',array['argo cd','argocd']),
('bazel','build',array['bazel']),
('nx','build',array['nx monorepo','nx.dev']),
('turborepo','build',array['turborepo','turbo repo']),
('monorepo','build',array['monorepo']),
('grpc','infra',array['grpc','protobuf','protocol buffers']),
('kafka','data',array['kafka']),
('postgres','data',array['postgres','postgresql']),
('clickhouse','data',array['clickhouse']),
('redis','data',array['redis']),
('snowflake','data',array['snowflake']),
('prometheus','observability',array['prometheus']),
('grafana','observability',array['grafana']),
('datadog','observability',array['datadog']),
('opentelemetry','observability',array['opentelemetry','otel']),
('go','language',array['golang']),
('typescript','language',array['typescript']),
('python','language',array['python']),
('rust','language',array['rust']),
('java','language',array['java']),
('kotlin','language',array['kotlin']),
('ruby','language',array['ruby','rails']),
('elixir','language',array['elixir']),
('scala','language',array['scala']),
('c++','language',array['c++']),
('php','language',array['php']),
('react','language',array['react','next.js','nextjs'])
on conflict (tech) do nothing;insert into public.seller_profile(id,product,tone,banned_phrases,icp_weights) values ('default','a developer productivity platform that cuts CI time with remote caching and test impact analysis, and gives every engineer reproducible preview environments','plain, specific, no hype',array['I noticed','hope this finds you','leverage','synergy','cutting-edge','in today''s','streamline','game-changer','revolutionize','seamless'],'{"icp": {"base": 0.15, "per_hypothesis": 0.12, "kubernetes": 0.12, "measured_ci": 0.1, "platform_roles": 0.1, "tier_a": 0.1}, "why_now": {"base": 0.1, "per_change": 0.08, "migration": 0.3, "platform_per_role": 0.06, "platform_cap": 0.3, "ci_slow": 0.15, "ci_slow_min": 15}}'::jsonb) on conflict (id) do nothing;
insert into public.hook_playbooks(slug,hook_type,label,friction,rule,evidence,base,metric,per,enabled,sort) values
('measured_ci','measured_ci','Slow measured CI','slow CI feedback loop on every pull request','{"all": [{"m": "ci", "op": ">=", "v": 8}]}'::jsonb,'{"kind": "ci"}'::jsonb,0,'ci',0.04,true,10),
('migration','migration','Migration in flight','running two systems in parallel during a migration doubles the CI and environment surface','{"all": [{"m": "migrating"}]}'::jsonb,'{"kind": "migrating"}'::jsonb,0.85,null,0,true,20),
('hiring_surge','hiring_surge','Platform hiring surge','a growing platform team is a build-vs-buy moment for internal developer tooling','{"all": [{"m": "platform_roles", "op": ">=", "v": 2}]}'::jsonb,'{"kind": "hiring"}'::jsonb,0.4,'platform_roles',0.1,true,30),
('monorepo_scale','scale_threshold','Monorepo at scale','monorepo builds rebuild and retest far more than each change touches','{"all": [{"m": "has", "v": ["bazel", "nx", "turborepo", "monorepo"]}, {"m": "active30", "op": ">=", "v": 10}]}'::jsonb,'{"kind": "tech", "techs": ["bazel", "nx", "turborepo", "monorepo"], "max": 3}'::jsonb,0.7,null,0,true,40),
('k8s_local_env','scale_threshold','Kubernetes without local parity','local environments cannot reproduce a Kubernetes service mesh, so integration bugs surface late','{"all": [{"m": "has", "v": ["kubernetes"]}, {"m": "has", "v": ["docker", "grpc"]}]}'::jsonb,'{"kind": "tech", "techs": ["kubernetes", "grpc"], "max": 3}'::jsonb,0.6,null,0,true,50),
('blog_reference','blog_reference','Their own engineering post','the engineering problem described in their own post','{"all": [{"m": "blog_match", "v": "(ci|build|test|deploy|infra|platform|kubernetes|monorepo|migrat|developer|performance|scal)"}]}'::jsonb,'{"kind": "blog"}'::jsonb,0.55,null,0,true,60),
('oss_project','oss_project','Large open-source footprint','maintaining many public repos multiplies CI and release toil','{"all": [{"m": "public_repos", "op": ">=", "v": 20}, {"m": "no_other"}]}'::jsonb,'{"kind": "activity"}'::jsonb,0.4,null,0,true,70),
('tool_sprawl','tool_sprawl','Two observability stacks (example, off by default)','running a paid and an open-source observability stack means two systems to maintain','{"all": [{"m": "has", "v": ["datadog"]}, {"m": "has", "v": ["prometheus", "grafana", "opentelemetry"]}]}'::jsonb,'{"kind": "tech", "techs": ["datadog", "prometheus", "grafana"], "max": 3}'::jsonb,0.5,null,0,false,80)
on conflict (slug) do nothing;
insert into public.sources(slug,label,kind,parser,url_template,enabled,note) values
('github','GitHub repos, languages, workflows, CI run times','builtin',null,null,true,'Collected with the GitHub REST API'),
('job_board','Job boards (Greenhouse, Ashby, Lever)','builtin',null,null,true,'Public job-board APIs'),
('blog','Engineering blog (RSS / Atom)','builtin',null,null,true,'Auto-discovered feed'),
('changelog','Public changelog page (example)','custom','html','https://{domain}/changelog',false,'Fetches the page, strips HTML and scans it with the technology dictionary'),
('status_feed','Status page feed (example)','custom','rss','https://status.{domain}/history.rss',false,'Incident posts often name the cloud or database involved')
on conflict (slug) do nothing;
insert into public.prompt_versions(role,version,system_text,notes,active) select 'writer','writer-v1','You write pre-call research for an enterprise account executive who sells {{product}}.
You may ONLY use facts in FACT_SHEET. Every sentence must cite the fact IDs it relies on (e.g. "F3").
Never name a technology, number, team, repository or project that is not in FACT_SHEET.
Facts with confidence below 0.6, or state "hiring_only"/"emerging", must be hedged ("job posts suggest", "appears to").
Never mention individual employees. Never invent customers, metrics or outcomes.
TASK
1. summary: exactly 2 paragraphs, each 2-3 sentences.
   Paragraph 1 = how they build: dominant languages, cloud/infrastructure, build and CI setup.
   Paragraph 2 = how actively they are building and what is changing: hiring, platform roles, CI time, recent posts.
2. opener: ONE sentence, max 30 words, written to a {{persona}}. It must contain a specific noun or number from the chosen hypothesis evidence and connect it to that hypothesis''s friction. No greeting, no product name, no question mark.
3. hook_type: the chosen hypothesis''s hook type.
4. discovery: 3 short questions the AE should still ask on the call, about things the fact sheet does NOT answer.
BANNED words/phrases: {{banned}}.','Original writer prompt, moved out of code',true where not exists (select 1 from public.prompt_versions where role='writer');