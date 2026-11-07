# GitDoco: Code, Issues, Discussions & Dependencies for your AI

A zero-install, 100% client-side web application that fetches, filters, cleans, and formats source code and issue threads from any public or private GitHub repository into an LLM-ready context file (Claude XML, Markdown, Generic XML, or JSON).

## Features

- **100% Client-Side Privacy:** Direct browser-to-GitHub API connection. Personal Access Tokens (PATs) and fine-grained PATs (`github_pat_`) remain strictly in memory.
- **Local `.zip` Archives (no token needed):** Click **Open .zip** or drop a repository `.zip` (e.g. GitHub's "Download ZIP") anywhere on the Code page. The archive is read in your browser and never uploaded: only its file list is read up front, and each selected file is unzipped on demand. Supports Deflate and Store compression and ZIP64 (very large archives); password-protected archives are not supported.
- **Landing page** (`index.html`) with a quick start; the Code tool is `code.html` (old `index.html?repo=...` links are forwarded).
- **Links out:** every issue and discussion row links to the thread on GitHub, every file in the code tree to the file on GitHub, and every package to its registry page (npm, PyPI, pkg.go.dev, crates.io), its deps.dev page and its security advisories.
- **Your own topic:** in Issues and Discussions, type a topic (words or an exact "phrase") to filter to the threads that mention it, plus related threads that discuss the same thing in other words (TF-IDF similarity). Related ones are marked.
- **Four Tools:** Switch between **Code Packer** (source tree packaging), **Issues Explorer** (issue thread triage & context packaging), **Discussions Explorer** (GitHub Discussions Q&A and ideas) and **Dependencies** (dependency licenses and advisories).
- **Dependencies:** Reads `package.json`, `requirements*.txt`, `pyproject.toml`, `Pipfile`, `go.mod` and `Cargo.toml` from a GitHub repo or a local `.zip` (with exact versions and the real dependency tree from `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `poetry.lock`, `uv.lock`, `Pipfile.lock` or `Cargo.lock` when present, including workspace members), looks up each package's license, known security advisories and (for npm, PyPI and Cargo) transitive dependencies on [deps.dev](https://deps.dev), and groups licenses for review: permissive, weak copyleft, strong copyleft, restricted (source-available or non-commercial) and unknown. Advisories show their severity (CVSS) and title; direct dependencies show whether they are outdated, whether upgrading clears their advisories, and project health (OpenSSF Scorecard, maintenance activity, deprecated or yanked releases). The groups are a guide for review, not legal advice. Package names and versions are sent to deps.dev; nothing else is. It also explains why each transitive package is there (the path from a direct dependency), applies a **license policy** (allow / review / block per group, with allow and block lists, saved in the browser or committed as `.gitdoco-policy.json`), **compares** a branch, tag, commit or pull request with its base (added, updated and removed packages, new advisories, new policy findings), and **exports** a printable HTML report (for readers who don't use AI), a `THIRD_PARTY_NOTICES.md` attribution file, CSV or a CycloneDX 1.5 SBOM. Clicking a count in the summary (advisories, outdated, blocked, ...) filters the list to those packages. A **dependency graph** (the Graph button) shows who depends on whom, coloured by license group with advisories marked: search, pan and zoom, expand and collapse, "Problems only" (the paths that lead to flagged packages), and a details panel with each package's license, advisories and why it is here. It can be shared from a README: `gitdoco.timedoco.com/owner/repo/graph` opens the live graph, and the graph also downloads as a static SVG picture or as one self-contained interactive HTML page for GitHub Pages (it loads nothing and its Content-Security-Policy allows only its own, hashed script). Not supported yet: Maven, Gradle, Ruby, PHP, .NET, Swift and Dart (the report warns when it finds their manifests). It never sees code copied into the repo, git submodules or system/container packages, and only advisories known to deps.dev are listed.
- **Discussions Explorer:** Filter by category and by answered / unanswered questions, then pack the question only, the accepted answer only, the answer plus the author's and maintainers' replies, or the full thread. Accepted answers and threaded replies are marked in every output format.
- **GitHub request budget:** without a token GitHub allows 60 requests an hour, and fetching issue comments usually costs one request per issue (Discussions with a token fetch ten per request). The comment hint above Build turns amber when a fetch would take a big share of that and red when it needs more than is left; Build then stops and asks (add a token, select fewer, or fetch anyway) instead of spending the rest of the hour on a partial result. The requests-left counter is always shown when there is no token.
- **Issues and Discussions map:** the Map button shows how the loaded threads link to each other: `#number` references (solid lines, from bodies and any comments already loaded) and very similar wording (dashed, possible duplicates), coloured by topic, sized by comments and reactions, with closed threads hollow and pull requests square. Search by number or title, hide either kind of link, and select a thread or its whole connected group for the AI output. Two more tabs: **Phrases** (the phrases that recur across threads, linked when they appear in the same threads; click one to list its threads, filter the list to them or select them) and **Timeline** (new threads per week, month or quarter, stacked by topic, with hover details, a table view, and click-to-list). Topic colours come from a palette checked for colour-blind separation in light and dark mode, and every legend is clickable to highlight one topic. None of this makes extra requests: it uses the threads and topics already loaded.
  - **With a token** it uses GitHub's official GraphQL API (about 10 discussion threads per request). For public repos a token with no permissions is enough.
  - **Without a token** it falls back to GitHub's REST discussions endpoints. These are not in GitHub's published API documentation, so they may change without notice.
- **Interactive File Selection & Issue Filtering:**
  - **Code Packer:** Interactive directory tree to select or deselect files and folders before fetching contents.
  - **Issues Explorer:** Multi-dimensional filters (state, labels, dates, comment counts, search, and cross-referenced `#refs`).
- **NLP Topic Clustering & N-Grams:** Client-side Web Worker powered TF-IDF cosine K-Means topic clustering and bigram/trigram phrase extraction for issues triage.
- **Noise Cleanup & Sanitization:** Automatically strips bot comments, low-signal replies ("+1", "me too"), images/base64 attachments, template boilerplate, and truncates massive log traces.
- **Context Chunking & Token Splitting:** Automatically splits large output context bundles into sequential multi-part chunks when exceeding a specified token limit (e.g. 100k tokens).
- **Background Web Worker Tokenization:** Offloads BPE token estimation to a Web Worker thread for seamless background processing.
- **Code Minification & Whitespace Stripping:** Optional code minification (Basic: whitespace & blank line cleanup; Aggressive: language-aware comment removal and full blank-line stripping) to maximize token efficiency.
- **Token Estimation:** BPE regex-based heuristic estimator matching Tiktoken / Claude token densities for immediate size feedback.
- **Multiple Output Formats:**
  - **Claude XML (`<documents>`)**: Optimized for Claude prompts.
  - **Markdown**: Standard Markdown code blocks.
  - **Generic XML**: Clean XML representation.
  - **JSON**: Structured JSON output.
- **API Limits & Pacing:** Uses the GitHub Git Trees API (recursive) to minimize rate consumption, respecting secondary rate limits with automatic `Retry-After` handling.
- **Zero Build Dependencies:** Built with vanilla HTML/CSS and native ES Modules. No bundlers or npm packages needed.

## Keyboard shortcuts

- **Ctrl/⌘ + Enter:** the next step: Load, or Build context once a repo is loaded.
- **Ctrl/⌘ + Shift + Enter:** Copy the output (then paste it into your AI; a hint links to it).
- **/** (Issues and Discussions): jump to the search box.

## GitHub URL shortcut

In any GitHub repository URL, replace `github.com` with GitDoco's domain to open it in the matching tool:

| GitDoco URL | Opens |
| --- | --- |
| `/owner/repo` | A page to choose a tool |
| `/owner/repo/issues`, `/pulls` | Issues (issues, or pull requests only) |
| `/owner/repo/pull/123` | Dependencies, comparing pull request #123 with its base |
| `/owner/repo/compare/main...feature` | Dependencies, comparing `feature` |
| `/owner/repo/discussions` | Discussions |
| `/owner/repo/tree/<branch>/<folder>`, `/blob/...`, `/commit/<sha>` | Code, at that branch and folder |
| `/owner/repo/network/dependencies`, `/security` | Dependencies |

The site is static: the host serves `404.html` for these paths (Cloudflare Pages, Netlify and GitHub Pages all do), and `js/not-found.js` sends the browser on. The tool then starts loading the repo, after the one-time notice on a first visit.

## Output Formats

| Format | Description | Extension |
| --- | --- | --- |
| **Claude XML** | Wrapped in `<documents>` and `<document>` tags with global repository metadata | `.xml` |
| **Markdown** | Structured Markdown header with code fences per file | `.md` |
| **Generic XML** | Minimalist XML structure with CDATA file wrappers | `.xml` |
| **JSON** | Machine-readable object with repo info, file tree, and content array | `.json` |

## Getting Started

### Local Development

Because modern web browsers enforce CORS restrictions on ES Modules over the `file://` protocol, serve the directory using any static HTTP server:

```bash
# Python 3
python -m http.server 8000

# Node.js
npx serve .
```

Navigate to `http://localhost:8000` in your web browser.

## Deploying

The site is static. `npm run build` copies only the public files (no tests or tooling) into `dist/`. It is served on Cloudflare Pages at `gitdoco.timedoco.com`; `_headers` sets the security headers, and Pages serves `404.html` for unknown paths, which the `/owner/repo` shortcut links rely on (so GitHub Pages is not supported).

Deployment is manual, through `.github/workflows/deploy.yml` (modelled on TimeDoco's):

- **Every push to `main` or `staging`** runs `verify` only: `npm test`, then `npm run build`. Nothing is published.
- **Deploy by hand:** Actions -> Deploy -> *Run workflow*, pick the branch, then the target:
  - `preview` from `staging` or `main` publishes to the `staging` branch of the Cloudflare Pages project (`https://staging.gitdoco.pages.dev`).
  - `production` from `main` only publishes to `gitdoco.timedoco.com`.
- The deploy job publishes the exact `dist/` that `verify` tested; it does not build again.

One-time setup:

1. The workflow creates the Pages project `gitdoco` (production branch `main`) on its first deploy, so nothing needs creating by hand. If you create it yourself in the dashboard, check it is a Pages project and not a Worker: a Worker with the same name will not work.
2. Add the custom domain `gitdoco.timedoco.com` to that project (Pages -> Custom domains).
3. In the GitHub repository, add the secrets `CLOUDFLARE_API_TOKEN` (permission: Cloudflare Pages: Edit) and `CLOUDFLARE_ACCOUNT_ID`.
4. Optionally create the `preview` and `production` Environments (Settings -> Environments) and add required reviewers to `production`.
5. Create a `staging` branch to deploy previews from.

After the first production deploy, open an `/owner/repo` link once to check the shortcut routing.

**Repository.** GitDoco lives at [github.com/InYourOwnBrowser/GitDoco](https://github.com/InYourOwnBrowser/GitDoco) (it began as LukeAFullard/GitHub-tools).

**Keep the host from adding scripts.** The privacy promises below depend on the site serving only its own files. In the Cloudflare dashboard, leave these off for the GitDoco project/zone: Web Analytics (automatic setup), Zaraz, Rocket Loader, Email Address Obfuscation and Browser Insights. Some of them inject scripts from the site's own origin (`/cdn-cgi/`), which the CSP's `script-src 'self'` would allow.

## Security & Privacy

- **Repository content is untrusted input to your AI.** Code, issues, discussions and package metadata can contain text written to steer an AI (prompt injection). Review the output before sending it, especially for private or sensitive work.
- **Secrets:** known token and key formats are hidden by default; generic passwords and tokens in code are flagged, and hidden only with "Strict". Files such as `.env`, private keys, key stores, `.npmrc`/`.netrc` and Terraform state are replaced entirely.
- **No tracking.** GitDoco sets no cookies and uses no analytics, third-party scripts, fonts or images; the IBM Plex fonts are bundled. Opening a page contacts nothing (except a GitDoco shortcut link that names a repo, which starts loading it); the browser only talks to `api.github.com`, `raw.githubusercontent.com` and (Dependencies tab) `api.deps.dev` once you use a tool, without a `Referer` header or cookies. `tests/privacy.test.js` guards all of this; `privacy.html` explains it to users and has a button that clears everything GitDoco stores.
- **TimeDoco banner:** a dismissible ticker on the seven main pages (`js/promo-banner.js`, `css/promo-banner.css`) links to timedoco.com. It loads nothing until clicked, stops for reduced-motion users, and remembers being closed under `cfg_promo_timedoco_closed` (cleared by "Clear GitDoco data"). To change the message or remove it, edit or delete that script and its two tags in each page.
- **First use:** before a tool first contacts GitHub or deps.dev, a one-time notice says who the browser will connect to and asks the user to accept the [Terms](terms.html) and acknowledge the [Privacy notice](privacy.html). Nothing is requested until they do.
- **What GitDoco cannot control** (GitHub, deps.dev, AI services, hosting logs, browser extensions) is spelled out in `privacy.html`.
- **Tokens** stay in memory and are only sent to `api.github.com`. Repository names loaded with a token are not remembered between visits.
- **Dependencies tab:** package names and versions (including a private repo's internal packages) are sent to deps.dev to look up licenses.
- **Content-Security-Policy:** every page sets a CSP that allows scripts only from the site itself and network requests only to GitHub and deps.dev. A `<meta>` tag cannot set everything, so if your host supports response headers, also send:

  ```
  Content-Security-Policy: frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  ```

## Repository Structure

```
.
├── index.html          # Landing page
├── privacy.html        # Privacy notice + "clear saved data" button
├── terms.html          # Terms of Use
├── 404.html            # "Page not found", with links to the tools
├── code.html           # Code Packer Web interface
├── _headers            # Security headers for Cloudflare Pages
├── .github/workflows/deploy.yml # Verify on push; manual deploy to Cloudflare Pages
├── scripts/build-site.mjs # Copies the public site into dist/ (no dependencies)
├── scripts/og-image.html  # Source of assets/og-image.jpg, the image shown when GitDoco is shared
├── issues.html         # GitHub Issues Explorer Web interface
├── discussions.html    # GitHub Discussions Explorer Web interface
├── deps.html           # Dependencies & licenses Web interface
├── css/
│   ├── issues.css      # Issues explorer & mode switcher UI styling
│   └── style.css       # Clean, modern UI styling
└── js/
    ├── app.js          # Core Code Packer controller and UI event wiring
    ├── config.js       # Global constants, default ignore lists, API endpoints
    ├── first-use.js    # One-time notice before the first request to GitHub / deps.dev
    ├── formatters.js   # Code LLM context output formatters (XML, MD, JSON)
    ├── github-api.js   # GitHub API fetch logic & rate-limit handling
    ├── deps-api.js     # Manifests from GitHub or .zip, deps.dev license/advisory/graph lookups
    ├── deps-app.js     # Controller for deps.html
    ├── deps-formatters.js # Dependency license report formatters (XML, MD, JSON)
    ├── discussions-app.js # Entry for discussions.html (runs issues-app.js in discussions mode)
    ├── github-discussions-api.js # Discussions client: GraphQL with a token, REST fallback without
    ├── github-issues-api.js # GitHub Issues & comments API client
    ├── issue-cleaner.js # Issue sanitization, bot filtering, log truncation engine
    ├── issue-formatters.js # Issue LLM context output formatters & chunking
    ├── issues-app.js   # Controller for issues.html and discussions.html
    ├── landing.js      # Landing page quick start and old-link forwarding
    ├── license-classify.js # SPDX expression parsing and license grouping
    ├── license-policy.js # License policy (allow / review / block) and .gitdoco-policy.json
    ├── links.js        # Safe outbound links (GitHub, registries, deps.dev, advisories)
    ├── nlp-text.js     # Shared text tokenizing for topics and topic search
    ├── not-found.js    # 404 page: GitHub-style repo paths open the matching tool
    ├── privacy.js      # Privacy page: lists and clears what GitDoco stores
    ├── repo-route.js   # GitHub URL shortcut: /owner/repo/issues, /pull/123, /tree/... -> tool links
    ├── deps-compare.js # Comparing two refs or a pull request
    ├── deps-export.js  # CSV and CycloneDX SBOM export
    ├── deps-report.js  # Printable HTML report and THIRD_PARTY_NOTICES.md
    ├── dep-graph.js    # Dependency graph: data, layout and the interactive SVG view (no imports, so it can be inlined)
    ├── dep-graph-export.js # Standalone graph page (HTML) and README snippets
    ├── issue-graph.js  # Issues/Discussions relationship map: links, force layout and view
    ├── phrase-map.js   # Phrase map: recurring phrases linked by shared threads
    ├── topic-timeline.js # Topic timeline: new threads per period, stacked by topic, with a table view
    ├── lockfiles.js    # Lockfile readers (npm, yarn, pnpm, poetry, uv, Pipfile, Cargo) -> dependency graphs
    ├── manifest-parsers.js # package.json, requirements, pyproject, Pipfile, go.mod, Cargo.toml readers
    ├── minifier.js     # Code minification & comment stripping engine
    ├── nlp.worker.js   # Web Worker for N-grams & TF-IDF Cosine K-Means clustering
    ├── secrets.js      # Client-side secret scanning and redaction engine
    ├── tokenizer.js    # BPE regex token estimator
    ├── tokenizer.worker.js # Web Worker background tokenization
    ├── topic-search.js # "Your own topic" search: direct matches plus related threads
    ├── tree.js         # File tree rendering & selection state management
    ├── ui-status.js    # Status bar: what is running, progress, spinners, "done" messages
    ├── ui-actions.js   # After-copy hint ("paste it into Claude") and keyboard shortcuts
    └── zip-loader.js   # Local .zip reader (central directory + on-demand Deflate)
```

## License

MIT; see [LICENSE](LICENSE). The bundled IBM Plex fonts are under the SIL Open Font License 1.1 ([fonts/OFL.txt](fonts/OFL.txt)); see [NOTICE](NOTICE). Keep `LICENSE` as the plain MIT text: anything added to it makes GitHub report the license as "Other".
