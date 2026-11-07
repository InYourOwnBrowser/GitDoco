# GitDoco: Implementation Plan

Roadmap for the Code and Issues explorers and the two proposed new tabs. Each item was checked
against the code (and, where it relies on outside services, against those services) before it
went into this plan. Corrections to the original proposal are noted inline.

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Bug fixes and polish (Code + Issues explorers) | Done |
| 2 | Local `.zip` archives in the Code Explorer | Done |
| 3 | Discussions Explorer tab (`discussions.html`) | Done |
| 4 | Dependencies & licences tab (`deps.html`), slimmed down | Done |

Phases 3 and 4 are swapped from the original proposal: Discussions reuses most of the Issues
Explorer and fits the app's purpose (packing content for an AI); the licence auditor is larger,
riskier and further from that purpose.

---

## Phase 1: Bug fixes and polish (done)

- [x] Copy button keeps its target label ("Copy for Claude" etc.) after build, part changes and
      the "Copied!" reset, in both apps. Done through `updateCopyBtnLabel()`;
      `copyLabel()` in `js/ui-labels.js` is no longer used by the apps.
- [x] Issues budget meter judges split builds by the largest part and shows a pre-build estimate
      while selecting. The Code Explorer's big token number now also tracks the pre-build estimate.
- [x] Issues settings persist in `localStorage`; `?format`, `?commentScope` and `?includePrs`
      are read on load and written by "Share link". Redaction, comment scope and instructions use
      `cfg_issues_*` keys because the Issues page defaults to aggressive redaction.
- [x] Instruction edits and budget presets keep "Export NLP overview" mode.
- [x] `chunkIssuesOutput` no longer counts instructions against part 1.
- [x] Issues secret scan covers titles and labels, scans only included comments, skips
      overview-only exports and reports the location (`title`, `body L12`, `comment 3 L2`).
- [x] Loading a repo clears the previous output; "Select linked" follows `#refs` in comments.
- [x] Date filter uses local dates; "Recently updated" sort added. (Sorting newest/oldest by issue
      number was not a bug: GitHub assigns numbers in creation order.)
- [x] Wrap button starts in its "on" state in both apps (the preview starts wrapped).
- [x] Issue rows: `PR` tag and `MERGED` badge, `#number` links to GitHub, label pills filter by
      label, per-issue token estimate, "Deselect hidden" button, `/` focuses search.
- [ ] Not done: expandable issue-body preview in the list (larger UI change; optional).

## Phase 2: Local `.zip` archives in the Code Explorer (done)

- [x] `js/zip-loader.js`: zero-dependency reader.
  - Reads only the end of the file and the central directory up front (`File.slice`), then one
    entry at a time on demand. (The original proposal read the whole archive into memory.)
  - Store (method 0) and Deflate (method 8, `DecompressionStream('deflate-raw')`).
  - ZIP64 supported (archives over 4 GB or with more than 65,535 entries) rather than rejected.
  - Strips one shared top-level folder and macOS `__MACOSX/` metadata; marks symlinks so the
    existing filter drops them.
  - Clear `ZipError` messages for non-zip, truncated and password-protected files.
  - Output capped at each entry's declared size, so a malformed entry cannot expand without limit.
  - No repo/branch guessing from the file name (that split `my-repo.zip` into repo `my`,
    branch `repo`); the archive is named by its root folder or file name.
- [x] "Open .zip" button and drop-anywhere support in `index.html`; the source note says the
      file is read locally. The repo box, share link and Issues tab link are left untouched, so
      they never point at a made-up `local/<repo>` GitHub repo.
- [x] `js/app.js`: one `loadSource(zipArchive)` pipeline for GitHub and zip; zip reads skip the
      network and request throttling. Secret scanning, redaction, minifying, chunking and the
      budget meter are unchanged.
- [x] Output names a zip by archive (`<repository>my-repo-main</repository>`,
      `<source>local archive my-repo-main.zip</source>`) with no branch or GitHub URL.
- [x] Tests: `tests/zip-loader.test.js` builds zips in memory and covers parsing, root stripping,
      symlinks, `__MACOSX`, errors, the expansion cap, redaction and formatter output.

## Phase 3: Discussions Explorer (done)

Checked against GitHub's published API description and GraphQL schema: there is **no
documented REST API** for repository discussions (the REST paths respond but are absent from
GitHub's API description). GraphQL is the official route and always needs a token.

- [x] `js/github-discussions-api.js`
  - With a token: GraphQL. Lists 100 discussions per request; fetches comment threads (replies,
    accepted answer, hidden comments dropped) for 10 discussions per request, paging long
    threads. Queries validated against GitHub's published schema.
  - Without a token: the undocumented REST endpoints, read using the `discussion` schema GitHub
    publishes for webhooks; replies grouped by `parent_id`, the answer matched from
    `answer_html_url`. The page says so and recommends a token.
  - Clear errors for Discussions turned off (410 / `hasDiscussionsEnabled: false`), not found,
    rate limits and a missing token.
- [x] `discussions.html` + `js/discussions-app.js`: the Issues Explorer controller runs in a
      discussions mode instead of a second copy of it. Category filter and clickable category
      pills, answered / unanswered filter, upvotes, "answered" badge, comment scopes
      `Question only` / `Answer` / `Answer + maintainers` / `Full thread`, settings saved under
      `cfg_discussions_*`.
- [x] Formatters: `kind: 'discussions'` gives discussion wording plus category, answered,
      upvotes, `accepted_answer` and `reply_to` markers in all four formats. Issue output is
      unchanged.
- [x] "Discussions" tab on every page (`js/nav.js`).
- [x] Tests: `tests/discussions.test.js` (API client, scopes, formatters) and
      `tests/e2e/discussions-flow.test.mjs` (GraphQL and REST flows) against a fake GitHub.
- [ ] Not verified against live GitHub data: this environment could not call the GitHub API
      for other repositories. Try it on a public repo with Discussions (e.g. `whitphx/stlite`),
      with and without a token.

## Phase 4: Dependencies & licences (`deps.html`) (done)

The original proposal was a full licence-compatibility auditor. Problems found, and how the
built version handles them:

- "Conflict" verdicts are legal judgements that depend on how a package is used (linking,
  distribution, hosted service). **Built:** packages are grouped for review (permissive / weak
  copyleft / strong copyleft / restricted / unknown) with "review" wording and a not-legal-advice
  note in the page and in every output; no "compatible" or "conflict" verdicts.
- Classification errors in the proposal. **Built:** SSPL, BUSL, Elastic, PolyForm and
  CC-BY-NC/ND are "restricted"; EUPL is strong copyleft; `-only` / `-or-later` are recognised
  (and noted); linking exceptions such as Classpath move GPL to weak copyleft; `AND` takes the
  strictest part, `OR` the easiest known option.
- GitHub's SBOM endpoint. **Not used:** its synchronous export closes on 13 November 2026, and the
  replacement is an asynchronous job that redirects to a temporary download URL, which could not
  be tested from here. Its licence data is also often `NOASSERTION`.
- Reading `pyproject.toml` / `Cargo.toml` needs a TOML parser. **Built:** narrow line-based
  readers for the dependency sections only (PEP 621, Poetry, Cargo tables), no library.
- `api.deps.dev` allows browser requests. **Built:** it supplies licences, known security
  advisories and transitive dependency graphs (npm, PyPI, Cargo). Its stable v3 GET endpoints
  are used; the experimental batch endpoint is not (its CORS preflight fails for JSON POSTs).

What was built:

- [x] `js/manifest-parsers.js`: package.json, requirements*.txt, pyproject.toml, go.mod,
      Cargo.toml; skips vendored, hidden and (optionally) example/test/docs folders, local and VCS
      dependencies, and the repository's own workspace packages.
- [x] `js/license-classify.js`: SPDX expression parser and grouping, LICENSE-file detection for
      `.zip` sources.
- [x] `js/deps-api.js`: GitHub repo licence, tree and manifests, or a local `.zip`; deps.dev
      lookups with caching, retries, a concurrency limit and a lookup limit per run (now 5,000, most important packages first, with "Check the remaining" for the rest). Ranges are checked
      at their lowest version (or the latest release when unpinned), and the output says so.
- [x] `deps.html` + `js/deps-app.js`: group pills, ecosystem / direct-transitive / advisories
      filters, dev and transitive toggles, target bar, instruction presets (review licences,
      attribution file, alternatives, advisories). The output contains the packages shown.
- [x] `js/deps-formatters.js`: report in the four formats, most-attention groups first;
      permissive packages can be listed one per line to save tokens.
- [x] "Dependencies" tab on every page; the header now fits four tabs on phones.
- [x] Tests: `tests/deps.test.js` and `tests/e2e/deps-flow.test.mjs`; checked live against
      deps.dev in a browser.

Possible follow-ups:

- [x] Lockfiles for exact installed versions (see Phase 8).
- [ ] More ecosystems deps.dev supports (Maven, NuGet, RubyGems).

---

## Phase 5: Links, your own topic, landing page (done)

- [x] Links out: issue and discussion rows ("#123 ↗"), files in the code tree (GitHub blob URL;
      none for local .zip), packages (registry page, deps.dev, advisories on GitHub or OSV). Built
      in `js/links.js`: fixed https hosts, every data-derived path segment encoded, branch names
      validated; links open in a new tab with `noopener noreferrer`.
- [x] Your own topic (`js/topic-search.js`): every word must appear (word variants count, matched
      at word starts), "quoted phrases" exactly; plus related threads by TF-IDF cosine similarity to
      the centroid of the direct matches (threshold 0.18, at most 50), marked "related" in the list.
- [x] Landing page `index.html` in TimeDoco's palette and type; the Code tool moved to
      `code.html` and old `index.html?repo=` links are forwarded. Screenshots in `assets/` use a
      fictional `example/webapp` repo. `_headers`, `robots.txt`, `sitemap.xml`, `favicon.svg`, and
      `scripts/build-site.mjs` (copies the site into `dist/`).

### Hosting recommendation: `gitdoco.timedoco.com`

A subdomain, deployed as its own Cloudflare Pages project from this repository, rather than
`timedoco.com/gitdoco`:

- **Isolation.** A path on timedoco.com shares the origin with TimeDoco's app, so GitDoco (which
  renders third-party repository content) would share localStorage/IndexedDB with users'
  timesheets. A subdomain is a separate origin.
- **Headers.** TimeDoco's `_headers` CSP (`connect-src 'self' https://cloudflareinsights.com`)
  would block GitHub and deps.dev; a path would need per-path overrides in TimeDoco's repo.
- **Deploys.** The two sites ship independently, with no changes to TimeDoco's Vite build.

Steps: Cloudflare Pages → Create project → connect this repo → build command
`node scripts/build-site.mjs`, output `dist` → Custom domains → `gitdoco.timedoco.com` (Cloudflare
adds the CNAME when timedoco.com is on Cloudflare DNS). Optionally link to it from TimeDoco's
footer or nav.

### Open decisions

- [ ] Name and address: "GitDoco" at `gitdoco.timedoco.com` are used in the page, canonical URL,
      sitemap and social image; change them in `index.html`, `robots.txt` and `sitemap.xml` if
      different.
- [x] `LICENSE` (MIT, In Your Own Browser) added, plus `fonts/OFL.txt` for the bundled IBM Plex fonts.
- [ ] Analytics: TimeDoco's marketing pages use Cloudflare Web Analytics; none is added here (the
      CSP would need `static.cloudflareinsights.com`).

## Phase 6: Privacy audit (done)

- [x] Nothing third-party is loaded; only GitHub and deps.dev are contacted, and only after the user
      acts (fixed: the Code/Issues/Discussions pages called GitHub's rate-limit API on open).
- [x] No cookies, IndexedDB, service worker or caches; localStorage holds settings, AI instructions
      and the last public repo only; the token is never stored. No `Referer` on any request.
- [x] `privacy.html` (notice + "Clear GitDoco data in this browser"), linked from the landing page.
- [x] `tests/privacy.test.js` guards these promises.
- [ ] Hosting: keep Cloudflare features that inject scripts off (see README, Deploying).

## Phase 7: Terms, notice before first contact, and planning for ads (done / planned)

- [x] `terms.html` (modelled on TimeDoco's terms): third-party services' own terms, user
      responsibility for content and tokens, best-effort secret hiding, no legal/security advice,
      warranty disclaimer, liability limit, MIT code licence, changes.
- [x] Privacy notice: "What GitDoco cannot control" (GitHub, deps.dev/Google, AI services, hosting,
      browser/extensions/network, linked sites) and "Changes" (consent before any analytics or ads).
- [x] One-time notice (`js/first-use.js`) before a tool first contacts GitHub or deps.dev: names
      the services, links Terms and Privacy, Continue stays disabled until "I accept" is ticked;
      Cancel/Escape send nothing. Remembered in `cfg_notice_accepted`; bump `NOTICE_VERSION` to ask
      everyone again after a material change. Local `.zip` in the Code tool skips it (no contact).

### If ads or analytics are added later

This is not a cookie/consent banner: GitDoco has nothing that needs consent today, and asking for
consent to nothing would be meaningless. When that changes:

1. **Use a certified consent platform (CMP)** rather than a home-made banner. Google requires a
   Google-certified CMP (IAB TCF) to serve AdSense/Ad Manager ads to users in the EEA, UK and
   Switzerland; Google's own "Privacy & messaging" CMP is free. Share one CMP across timedoco.com
   and GitDoco.
2. **Keep ads off the tool pages.** Third-party ad scripts on pages where users enter GitHub
   tokens and view private code could read both. Put ads only on the landing page, blog or FAQ,
   never on `code.html`, `issues.html`, `discussions.html` or `deps.html`.
3. **Nothing optional runs before consent**, and refusing is as easy as accepting.
4. **Update in the same change:** `privacy.html` (sections 1, 2, 8), the CSP in every page and
   `_headers`, `tests/privacy.test.js` (it will fail on purpose), and bump `NOTICE_VERSION`.
5. Cookieless analytics (e.g. Cloudflare Web Analytics, as on TimeDoco's marketing pages) usually
   needs no consent banner but must be disclosed in the privacy notice.

## Phase 8: Dependencies, accurate and actionable (done)

- [x] `js/lockfiles.js`: package-lock.json (v1-v3), yarn.lock (classic and Berry), pnpm-lock.yaml
      (v5-v9, multi-document), poetry.lock, uv.lock, Pipfile.lock, Cargo.lock. Checked against real
      lockfiles from npm/cli, React, Yarn Berry, Vite, Poetry, pydantic and ripgrep (package counts
      verified independently). Workspace members are kept as pass-through nodes so monorepos' whole
      trees are found; their dev dependencies are followed only with "Include dev".
- [x] Advisory titles and CVSS severity (deps.dev advisories), worst first; a "Security
      advisories" section in every report format; brief permissive lines keep their advisories.
- [x] Direct dependencies: latest version, outdated flag, and whether upgrading clears advisories.
- [x] Project health for direct dependencies: OpenSSF Scorecard, "Maintained" check, deprecated or
      yanked releases, and a recognised source-repo licence that disagrees with the registry.
- [x] "Show" filter: advisories, high/critical, outdated, health warnings.
- Known limit: Cargo.lock does not mark dev-only crates, so workspace members' dev crates are
  included for Rust projects.

## Phase 9: Dependencies, ready for a team (done)

- [x] Dependency paths ("why is this here?"): the shortest chain from a direct dependency (or a
      workspace member) to each transitive package, from lockfiles or the deps.dev graph; shown as
      "via a → b" and in every report format and export.
- [x] Licence policy (`js/license-policy.js`): allow / review / block per licence group, plus
      always-blocked and always-allowed licences and approved packages. Saved in the browser, or read
      from a committed `.gitdoco-policy.json` (which takes precedence and can be downloaded from the
      editor). SPDX OR picks the best option, AND the worst. Not legal advice.
- [x] Exports (`js/deps-export.js`): CSV (with formula-injection protection) and CycloneDX 1.5 JSON
      SBOM with purls, licences, scope, paths and vulnerabilities (validated against the official
      schema).
- [x] Compare (`js/deps-compare.js`): a branch, tag, commit or pull request (including forks)
      against the base; added, updated and removed packages, new advisories and new policy findings,
      as badges, a "Changed" filter, and a comparison section first in every report format.
      `?compare=` is kept in share links.

Next candidates: more ecosystems (.NET, Ruby, Maven), a CI-friendly mode that fails on new policy
findings, and SPDX (tag-value or JSON) as a second SBOM format.

## Phase 10: Usability and polish (done)

- [x] Landing page: each tool card opens with its own icon, colour, large title and one-line purpose.
- [x] Page intros say plainly that public repos need no token, and offer "add a GitHub token" (and
      Open .zip on Code and Dependencies) for private repos. The Issues intro was a copy of Code's.
- [x] Status bar (`js/ui-status.js`): shown as soon as anything loads (it was hidden before the
      first load), with a spinner, the current step, and a progress bar that slides when the total is
      unknown instead of showing a made-up percentage (it used to stop at e.g. 3% for 10 of "up to
      300"). It completes and hides when done, and the button that started the work spins.
- [x] Topic clustering says when it starts ("Finding topics…") and when it is done ("Found 5 topics
      and 14 common phrases"); a background result never overwrites a running build's status.
- [x] Desktop layout: the panes fill the window and scroll inside, so Build context is always on
      screen; the header and status bar stay put (`overflow-x: clip`, not `hidden`, which broke
      `position: sticky`). Sections are cards on a grey background so panes no longer blend.
- [x] Labels: "Wrap lines" is a toggle in the preview toolbar (it looked like a primary action),
      "Activity log", "Expand all", tooltips on Share link and Download, consistent step names.
- [x] Dark mode: text on blue and red fills is dark, not white (contrast was about 2.5:1).
- [x] Empty results explain themselves ("No issues found in o/r. It may only have pull requests.")
      with a one-click fix, instead of "Loaded 0 issues. No clear topics found".
- [x] Dependencies: nothing is dropped at a package limit any more. Every package is listed; up to
      5,000 are looked up per run, most important first, and "Check the remaining N" does the rest.
- [x] Page titles and descriptions name GitDoco; a 404 page; the status line is announced to screen
      readers; toasts sit above the status bar; the output header wraps on phones.


## Phase 11: Focus and the GitHub URL shortcut (done)

- [x] Landing page leads with the two tools with least competition: "Check any GitHub repo's licenses
      and security, and triage its issues with your AI". "Check dependencies" and "Triage issues"
      are the main actions; cards and tool tabs run Dependencies, Issues, Discussions, Code.
- [x] GitHub URL shortcut (`js/repo-route.js`, `404.html`, `js/not-found.js`): swap `github.com` for
      GitDoco's domain. `/issues`, `/pulls`, `/discussions`, `/tree/...` open the matching tool; a pull
      request opens its dependency changes; a bare `/owner/repo` offers a choice. Links carry `go=1`
      so the tool starts loading (the first-use notice still comes first), and `go` is then removed
      from the address bar.
- Later: a GitHub Action that fails a pull request on new policy findings or advisories; a scheduled
  live check against large public repositories (would have caught the 422 pagination change).

## Phase 12: Results first, and reports for people (done)

- [x] After a load the repo bar shrinks to one line and the page scrolls to the results.
- [x] Dependencies: clicking a summary count (advisories, high/critical, outdated, health warnings,
      changed, blocked, to review) filters the list; clicking it again shows everything.
- [x] After Copy: "Copied. Now paste it into Claude." with a link that opens the chosen AI (nothing is
      sent to it), and part-by-part guidance for split output.
- [x] Keyboard shortcuts: Ctrl/Cmd+Enter for the next step, Ctrl/Cmd+Shift+Enter to copy
      (Ctrl+Shift+C would clash with browser developer tools).
- [x] Dependencies exports a printable HTML report (summary cards, policy findings, advisories,
      licenses, every package; no scripts, everything escaped) and `THIRD_PARTY_NOTICES.md`
      (runtime packages by license, links to license texts, and a reminder that copyright lines
      and full license texts must come from each package).

## Hosting and repository move

GitDoco moved to github.com/InYourOwnBrowser/GitDoco (from LukeAFullard/GitHub-tools, with its full
history), and its links (footer, feedback, licence, "Report a problem") point there. Next: deploy to
Cloudflare Pages on its own domain, then check one shortcut link (`/owner/repo`) on the live site.
