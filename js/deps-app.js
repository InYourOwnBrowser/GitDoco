/**
 * Controller for the Dependencies tab (deps.html): finds manifests in a GitHub repo or a local
 * .zip, looks up licenses on deps.dev, groups them for review and packs a report for an AI.
 */
import { parseRepoInput, isSafeBranchName } from './github-api.js';
import { parseCompareInput, diffPackages, summarizeDiff } from './deps-compare.js';
import { fetchPullRequest, fetchRepoInfo, fetchRepoManifests, readZipManifests, collectDirectDependencies, resolveLicenses, ROOT_KEY } from './deps-api.js';
import { toGraphData, mountGraph } from './dep-graph.js';
import { toStandaloneGraphHtml, readmeSnippets } from './dep-graph-export.js';
import { classifyLicense, guessLicenseFromText, LICENSE_GROUPS, GROUP_LABELS, GROUP_HINTS } from './license-classify.js';
import { buildDepsOutput, groupCounts, sortPackages, collectAdvisories } from './deps-formatters.js';

const SEVERITY_TEXT = { critical: 'critical', high: 'high', medium: 'medium', low: 'low', unknown: 'unrated' };
import { parseZipArchive } from './zip-loader.js';
import { escapeXml } from './formatters.js';
import { estimateTokensAsync } from './tokenizer.js';
import { TARGETS, detectTarget } from './targets.js';
import { switchTab } from './ui-tabs.js';
import { renderBanner } from './ui-banner.js';
import { buildTabHref, startFromShortcut } from './nav.js';
import { externalLink, registryUrl, depsDevUrl, advisoryUrl } from './links.js';
import { confirmFirstUse } from './first-use.js';
import * as status from './ui-status.js';
import { showCopyHint, hideCopyHint, initShortcuts } from './ui-actions.js';
import { toCsv, toCycloneDx } from './deps-export.js';
import { toHtmlReport, toThirdPartyNotices } from './deps-report.js';
import { unsupportedText } from './manifest-parsers.js';
import { DEFAULT_POLICY, normalizePolicy, parsePolicyFile, policyToFile, evaluatePolicy, describePolicy, POLICY_FILE } from './license-policy.js';

const $ = id => document.getElementById(id);
const dom = {
    repoUrl: $('repoUrl'), loadBtn: $('loadDepsBtn'), uploadZipBtn: $('uploadZipBtn'), zipFileInput: $('zipFileInput'),
    abortBtn: $('abortBtn'), optionsToggleBtn: $('optionsToggleBtn'), optionsToggleSummary: $('optionsToggleSummary'),
    optionsDrawer: $('optionsDrawer'), drawerDoneBtn: $('drawerDoneBtn'), drawerTokenLink: $('drawerTokenLink'),
    tokenPanel: $('tokenPanel'), tokenPanelMessage: $('tokenPanelMessage'), pat: $('pat'),
    repoInputError: $('repoInputError'), sourceNote: $('sourceNote'), exampleRepos: $('exampleRepos'),
    targetBar: $('targetBar'), formatField: $('formatField'), format: $('format'),
    includeTransitive: $('includeTransitive'), includeDev: $('includeDev'), skipExamples: $('skipExamples'),
    compactPermissive: $('compactPermissive'), aiInstructions: $('aiInstructions'),
    instructionsCharCount: $('instructionsCharCount'), clearInstructionsBtn: $('clearInstructionsBtn'),
    statPackages: $('statPackages'), repoLicenseText: $('repoLicenseText'), statTokens: $('statTokens'),
    targetBudgetDisplay: $('targetBudgetDisplay'), groupPills: $('groupPills'),
    depSearchInput: $('depSearchInput'), ecosystemFilter: $('ecosystemFilter'), relationFilter: $('relationFilter'),
    attentionFilter: $('attentionFilter'), repoPolicyNote: $('repoPolicyNote'), useRepoPolicy: $('useRepoPolicy'),
    useRepoPolicyLabel: $('useRepoPolicyLabel'), policyBlock: $('policyBlock'), policyAllow: $('policyAllow'),
    policyPackages: $('policyPackages'), policyResetBtn: $('policyResetBtn'), policyDownloadBtn: $('policyDownloadBtn'),
    policyEditor: $('policyEditor'), compareInput: $('compareInput'), exportBar: $('exportBar'), csvBtn: $('csvBtn'), sbomBtn: $('sbomBtn'), htmlReportBtn: $('htmlReportBtn'), noticesBtn: $('noticesBtn'), matchCount: $('matchCount'), depsEmptyState: $('depsEmptyState'),
    depsList: $('depsList'), outputScopeNote: $('outputScopeNote'),
    wrapToggleBtn: $('wrapToggleBtn'), copyBtn: $('copyBtn'), downloadBtn: $('downloadBtn'),
    warningBanner: $('warningBanner'), summaryCard: $('summaryCard'), outputEmptyState: $('outputEmptyState'),
    togglePreviewBtn: $('togglePreviewBtn'), previewArea: $('previewArea'),
    logHeader: $('logHeader'), logSummary: $('logSummary'), logToggleBtn: $('logToggleBtn'),
    progressTrack: $('progressTrack'), progressFill: $('progressFill'), log: $('log'),
    tabListBtn: $('tabListBtn'), tabOutputBtn: $('tabOutputBtn'), depsCard: $('depsCard'), outputCard: $('outputCard'),
    mobilePrimaryBtn: $('mobilePrimaryBtn'), step1: $('step1'), step2: $('step2'), step3: $('step3'),
    themeToggleBtn: $('themeToggleBtn'), shareUrlBtn: $('shareUrlBtn'), toastContainer: $('toastContainer'),
    graphBtn: $('graphBtn'), graphDialog: $('graphDialog'), graphDialogTitle: $('graphDialogTitle'), graphMount: $('graphMount'),
    graphShareBtn: $('graphShareBtn'), graphShare: $('graphShare'), graphCloseBtn: $('graphCloseBtn'), graphSnippet: $('graphSnippet'),
    graphCopyLinkBtn: $('graphCopyLinkBtn'), graphCopyImageBtn: $('graphCopyImageBtn'), graphSvgBtn: $('graphSvgBtn'), graphHtmlBtn: $('graphHtmlBtn'),
    tabCodeLink: $('tabCodeLink'), tabIssuesLink: $('tabIssuesLink'), tabDiscussionsLink: $('tabDiscussionsLink'), tabDepsLink: $('tabDepsLink')
};

const VALID_FORMATS = ['claude-xml', 'markdown', 'generic-xml', 'json'];
const DEFAULT_LOOKUPS = 5000;
const UNCHECKED_WARNING = /were not looked up on deps\.dev/;

let state = {
    appState: 'empty',          // 'empty' | 'loaded'
    targetKey: 'claude',
    budget: 200000,
    source: null,               // { kind: 'github', owner, repo } | { kind: 'zip', archive }
    repoName: '',
    sourceText: '',
    repoLicense: null,
    manifests: [],
    directDeps: [],
    locks: [],
    lockfiles: [],
    localPolicy: normalizePolicy(DEFAULT_POLICY),
    repoPolicy: null,      // from the repository's .gitdoco-policy.json, when present
    compare: null,         // { baseLabel, headLabel, baseManifests } when comparing two refs or a PR
    diff: null,
    packages: [],
    edges: [],             // [fromKey, toKey] from resolveLicenses, for the graph
    openGraphAfterLoad: false, // ?view=graph (from a /owner/repo/graph link)
    warnings: [],
    groupFilter: null,
    output: null,
    maxLookups: DEFAULT_LOOKUPS, // deps.dev lookups per run; "Check the remaining" raises it
    unchecked: 0
};
let controller = null;
let generation = 0;

// ------------------------------------------------------------------ small UI helpers

function showToast(message, type = 'info') {
    if (!dom.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    dom.toastContainer.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 250); }, 3500);
}

function log(msg) {
    if (dom.log) { dom.log.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`; dom.log.scrollTop = dom.log.scrollHeight; }
    if (dom.logSummary) dom.logSummary.textContent = msg.replace(/^\[[A-Z]+\]\s*/, '');
}

let depsStatus = 0;

/** Progress of the current load or update, shown in the status bar. */
function progress(percent, message) {
    status.progress(depsStatus, { percent, message });
}

function showError(msg) {
    if (!dom.repoInputError) return;
    dom.repoInputError.textContent = msg || '';
    dom.repoInputError.style.display = msg ? 'block' : 'none';
}

function showTokenPanel(message = '') {
    if (dom.tokenPanel) { dom.tokenPanel.hidden = false; dom.tokenPanel.removeAttribute('hidden'); }
    if (dom.tokenPanelMessage) dom.tokenPanelMessage.textContent = message;
}

function copyLabel() {
    const names = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
    return names[state.targetKey] ? `Copy for ${names[state.targetKey]}` : 'Copy';
}

function setAppState(next) {
    status.showResults(state.appState, next);
    state.appState = next;
    if (document.body) document.body.classList.toggle('is-empty', next === 'empty');
    if (dom.step1) dom.step1.classList.toggle('active', next === 'empty');
    if (dom.step2) dom.step2.classList.toggle('active', next === 'loaded');
    if (dom.mobilePrimaryBtn) dom.mobilePrimaryBtn.textContent = next === 'empty' ? 'Load dependencies' : copyLabel();
}

const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
};

// ------------------------------------------------------------------ settings & target

function updateSettingsSummary() {
    const target = TARGETS[state.targetKey] || TARGETS.custom;
    const parts = [target.label, dom.includeTransitive.checked ? 'direct + transitive' : 'direct only'];
    if (dom.includeDev.checked) parts.push('with dev');
    if (dom.optionsToggleSummary) dom.optionsToggleSummary.textContent = `Settings: ${parts.join(' · ')}`;
}

function saveSettings() {
    store.set('cfg_deps_includeTransitive', String(dom.includeTransitive.checked));
    store.set('cfg_deps_includeDev', String(dom.includeDev.checked));
    store.set('cfg_deps_skipExamples', String(dom.skipExamples.checked));
    store.set('cfg_deps_compactPermissive', String(dom.compactPermissive.checked));
    store.set('cfg_deps_aiInstructions', dom.aiInstructions.value);
    if (dom.format) store.set('cfg_format', dom.format.value);
}

// ------------------------------------------------------------------ license policy

const policyGroupSelects = () => [...document.querySelectorAll('select[data-policy-group]')];

function readPolicyEditor() {
    const groups = {};
    for (const sel of policyGroupSelects()) groups[sel.dataset.policyGroup] = sel.value;
    return normalizePolicy({ groups, blockLicenses: dom.policyBlock.value, allowLicenses: dom.policyAllow.value, allowPackages: dom.policyPackages.value });
}

function writePolicyEditor(policy) {
    for (const sel of policyGroupSelects()) sel.value = policy.groups[sel.dataset.policyGroup];
    dom.policyBlock.value = policy.blockLicenses.join(', ');
    dom.policyAllow.value = policy.allowLicenses.join(', ');
    dom.policyPackages.value = policy.allowPackages.join(', ');
}

const usingRepoPolicy = () => Boolean(state.repoPolicy && dom.useRepoPolicy.checked);
const effectivePolicy = () => (usingRepoPolicy() ? state.repoPolicy : state.localPolicy);
const policySource = () => (usingRepoPolicy() ? `Policy from the repository's ${POLICY_FILE}` : 'Policy from GitDoco settings');

function renderPolicyEditor() {
    const repo = Boolean(state.repoPolicy);
    dom.repoPolicyNote.hidden = !repo;
    dom.useRepoPolicyLabel.hidden = !repo;
    if (repo) dom.repoPolicyNote.textContent = `This repository has a ${POLICY_FILE}. ${usingRepoPolicy() ? 'It is used below (read-only).' : 'Your own policy is used instead.'}`;
    writePolicyEditor(effectivePolicy());
    const locked = usingRepoPolicy();
    for (const el of [...policyGroupSelects(), dom.policyBlock, dom.policyAllow, dom.policyPackages, dom.policyResetBtn]) el.disabled = locked;
}

function applyPolicy() {
    const policy = effectivePolicy();
    for (const p of state.packages) p.policy = evaluatePolicy(p, policy);
}

function onPolicyChanged() {
    applyPolicy();
    if (state.diff && state.diff.basePackages) {
        for (const p of state.diff.basePackages) p.policy = evaluatePolicy(p, effectivePolicy());
        state.diff = { ...diffPackages(state.diff.basePackages, state.packages), basePackages: state.diff.basePackages };
    }
    if (state.appState === 'loaded') renderAll();
}

function loadSettings() {
    const bool = (k, el) => { const v = store.get(k); if (v !== null && el) el.checked = v === 'true'; };
    bool('cfg_deps_includeTransitive', dom.includeTransitive);
    bool('cfg_deps_includeDev', dom.includeDev);
    bool('cfg_deps_skipExamples', dom.skipExamples);
    bool('cfg_deps_compactPermissive', dom.compactPermissive);
    try {
        const saved = store.get('cfg_deps_policy');
        if (saved) state.localPolicy = normalizePolicy(JSON.parse(saved));
    } catch (_) {}
    const inst = store.get('cfg_deps_aiInstructions');
    if (inst !== null) dom.aiInstructions.value = inst;
    const fmt = store.get('cfg_format');
    if (VALID_FORMATS.includes(fmt) && dom.format) dom.format.value = fmt;
    const budget = parseInt(store.get('cfg_budgetWindow') || '', 10);
    if (budget > 0) state.budget = budget;
    dom.instructionsCharCount.textContent = `${dom.aiInstructions.value.length} chars`;
}

export function applyTarget(key) {
    state.targetKey = key in TARGETS ? key : 'custom';
    const t = TARGETS[state.targetKey];
    if (state.targetKey !== 'custom' && t.format) {
        if (dom.format) dom.format.value = t.format;
        if (t.budget) state.budget = t.budget;
    }
    if (dom.formatField) dom.formatField.hidden = state.targetKey !== 'custom';
    if (dom.targetBar) {
        dom.targetBar.querySelectorAll('button[data-target]').forEach(b => {
            b.setAttribute('aria-pressed', b.dataset.target === state.targetKey ? 'true' : 'false');
        });
    }
    store.set('cfg_target', state.targetKey);
    updateSettingsSummary();
    if (dom.copyBtn) dom.copyBtn.textContent = copyLabel();
    rebuildOutput();
}

// ------------------------------------------------------------------ filtering & rendering

function filteredPackages() {
    const q = (dom.depSearchInput.value || '').trim().toLowerCase();
    const eco = dom.ecosystemFilter.value;
    const rel = dom.relationFilter.value;
    const attention = dom.attentionFilter.value;
    return state.packages.filter(p => {
        if (state.groupFilter && p.license.group !== state.groupFilter) return false;
        if (eco && p.ecosystem !== eco) return false;
        if (rel && p.relation !== rel) return false;
        if (attention === 'advisories' && !(p.advisories && p.advisories.length)) return false;
        if (attention === 'high' && !['critical', 'high'].includes(p.maxSeverity)) return false;
        if (attention === 'outdated' && !p.outdated) return false;
        if (attention === 'health' && !(p.healthFlags && p.healthFlags.length)) return false;
        if (attention === 'changed' && !p.change) return false;
        if (attention === 'blocked' && !(p.policy && p.policy.verdict === 'block')) return false;
        if (attention === 'policy-review' && !(p.policy && p.policy.verdict === 'review')) return false;
        if (q && !p.name.toLowerCase().includes(q) && !(p.license.expression || '').toLowerCase().includes(q)) return false;
        return true;
    });
}

function renderGroupPills() {
    const counts = groupCounts(state.packages);
    dom.groupPills.innerHTML = '';
    for (const g of LICENSE_GROUPS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `nlp-pill license-pill license-${g}${state.groupFilter === g ? ' active' : ''}`;
        btn.setAttribute('aria-pressed', state.groupFilter === g ? 'true' : 'false');
        btn.title = GROUP_HINTS[g];
        btn.innerHTML = `<span>${escapeXml(GROUP_LABELS[g])}</span><span class="nlp-pill-count">${counts[g]}</span>`;
        btn.disabled = counts[g] === 0;
        btn.addEventListener('click', () => {
            state.groupFilter = state.groupFilter === g ? null : g;
            renderAll();
        });
        dom.groupPills.appendChild(btn);
    }
}

function renderList() {
    const visible = sortPackages(filteredPackages());
    dom.matchCount.textContent = state.packages.length ? `${visible.length} / ${state.packages.length}` : '';
    if (state.packages.length === 0) {
        dom.depsEmptyState.style.display = 'flex';
        dom.depsList.style.display = 'none';
        return visible;
    }
    dom.depsEmptyState.style.display = 'none';
    dom.depsList.style.display = 'block';
    dom.depsList.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const p of visible.slice(0, 1000)) {
        const li = document.createElement('li');
        li.className = 'issue-item dep-item';
        const main = document.createElement('div');
        main.className = 'issue-main';
        const title = document.createElement('div');
        title.className = 'issue-title-row';
        const badge = document.createElement('span');
        badge.className = `issue-state-badge license-badge license-${p.license.group}`;
        badge.textContent = GROUP_LABELS[p.license.group];
        badge.title = GROUP_HINTS[p.license.group];
        const label = `${p.name}@${p.version || '?'}`;
        const regHref = registryUrl(p.ecosystem, p.name, p.version);
        let name;
        if (regHref) {
            name = externalLink(regHref, label, { title: `Open ${p.name} on its package registry`, className: 'issue-title ext-link dep-name-link' });
        } else {
            name = document.createElement('span');
            name.className = 'issue-title';
            name.textContent = label;
        }
        const lic = document.createElement('span');
        lic.className = 'issue-number';
        lic.textContent = p.license.expression || (p.status === 'not-found' ? 'not on deps.dev' : p.status === 'not-checked' ? 'not checked yet' : 'no license data');
        title.append(badge, name, lic);
        if (p.change) {
            const ch = document.createElement('span');
            ch.className = `issue-state-badge change-badge change-${p.change}`;
            ch.textContent = p.change === 'added' ? 'New' : `Updated from ${(p.changedFrom || []).join(', ')}`;
            ch.title = p.change === 'added' ? `Not in ${state.compare ? state.compare.baseLabel : 'the base'}` : `Was ${(p.changedFrom || []).join(', ')} in ${state.compare ? state.compare.baseLabel : 'the base'}`;
            title.appendChild(ch);
        }
        if (p.policy && p.policy.verdict !== 'allow') {
            const pol = document.createElement('span');
            pol.className = `issue-state-badge policy-badge policy-${p.policy.verdict}`;
            pol.textContent = p.policy.verdict === 'block' ? 'Blocked' : 'Review';
            pol.title = `${p.policy.verdict === 'block' ? 'Blocked' : 'Needs review'} by policy: ${p.policy.reason}`;
            title.appendChild(pol);
        }
        const ddHref = p.status !== 'not-found' ? depsDevUrl(p.ecosystem, p.name, p.version) : null;
        if (ddHref) title.appendChild(externalLink(ddHref, 'deps.dev', { title: `${p.name} on deps.dev: license, dependencies and advisories`, className: 'ext-link dep-source-link' }));
        const meta = document.createElement('div');
        meta.className = 'issue-meta-row';
        const bits = [p.ecosystem, p.relation + (p.dev ? ' (dev)' : '')];
        if (p.path && p.path.length > 2) bits.push(`via ${p.path.slice(0, -1).join(' → ')}`);
        else if (p.via && p.via.length) bits.push(`via ${p.via.slice(0, 2).join(', ')}${p.via.length > 2 ? '…' : ''}`);
        if (p.versionKind === 'range-min') bits.push('lowest version in range');
        if (p.versionKind === 'latest') bits.push('latest release');
        if (p.versionKind === 'locked') bits.push('locked');
        meta.innerHTML = bits.map(b => `<span>${escapeXml(b)}</span>`).join('<span>•</span>');
        if (p.advisories && p.advisories.length) {
            // One advisory opens directly; several open the deps.dev page, which lists them all.
            const sev = p.maxSeverity || 'unknown';
            const advText = `${p.advisories.length} advisor${p.advisories.length === 1 ? 'y' : 'ies'} · ${SEVERITY_TEXT[sev]}`;
            const advTitle = (p.advisoryDetails || []).slice(0, 10)
                .map(a => `${a.id} (${SEVERITY_TEXT[a.severity]}${a.score ? ` ${a.score}` : ''})${a.title ? `: ${a.title}` : ''}`).join('\n') || p.advisories.join(', ');
            const advHref = p.advisories.length === 1 ? advisoryUrl(p.advisories[0]) : depsDevUrl(p.ecosystem, p.name, p.version);
            const cls = `issue-label-pill dep-advisory sev-${sev}`;
            const adv = advHref
                ? externalLink(advHref, advText, { title: advTitle, className: `${cls} ext-link` })
                : Object.assign(document.createElement('span'), { className: cls, textContent: advText, title: advTitle });
            meta.appendChild(adv);
        }
        if (p.outdated && p.latest) {
            const up = document.createElement('span');
            up.className = 'issue-label-pill dep-outdated';
            up.textContent = p.upgradeClears ? `latest ${p.latest} · fixes ${p.upgradeClears}` : `latest ${p.latest}`;
            up.title = p.upgradeClears
                ? `Upgrading to ${p.latest} clears ${p.upgradeClears} of ${p.advisories.length} known advisor${p.advisories.length === 1 ? 'y' : 'ies'}`
                : `A newer release (${p.latest}) is available`;
            meta.appendChild(up);
        }
        for (const flag of p.healthFlags || []) {
            const h = document.createElement('span');
            h.className = 'issue-label-pill dep-health';
            h.textContent = flag;
            if (p.health && p.health.project) h.title = `Source project: ${p.health.project}${p.health.scorecard !== null ? `, OpenSSF Scorecard ${p.health.scorecard}/10` : ''}`;
            meta.appendChild(h);
        }
        for (const note of p.license.notes || []) {
            const n = document.createElement('span');
            n.className = 'issue-label-pill';
            n.textContent = note;
            meta.appendChild(n);
        }
        main.append(title, meta);
        li.appendChild(main);
        frag.appendChild(li);
    }
    dom.depsList.appendChild(frag);
    if (visible.length > 1000) {
        const more = document.createElement('li');
        more.className = 'field-helper';
        more.style.padding = '0.5rem 0.85rem';
        more.textContent = `Showing the first 1,000 of ${visible.length}. The output includes all of them.`;
        dom.depsList.appendChild(more);
    }
    return visible;
}

let outputGen = 0;
/** What the reports describe: the packages shown, with the load's context. */
function reportContext(visible = filteredPackages()) {
    return {
        repoName: state.repoName,
        source: state.sourceText,
        repoLicense: state.repoLicense,
        packages: visible,
        manifests: state.manifests,
        lockfiles: state.lockfiles,
        policy: { description: describePolicy(effectivePolicy(), policySource()) },
        comparison: state.diff ? { base: state.compare.baseLabel, head: state.compare.headLabel, diff: state.diff } : null,
        includeTransitive: dom.includeTransitive.checked,
        includeDev: dom.includeDev.checked,
        compactPermissive: dom.compactPermissive.checked,
        warnings: state.warnings,
        instructions: dom.aiInstructions.value
    };
}

async function rebuildOutput() {
    if (state.appState !== 'loaded') return;
    const myGen = ++outputGen;
    const visible = filteredPackages();
    const out = buildDepsOutput(dom.format.value, reportContext(visible));
    state.output = out;
    dom.previewArea.value = out.text.slice(0, 45000) + (out.text.length > 45000 ? '\n\n... [Truncated for preview] ...' : '');
    dom.outputEmptyState.style.display = 'none';
    if (dom.togglePreviewBtn) dom.togglePreviewBtn.style.display = 'inline-flex';
    dom.copyBtn.disabled = false;
    dom.downloadBtn.disabled = false;
    dom.copyBtn.textContent = copyLabel();
    const filtersOn = visible.length !== state.packages.length;
    dom.outputScopeNote.textContent = filtersOn
        ? `The output includes the ${visible.length} package${visible.length === 1 ? '' : 's'} shown (filters are on).`
        : `The output includes all ${visible.length} package${visible.length === 1 ? '' : 's'}.`;

    const tokens = await estimateTokensAsync(out.text);
    if (myGen !== outputGen) return;
    dom.statTokens.textContent = tokens.toLocaleString();
    dom.targetBudgetDisplay.textContent = tokens > state.budget
        ? `over the ${state.budget.toLocaleString()} target: filter or list permissive packages briefly`
        : `of ${state.budget.toLocaleString()}`;
    const counts = groupCounts(visible);
    const review = counts['strong-copyleft'] + counts['weak-copyleft'] + counts['restricted'];
    const sev = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
    for (const { a } of collectAdvisories(visible)) sev[a.severity]++;
    const totalAdv = Object.values(sev).reduce((x, y) => x + y, 0);
    const directs = visible.filter(p => p.relation === 'direct');
    const outdated = directs.filter(p => p.outdated).length;
    const fixable = directs.filter(p => p.upgradeClears).length;
    const health = directs.filter(p => p.healthFlags && p.healthFlags.length).length;
    const blocked = visible.filter(p => p.policy && p.policy.verdict === 'block').length;
    const toReview = visible.filter(p => p.policy && p.policy.verdict === 'review').length;
    // A part is plain text, or [text, filter]: clicking it filters the package list ("Show" menu).
    const f = (text, filter, count) => (count ? [text, filter] : text);
    dom.summaryCard.innerHTML = '';
    for (const parts of [
        [`${visible.length} package${visible.length === 1 ? '' : 's'} · about ${tokens.toLocaleString()} tokens`],
        [`${review} to review (copyleft or restricted) · ${counts.unknown} unknown`],
        totalAdv
            ? [f(`${totalAdv} security advisor${totalAdv === 1 ? 'y' : 'ies'}`, 'advisories', totalAdv), ': ',
                f(`${sev.critical} critical, ${sev.high} high`, 'high', sev.critical + sev.high), `, ${sev.medium} medium, ${sev.low + sev.unknown} low or unrated`]
            : ['No known security advisories'],
        ['Direct: ', f(`${outdated} outdated`, 'outdated', outdated), fixable ? ` (${fixable} fixed by upgrading)` : '', ' · ', f(`${health} with health warnings`, 'health', health)],
        [state.lockfiles.length
            ? `Exact versions from ${state.lockfiles.join(', ')}${state.packages.some(p => p.versionKind && p.versionKind !== 'locked') ? '; others estimated' : ''}`
            : 'No lockfile: versions estimated from manifest ranges'],
        ...(state.diff ? [[`Compared with ${state.compare.baseLabel}: `, f(summarizeDiff(state.diff), 'changed', state.diff.added.length + state.diff.updated.length)]] : []),
        ['Policy: ', f(`${blocked} blocked`, 'blocked', blocked), ' · ', f(`${toReview} to review`, 'policy-review', toReview), ` (${usingRepoPolicy() ? POLICY_FILE : 'your settings'})`]
    ]) {
        const el = document.createElement('div');
        for (const part of parts) {
            if (typeof part === 'string') { el.appendChild(document.createTextNode(part)); continue; }
            const [text, filter] = part;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'summary-filter';
            btn.textContent = text;
            const on = dom.attentionFilter.value === filter;
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
            btn.title = on ? 'Showing only these packages. Click to show all.' : 'Show only these packages';
            btn.addEventListener('click', () => applyAttentionFilter(on ? '' : filter));
            el.appendChild(btn);
        }
        dom.summaryCard.appendChild(el);
    }
    dom.summaryCard.hidden = false;
    dom.exportBar.hidden = false;
}

/** Sets the "Show" filter (from a summary line) and brings the package list into view. */
function applyAttentionFilter(value) {
    dom.attentionFilter.value = value;
    dom.attentionFilter.dispatchEvent(new Event('change'));
    if (value && dom.depsList && typeof dom.depsList.scrollIntoView === 'function') {
        const viewport = dom.depsList.closest ? dom.depsList.closest('.tree-viewport') : null;
        if (viewport) viewport.scrollTop = 0;
    }
}

function renderAll() {
    renderGroupPills();
    renderList();
    rebuildOutput();
}

function fillEcosystemFilter() {
    const ecos = [...new Set(state.packages.map(p => p.ecosystem))].sort();
    dom.ecosystemFilter.innerHTML = '<option value="">Ecosystem: All</option>'
        + ecos.map(e => `<option value="${escapeXml(e)}">${escapeXml(e)} (${state.packages.filter(p => p.ecosystem === e).length})</option>`).join('');
}

function resetView() {
    hideCopyHint();
    state.packages = [];
    state.edges = [];
    if (dom.graphBtn) dom.graphBtn.disabled = true;
    state.maxLookups = DEFAULT_LOOKUPS;
    state.unchecked = 0;
    state.compare = null;
    state.diff = null;
    state.locks = [];
    state.lockfiles = [];
    state.groupFilter = null;
    state.output = null;
    state.warnings = [];
    dom.statPackages.textContent = '0';
    dom.statTokens.textContent = '0';
    dom.repoLicenseText.textContent = '-';
    dom.previewArea.value = '';
    dom.previewArea.style.display = 'none';
    dom.copyBtn.disabled = true;
    dom.downloadBtn.disabled = true;
    dom.summaryCard.hidden = true;
    dom.exportBar.hidden = true;
    dom.outputEmptyState.style.display = 'flex';
    if (dom.togglePreviewBtn) {
        dom.togglePreviewBtn.style.display = 'none';
        dom.togglePreviewBtn.setAttribute('aria-expanded', 'false');
        dom.togglePreviewBtn.textContent = 'Show preview';
    }
    renderBanner(dom.warningBanner, []);
    renderGroupPills();
    renderList();
}

// ------------------------------------------------------------------ loading

async function load(source) {
    showError('');
    // First contact with GitHub / deps.dev: one-time notice.
    if (!(await confirmFirstUse(source.kind === 'zip' ? 'depsZip' : 'deps'))) return;
    if (controller) controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const myGen = ++generation;
    resetView();
    state.source = source;
    dom.loadBtn.disabled = true;
    dom.abortBtn.style.display = 'inline-flex';
    dom.log.textContent = '';
    const myStatus = depsStatus = status.begin(source.kind === 'zip'
        ? `Reading ${source.archive.fileName}…`
        : `Reading ${source.owner}/${source.repo} from GitHub…`, { button: source.kind === 'zip' ? dom.uploadZipBtn : dom.loadBtn, percent: 2 });
    const pat = dom.pat.value.trim();

    try {
        let manifestResult;
        if (source.kind === 'zip') {
            state.repoName = source.archive.label;
            state.sourceText = `local archive ${source.archive.fileName}`;
            state.repoLicense = null;
            dom.sourceNote.hidden = false;
            dom.sourceNote.textContent = `Reading ${source.archive.fileName} in your browser. Only package names and versions are sent to deps.dev.`;
            log(`[ZIP] Looking for manifests in ${source.archive.fileName}...`);
            if (dom.compareInput.value.trim()) state.warnings.push('Comparing is only available for GitHub repositories; the .zip was checked on its own.');
            manifestResult = await readZipManifests(source.archive, { skipExamples: dom.skipExamples.checked });
            const licFile = source.archive.treeNodes.find(n => /^(LICENSE|LICENCE|COPYING)(\.(md|txt))?$/i.test(n.path));
            if (licFile) {
                try {
                    const head = (await source.archive.readText(licFile.path)).slice(0, 2000);
                    state.repoLicense = guessLicenseFromText(head);
                } catch (_) {}
            }
        } else {
            dom.sourceNote.hidden = true;
            state.repoName = `${source.owner}/${source.repo}`;
            state.sourceText = `GitHub repository ${source.owner}/${source.repo}`;
            log(`[FETCH] Reading ${state.repoName} from GitHub...`);
            const info = await fetchRepoInfo(source.owner, source.repo, { pat, signal });
            state.repoLicense = info.license ? classifyLicense(info.license) : null;
            const compare = parseCompareInput(dom.compareInput.value, source);
            if (compare && compare.error) throw Object.assign(new Error(compare.error), { status: 400 });
            let head = { owner: source.owner, repo: source.repo, ref: info.branch };
            let base = null;
            if (compare && compare.kind === 'pr') {
                const pr = await fetchPullRequest(source.owner, source.repo, compare.number, { pat, signal });
                base = { owner: source.owner, repo: source.repo, ref: pr.baseRef };
                head = { owner: pr.headOwner, repo: pr.headRepo, ref: pr.headSha };
                state.compare = { baseLabel: `${pr.baseRef} (base of #${pr.number})`, headLabel: `pull request #${pr.number}${pr.title ? ` "${pr.title}"` : ''} (${pr.headLabel}, ${pr.headSha.slice(0, 7)})` };
                state.sourceText += ` (pull request #${pr.number} into ${pr.baseRef})`;
            } else if (compare && compare.kind === 'ref') {
                // The base is the default branch unless the page was opened with ?base= (a compare link).
                const baseRef = state.compareBase || info.branch;
                base = { owner: source.owner, repo: source.repo, ref: baseRef };
                head = { owner: source.owner, repo: source.repo, ref: compare.ref };
                state.compare = { baseLabel: baseRef, headLabel: compare.ref };
                state.sourceText += ` (${compare.ref}, compared with ${baseRef})`;
            } else {
                state.sourceText += ` (branch ${info.branch})`;
            }
            manifestResult = await fetchRepoManifests(head.owner, head.repo, { pat, branch: head.ref, isPrivate: info.isPrivate, skipExamples: dom.skipExamples.checked, signal });
            if (base) {
                log(`[FETCH] Reading ${base.ref} to compare...`);
                const baseResult = await fetchRepoManifests(base.owner, base.repo, { pat, branch: base.ref, isPrivate: info.isPrivate, skipExamples: dom.skipExamples.checked, signal });
                state.compare.baseManifests = baseResult.manifests;
            }
            // Remember the repo, but not a private one or one loaded with a token.
            if (!pat && !info.isPrivate) store.set('cfg_lastRepo', state.repoName);
            if (info.isPrivate) {
                state.warnings.push('Private repository: its package names and versions, including any internal packages, are sent to deps.dev (Google) to look up licenses.');
            }
        }
        if (myGen !== generation) return;
        progress(15);

        const { manifests, failed, skipped, treeTruncated, unsupported = [] } = manifestResult;
        if (unsupported.length) {
            state.warnings.push(unsupportedText(unsupported));
            log(`[WARN] Not checked (unsupported): ${unsupported.slice(0, 8).map(u => u.path).join(', ')}${unsupported.length > 8 ? '…' : ''}`);
        }
        const policyFile = manifests.find(m => m.path === POLICY_FILE);
        state.repoPolicy = null;
        if (policyFile) {
            try {
                state.repoPolicy = parsePolicyFile(policyFile.text);
                log(`[INFO] Using the repository's ${POLICY_FILE}.`);
            } catch (err) {
                state.warnings.push(`${err.message}; your own policy is used instead.`);
            }
        }
        renderPolicyEditor();
        state.manifests = manifests.filter(m => m.path !== POLICY_FILE).map(m => m.path);
        if (treeTruncated) state.warnings.push('GitHub returned a partial file list, so some manifests may be missing.');
        if (skipped > 0) state.warnings.push(`${skipped} more manifest file(s) were found but not read (limit 60).`);
        if (failed.length) state.warnings.push(`${failed.length} manifest file(s) could not be read: ${failed.map(f => f.path).slice(0, 5).join(', ')}.`);
        dom.repoLicenseText.textContent = state.repoLicense && state.repoLicense.expression ? state.repoLicense.expression : 'not detected';
        log(`[INFO] Found ${manifests.length} manifest(s): ${state.manifests.slice(0, 8).join(', ')}${manifests.length > 8 ? '…' : ''}`);
        if (manifests.every(m => m.path === POLICY_FILE)) {
            showToast(unsupported.length
                ? `${unsupportedText(unsupported)} Supported: npm, Python (requirements, pyproject.toml, Pipfile), Go and Rust.`
                : 'No supported manifest files found. Supported: package.json, requirements*.txt, pyproject.toml, Pipfile, go.mod, Cargo.toml (and their lockfiles).', 'warn');
            log('[WARN] No supported manifest files found.');
            setAppState('empty');
            return;
        }

        const { deps, locks, lockfilesUsed, parseErrors } = collectDirectDependencies(manifests);
        state.directDeps = deps;
        state.locks = locks;
        state.lockfiles = lockfilesUsed;
        if (lockfilesUsed.length) log(`[INFO] Exact versions from ${lockfilesUsed.join(', ')}.`);
        for (const e of parseErrors) state.warnings.push(`${e.path}: ${e.error}.`);
        log(`[INFO] ${deps.length} direct dependencies. Looking up licenses on deps.dev...`);
        await resolve(signal, myGen);
    } catch (err) {
        if (err.name === 'AbortError') { log('[CANCEL] Cancelled.'); return; }
        log(`[ERROR] ${err.message}`);
        showToast(err.message, 'error');
        if (err.status === 404 || err.status === 403 || err.status === 429) showTokenPanel(err.status === 404 ? 'If this is a private repo, add a token.' : '');
    } finally {
        status.end(myStatus);
        if (myGen === generation) {
            dom.loadBtn.disabled = false;
            dom.abortBtn.style.display = 'none';
        }
    }
}

const RESOLVE_WARNINGS = [/^Stopped at/, UNCHECKED_WARNING, /license lookup\(s\) failed/, /^Cargo\.lock does not mark/, /^Go: indirect modules/];

/** Warning banner; the "not looked up" warning gets a button that checks the rest. */
function renderWarnings() {
    renderBanner(dom.warningBanner, state.warnings.map(w => ({
        level: 'warn',
        text: w,
        action: UNCHECKED_WARNING.test(w) && state.unchecked > 0
            ? { label: `Check the remaining ${state.unchecked.toLocaleString()}`, onClick: checkRemaining }
            : null
    })));
}

/** Looks up the packages left out by the lookup limit (the ones already checked are cached). */
function checkRemaining() {
    state.maxLookups = Infinity;
    log(`[INFO] Checking the remaining ${state.unchecked} packages on deps.dev...`);
    rerunResolve();
}

/** Re-runs the deps.dev lookup with the current options (results are cached, so this is quick). */
async function resolve(signal, myGen) {
    const t0 = Date.now();
    const { packages, capped, unchecked, edges } = await resolveLicenses(state.directDeps, {
        locks: state.locks,
        maxLookups: state.maxLookups,
        includeTransitive: dom.includeTransitive.checked,
        includeDev: dom.includeDev.checked,
        signal,
        onProgress: (done, total) => progress(15 + (done / Math.max(total, 1)) * 85, `Looking up licenses and advisories on deps.dev… ${done} of ${total} packages`)
    });
    if (myGen !== generation) return;
    state.packages = packages;
    state.edges = edges || [];
    applyPolicy();
    state.diff = null;
    if (state.compare && state.compare.baseManifests) {
        log(`[INFO] Checking ${state.compare.baseLabel} for the comparison...`);
        const b = collectDirectDependencies(state.compare.baseManifests);
        const baseResult = await resolveLicenses(b.deps, {
            locks: b.locks, includeTransitive: dom.includeTransitive.checked, includeDev: dom.includeDev.checked, details: false, maxLookups: state.maxLookups, signal
        });
        if (myGen !== generation) return;
        const policy = effectivePolicy();
        for (const p of baseResult.packages) p.policy = evaluatePolicy(p, policy);
        state.diff = { ...diffPackages(baseResult.packages, state.packages), basePackages: baseResult.packages };
        log(`[INFO] Compared with ${state.compare.baseLabel}: ${summarizeDiff(state.diff)}.`);
    }
    // Warnings that depend on the lookup options are recomputed on every run.
    state.warnings = state.warnings.filter(w => !RESOLVE_WARNINGS.some(re => re.test(w)));
    state.unchecked = unchecked || 0;
    if (state.unchecked) {
        state.warnings.push(`${state.unchecked.toLocaleString()} of ${packages.length.toLocaleString()} packages were not looked up on deps.dev (limit ${DEFAULT_LOOKUPS.toLocaleString()} per run), so their licenses and advisories are not checked yet. Direct and runtime packages, and those closest to them, were checked first.`);
    } else if (capped) {
        state.warnings.push(`Stopped listing at ${packages.length.toLocaleString()} packages; the list is incomplete.`);
    }
    const failedLookups = packages.filter(p => p.status === 'error').length;
    if (failedLookups) state.warnings.push(`${failedLookups} license lookup(s) failed; they are listed as unknown.`);
    if (dom.includeTransitive.checked && !dom.includeDev.checked && state.lockfiles.some(l => /(^|\/)Cargo\.lock$/.test(l))) {
        state.warnings.push('Cargo.lock does not mark development-only crates, so some Rust dev dependencies may be included.');
    }
    if (dom.includeTransitive.checked && packages.some(p => p.ecosystem === 'go' && p.relation !== 'direct')) {
        state.warnings.push('Go: indirect modules come from go.mod (deps.dev has no Go dependency graph), so they show no "via" path; modules made before Go 1.17 may list fewer.');
    }
    progress(100);
    fillEcosystemFilter();
    dom.statPackages.textContent = packages.length.toLocaleString();
    renderWarnings();
    setAppState('loaded');
    renderAll();
    if (dom.graphBtn) dom.graphBtn.disabled = packages.length === 0;
    if (state.openGraphAfterLoad && packages.length) { state.openGraphAfterLoad = false; openGraph(); }
    log(`[SUCCESS] ${packages.length} packages checked in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
    showToast(`Checked ${packages.length} packages.`, 'info');
}

function rerunResolve() {
    if (state.appState !== 'loaded' || !state.directDeps.length) return;
    if (controller) controller.abort();
    controller = new AbortController();
    const myGen = ++generation;
    log('[INFO] Updating the package list...');
    const myStatus = depsStatus = status.begin('Updating the package list…', { percent: 0 });
    resolve(controller.signal, myGen).catch(err => {
        if (err.name !== 'AbortError') { log(`[ERROR] ${err.message}`); showToast(err.message, 'error'); }
    }).finally(() => status.end(myStatus));
}

async function openZip(file) {
    if (!file) return;
    if (!/\.zip$/i.test(file.name || '')) { showError('Choose a .zip file.'); return; }
    try {
        const archive = await parseZipArchive(file);
        await load({ kind: 'zip', archive });
    } catch (err) {
        showError(err.message || 'Could not read that .zip file.');
        showToast(err.message || 'Could not read that .zip file.', 'error');
    }
}

// ------------------------------------------------------------------ wiring

dom.loadBtn.addEventListener('click', () => {
    const info = parseRepoInput(dom.repoUrl.value);
    if (!info) { showError('Enter a repo as owner/name or a GitHub URL.'); return; }
    const compare = parseCompareInput(dom.compareInput.value, info);
    if (compare && compare.error) { showError(compare.error); return; }
    load({ kind: 'github', owner: info.owner, repo: info.repo });
});
dom.repoUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); dom.loadBtn.click(); } });
dom.compareInput.addEventListener('input', () => { state.compareBase = null; });
dom.compareInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); dom.loadBtn.click(); } });

// The repo form never submits (Enter is handled by the buttons); kept out of HTML for the CSP.
const sourceFormEl = document.getElementById('sourceForm');
if (sourceFormEl) sourceFormEl.addEventListener('submit', (e) => e.preventDefault());

dom.abortBtn.addEventListener('click', () => { if (controller) controller.abort(); });
dom.uploadZipBtn.addEventListener('click', () => dom.zipFileInput.click());
dom.zipFileInput.addEventListener('change', () => {
    const f = dom.zipFileInput.files && dom.zipFileInput.files[0];
    dom.zipFileInput.value = '';
    openZip(f);
});

dom.optionsToggleBtn.addEventListener('click', () => {
    const open = dom.optionsDrawer.classList.toggle('open');
    dom.optionsToggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
});
if (dom.drawerDoneBtn) dom.drawerDoneBtn.addEventListener('click', () => dom.optionsToggleBtn.click());
if (dom.drawerTokenLink) dom.drawerTokenLink.addEventListener('click', (e) => { e.preventDefault(); showTokenPanel(''); });

let logOpen = false;
dom.logToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    logOpen = !logOpen;
    dom.log.style.display = logOpen ? 'block' : 'none';
    dom.logToggleBtn.textContent = logOpen ? 'Hide log' : 'Activity log';
    dom.logToggleBtn.setAttribute('aria-expanded', logOpen ? 'true' : 'false');
});
status.bindLogHeader(dom.logHeader, dom.logToggleBtn);

if (dom.targetBar) {
    dom.targetBar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-target]');
        if (b) applyTarget(b.dataset.target);
    });
}
dom.format.addEventListener('change', () => {
    const detected = detectTarget(dom.format.value, state.budget);
    if (detected !== state.targetKey) applyTarget(detected);
    saveSettings();
    rebuildOutput();
});

[dom.includeTransitive, dom.includeDev].forEach(el => el.addEventListener('change', () => { saveSettings(); updateSettingsSummary(); rerunResolve(); }));
dom.skipExamples.addEventListener('change', () => {
    saveSettings();
    if (state.appState === 'loaded' && state.source) load(state.source);
});
dom.compactPermissive.addEventListener('change', () => { saveSettings(); rebuildOutput(); });

[...policyGroupSelects(), dom.policyBlock, dom.policyAllow, dom.policyPackages].forEach(el => {
    el.addEventListener('change', () => {
        if (usingRepoPolicy()) return;
        state.localPolicy = readPolicyEditor();
        store.set('cfg_deps_policy', JSON.stringify(state.localPolicy));
        onPolicyChanged();
    });
});
dom.useRepoPolicy.addEventListener('change', () => { renderPolicyEditor(); onPolicyChanged(); });
dom.policyResetBtn.addEventListener('click', () => {
    state.localPolicy = normalizePolicy(DEFAULT_POLICY);
    store.set('cfg_deps_policy', JSON.stringify(state.localPolicy));
    renderPolicyEditor();
    onPolicyChanged();
});
function saveFile(text, filename, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const fileBase = () => (state.repoName.split('/').pop() || 'repo').replace(/[^\w.-]+/g, '-');

dom.policyDownloadBtn.addEventListener('click', () => saveFile(policyToFile(effectivePolicy()), POLICY_FILE, 'application/json'));
dom.csvBtn.addEventListener('click', () => {
    saveFile(toCsv(sortPackages(filteredPackages())), `${fileBase()}-dependencies.csv`, 'text/csv');
    showToast('Downloaded the CSV.', 'info');
});
dom.sbomBtn.addEventListener('click', () => {
    const bom = toCycloneDx({ repoName: state.repoName, packages: sortPackages(filteredPackages()) });
    saveFile(JSON.stringify(bom, null, 2), `${fileBase()}-sbom.cdx.json`, 'application/vnd.cyclonedx+json');
    showToast('Downloaded the CycloneDX SBOM.', 'info');
});
dom.htmlReportBtn.addEventListener('click', () => {
    saveFile(toHtmlReport(reportContext()), `${fileBase()}-dependency-report.html`, 'text/html');
    showToast('Downloaded the report. Open it in a browser to read or print it.', 'info');
});
// ------------------------------------------------------------------ dependency graph

let graphView = null;

function graphData() {
    return toGraphData({
        packages: state.packages,
        edges: state.edges,
        rootKey: ROOT_KEY,
        label: state.repoName || 'project',
        groupLabels: GROUP_LABELS,
        links: p => ({ url: registryUrl(p.ecosystem, p.name, p.version), advisoryUrl: id => advisoryUrl(id) })
    });
}

/** "owner/name" when the packages came from a GitHub repository (not a .zip). */
const githubRepoName = () => (state.source && state.source.kind === 'github' ? `${state.source.owner}/${state.source.repo}` : '');

function openGraph() {
    if (!state.packages.length || !dom.graphDialog) return;
    const data = graphData();
    dom.graphDialogTitle.textContent = `Dependency graph: ${data.label}`;
    const snippets = readmeSnippets(githubRepoName());
    dom.graphSnippet.value = snippets ? snippets.image : 'README links need a repository loaded from GitHub. You can still download the interactive page or the picture.';
    dom.graphCopyLinkBtn.disabled = !snippets;
    dom.graphCopyImageBtn.disabled = !snippets;
    if (typeof dom.graphDialog.showModal === 'function') dom.graphDialog.showModal(); else dom.graphDialog.setAttribute('open', '');
    graphView = mountGraph(dom.graphMount, data);
}

function closeGraph() {
    if (graphView) { graphView.destroy(); graphView = null; }
    dom.graphShare.hidden = true;
    dom.graphShareBtn.setAttribute('aria-expanded', 'false');
}

async function copySnippet(kind) {
    const snippets = readmeSnippets(githubRepoName());
    if (!snippets) return;
    dom.graphSnippet.value = snippets[kind];
    try {
        await navigator.clipboard.writeText(snippets[kind]);
        showToast(kind === 'image' ? 'Copied. Commit the picture as docs/dependency-graph.svg, then paste this into your README.' : 'Copied. Paste it into your README.', 'info');
    } catch (_) {
        dom.graphSnippet.select();
    }
}

if (dom.graphDialog) {
    dom.graphBtn.addEventListener('click', openGraph);
    dom.graphCloseBtn.addEventListener('click', () => dom.graphDialog.close());
    dom.graphDialog.addEventListener('close', closeGraph);
    dom.graphShareBtn.addEventListener('click', () => {
        const open = dom.graphShare.hidden;
        dom.graphShare.hidden = !open;
        dom.graphShareBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    dom.graphCopyLinkBtn.addEventListener('click', () => copySnippet('link'));
    dom.graphCopyImageBtn.addEventListener('click', () => copySnippet('image'));
    dom.graphSvgBtn.addEventListener('click', () => {
        if (!graphView) return;
        saveFile(graphView.getSvgMarkup(), 'dependency-graph.svg', 'image/svg+xml');
        showToast('Downloaded the picture of the graph as shown now.', 'info');
    });
    dom.graphHtmlBtn.addEventListener('click', async () => {
        try {
            const [engineSource, css] = await Promise.all(['js/dep-graph.js', 'css/dep-graph.css'].map(async (path) => {
                const res = await fetch(path);
                if (!res.ok) throw new Error(`Could not read ${path}`);
                return res.text();
            }));
            const generated = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
            const html = await toStandaloneGraphHtml({ data: graphData(), engineSource, css, generated });
            saveFile(html, 'dependency-graph.html', 'text/html');
            showToast('Downloaded the interactive page. Open it in a browser, or publish it with GitHub Pages.', 'info');
        } catch (err) {
            showToast(`Could not build the page: ${err.message}`, 'error');
        }
    });
}

dom.noticesBtn.addEventListener('click', () => {
    saveFile(toThirdPartyNotices({ repoName: state.repoName, packages: filteredPackages() }), 'THIRD_PARTY_NOTICES.md', 'text/markdown');
    showToast('Downloaded THIRD_PARTY_NOTICES.md. Add each package\'s copyright and license text before publishing it.', 'info');
});

let instTimer = null;
dom.aiInstructions.addEventListener('input', () => {
    dom.instructionsCharCount.textContent = `${dom.aiInstructions.value.length} chars`;
    saveSettings();
    clearTimeout(instTimer);
    instTimer = setTimeout(rebuildOutput, 300);
});
dom.clearInstructionsBtn.addEventListener('click', () => {
    dom.aiInstructions.value = '';
    dom.instructionsCharCount.textContent = '0 chars';
    saveSettings();
    rebuildOutput();
});
document.querySelectorAll('.preset-buttons button[data-instruction]').forEach(btn => {
    btn.addEventListener('click', () => {
        dom.aiInstructions.value = btn.getAttribute('data-instruction');
        dom.instructionsCharCount.textContent = `${dom.aiInstructions.value.length} chars`;
        saveSettings();
        rebuildOutput();
    });
});

[dom.depSearchInput, dom.ecosystemFilter, dom.relationFilter, dom.attentionFilter].forEach(el => {
    el.addEventListener('input', () => { renderList(); rebuildOutput(); });
    el.addEventListener('change', () => { renderList(); rebuildOutput(); });
});

dom.copyBtn.addEventListener('click', async () => {
    if (!state.output) return;
    try {
        await navigator.clipboard.writeText(state.output.text);
        showToast('Copied the dependency report.', 'info');
        dom.copyBtn.textContent = 'Copied!';
        showCopyHint(dom.copyBtn, state.targetKey);
        setTimeout(() => { dom.copyBtn.textContent = copyLabel(); }, 2000);
    } catch (_) {
        showToast('Unable to copy automatically.', 'error');
    }
});
dom.downloadBtn.addEventListener('click', () => {
    if (!state.output) return;
    const blob = new Blob([state.output.text], { type: state.output.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(state.repoName.split('/').pop() || 'repo')}-dependencies.${state.output.ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
});
if (dom.togglePreviewBtn) {
    dom.togglePreviewBtn.addEventListener('click', () => {
        const open = dom.togglePreviewBtn.getAttribute('aria-expanded') !== 'true';
        dom.togglePreviewBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        dom.togglePreviewBtn.textContent = open ? 'Hide preview' : 'Show preview';
        dom.previewArea.style.display = open ? 'block' : 'none';
    });
}
dom.wrapToggleBtn.addEventListener('click', () => {
    const wrapped = dom.previewArea.classList.toggle('wrap');
    dom.wrapToggleBtn.setAttribute('aria-pressed', wrapped ? 'true' : 'false');
});

if (dom.tabListBtn && dom.tabOutputBtn) {
    dom.tabListBtn.addEventListener('click', () => switchTab(dom.tabListBtn, dom.tabOutputBtn, dom.depsCard, dom.outputCard));
    dom.tabOutputBtn.addEventListener('click', () => switchTab(dom.tabOutputBtn, dom.tabListBtn, dom.outputCard, dom.depsCard));
}
if (dom.mobilePrimaryBtn) {
    dom.mobilePrimaryBtn.addEventListener('click', () => {
        if (state.appState === 'empty') dom.loadBtn.click();
        else dom.copyBtn.click();
    });
}

if (dom.themeToggleBtn) {
    const saved = store.get('app_theme');
    if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
    dom.themeToggleBtn.addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme');
        const sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        const next = cur === 'dark' ? 'light' : cur === 'light' ? 'dark' : (sysDark ? 'light' : 'dark');
        document.documentElement.setAttribute('data-theme', next);
        store.set('app_theme', next);
    });
}
if (dom.shareUrlBtn) {
    dom.shareUrlBtn.addEventListener('click', async () => {
        const url = new URL(window.location.href.split('?')[0]);
        const repo = dom.repoUrl.value.trim();
        if (repo) url.searchParams.set('repo', repo);
        const compare = dom.compareInput.value.trim();
        if (compare) url.searchParams.set('compare', compare);
        if (compare && state.compareBase) url.searchParams.set('base', state.compareBase);
        try { await navigator.clipboard.writeText(url.toString()); showToast('Deep-link URL copied!', 'info'); } catch (_) {}
    });
}
[dom.tabCodeLink, dom.tabIssuesLink, dom.tabDiscussionsLink, dom.tabDepsLink].forEach(link => {
    if (!link) return;
    link.addEventListener('click', () => {
        const repo = dom.repoUrl.value;
        if (dom.tabCodeLink) dom.tabCodeLink.href = buildTabHref('code', repo);
        if (dom.tabIssuesLink) dom.tabIssuesLink.href = buildTabHref('issues', repo);
        if (dom.tabDiscussionsLink) dom.tabDiscussionsLink.href = buildTabHref('discussions', repo);
        if (dom.tabDepsLink) dom.tabDepsLink.href = buildTabHref('deps', repo);
    });
});
if (dom.exampleRepos) {
    dom.exampleRepos.addEventListener('click', (e) => {
        const b = e.target.closest('[data-repo]');
        if (!b) return;
        dom.repoUrl.value = b.dataset.repo;
        dom.loadBtn.click();
    });
}

// ------------------------------------------------------------------ startup

const params = new URLSearchParams(window.location.search);
if (params.get('repo')) dom.repoUrl.value = params.get('repo');
state.openGraphAfterLoad = params.get('view') === 'graph';
if (params.get('compare') && dom.compareInput) dom.compareInput.value = params.get('compare').slice(0, 300);
// ?base= (from a GitHub compare link): compare with that branch instead of the default one.
if (params.get('base') && isSafeBranchName(params.get('base'))) state.compareBase = params.get('base');
else { const last = store.get('cfg_lastRepo'); if (last && !dom.repoUrl.value) dom.repoUrl.value = last; }
loadSettings();
// ?format= wins (lands on "Custom"); else the target saved on any tab; else Claude.
if (VALID_FORMATS.includes(params.get('format'))) {
    dom.format.value = params.get('format');
    applyTarget('custom');
} else {
    const savedTarget = store.get('cfg_target');
    applyTarget(savedTarget && savedTarget in TARGETS ? savedTarget : 'claude');
}
resetView();
renderPolicyEditor();
setAppState('empty');
status.initTokenLinks(showTokenPanel);
startFromShortcut(dom.loadBtn, dom.repoUrl);
initShortcuts({ main: () => dom.loadBtn, copy: dom.copyBtn, mainButtons: [dom.loadBtn] });
