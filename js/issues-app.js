/**
 * Controller for the GitHub Issues Explorer (issues.html) and, in discussions mode, the
 * Discussions Explorer (discussions.html). discussions.html loads js/discussions-app.js, which
 * sets globalThis.__THREAD_EXPLORER_KIND__ = 'discussions' before importing this module.
 */
import { parseRepoInput, fetchRateLimit, sleep } from './github-api.js';
import { fetchIssuesManifest, fetchCommentsForIssues } from './github-issues-api.js';
import { fetchDiscussionsManifest, fetchCommentsForDiscussions, estimateDiscussionCommentCost } from './github-discussions-api.js';
import { processIssueThread, extractIssueReferences, filterIncludedComments } from './issue-cleaner.js';
import { toIssueGraphData, mountIssueGraph } from './issue-graph.js';
import { toPhraseData, mountPhraseMap } from './phrase-map.js';
import { toTimelineData, mountTopicTimeline } from './topic-timeline.js';
import { buildIssuesOutput, chunkIssuesOutput } from './issue-formatters.js';
import { escapeXml } from './formatters.js';
import { estimateTokens, estimateTokensAsync } from './tokenizer.js';
import { scanForSecrets } from './secrets.js';
import { switchTab } from './ui-tabs.js';
import { buildBannerItems, renderBanner } from './ui-banner.js';
import { TARGETS, detectTarget } from './targets.js';
import { buildSettingsSummary } from './settings-summary.js';
import { commentCostHint, quotaNote } from './comment-cost.js';
import { buildSummaryLines } from './ui-summary.js';
import { buildTabHref, startFromShortcut } from './nav.js';
import { externalLink, isGithubUrl } from './links.js';
import { searchTopic } from './topic-search.js';
import { confirmFirstUse } from './first-use.js';
import { begin, progress, end, isCurrent, initTokenLinks, bindLogHeader, showResults } from './ui-status.js';
import { showCopyHint, hideCopyHint, initShortcuts } from './ui-actions.js';

export const KIND = globalThis.__THREAD_EXPLORER_KIND__ === 'discussions' ? 'discussions' : 'issues';
const IS_DISCUSSIONS = KIND === 'discussions';
const W = IS_DISCUSSIONS
    ? { noun: 'discussions', Noun: 'Discussions', one: 'discussion', One: 'Discussion' }
    : { noun: 'issues', Noun: 'Issues', one: 'issue', One: 'Issue' };

let loadController = null;
let buildController = null;
let lastBuildSummaryOnly = false;
let lastFetchRateLimited = false;
let allIssues = [];
let selectedIssueNumbers = new Set();
let cachedCommentsByIssue = new Map();
let fetchFailuresMap = new Map();
let nlpResults = { clusters: [], ngrams: [], similarMap: {} };
let activeTopicFilter = null;
let currentRepoInfo = null;
let generatedChunks = [];
let activeChunkIndex = 0;
let packedOutputText = '';
let outputExt = 'xml';
let outputMime = 'application/xml';
let currentBudgetWindow = 200000;
let currentAppState = 'empty';
let currentTargetKey = 'claude';
let nlpWorker = null;
let buildGeneration = 0;
let inputDebounceTimer = null;

const dom = {
    heroBlock: document.getElementById('heroBlock'),
    exampleRepos: document.getElementById('exampleRepos'),
    tokenPanel: document.getElementById('tokenPanel'),
    tokenPanelMessage: document.getElementById('tokenPanelMessage'),
    drawerTokenLink: document.getElementById('drawerTokenLink'),
    tabCodeLink: document.getElementById('tabCodeLink'),
    tabIssuesLink: document.getElementById('tabIssuesLink'),
    tabDiscussionsLink: document.getElementById('tabDiscussionsLink'),
    tabDepsLink: document.getElementById('tabDepsLink'),
    categoryFilter: document.getElementById('categoryFilter'),
    branchTokenGroup: document.getElementById('branchTokenGroup'),
    repoUrl: document.getElementById('repoUrl'),
    switchToCodeLink: document.getElementById('switchToCodeLink'),
    maxIssuesLimit: document.getElementById('maxIssuesLimit'),
    includePrs: document.getElementById('includePrs'),
    pat: document.getElementById('pat'),
    loadIssuesBtn: document.getElementById('loadIssuesBtn'),
    abortBtn: document.getElementById('abortBtn'),
    optionsToggleBtn: document.getElementById('optionsToggleBtn'),
    optionsToggleSummary: document.getElementById('optionsToggleSummary'),
    optionsDrawer: document.getElementById('optionsDrawer'),
    drawerDoneBtn: document.getElementById('drawerDoneBtn'),
    repoInputError: document.getElementById('repoInputError'),
    rateBadge: document.getElementById('rateBadge'),
    quotaVal: document.getElementById('quotaVal'),
    quotaRemainingText: document.getElementById('quotaRemainingText'),
    resetVal: document.getElementById('resetVal'),
    budgetBanner: document.getElementById('budgetBanner'),
    budgetPresets: document.querySelector('.budget-presets'),
    workspacePanes: document.getElementById('workspacePanes'),
    logCard: document.getElementById('logCard'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    shareUrlBtn: document.getElementById('shareUrlBtn'),
    persistentWarningBanner: document.getElementById('persistentWarningBanner'),
    warningBannerText: document.getElementById('warningBannerText'),
    warningBannerTokenBtn: document.getElementById('warningBannerTokenBtn'),
    warningBannerRetryBtn: document.getElementById('warningBannerRetryBtn'),
    warningBannerDismissBtn: document.getElementById('warningBannerDismissBtn'),

    targetBar: document.getElementById('targetBar'),
    formatField: document.getElementById('formatField'),
    format: document.getElementById('format'),
    commentScope: document.getElementById('commentScope'),
    commentScopeBar: document.getElementById('commentScopeBar'),
    commentCostHint: document.getElementById('commentCostHint'),
    selectionSummary: document.getElementById('selectionSummary'),
    hiddenSelectedNote: document.getElementById('hiddenSelectedNote'),
    maxLogLines: document.getElementById('maxLogLines'),
    chunkLimitField: document.getElementById('chunkLimitField'),
    chunkLimit: document.getElementById('chunkLimit'),
    redactLevel: document.getElementById('redactLevel'),
    secretsControl: document.getElementById('secretsControl'),
    stripImages: document.getElementById('stripImages'),
    filterBots: document.getElementById('filterBots'),
    filterNoise: document.getElementById('filterNoise'),
    includeNlpSummary: document.getElementById('includeNlpSummary'),
    redactSecrets: document.getElementById('redactSecrets'),
    aggressiveRedact: document.getElementById('aggressiveRedact'),
    stripTemplates: document.getElementById('stripTemplates'),
    aiInstructions: document.getElementById('aiInstructions'),
    instructionsCharCount: document.getElementById('instructionsCharCount'),
    clearInstructionsBtn: document.getElementById('clearInstructionsBtn'),

    nlpBanner: document.getElementById('nlpBanner'),
    nlpMetaBadge: document.getElementById('nlpMetaBadge'),
    nlpBody: document.getElementById('nlpBody'),
    topicClustersContainer: document.getElementById('topicClustersContainer'),
    ngramsContainer: document.getElementById('ngramsContainer'),
    clearNlpFilterBtn: document.getElementById('clearNlpFilterBtn'),
    selectActiveTopicBtn: document.getElementById('selectActiveTopicBtn'),
    toggleNlpCollapseBtn: document.getElementById('toggleNlpCollapseBtn'),
    customTopicForm: document.getElementById('customTopicForm'),
    customTopicInput: document.getElementById('customTopicInput'),
    customTopicHint: document.getElementById('customTopicHint'),

    statTokens: document.getElementById('statTokens'),
    targetBudgetDisplay: document.getElementById('targetBudgetDisplay'),
    budgetFill: document.getElementById('budgetFill'),
    budgetStatusText: document.getElementById('budgetStatusText'),
    statChunks: document.getElementById('statChunks'),
    statIssues: document.getElementById('statIssues'),
    statComments: document.getElementById('statComments'),
    statChars: document.getElementById('statChars'),

    issuesCard: document.getElementById('issuesCard'),
    selectedTokensBadge: document.getElementById('selectedTokensBadge'),
    issueSearchInput: document.getElementById('issueSearchInput'),
    searchMatchCount: document.getElementById('searchMatchCount'),
    stateFilter: document.getElementById('stateFilter'),
    labelFilter: document.getElementById('labelFilter'),
    sortFilter: document.getElementById('sortFilter'),
    dateFromFilter: document.getElementById('dateFromFilter'),
    dateToFilter: document.getElementById('dateToFilter'),
    minCommentsFilter: document.getElementById('minCommentsFilter'),
    selectAllVisibleBtn: document.getElementById('selectAllVisibleBtn'),
    deselectAllBtn: document.getElementById('deselectAllBtn'),
    selectLinkedBtn: document.getElementById('selectLinkedBtn'),
    exportNlpOnlyBtn: document.getElementById('exportNlpOnlyBtn'),
    issuesEmptyState: document.getElementById('issuesEmptyState'),
    issuesListContainer: document.getElementById('issuesListContainer'),
    buildContextBtn: document.getElementById('buildContextBtn'),

    outputCard: document.getElementById('outputCard'),
    chunkSelectLabel: document.getElementById('chunkSelectLabel'),
    chunkSelect: document.getElementById('chunkSelect'),
    wrapToggleBtn: document.getElementById('wrapToggleBtn'),
    copyBtn: document.getElementById('copyBtn'),
    nextPartBtn: document.getElementById('nextPartBtn'),
    downloadBtn: document.getElementById('downloadBtn'),
    downloadAllBtn: document.getElementById('downloadAllBtn'),
    warningBanner: document.getElementById('warningBanner'),
    summaryCard: document.getElementById('summaryCard'),
    togglePreviewBtn: document.getElementById('togglePreviewBtn'),
    secretsWarningPanel: document.getElementById('secretsWarningPanel'),
    secretsWarningSummary: document.getElementById('secretsWarningSummary'),
    excludeAllSecretsBtn: document.getElementById('excludeAllSecretsBtn'),
    secretsTableBody: document.getElementById('secretsTableBody'),
    previewNotice: document.getElementById('previewNotice'),
    outputEmptyState: document.getElementById('outputEmptyState'),
    previewArea: document.getElementById('previewArea'),

    logHeader: document.getElementById('logHeader'),
    logSummary: document.getElementById('logSummary'),
    logToggleBtn: document.getElementById('logToggleBtn'),
    progressTrack: document.getElementById('progressTrack'),
    progressFill: document.getElementById('progressFill'),
    log: document.getElementById('log'),
    tabIssuesBtn: document.getElementById('tabIssuesBtn'),
    tabOutputBtn: document.getElementById('tabOutputBtn'),
    mobilePrimaryBtn: document.getElementById('mobilePrimaryBtn'),
    step1: document.getElementById('step1'),
    step2: document.getElementById('step2'),
    step3: document.getElementById('step3'),
    toastContainer: document.getElementById('toastContainer')
};

function showToast(message, type = 'info') {
    if (!dom.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    dom.toastContainer.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 250);
    }, 3500);
}

/** Adds a line to the activity log and, unless summary is false, shows it in the status bar. */
function log(msg, { summary = true } = {}) {
    if (dom.log) {
        dom.log.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
        dom.log.scrollTop = dom.log.scrollHeight;
    }
    if (summary && dom.logSummary) {
        dom.logSummary.textContent = msg.replace(/^\[[A-Z]+\]\s*/, '');
    }
}

// --- Token On Demand & Workspace Visibility ---
export function showTokenPanel(message = '') {
    if (dom.tokenPanel) {
        dom.tokenPanel.hidden = false;
        dom.tokenPanel.removeAttribute('hidden');
    }
    if (dom.tokenPanelMessage) {
        dom.tokenPanelMessage.textContent = message || '';
    }
}

// Keep backward compatibility alias if external or tests import showTokenField
export function showTokenField(reason = '') {
    showTokenPanel(reason);
}

function setAppState(state) {
    showResults(currentAppState, state);
    currentAppState = state;
    if (document.body) {
        document.body.classList.toggle('is-empty', state === 'empty');
    }
    if (dom.step1) dom.step1.classList.toggle('active', state === 'empty');
    if (dom.step2) dom.step2.classList.toggle('active', state === 'loaded');
    if (dom.step3) dom.step3.classList.toggle('active', state === 'built');

    if (dom.mobilePrimaryBtn) {
        dom.mobilePrimaryBtn.textContent = state === 'empty'
            ? `Load ${W.noun}`
            : state === 'loaded'
                ? 'Build context'
                : getCopyButtonLabel(currentTargetKey, activeChunkIndex, generatedChunks.length);
    }
}

function initTheme() {
    try {
        const savedTheme = localStorage.getItem('app_theme');
        if (savedTheme === 'dark' || savedTheme === 'light') {
            document.documentElement.setAttribute('data-theme', savedTheme);
        }
    } catch (_) {}
}
initTheme();

if (dom.themeToggleBtn) {
    dom.themeToggleBtn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        const isDarkSystem = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const next = current === 'dark' ? 'light' : current === 'light' ? 'dark' : (isDarkSystem ? 'light' : 'dark');
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('app_theme', next); } catch (_) {}
    });
}

if (dom.switchToCodeLink) {
    dom.switchToCodeLink.addEventListener('click', () => {
        const repoVal = dom.repoUrl ? dom.repoUrl.value.trim() : '';
        if (repoVal) {
            dom.switchToCodeLink.href = `code.html?repo=${encodeURIComponent(repoVal)}`;
        }
    });
}

// Navigation tab click listeners
[dom.tabCodeLink, dom.tabIssuesLink, dom.tabDiscussionsLink, dom.tabDepsLink].forEach(link => {
    if (link) {
        link.addEventListener('click', () => {
            const repoVal = dom.repoUrl ? dom.repoUrl.value : '';
            if (dom.tabCodeLink) dom.tabCodeLink.href = buildTabHref('code', repoVal);
            if (dom.tabIssuesLink) dom.tabIssuesLink.href = buildTabHref('issues', repoVal);
            if (dom.tabDiscussionsLink) dom.tabDiscussionsLink.href = buildTabHref('discussions', repoVal);
            if (dom.tabDepsLink) dom.tabDepsLink.href = buildTabHref('deps', repoVal);
        });
    }
});

let lastRateLimitRemaining = Infinity;

function showPersistentWarning(message, options = {}) {
    if (!dom.persistentWarningBanner) return;
    const { showTokenBtn = false, showRetryBtn = false, onRetry = null, retryLabel = 'Retry' } = options;
    if (dom.warningBannerText) dom.warningBannerText.textContent = message;
    if (dom.warningBannerTokenBtn) dom.warningBannerTokenBtn.style.display = showTokenBtn ? 'inline-block' : 'none';
    if (dom.warningBannerRetryBtn) {
        dom.warningBannerRetryBtn.style.display = showRetryBtn ? 'inline-block' : 'none';
        dom.warningBannerRetryBtn.textContent = retryLabel;
        dom.warningBannerRetryBtn.onclick = onRetry || null;
    }
    dom.persistentWarningBanner.style.display = 'flex';
}

function hidePersistentWarning() {
    if (dom.persistentWarningBanner) {
        dom.persistentWarningBanner.style.display = 'none';
    }
}

export function formatQuotaBadgeText(remaining, resetTimeStr) {
    return `${remaining} requests left, resets ${resetTimeStr}`;
}

function updateRateLimitUI(meta) {
    if (!meta) return;
    let resetTimeStr = '--:--';
    if (meta.reset) {
        const resetDate = new Date(meta.reset * 1000);
        resetTimeStr = resetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (dom.resetVal) dom.resetVal.textContent = resetTimeStr;
    }

    if (meta.remaining !== null && meta.remaining !== undefined) {
        lastRateLimitRemaining = meta.remaining;
        if (dom.quotaVal) {
            dom.quotaVal.textContent = `${meta.remaining} / ${meta.limit || '--'}`;
            dom.quotaVal.className = meta.remaining < 5 ? 'rate-critical' : meta.remaining < 10 ? 'rate-warning' : 'rate-normal';
        }
        if (dom.quotaRemainingText) {
            dom.quotaRemainingText.innerHTML = `${meta.remaining} requests left, resets <span id="resetVal">${resetTimeStr}</span>`;
        }
        if (dom.rateBadge) {
            // Without a token the hourly allowance is small (60), so always show what is left.
            dom.rateBadge.style.display = meta.remaining < 30 || !(dom.pat && dom.pat.value.trim()) ? 'flex' : 'none';
        }
        if (meta.remaining < 10) {
            showTokenPanel('');
        }
        // The comment cost hint compares against what is left.
        if (allIssues.length) updateSelectionTelemetry();
    }
}

async function refreshRateLimitBadge() {
    try {
        const info = await fetchRateLimit(dom.pat.value.trim());
        updateRateLimitUI(info);
    } catch (_) {}
}
if (dom.repoUrl) {
    dom.repoUrl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            dom.loadIssuesBtn.click();
        }
    });
}

// Check the quota when the user enters a token, not on page open: opening a page must not
// contact GitHub. Loading a repo updates the quota from GitHub's response headers anyway.
dom.pat.addEventListener('change', refreshRateLimitBadge);
dom.pat.addEventListener('input', () => { if (allIssues.length) updateSelectionTelemetry(); });

if (dom.warningBannerDismissBtn) {
    dom.warningBannerDismissBtn.addEventListener('click', hidePersistentWarning);
}
if (dom.warningBannerTokenBtn) {
    dom.warningBannerTokenBtn.addEventListener('click', () => {
        showTokenPanel('');
    });
}

const VALID_FORMATS = ['claude-xml', 'markdown', 'generic-xml', 'json'];
const VALID_COMMENT_SCOPES = IS_DISCUSSIONS
    ? ['all', 'answer-maintainers', 'answer', 'none']
    : ['all', 'maintainers', 'none'];
const VALID_ITEM_TYPES = ['issues', 'prs', 'both'];

// cfg_target / cfg_format / cfg_chunkLimit / cfg_budgetWindow are shared with the Code Explorer
// so the chosen target carries across tabs. Redaction defaults differ between the two pages
// (aggressive is on here), so those and the issue-specific options use their own keys.
function loadSavedSettings() {
    try {
        const get = k => localStorage.getItem(k);
        if (dom.format && VALID_FORMATS.includes(get('cfg_format'))) dom.format.value = get('cfg_format');
        if (dom.chunkLimit && get('cfg_chunkLimit') !== null) dom.chunkLimit.value = get('cfg_chunkLimit');
        if (get('cfg_budgetWindow')) currentBudgetWindow = parseInt(get('cfg_budgetWindow'), 10) || 200000;
        if (dom.redactSecrets && get(`cfg_${KIND}_redactSecrets`) !== null) {
            dom.redactSecrets.checked = get(`cfg_${KIND}_redactSecrets`) !== 'false';
        }
        if (dom.aggressiveRedact && get(`cfg_${KIND}_aggressiveRedact`) !== null) {
            dom.aggressiveRedact.checked = get(`cfg_${KIND}_aggressiveRedact`) !== 'false';
        }
        if (dom.commentScope && VALID_COMMENT_SCOPES.includes(get(`cfg_${KIND}_commentScope`))) {
            dom.commentScope.value = get(`cfg_${KIND}_commentScope`);
        }
        if (dom.aiInstructions && get(`cfg_${KIND}_aiInstructions`) !== null) {
            dom.aiInstructions.value = get(`cfg_${KIND}_aiInstructions`);
            if (dom.instructionsCharCount) dom.instructionsCharCount.textContent = `${dom.aiInstructions.value.length} chars`;
        }
    } catch (_) {}
}

function saveSettings() {
    try {
        if (dom.format) localStorage.setItem('cfg_format', dom.format.value);
        if (dom.chunkLimit) localStorage.setItem('cfg_chunkLimit', dom.chunkLimit.value);
        localStorage.setItem('cfg_budgetWindow', String(currentBudgetWindow));
        if (dom.redactSecrets) localStorage.setItem(`cfg_${KIND}_redactSecrets`, dom.redactSecrets.checked ? 'true' : 'false');
        if (dom.aggressiveRedact) localStorage.setItem(`cfg_${KIND}_aggressiveRedact`, dom.aggressiveRedact.checked ? 'true' : 'false');
        if (dom.commentScope) localStorage.setItem(`cfg_${KIND}_commentScope`, dom.commentScope.value);
        if (dom.aiInstructions) localStorage.setItem(`cfg_${KIND}_aiInstructions`, dom.aiInstructions.value);
    } catch (_) {}
}

const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('repo') && dom.repoUrl) {
    dom.repoUrl.value = urlParams.get('repo');
} else if (!urlParams.get('repo') && dom.repoUrl && !dom.repoUrl.value.trim()) {
    try {
        const lastRepo = localStorage.getItem('cfg_lastRepo');
        if (lastRepo) dom.repoUrl.value = lastRepo;
    } catch (_) {}
}

export function formatSettingsSummaryIssues({ format, secretsMode }) {
    const targetKey = detectTarget(format, currentBudgetWindow);
    const targetLabel = TARGETS[targetKey]?.label || 'Custom';
    return 'Settings: ' + buildSettingsSummary({
        targetLabel,
        minifyMode: 'none',
        redactLevel: secretsMode,
        chunkLimit: parseInt(dom.chunkLimit ? dom.chunkLimit.value : '0', 10) || 0
    });
}

function updateSettingsSummary() {
    const target = TARGETS[currentTargetKey] || TARGETS.custom;
    const targetLabel = target.label;
    const redactLevel = dom.redactLevel ? dom.redactLevel.value : 'strict';
    const chunkLimit = parseInt(dom.chunkLimit ? dom.chunkLimit.value : '0', 10) || 0;

    const summaryText = 'Settings: ' + buildSettingsSummary({
        targetLabel,
        minifyMode: 'none',
        redactLevel,
        chunkLimit
    });

    const summarySpan = dom.optionsToggleSummary || (dom.optionsToggleBtn ? dom.optionsToggleBtn.querySelector('span') : null);
    if (summarySpan) {
        summarySpan.textContent = summaryText;
    }
}

function syncRedactLevelFromCheckboxes() {
    const isRedact = dom.redactSecrets ? dom.redactSecrets.checked : true;
    const isAggressive = dom.aggressiveRedact ? dom.aggressiveRedact.checked : true;
    const level = !isRedact ? 'off' : (isAggressive ? 'strict' : 'standard');
    if (dom.redactLevel) dom.redactLevel.value = level;
    if (dom.secretsControl) dom.secretsControl.value = level;
}

function syncCheckboxesFromRedactLevel() {
    const level = dom.redactLevel ? dom.redactLevel.value : (dom.secretsControl ? dom.secretsControl.value : 'strict');
    if (dom.redactSecrets) {
        dom.redactSecrets.checked = (level !== 'off');
        dom.redactSecrets.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (dom.aggressiveRedact) {
        dom.aggressiveRedact.checked = (level === 'strict');
        dom.aggressiveRedact.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

function updateTargetVisibility(key) {
    const isCustom = key === 'custom';
    const formatEl = dom.formatField || (dom.format ? dom.format.closest('.option-field') : null);
    const chunkLimitEl = dom.chunkLimitField || (dom.chunkLimit ? dom.chunkLimit.closest('.option-field') : null);
    const presetsEl = dom.budgetPresets || document.querySelector('.budget-presets');

    if (formatEl) formatEl.hidden = !isCustom;
    if (chunkLimitEl) chunkLimitEl.hidden = !isCustom;
    if (presetsEl) presetsEl.hidden = !isCustom;
}

export function applyTarget(key) {
    currentTargetKey = key in TARGETS ? key : 'custom';
    const target = TARGETS[currentTargetKey];

    if (currentTargetKey !== 'custom' && target.format && target.budget !== undefined) {
        if (dom.format) dom.format.value = target.format;
        if (dom.chunkLimit) dom.chunkLimit.value = String(target.budget);
        currentBudgetWindow = target.budget;
        if (dom.targetBudgetDisplay) {
            dom.targetBudgetDisplay.textContent = 'of ' + target.budget.toLocaleString() + ' estimated tokens';
        }
        if (dom.format) dom.format.dispatchEvent(new Event('change', { bubbles: true }));
        if (dom.chunkLimit) dom.chunkLimit.dispatchEvent(new Event('change', { bubbles: true }));
    }

    updateTargetVisibility(currentTargetKey);

    if (dom.targetBar) {
        const buttons = dom.targetBar.querySelectorAll('button[data-target]');
        buttons.forEach(btn => {
            btn.setAttribute('aria-pressed', btn.dataset.target === currentTargetKey ? 'true' : 'false');
        });
    }

    try {
        localStorage.setItem('cfg_target', currentTargetKey);
    } catch (_) {}

    if (currentAppState !== 'built') updateSelectionTelemetry();
    updateSettingsSummary();
    updateCopyBtnLabel(activeChunkIndex);
}

export function getCopyButtonLabel(target, activeIndex = 0, totalParts = 1) {
    if (totalParts > 1) {
        return `Copy part ${activeIndex + 1} of ${totalParts}`;
    }
    switch (target) {
        case 'claude': return 'Copy for Claude';
        case 'chatgpt': return 'Copy for ChatGPT';
        case 'gemini': return 'Copy for Gemini';
        default: return 'Copy';
    }
}

function updateCopyBtnLabel(activeIndex = 0) {
    const label = getCopyButtonLabel(currentTargetKey, activeIndex, generatedChunks.length);
    if (dom.copyBtn) dom.copyBtn.textContent = label;
    if (dom.mobilePrimaryBtn && currentAppState === 'built') dom.mobilePrimaryBtn.textContent = label;
}

dom.optionsToggleBtn.addEventListener('click', () => {
    const isOpen = dom.optionsDrawer.classList.toggle('open');
    dom.optionsToggleBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
});

if (dom.drawerDoneBtn) {
    dom.drawerDoneBtn.addEventListener('click', () => {
        dom.optionsToggleBtn.click();
    });
}

let logOpen = false;
dom.logToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    logOpen = !logOpen;
    dom.log.style.display = logOpen ? 'block' : 'none';
    dom.logToggleBtn.textContent = logOpen ? 'Hide log' : 'Activity log';
    dom.logToggleBtn.setAttribute('aria-expanded', logOpen ? 'true' : 'false');
});
bindLogHeader(dom.logHeader, dom.logToggleBtn);

dom.toggleNlpCollapseBtn.addEventListener('click', () => {
    const hidden = dom.nlpBody.style.display === 'none';
    dom.nlpBody.style.display = hidden ? 'grid' : 'none';
    dom.toggleNlpCollapseBtn.textContent = hidden ? 'Hide topics' : 'Show topics';
});

/**
 * Converts an ISO-8601 timestamp to the viewer's local YYYY-MM-DD, matching what
 * <input type="date"> returns. Returns '' when the timestamp is missing or invalid.
 */
export function localDateString(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getFilteredIssues() {
    const q = (dom.issueSearchInput.value || '').trim().toLowerCase();
    const stateVal = dom.stateFilter.value;
    const labelVal = dom.labelFilter.value;
    const categoryVal = dom.categoryFilter ? dom.categoryFilter.value : '';
    const sortVal = dom.sortFilter.value;
    const dateFrom = dom.dateFromFilter.value;
    const dateTo = dom.dateToFilter.value;
    const minComments = parseInt(dom.minCommentsFilter.value, 10) || 0;

    const filtered = allIssues.filter(iss => {
        if (activeTopicFilter && !activeTopicFilter.numbers.has(iss.number)) return false;

        if (stateVal === 'open' && iss.state !== 'open') return false;
        if (stateVal === 'closed' && iss.state !== 'closed') return false;
        if (stateVal === 'completed' && (iss.state !== 'closed' || iss.stateReason !== 'completed')) return false;
        if (stateVal === 'not_planned' && (iss.state !== 'closed' || iss.stateReason !== 'not_planned')) return false;
        if (stateVal === 'answered' && !iss.isAnswered) return false;
        if (stateVal === 'unanswered' && (!iss.isAnswerable || iss.isAnswered)) return false;
        if (categoryVal && iss.category !== categoryVal) return false;

        if (labelVal && !iss.labels.includes(labelVal)) return false;
        const createdLocal = localDateString(iss.createdAtIso) || iss.createdAt;
        if (dateFrom && createdLocal < dateFrom) return false;
        if (dateTo && createdLocal > dateTo) return false;
        if (iss.commentsCount < minComments) return false;

        if (q) {
            const matchNum = `#${iss.number}` === q || String(iss.number) === q;
            const matchText = iss.title.toLowerCase().includes(q) ||
                iss.body.toLowerCase().includes(q) ||
                iss.author.toLowerCase().includes(q);
            if (!matchNum && !matchText) return false;
        }
        return true;
    });

    filtered.sort((a, b) => {
        if (sortVal === 'oldest') return a.number - b.number;
        if (sortVal === 'comments') return b.commentsCount - a.commentsCount;
        if (sortVal === 'reactions') return b.reactionsTotal - a.reactionsTotal;
        if (sortVal === 'updated') return (b.updatedAtIso || '').localeCompare(a.updatedAtIso || '') || b.number - a.number;
        // Issue numbers are assigned in creation order, so they sort the same as created_at.
        return b.number - a.number;
    });

    return filtered;
}

function updateCommentScopeBarUI() {
    if (!dom.commentScopeBar) return;
    const currentScope = dom.commentScope ? dom.commentScope.value : 'all';
    const buttons = dom.commentScopeBar.querySelectorAll('button[data-scope]');
    buttons.forEach(btn => {
        btn.setAttribute('aria-pressed', btn.dataset.scope === currentScope ? 'true' : 'false');
    });
}

/**
 * Updates the budget meter. When the output is split into several parts, each part is judged
 * against the target window (the largest part), not the sum of all parts.
 */
function updateBudgetMeterUI(totalTokens, numChunks = 1, isPreBuild = false, maxChunkTokens = 0, hasOversizedChunk = false) {
    if (dom.targetBudgetDisplay) {
        dom.targetBudgetDisplay.textContent = `of ${currentBudgetWindow.toLocaleString()} estimated tokens${isPreBuild ? ' (pre-build estimate)' : ''}`;
    }
    if (dom.statTokens) dom.statTokens.textContent = totalTokens.toLocaleString();

    const chunkLimitVal = parseInt(dom.chunkLimit ? dom.chunkLimit.value : '0', 10) || 0;
    const isSplit = numChunks > 1 || (chunkLimitVal > 0 && totalTokens > chunkLimitVal);
    const evaluatedTokens = isSplit
        ? (maxChunkTokens || (chunkLimitVal > 0 ? Math.min(totalTokens, chunkLimitVal) : Math.round(totalTokens / numChunks)))
        : totalTokens;
    const ratio = currentBudgetWindow > 0 ? evaluatedTokens / currentBudgetWindow : 0;
    const pct = currentBudgetWindow > 0 ? Math.min(100, Math.round((totalTokens / currentBudgetWindow) * 100)) : 0;
    const isOver = hasOversizedChunk || ratio > 1.0;
    const level = isOver ? 'over' : ratio <= 0.85 ? 'fits' : 'near';

    if (dom.budgetFill) {
        dom.budgetFill.style.width = `${pct}%`;
        dom.budgetFill.className = 'budget-fill ' + level;
    }
    if (!dom.budgetStatusText) return;

    let text;
    let status = level;
    if (isPreBuild && totalTokens === 0) {
        text = `Select ${W.noun} to estimate size`;
        status = 'fits';
    } else if (isPreBuild && isSplit && chunkLimitVal > 0) {
        text = `About ${totalTokens.toLocaleString()} tokens (bodies only), will split into about ${Math.ceil(totalTokens / chunkLimitVal)} parts`;
    } else if (isPreBuild) {
        text = `About ${totalTokens.toLocaleString()} tokens (bodies only, before comments)`;
    } else if (isSplit && numChunks > 1) {
        const largest = (maxChunkTokens || Math.round(totalTokens / numChunks)).toLocaleString();
        text = hasOversizedChunk
            ? `Split into ${numChunks} parts (largest: ${largest} tok) - 1+ part exceeds split limit`
            : `Split into ${numChunks} parts (largest: ${largest} tok) - fits target window`;
        status = hasOversizedChunk ? 'over' : 'fits';
    } else if (ratio <= 0.85) {
        text = 'Fits target budget';
    } else if (ratio <= 1.0) {
        text = 'Near target budget';
    } else {
        text = `Over budget by ${(totalTokens - currentBudgetWindow).toLocaleString()} tokens. Split into parts or deselect ${W.noun}.`;
    }
    dom.budgetStatusText.textContent = text;
    dom.budgetStatusText.className = `budget-status-text status-${status}`;
}

function estimateIssueTokens(iss) {
    let chars = iss.title.length + iss.body.length;
    const comms = cachedCommentsByIssue.get(iss.number);
    if (comms) for (const c of comms) chars += (c.body || '').length;
    return Math.round(chars / 3.8);
}

function updateSelectionTelemetry() {
    const selectedList = allIssues.filter(iss => selectedIssueNumbers.has(iss.number));
    let totalBodyBytes = 0;
    for (const iss of selectedList) {
        totalBodyBytes += (iss.title.length + iss.body.length);
    }
    const estBodyTokens = Math.round(totalBodyBytes / 3.8);
    const n = selectedList.length;
    const tokens = estBodyTokens.toLocaleString();

    if (dom.selectedTokensBadge) {
        dom.selectedTokensBadge.textContent = `${n} selected (~${tokens} estimated body tokens)`;
    }
    if (dom.selectionSummary) {
        dom.selectionSummary.textContent = `${n} selected · ~${tokens} tokens (estimated)`;
    }

    if (currentAppState !== 'built') {
        updateBudgetMeterUI(estBodyTokens, 1, true);
    }

    const filtered = getFilteredIssues();
    const visibleNums = new Set(filtered.map(i => i.number));
    const hiddenNums = selectedList.filter(i => !visibleNums.has(i.number)).map(i => i.number);
    if (dom.hiddenSelectedNote) {
        dom.hiddenSelectedNote.textContent = hiddenNums.length > 0
            ? `${hiddenNums.length} selected ${W.one}(s) are hidden by the current filters.`
            : '';
        if (hiddenNums.length > 0) {
            const clearBtn = document.createElement('button');
            clearBtn.type = 'button';
            clearBtn.className = 'secondary btn-xs';
            clearBtn.style.marginLeft = '0.5rem';
            clearBtn.textContent = 'Deselect hidden';
            clearBtn.addEventListener('click', () => {
                for (const n of hiddenNums) selectedIssueNumbers.delete(n);
                renderIssuesList();
            });
            dom.hiddenSelectedNote.appendChild(clearBtn);
        }
    }

    if (dom.commentCostHint) {
        const scope = dom.commentScope ? dom.commentScope.value : 'all';
        const cost = commentRequestEstimate(selectedList, scope);
        const note = cost.requests > 0
            ? quotaNote(cost.requests, { hasToken: Boolean(dom.pat.value.trim()), remaining: lastRateLimitRemaining, max: cost.max || 0, words: W })
            : { text: cost.text, level: 'ok' };
        dom.commentCostHint.textContent = note.text;
        dom.commentCostHint.classList.toggle('cost-warn', note.level === 'warn');
        dom.commentCostHint.classList.toggle('cost-over', note.level === 'over');
    }
}

/** GitHub requests needed to fetch the comments of `list` that are not loaded yet. */
function commentRequestEstimate(list, scope) {
    if (scope === 'none') return { requests: 0, text: 'No extra requests.' };
    const cachedNumbers = new Set(cachedCommentsByIssue.keys());
    if (IS_DISCUSSIONS) {
        const needs = list.filter(i => i.commentsCount > 0 && !cachedNumbers.has(i.number));
        if (!needs.length) return { requests: 0, text: 'Comments already loaded.' };
        return { requests: estimateDiscussionCommentCost(needs, Boolean(dom.pat.value.trim())), text: '' };
    }
    return commentCostHint(list, allIssues, cachedNumbers, scope);
}

function renderIssuesList() {
    const visible = getFilteredIssues();
    dom.searchMatchCount.textContent = `${visible.length} / ${allIssues.length}`;

    if (allIssues.length === 0) {
        dom.issuesEmptyState.style.display = 'flex';
        dom.issuesListContainer.style.display = 'none';
        return;
    }

    dom.issuesEmptyState.style.display = 'none';
    dom.issuesListContainer.style.display = 'block';
    dom.issuesListContainer.innerHTML = '';

    const fragment = document.createDocumentFragment();

    for (const iss of visible) {
        const li = document.createElement('li');
        li.className = 'issue-item';
        li.tabIndex = 0;
        li.setAttribute('role', 'checkbox');
        li.setAttribute('aria-checked', selectedIssueNumbers.has(iss.number) ? 'true' : 'false');
        li.setAttribute('aria-label', `${W.One} #${iss.number}: ${iss.title}`);

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'issue-checkbox';
        cb.checked = selectedIssueNumbers.has(iss.number);
        cb.setAttribute('aria-label', `Select ${W.one} #${iss.number}`);
        cb.tabIndex = -1; // row is focused for keyboard navigation

        cb.addEventListener('change', (e) => {
            e.stopPropagation();
            if (cb.checked) selectedIssueNumbers.add(iss.number);
            else selectedIssueNumbers.delete(iss.number);
            li.setAttribute('aria-checked', cb.checked ? 'true' : 'false');
            updateSelectionTelemetry();
        });

        li.addEventListener('click', (e) => {
            if (e.target === cb || e.target.classList.contains('issue-sim-badge')) return;
            if (e.target.closest && e.target.closest('a, .issue-label-pill')) return;
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event('change'));
        });

        li.addEventListener('keydown', (e) => {
            if (e.target !== li) return;
            if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') {
                e.preventDefault();
                cb.checked = !cb.checked;
                cb.dispatchEvent(new Event('change'));
            }
        });

        const main = document.createElement('div');
        main.className = 'issue-main';

        const titleRow = document.createElement('div');
        titleRow.className = 'issue-title-row';

        const badge = document.createElement('span');
        const isMerged = Boolean(iss.isPullRequest && iss.mergedAt);
        const isNotPlanned = !isMerged && iss.state === 'closed' && iss.stateReason === 'not_planned';
        const stateClass = iss.state === 'open' ? 'issue-state-open'
            : isMerged ? 'issue-state-merged'
                : isNotPlanned ? 'issue-state-not-planned' : 'issue-state-closed';
        badge.className = `issue-state-badge ${stateClass}`;
        badge.textContent = isMerged ? 'merged' : isNotPlanned ? 'not planned' : iss.state;
        if (IS_DISCUSSIONS && iss.isAnswered) {
            badge.className = 'issue-state-badge issue-state-answered';
            badge.textContent = 'answered';
            badge.title = iss.state === 'closed' ? 'Answered (closed)' : 'Answered';
        }

        const kindParts = [];
        if (iss.isPullRequest) {
            const prTag = document.createElement('span');
            prTag.className = 'issue-kind-pr';
            prTag.textContent = 'PR';
            prTag.title = 'Pull request';
            kindParts.push(prTag);
        }

        // "#123 ↗" opens the thread on GitHub. Only ever github.com URLs, whatever the data says.
        let numEl;
        if (isGithubUrl(iss.htmlUrl)) {
            numEl = externalLink(iss.htmlUrl, `#${iss.number}`, { title: `Open #${iss.number} on GitHub`, className: 'issue-number ext-link issue-link' });
        } else {
            numEl = document.createElement('span');
            numEl.className = 'issue-number';
            numEl.textContent = `#${iss.number}`;
        }

        const titleSpan = document.createElement('span');
        titleSpan.className = 'issue-title';
        titleSpan.textContent = iss.title;

        const tokSpan = document.createElement('span');
        tokSpan.className = 'issue-token-weight';
        const issTokens = estimateIssueTokens(iss);
        tokSpan.textContent = issTokens >= 1000 ? `~${(issTokens / 1000).toFixed(1)}k tok` : `~${issTokens} tok`;
        tokSpan.title = cachedCommentsByIssue.has(iss.number) || iss.commentsCount === 0
            ? 'Estimated tokens (title, body and fetched comments, before cleaning)'
            : `Estimated tokens for title and body; ${iss.commentsCount} comment(s) not fetched yet`;

        const relatedTag = [];
        if (activeTopicFilter && activeTopicFilter.type === 'custom' && activeTopicFilter.related.has(iss.number)) {
            const tag = document.createElement('span');
            tag.className = 'issue-related-tag';
            tag.textContent = 'related';
            tag.title = `Does not use the words of ${activeTopicFilter.label}, but discusses similar things`;
            relatedTag.push(tag);
        }

        titleRow.append(badge, ...kindParts, numEl, titleSpan, ...relatedTag, tokSpan);

        const metaRow = document.createElement('div');
        metaRow.className = 'issue-meta-row';
        metaRow.innerHTML = `<span>@${escapeXml(iss.author)}</span><span>• ${escapeXml(localDateString(iss.createdAtIso) || iss.createdAt)}</span><span>• 💬 ${iss.commentsCount}</span>`;
        if (iss.reactionsTotal > 0) {
            metaRow.innerHTML += IS_DISCUSSIONS
                ? `<span title="Upvotes">• ▲ ${iss.reactionsTotal}</span>`
                : `<span>• 👍 ${iss.reactionsTotal}</span>`;
        }
        if (IS_DISCUSSIONS && iss.category) {
            const catBtn = document.createElement('button');
            catBtn.type = 'button';
            catBtn.className = 'issue-label-pill issue-category-pill';
            catBtn.textContent = iss.category;
            const isActiveCat = dom.categoryFilter && dom.categoryFilter.value === iss.category;
            catBtn.title = isActiveCat ? 'Clear category filter' : `Filter by category "${iss.category}"`;
            catBtn.setAttribute('aria-pressed', isActiveCat ? 'true' : 'false');
            catBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (dom.categoryFilter) dom.categoryFilter.value = isActiveCat ? '' : iss.category;
                renderIssuesList();
            });
            metaRow.appendChild(catBtn);
        }

        for (const lbl of iss.labels.slice(0, 4)) {
            const pill = document.createElement('button');
            pill.type = 'button';
            pill.className = 'issue-label-pill';
            pill.textContent = lbl;
            const isActiveLabel = dom.labelFilter.value === lbl;
            pill.title = isActiveLabel ? 'Clear label filter' : `Filter by label "${lbl}"`;
            pill.setAttribute('aria-pressed', isActiveLabel ? 'true' : 'false');
            pill.addEventListener('click', (e) => {
                e.stopPropagation();
                dom.labelFilter.value = isActiveLabel ? '' : lbl;
                renderIssuesList();
            });
            metaRow.appendChild(pill);
        }

        const simList = nlpResults.similarMap && nlpResults.similarMap[iss.number];
        if (simList && simList.length > 0) {
            const simBtn = document.createElement('button');
            simBtn.type = 'button';
            simBtn.className = 'issue-sim-badge';
            simBtn.title = `Click to also select similar ${W.one}(s): ${simList.map(n => '#' + n).join(', ')}`;
            simBtn.textContent = `~${simList.length} similar (${simList.slice(0, 2).map(n => '#' + n).join(', ')})`;
            simBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                selectedIssueNumbers.add(iss.number);
                simList.forEach(n => selectedIssueNumbers.add(n));
                renderIssuesList();
                updateSelectionTelemetry();
                showToast(`Selected #${iss.number} and ${simList.length} similar ${W.one}(s).`, 'info');
            });
            metaRow.appendChild(simBtn);
        }

        main.append(titleRow, metaRow);
        li.append(cb, main);
        fragment.appendChild(li);
    }

    dom.issuesListContainer.appendChild(fragment);
    updateSelectionTelemetry();
}

[dom.issueSearchInput, dom.stateFilter, dom.labelFilter, dom.categoryFilter, dom.sortFilter, dom.dateFromFilter, dom.dateToFilter, dom.minCommentsFilter].forEach(el => {
    if (el) el.addEventListener('input', renderIssuesList);
});

// Press "/" anywhere (outside a text field) to jump to the issue search box, as in the Code Explorer.
document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const active = document.activeElement;
    const tag = active && active.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (active && active.isContentEditable)) return;
    if (!dom.issueSearchInput || allIssues.length === 0) return;
    e.preventDefault();
    dom.issueSearchInput.focus();
});

// ------------------------------------------------------------------ relationship map

const mapEls = {
    btn: document.getElementById('mapBtn'),
    dialog: document.getElementById('mapDialog'),
    title: document.getElementById('mapDialogTitle'),
    mount: document.getElementById('mapMount'),
    close: document.getElementById('mapCloseBtn'),
    tabs: [...document.querySelectorAll('#mapDialog [role="tab"]')]
};
let mapView = null;
let mapTab = 'links';

/** What the phrase map and timeline need to list a thread. */
const threadInfo = (num) => {
    const iss = allIssues.find(i => i.number === num);
    return iss ? { title: iss.title || '', url: typeof iss.htmlUrl === 'string' && /^https:\/\/github\.com\//.test(iss.htmlUrl) ? iss.htmlUrl : '' } : null;
};
const mapSelection = {
    isSelected: n => selectedIssueNumbers.has(n),
    setSelected: (numbers, on) => {
        for (const n of numbers) { if (on) selectedIssueNumbers.add(n); else selectedIssueNumbers.delete(n); }
        renderIssuesList();
    }
};
/** "Show these in the list": filter the list to those threads, like a topic pill, and close the map. */
function showInList(label, numbers) {
    activeTopicFilter = null;
    toggleTopicFilter('custom-map', label, numbers);
    mapEls.dialog.close();
    showToast(`Showing ${numbers.length} ${numbers.length === 1 ? W.one : W.noun}: ${label}.`, 'info');
}

function mountMapTab(view) {
    if (mapView) { mapView.destroy(); mapView = null; }
    mapTab = view;
    for (const t of mapEls.tabs) t.setAttribute('aria-selected', t.dataset.view === view ? 'true' : 'false');
    if (view === 'phrases') {
        mapView = mountPhraseMap(mapEls.mount, toPhraseData({ phrases: nlpResults.phrases || [], clusters: nlpResults.clusters }),
            { words: W, thread: threadInfo, showInList, ...mapSelection });
        return;
    }
    if (view === 'timeline') {
        mapView = mountTopicTimeline(mapEls.mount, toTimelineData({ issues: allIssues, clusters: nlpResults.clusters }),
            { words: W, thread: threadInfo, showInList, ...mapSelection });
        return;
    }
    const data = toIssueGraphData({
        issues: allIssues,
        clusters: nlpResults.clusters,
        similarMap: nlpResults.similarMap,
        // References in comments count too, for the threads whose comments are already loaded.
        extraTexts: n => (cachedCommentsByIssue.get(n) || []).map(c => c.body || ''),
        extractRefs: extractIssueReferences
    });
    mapView = mountIssueGraph(mapEls.mount, data, { words: W, ...mapSelection });
}

function openMap() {
    if (!allIssues.length || !mapEls.dialog) return;
    const repo = currentRepoInfo ? `${currentRepoInfo.owner}/${currentRepoInfo.repo}` : '';
    mapEls.title.textContent = `${W.Noun}${repo ? `: ${repo}` : ''}${nlpPending ? ' (topics still being found)' : ''}`;
    if (typeof mapEls.dialog.showModal === 'function') mapEls.dialog.showModal(); else mapEls.dialog.setAttribute('open', '');
    mountMapTab(mapTab);
}

if (mapEls.dialog) {
    mapEls.btn.addEventListener('click', openMap);
    mapEls.close.addEventListener('click', () => mapEls.dialog.close());
    mapEls.tabs.forEach((t, i) => {
        t.addEventListener('click', () => mountMapTab(t.dataset.view));
        t.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            const next = mapEls.tabs[(i + (e.key === 'ArrowRight' ? 1 : mapEls.tabs.length - 1)) % mapEls.tabs.length];
            next.focus();
            mountMapTab(next.dataset.view);
        });
    });
    mapEls.dialog.addEventListener('close', () => { if (mapView) { mapView.destroy(); mapView = null; } });
}

let currentNlpRequestId = 0;
let nlpPending = false;
let nlpStatus = 0;

/** Finishes the topic step: says how many topics were found, in the log and the status bar. */
function finishNlp(message) {
    nlpPending = false;
    const ok = isCurrent(nlpStatus);
    log(message, { summary: ok });
    if (ok) end(nlpStatus);
    renderNlpBanner();
}

function runNlpAnalysis(issues) {
    if (!nlpWorker) {
        nlpWorker = new Worker(new URL('./nlp.worker.js', import.meta.url), { type: 'module' });
        nlpWorker.onmessage = (e) => {
            if (!e.data || e.data.id !== currentNlpRequestId) return;
            nlpResults = e.data || { clusters: [], ngrams: [], similarMap: {} };
            const c = nlpResults.clusters.length;
            const n = nlpResults.ngrams.length;
            finishNlp(c || n
                ? `[DONE] Loaded ${allIssues.length} ${W.noun}. Found ${c} topic${c === 1 ? '' : 's'} and ${n} common phrase${n === 1 ? '' : 's'}.`
                : `[DONE] Loaded ${allIssues.length} ${W.noun}. No clear topics found; search for your own topic instead.`);
            renderIssuesList();
        };
        nlpWorker.onerror = (err) => {
            finishNlp(`[WARN] Topic clustering failed (${err.message || String(err)}). Filtering and packing still work.`);
        };
    }
    currentNlpRequestId++;
    nlpPending = true;
    nlpStatus = begin(`Loaded ${issues.length} ${W.noun}. Finding topics…`);
    renderNlpBanner();
    nlpWorker.postMessage({
        id: currentNlpRequestId,
        issues: issues.map(i => ({ number: i.number, title: i.title, body: i.body }))
    });
}

function renderNlpBanner() {
    if (!allIssues.length) {
        dom.nlpBanner.style.display = 'none';
        return;
    }
    dom.nlpBanner.style.display = 'flex';
    dom.nlpBanner.classList.toggle('is-pending', nlpPending);
    dom.nlpMetaBadge.textContent = nlpPending
        ? `Finding topics in ${allIssues.length} ${W.noun}…`
        : nlpResults.clusters.length || nlpResults.ngrams.length
            ? `${nlpResults.clusters.length} topic${nlpResults.clusters.length === 1 ? '' : 's'}, ${nlpResults.ngrams.length} common phrase${nlpResults.ngrams.length === 1 ? '' : 's'} across ${allIssues.length} ${W.noun}`
            : `No clear topics in ${allIssues.length} ${W.noun}; search for your own below`;

    dom.topicClustersContainer.innerHTML = '';
    if (activeTopicFilter && activeTopicFilter.type === 'custom') {
        const f = activeTopicFilter;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nlp-pill active custom-topic-pill';
        btn.title = 'Click to clear this topic';
        btn.innerHTML = `<span>${escapeXml(f.label)}</span><span class="nlp-pill-count">${f.matchCount}${f.related.size ? ` + ${f.related.size} related` : ''}</span>`;
        btn.addEventListener('click', clearTopicFilter);
        dom.topicClustersContainer.appendChild(btn);
    }
    if (activeTopicFilter && activeTopicFilter.type === 'custom-map') {
        // A group picked on the map (a phrase, or a topic in one period of the timeline).
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nlp-pill active custom-topic-pill';
        btn.title = 'Click to clear this filter';
        const name = document.createElement('span');
        name.textContent = activeTopicFilter.label;
        const count = document.createElement('span');
        count.className = 'nlp-pill-count';
        count.textContent = String(activeTopicFilter.numbers.size);
        btn.append(name, count);
        btn.addEventListener('click', clearTopicFilter);
        dom.topicClustersContainer.appendChild(btn);
    }
    for (const c of nlpResults.clusters) {
        const btn = document.createElement('button');
        btn.type = 'button';
        const isActive = activeTopicFilter && activeTopicFilter.label === c.label;
        btn.className = `nlp-pill${isActive ? ' active' : ''}`;
        btn.innerHTML = `<span>${escapeXml(c.label)}</span><span class="nlp-pill-count">${c.count}</span>`;
        btn.addEventListener('click', () => toggleTopicFilter('cluster', c.label, c.issueNumbers));
        dom.topicClustersContainer.appendChild(btn);
    }

    dom.ngramsContainer.innerHTML = '';
    for (const ng of nlpResults.ngrams) {
        const btn = document.createElement('button');
        btn.type = 'button';
        const isActive = activeTopicFilter && activeTopicFilter.label === ng.phrase;
        btn.className = `nlp-pill${isActive ? ' active' : ''}`;
        btn.innerHTML = `<span>"${escapeXml(ng.phrase)}"</span><span class="nlp-pill-count">${ng.count}</span>`;
        btn.addEventListener('click', () => toggleTopicFilter('ngram', ng.phrase, ng.issueNumbers));
        dom.ngramsContainer.appendChild(btn);
    }
}

function toggleTopicFilter(type, label, issueNumbers) {
    if (activeTopicFilter && activeTopicFilter.label === label) {
        activeTopicFilter = null;
        dom.clearNlpFilterBtn.style.display = 'none';
        dom.selectActiveTopicBtn.style.display = 'none';
    } else {
        activeTopicFilter = { type, label, numbers: new Set(issueNumbers) };
        dom.clearNlpFilterBtn.style.display = 'inline-flex';
        dom.selectActiveTopicBtn.style.display = 'inline-flex';
    }
    renderNlpBanner();
    renderIssuesList();
}

function clearTopicFilter() {
    activeTopicFilter = null;
    dom.clearNlpFilterBtn.style.display = 'none';
    dom.selectActiveTopicBtn.style.display = 'none';
    renderNlpBanner();
    renderIssuesList();
}
dom.clearNlpFilterBtn.addEventListener('click', clearTopicFilter);

/** Filters the list to a topic the user types: direct matches plus related threads. */
export function applyCustomTopic(query) {
    const result = searchTopic(allIssues, query);
    if (!result) {
        if (dom.customTopicHint) dom.customTopicHint.textContent = 'Type at least one word.';
        return null;
    }
    const total = result.matches.length + result.related.length;
    if (dom.customTopicHint) {
        dom.customTopicHint.textContent = total === 0
            ? `No ${W.noun} mention ${result.terms.join(' + ')}.`
            : `${result.matches.length} mention${result.matches.length === 1 ? 's' : ''} ${result.terms.join(' + ')}${result.related.length ? `; ${result.related.length} more look${result.related.length === 1 ? 's' : ''} related` : ''}. Related ones are marked in the list.`;
    }
    if (total === 0) return result;
    activeTopicFilter = {
        type: 'custom',
        label: /^".*"$/.test(result.query) ? result.query : `"${result.query}"`,
        numbers: new Set([...result.matches, ...result.related]),
        related: new Set(result.related),
        matchCount: result.matches.length
    };
    dom.clearNlpFilterBtn.style.display = 'inline-flex';
    dom.selectActiveTopicBtn.style.display = 'inline-flex';
    renderNlpBanner();
    renderIssuesList();
    return result;
}

if (dom.customTopicForm) {
    dom.customTopicForm.addEventListener('submit', (e) => {
        e.preventDefault();
        if (allIssues.length === 0) return;
        applyCustomTopic(dom.customTopicInput.value);
    });
}

dom.selectActiveTopicBtn.addEventListener('click', () => {
    if (!activeTopicFilter) return;
    for (const num of activeTopicFilter.numbers) {
        selectedIssueNumbers.add(num);
    }
    renderIssuesList();
    showToast(`Selected ${activeTopicFilter.numbers.size} ${W.noun} in "${activeTopicFilter.label}".`, 'info');
});

dom.selectAllVisibleBtn.addEventListener('click', () => {
    const visible = getFilteredIssues();
    for (const iss of visible) selectedIssueNumbers.add(iss.number);
    renderIssuesList();
});

dom.deselectAllBtn.addEventListener('click', () => {
    selectedIssueNumbers.clear();
    renderIssuesList();
});

dom.selectLinkedBtn.addEventListener('click', () => {
    const knownNumbers = new Set(allIssues.map(i => i.number));
    let added = 0;
    for (const iss of allIssues) {
        if (!selectedIssueNumbers.has(iss.number)) continue;
        const refs = new Set(extractIssueReferences(iss.body, iss.number));
        for (const c of cachedCommentsByIssue.get(iss.number) || []) {
            for (const r of extractIssueReferences(c.body, iss.number)) refs.add(r);
        }
        for (const r of refs) {
            if (knownNumbers.has(r) && !selectedIssueNumbers.has(r)) {
                selectedIssueNumbers.add(r);
                added++;
            }
        }
    }
    renderIssuesList();
    showToast(added > 0 ? `Added ${added} cross-referenced ${W.one}(s).` : `No new linked ${W.noun} found in current selection.`, 'info');
});

dom.loadIssuesBtn.addEventListener('click', async () => {
    dom.repoInputError.style.display = 'none';
    hidePersistentWarning();
    const repoInfo = parseRepoInput(dom.repoUrl.value);
    if (!repoInfo) {
        dom.repoInputError.style.display = 'block';
        return;
    }
    // First contact with GitHub: one-time notice.
    if (!(await confirmFirstUse('github'))) return;

    if (loadController) loadController.abort();
    if (buildController) buildController.abort();
    loadController = new AbortController();
    buildGeneration++;

    dom.buildContextBtn.disabled = false;

    currentRepoInfo = repoInfo;
    allIssues = [];
    if (mapEls.btn) mapEls.btn.disabled = true;
    selectedIssueNumbers.clear();
    cachedCommentsByIssue.clear();
    fetchFailuresMap.clear();
    activeTopicFilter = null;
    nlpResults = { clusters: [], ngrams: [], phrases: [], similarMap: {} };
    if (dom.customTopicInput) dom.customTopicInput.value = '';
    currentNlpRequestId++;
    nlpPending = false;
    renderNlpBanner();
    // Drop the previous repo's output so Copy/Download cannot hand it out for this repo.
    if (currentAppState === 'built') setAppState('loaded');
    clearOutputState();

    dom.loadIssuesBtn.disabled = true;
    dom.abortBtn.style.display = 'inline-flex';
    const loadStatus = begin(`Loading ${W.noun} from ${repoInfo.owner}/${repoInfo.repo}…`, { button: dom.loadIssuesBtn });

    const maxItems = parseInt(dom.maxIssuesLimit.value, 10) || 300;
    const itemType = IS_DISCUSSIONS ? 'discussions' : dom.includePrs.value;
    const pat = dom.pat.value.trim();

    try {
        const itemLabel = { issues: 'issues', prs: 'pull requests', both: 'issues and pull requests', discussions: 'discussions' }[itemType] || itemType;
        log(`[FETCH] Loading up to ${maxItems} ${itemLabel} from ${repoInfo.owner}/${repoInfo.repo}...`);
        const fetchManifest = IS_DISCUSSIONS ? fetchDiscussionsManifest : fetchIssuesManifest;
        const manifest = await fetchManifest(repoInfo.owner, repoInfo.repo, {
            maxItems,
            itemType,
            pat,
            signal: loadController.signal,
            onHeaders: updateRateLimitUI,
            // The total is only a cap ("up to 300"), so show the count found rather than a percentage.
            onProgress: (loaded) => progress(loadStatus, { message: `Loading ${W.noun} from ${repoInfo.owner}/${repoInfo.repo}… ${loaded} found` })
        });
        if (IS_DISCUSSIONS) {
            log(manifest.source === 'graphql'
                ? '[FETCH] Using GitHub GraphQL API (token).'
                : "[WARN] No token: using GitHub's undocumented token-free discussions endpoint. Add a token for the official API, accepted answers and fewer requests.");
        }

        allIssues = manifest;
        const openOnes = allIssues.filter(i => i.state === 'open');
        const initialSelect = (openOnes.length > 0 ? openOnes : allIssues).slice(0, 25);
        for (const iss of initialSelect) selectedIssueNumbers.add(iss.number);

        const labelCounts = new Map();
        for (const iss of allIssues) {
            for (const l of iss.labels) labelCounts.set(l, (labelCounts.get(l) || 0) + 1);
        }
        const sortedLabels = Array.from(labelCounts.entries()).sort((a, b) => b[1] - a[1]);
        if (dom.categoryFilter) {
            const catCounts = new Map();
            for (const iss of allIssues) if (iss.category) catCounts.set(iss.category, (catCounts.get(iss.category) || 0) + 1);
            const cats = Array.from(catCounts.entries()).sort((a, b) => b[1] - a[1]);
            dom.categoryFilter.innerHTML = `<option value="">Category: All (${cats.length})</option>` +
                cats.map(([c, cnt]) => `<option value="${escapeXml(c)}">${escapeXml(c)} (${cnt})</option>`).join('');
        }
        dom.labelFilter.innerHTML = `<option value="">Label: All labels (${sortedLabels.length})</option>` +
            sortedLabels.map(([l, cnt]) => `<option value="${escapeXml(l)}">${escapeXml(l)} (${cnt})</option>`).join('');

        renderIssuesList();
        setAppState('loaded');
        // Remember the repo for next time, but not one loaded with a token: it may be private.
        try {
            if (!pat) localStorage.setItem('cfg_lastRepo', `${repoInfo.owner}/${repoInfo.repo}`);
        } catch (_) {}

        if (manifest.stoppedEarly) {
            log(`[WARN] Reached scan limit (30 pages). Found ${allIssues.length} items.`);
            showToast(IS_DISCUSSIONS
                ? `Scanned 30 pages, found ${allIssues.length} discussions. Raise the limit to scan more.`
                : `Scanned 30 pages, found ${allIssues.length} items. Raise limit or select 'Issues & PRs'.`, 'warn');
            showPersistentWarning(`Reached scan limit (30 pages). Scanned ${allIssues.length} items. Output may be incomplete.`, {
                showTokenBtn: !dom.pat.value.trim(),
                showRetryBtn: true,
                onRetry: () => dom.loadIssuesBtn.click()
            });
        } else if (allIssues.length > 0) {
            log(`[SUCCESS] Loaded ${allIssues.length} ${itemLabel}.`);
            showToast(`Loaded ${allIssues.length} ${itemLabel}.`, 'info');
        }
        if (allIssues.length === 0) {
            const message = emptyResultMessage(repoInfo, itemType);
            log(`[INFO] ${message.text}`);
            showEmptyResult(message);
            end(loadStatus);
            return;
        }
        end(loadStatus);
        // Topic clustering runs in a background worker; the status bar says when it is done.
        runNlpAnalysis(allIssues);
        if (mapEls.btn) mapEls.btn.disabled = allIssues.length === 0;
    } catch (err) {
        if (err.name === 'AbortError') {
            log('[CANCEL] Manifest load cancelled.');
        } else {
            log(`[ERROR] ${err.message}`);
            if (err.disabled) {
                showToast(err.message, 'error');
                return;
            }
            if (err.isRateLimit || (err.message && (err.message.includes('rate limit') || err.message.includes('403') || err.message.includes('429')))) {
                showTokenPanel('');
            } else if (err.status === 404 || (err.message && err.message.includes('404'))) {
                showTokenPanel("If this is a private repo, add a token.");
            }
            showToast(err.message, 'error');
        }
    } finally {
        end(loadStatus);
        dom.loadIssuesBtn.disabled = false;
        dom.abortBtn.style.display = 'none';
    }
});

function clearOutputState() {
    hideCopyHint();
    generatedChunks = [];
    activeChunkIndex = 0;
    packedOutputText = '';
    lastBuildSummaryOnly = false;
    if (dom.summaryCard) {
        dom.summaryCard.hidden = true;
        dom.summaryCard.innerHTML = '';
    }
    if (dom.togglePreviewBtn) {
        dom.togglePreviewBtn.style.display = 'none';
        dom.togglePreviewBtn.setAttribute('aria-expanded', 'false');
        dom.togglePreviewBtn.textContent = 'Show preview';
    }
    if (dom.previewArea) {
        dom.previewArea.value = '';
        dom.previewArea.style.display = 'none';
    }
    if (dom.outputEmptyState) dom.outputEmptyState.style.display = 'flex';
    if (dom.previewNotice) dom.previewNotice.style.display = 'none';
    if (dom.secretsWarningPanel) dom.secretsWarningPanel.style.display = 'none';
    if (dom.warningBanner) renderBanner(dom.warningBanner, []);
    for (const k of ['statChunks', 'statIssues', 'statComments', 'statChars']) {
        if (dom[k]) dom[k].textContent = '0';
    }
    if (dom.chunkSelectLabel) dom.chunkSelectLabel.style.display = 'none';
    if (dom.chunkSelect) {
        dom.chunkSelect.style.display = 'none';
        dom.chunkSelect.innerHTML = '';
    }
    if (dom.downloadAllBtn) dom.downloadAllBtn.style.display = 'none';
    if (dom.nextPartBtn) dom.nextPartBtn.style.display = 'none';
    if (dom.downloadBtn) dom.downloadBtn.disabled = true;
    if (dom.copyBtn) dom.copyBtn.disabled = true;
    updateCopyBtnLabel(0);
    updateBudgetMeterUI(0, 1, true);
}

/** Why a load found nothing, and the one-click fix when there is one. */
function emptyResultMessage(repoInfo, itemType) {
    const repo = `${repoInfo.owner}/${repoInfo.repo}`;
    if (IS_DISCUSSIONS) return { text: `${repo} has no discussions, or Discussions are turned off for it.` };
    if (itemType === 'issues') {
        return { text: `No issues found in ${repo}. It may only have pull requests.`, action: 'Load pull requests too', apply: () => { dom.includePrs.value = 'both'; } };
    }
    if (itemType === 'prs') {
        return { text: `No pull requests found in ${repo}.`, action: 'Load issues too', apply: () => { dom.includePrs.value = 'both'; } };
    }
    return { text: `No issues or pull requests found in ${repo}.` };
}

function showEmptyResult(message) {
    const p = document.getElementById('issuesEmptyText');
    if (p) {
        p.textContent = message.text;
        if (message.action) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'emptyResultAction';
            btn.className = 'secondary btn-sm empty-action';
            btn.textContent = message.action;
            btn.addEventListener('click', () => { message.apply(); dom.loadIssuesBtn.click(); });
            p.appendChild(document.createElement('br'));
            p.appendChild(btn);
        }
    }
    showToast(message.text, 'info');
}

async function buildSelectedContext(summaryOnly = false, spendAnyway = false) {
    if (!currentRepoInfo || allIssues.length === 0) {
        showToast(allIssues.length === 0 && currentRepoInfo ? `There are no ${W.noun} to pack. Load another repository.` : `Load a repository first.`, 'warn');
        return;
    }

    lastBuildSummaryOnly = summaryOnly;
    lastFetchRateLimited = false;
    buildGeneration++;
    const thisBuildGen = buildGeneration;

    const targetIssues = summaryOnly
        ? getFilteredIssues()
        : allIssues.filter(i => selectedIssueNumbers.has(i.number));

    if (targetIssues.length === 0) {
        showToast(`Select at least one ${W.one} first.`, 'warn');
        return;
    }

    const commentScope = summaryOnly ? 'none' : dom.commentScope.value;
    const pat = dom.pat.value.trim();

    if (commentScope !== 'none') {
        const missingComments = targetIssues.filter(i => i.commentsCount > 0 && !cachedCommentsByIssue.has(i.number));
        if (missingComments.length > 0) {
            // Stop before spending requests that are not there: without a token GitHub allows 60 an
            // hour, and comments usually cost one request per thread.
            const needed = commentRequestEstimate(targetIssues, commentScope).requests;
            const left = Number.isFinite(lastRateLimitRemaining) ? lastRateLimitRemaining : (pat ? Infinity : 60);
            if (!spendAnyway && needed > left - 2) {
                log(`[WARN] Fetching comments needs about ${needed} GitHub requests, but only ${left} are left this hour.`);
                showPersistentWarning(
                    `Fetching these comments needs about ${needed} GitHub requests, but only ${left} ${left === 1 ? 'is' : 'are'} left this hour${pat ? '' : ' (GitHub allows 60 an hour without a token)'}. Add a token, select fewer ${W.noun}, include fewer comments, or fetch anyway and get the rest later.`,
                    { showTokenBtn: !pat, showRetryBtn: true, retryLabel: 'Fetch anyway', onRetry: () => { hidePersistentWarning(); buildSelectedContext(summaryOnly, true); } }
                );
                // The banner sits just below the sticky header, which is scrolled away once results show.
                if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: 'smooth' });
                return;
            }

            if (buildController) buildController.abort();
            buildController = new AbortController();
            const myController = buildController;
            dom.abortBtn.style.display = 'inline-flex';
            dom.buildContextBtn.disabled = true;
            const buildStatus = begin(`Fetching comments for ${missingComments.length} ${W.one}(s)…`, { button: dom.buildContextBtn, percent: 0 });

            try {
                log(`[FETCH] Fetching comment threads for ${missingComments.length} ${W.one}(s)...`);
                const fetchComments = IS_DISCUSSIONS ? fetchCommentsForDiscussions : fetchCommentsForIssues;
                const { commentsByIssue: fetchedMap, failures, stats: fetchStats } = await fetchComments(currentRepoInfo.owner, currentRepoInfo.repo, missingComments, {
                    pat,
                    signal: buildController.signal,
                    universe: allIssues,
                    onHeaders: updateRateLimitUI,
                    onProgress: (done, total) => progress(buildStatus, { message: `Fetching comments… ${done} of ${total} ${W.noun}`, percent: (done / Math.max(total, 1)) * 100 }),
                    onThread: (num, comms) => {
                        if (thisBuildGen !== buildGeneration || myController.signal.aborted) return;
                        cachedCommentsByIssue.set(num, comms);
                        fetchFailuresMap.delete(num);
                    }
                });
                if (thisBuildGen !== buildGeneration) return;
                if (fetchStats) {
                    if (fetchStats.rateLimited) lastFetchRateLimited = true;
                    log(`[FETCH] ${fetchStats.strategy}: ~${fetchStats.requests} request(s) (per-${W.one} estimate was ${fetchStats.perIssueRequestsEstimate}).`);
                }
                for (const [num, comms] of fetchedMap.entries()) {
                    cachedCommentsByIssue.set(num, comms);
                    fetchFailuresMap.delete(num);
                }
                if (failures && failures.length > 0) {
                    for (const f of failures) {
                        fetchFailuresMap.set(f.number, f.error);
                    }
                    log(`[WARN] ${failures.length} thread(s) failed to load comments.`);
                    showToast(`${failures.length} thread(s) failed to load comments. Rebuild to retry.`, 'warn');
                    const hasRateLimitFailure = failures.some(f => f.isRateLimit || (f.error && f.error.includes('rate limit')));
                    if (hasRateLimitFailure) lastFetchRateLimited = true;
                    showPersistentWarning(
                        `${failures.length} comment thread(s) failed to load.${hasRateLimitFailure ? ' Rate limit reached.' : ''} Output context is incomplete.`,
                        {
                            showTokenBtn: !pat,
                            showRetryBtn: true,
                            onRetry: () => buildSelectedContext(summaryOnly)
                        }
                    );
                } else if (fetchFailuresMap.size === 0) {
                    hidePersistentWarning();
                }
            } catch (err) {
                if (err.name === 'AbortError') {
                    log('[CANCEL] Comment fetch cancelled.');
                    return;
                }
                log(`[ERROR] Comment fetch error: ${err.message}`);
                showToast(err.message, 'error');
            } finally {
                end(buildStatus);
                if (buildController === myController && thisBuildGen === buildGeneration) {
                    dom.buildContextBtn.disabled = false;
                    dom.abortBtn.style.display = 'none';
                }
            }
        }
    }

    if (thisBuildGen !== buildGeneration) return;

    const cleanOptions = {
        commentScope,
        stripImages: dom.stripImages.checked,
        filterBots: dom.filterBots.checked,
        filterNoise: dom.filterNoise.checked,
        stripTemplates: dom.stripTemplates.checked,
        isRedact: dom.redactSecrets ? dom.redactSecrets.checked : true,
        aggressiveRedact: dom.aggressiveRedact ? dom.aggressiveRedact.checked : true,
        maxLogLines: parseInt(dom.maxLogLines.value, 10) || 0,
        knownNumbers: new Set(allIssues.map(i => i.number))
    };

    // Scan only what this build includes: titles, labels, bodies and the comments that the
    // scope / bot / noise filters keep. A summary-only export includes none of these.
    const secretRows = [];
    const flaggedNumbers = new Set();
    if (!summaryOnly) {
        for (const iss of targetIssues) {
            const parts = [
                { where: 'title', text: iss.title },
                { where: 'labels', text: (iss.labels || []).join('\n') },
                { where: 'body', text: iss.body }
            ];
            const rawComms = cachedCommentsByIssue.get(iss.number) || [];
            const { kept } = filterIncludedComments(iss, rawComms, cleanOptions);
            kept.forEach(c => {
                const idx = rawComms.indexOf(c) + 1;
                parts.push({ where: `comment ${idx}`, text: c.body });
            });
            for (const part of parts) {
                if (!part.text) continue;
                const findings = scanForSecrets(`issue-${iss.number}-${part.where}`, part.text, { assumeConfig: true });
                for (const f of findings) {
                    flaggedNumbers.add(iss.number);
                    const isSingleLine = part.where === 'title' || part.where === 'labels';
                    const location = isSingleLine ? part.where : `${part.where} L${f.line}`;
                    secretRows.push({ number: iss.number, type: f.type, line: location, preview: f.preview });
                }
            }
        }
    }
    updateSecretsPanel(secretRows, flaggedNumbers);

    const processedIssues = summaryOnly
        ? []
        : targetIssues.map(iss => {
            const rawComms = cachedCommentsByIssue.get(iss.number) || [];
            const commsFailed = fetchFailuresMap.has(iss.number) && !cachedCommentsByIssue.has(iss.number);
            const commsError = fetchFailuresMap.get(iss.number) || null;
            return processIssueThread(iss, rawComms, {
                ...cleanOptions,
                commentsFetchFailed: commsFailed,
                commentsFetchError: commsError,
                commentsTruncated: Boolean(rawComms.truncated)
            });
        });

    const totalCommentsIncluded = processedIssues.reduce((acc, i) => acc + i.cleanedComments.length, 0);
    if (!summaryOnly && commentScope !== 'none') {
        const agg = processedIssues.reduce((a, i) => {
            const cs = i.commentStats || {};
            for (const k of ['raw', 'kept', 'bots', 'scope', 'noise', 'empty']) a[k] += cs[k] || 0;
            return a;
        }, { raw: 0, kept: 0, bots: 0, scope: 0, noise: 0, empty: 0 });
        const failedThreads = processedIssues.filter(i => i.commentsFetchFailed).length;
        const noCommentThreads = processedIssues.filter(i => i.commentsCount > 0 && !i.commentsFetchFailed && i.commentStats && i.commentStats.raw === 0).length;
        log(`[INFO] Comments: ${agg.kept} kept of ${agg.raw} fetched (dropped: ${agg.bots} bot, ${agg.scope} out-of-scope, ${agg.noise} low-signal, ${agg.empty} empty); ${failedThreads} thread(s) failed; ${noCommentThreads} thread(s) expected comments but returned none.`);
    }
    const chunkLimitVal = parseInt(dom.chunkLimit.value, 10) || 0;

    const formatOptions = {
        instructions: dom.aiInstructions.value,
        includeNlpSummary: summaryOnly ? true : dom.includeNlpSummary.checked,
        nlpData: nlpResults,
        nlpScope: targetIssues.map(i => i.number),
        kind: KIND
    };

    generatedChunks = chunkIssuesOutput(
        dom.format.value,
        currentRepoInfo,
        processedIssues,
        chunkLimitVal,
        estimateTokens,
        formatOptions
    );

    activeChunkIndex = 0;
    const firstChunk = generatedChunks[0];
    packedOutputText = firstChunk.text;
    outputExt = firstChunk.ext;
    outputMime = firstChunk.mime;

    const chunkTokenList = await Promise.all(generatedChunks.map(c => estimateTokensAsync(c.text)));
    if (thisBuildGen !== buildGeneration) return;

    const totalTokens = chunkTokenList.reduce((a, b) => a + b, 0);
    const totalChars = generatedChunks.reduce((acc, c) => acc + c.text.length, 0);

    let hasOversizedChunk = false;
    generatedChunks.forEach((c, idx) => {
        if (c.exceedsLimit) {
            hasOversizedChunk = true;
            log(`[WARN] Chunk part ${idx + 1}/${generatedChunks.length} exceeds limit of ${chunkLimitVal.toLocaleString()} tokens.`);
        }
    });
    if (hasOversizedChunk) {
        showToast('Warning: 1 or more parts exceed the split token limit.', 'warn');
    }

    dom.statChunks.textContent = generatedChunks.length;
    dom.statIssues.textContent = targetIssues.length;
    dom.statComments.textContent = totalCommentsIncluded.toLocaleString();
    dom.statChars.textContent = totalChars.toLocaleString();

    const maxChunkTokens = chunkTokenList.length ? Math.max(...chunkTokenList) : 0;
    updateBudgetMeterUI(totalTokens, generatedChunks.length, false, maxChunkTokens, hasOversizedChunk);

    if (generatedChunks.length > 1) {
        dom.chunkSelectLabel.style.display = 'inline-block';
        dom.chunkSelect.style.display = 'inline-block';
        dom.downloadAllBtn.style.display = 'inline-flex';
        dom.chunkSelect.innerHTML = generatedChunks.map((_, i) => `<option value="${i}">Part ${i + 1} of ${generatedChunks.length}</option>`).join('');
        updateCopyBtnLabel(0);
        if (dom.nextPartBtn) dom.nextPartBtn.style.display = 'inline-flex';
    } else {
        dom.chunkSelectLabel.style.display = 'none';
        dom.chunkSelect.style.display = 'none';
        dom.downloadAllBtn.style.display = 'none';
        updateCopyBtnLabel(0);
        if (dom.nextPartBtn) dom.nextPartBtn.style.display = 'none';
    }

    dom.outputEmptyState.style.display = 'none';
    dom.previewNotice.style.display = 'none';
    dom.previewArea.style.display = 'none';
    if (dom.togglePreviewBtn) {
        dom.togglePreviewBtn.style.display = 'inline-flex';
        dom.togglePreviewBtn.setAttribute('aria-expanded', 'false');
        dom.togglePreviewBtn.textContent = 'Show preview';
    }
    dom.previewArea.value = packedOutputText.slice(0, 45000) + (packedOutputText.length > 45000 ? '\n\n... [Truncated for preview] ...' : '');
    dom.copyBtn.disabled = false;
    dom.downloadBtn.disabled = false;

    const failedThreads = processedIssues.filter(i => i.commentsFetchFailed).length;
    const resetTime = dom.resetVal ? dom.resetVal.textContent : '';
    const isRedactionOff = dom.redactSecrets ? !dom.redactSecrets.checked : false;
    const bannerItems = buildBannerItems({
        failedThreads,
        rateLimited: lastFetchRateLimited,
        resetTime,
        redactionOff: isRedactionOff,
        secretCount: secretRows.length
    });
    if (dom.warningBanner) {
        renderBanner(dom.warningBanner, bannerItems);
    }

    if (dom.summaryCard) {
        const isRedactOn = dom.redactSecrets ? dom.redactSecrets.checked : true;
        const isAggressiveOn = dom.aggressiveRedact ? dom.aggressiveRedact.checked : true;
        let redactedSecrets = 0;
        secretRows.forEach(r => {
            if (isRedactOn && (r.type !== 'generic-secret' || isAggressiveOn)) redactedSecrets++;
        });

        const summaryLines = buildSummaryLines({
            kind: KIND,
            items: targetIssues.length,
            comments: totalCommentsIncluded,
            tokens: totalTokens,
            parts: generatedChunks.length,
            secretsHidden: redactedSecrets,
            warnings: bannerItems.length
        });
        dom.summaryCard.innerHTML = '';
        summaryLines.forEach(line => {
            const lineEl = document.createElement('div');
            lineEl.textContent = line;
            dom.summaryCard.appendChild(lineEl);
        });
        dom.summaryCard.hidden = false;
    }

    setAppState('built');
    log(`[SUCCESS] Packed ${targetIssues.length} ${W.noun} & ${totalCommentsIncluded} comments (~${totalTokens.toLocaleString()} tokens).`);
}

function updateSecretsPanel(rows, flaggedNumbers) {
    if (rows.length === 0) {
        dom.secretsWarningPanel.style.display = 'none';
        return;
    }
    dom.secretsWarningPanel.style.display = 'flex';

    const isRedactOn = dom.redactSecrets ? dom.redactSecrets.checked : true;
    const isAggressiveOn = dom.aggressiveRedact ? dom.aggressiveRedact.checked : true;

    let redactedCount = 0;
    let presentCount = 0;

    const rowData = rows.map(r => {
        const isRedacted = isRedactOn && (r.type !== 'generic-secret' || isAggressiveOn);
        if (isRedacted) redactedCount++;
        else presentCount++;
        return {
            ...r,
            isRedacted
        };
    });

    if (presentCount > 0) {
        const hint = (!isAggressiveOn && isRedactOn)
            ? ` (enable Aggressive redaction or deselect ${W.one})`
            : ` (enable Redact secrets or deselect ${W.one})`;
        dom.secretsWarningSummary.textContent = `${rows.length} secret(s) in ${flaggedNumbers.size} ${W.one}(s): ${redactedCount} redacted, ${presentCount} still present${hint}.`;
    } else {
        dom.secretsWarningSummary.textContent = `${rows.length} secret(s) in ${flaggedNumbers.size} ${W.one}(s) (all redacted).`;
    }

    dom.secretsTableBody.innerHTML = rowData.map(r => `
        <tr>
            <td>#${r.number}</td>
            <td>${escapeXml(r.type)}</td>
            <td>${escapeXml(String(r.line))}</td>
            <td>${escapeXml(r.preview)}</td>
            <td>${r.isRedacted ? '<span class="status-fits" style="font-weight:600;">Redacted</span>' : '<span class="status-over" style="font-weight:600;">Present in output</span>'}</td>
            <td><button type="button" class="secondary btn-xs deselect-secret-issue" data-num="${r.number}">Deselect #${r.number}</button></td>
        </tr>
    `).join('');

    dom.secretsTableBody.querySelectorAll('.deselect-secret-issue').forEach(btn => {
        btn.addEventListener('click', () => {
            const num = parseInt(btn.getAttribute('data-num'), 10);
            selectedIssueNumbers.delete(num);
            renderIssuesList();
            buildSelectedContext(false);
        });
    });

    dom.excludeAllSecretsBtn.onclick = () => {
        for (const num of flaggedNumbers) selectedIssueNumbers.delete(num);
        renderIssuesList();
        buildSelectedContext(false);
    };
}

dom.buildContextBtn.addEventListener('click', () => buildSelectedContext(false));

// The repo form never submits (Enter is handled by the buttons); kept out of HTML for the CSP.
const sourceFormEl = document.getElementById('sourceForm');
if (sourceFormEl) sourceFormEl.addEventListener('submit', (e) => e.preventDefault());

dom.exportNlpOnlyBtn.addEventListener('click', () => buildSelectedContext(true));
dom.abortBtn.addEventListener('click', () => {
    if (loadController) loadController.abort();
    if (buildController) buildController.abort();
});

if (dom.targetBar) {
    dom.targetBar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-target]');
        if (!b) return;
        applyTarget(b.dataset.target);
        if (currentAppState === 'built') buildSelectedContext(lastBuildSummaryOnly);
    });
}

if (dom.redactLevel) {
    dom.redactLevel.addEventListener('change', () => {
        syncCheckboxesFromRedactLevel();
        updateSettingsSummary();
        saveSettings();
        if (currentAppState === 'built') buildSelectedContext(lastBuildSummaryOnly);
    });
}

if (dom.secretsControl) {
    dom.secretsControl.addEventListener('change', () => {
        if (dom.redactLevel) dom.redactLevel.value = dom.secretsControl.value;
        syncCheckboxesFromRedactLevel();
        updateSettingsSummary();
        saveSettings();
        if (currentAppState === 'built') buildSelectedContext(lastBuildSummaryOnly);
    });
}

[dom.format, dom.chunkLimit].forEach(el => {
    if (el) el.addEventListener('change', () => {
        const fmt = dom.format ? dom.format.value : '';
        const chunkVal = parseInt(dom.chunkLimit ? dom.chunkLimit.value : '0', 10) || 0;
        const detected = detectTarget(fmt, chunkVal);
        if (currentTargetKey !== detected) {
            currentTargetKey = detected;
            updateTargetVisibility(currentTargetKey);
            if (dom.targetBar) {
                const buttons = dom.targetBar.querySelectorAll('button[data-target]');
                buttons.forEach(btn => {
                    btn.setAttribute('aria-pressed', btn.dataset.target === currentTargetKey ? 'true' : 'false');
                });
            }
        }
        updateCopyBtnLabel(activeChunkIndex);
        updateSettingsSummary();
        saveSettings();
        if (currentAppState === 'built') buildSelectedContext(lastBuildSummaryOnly);
    });
});

[dom.commentScope, dom.maxLogLines, dom.stripImages, dom.filterBots, dom.filterNoise, dom.includeNlpSummary, dom.redactSecrets, dom.aggressiveRedact, dom.stripTemplates].forEach(el => {
    if (el) el.addEventListener('change', () => {
        if (el === dom.redactSecrets || el === dom.aggressiveRedact) {
            syncRedactLevelFromCheckboxes();
        }
        if (el === dom.commentScope) {
            updateCommentScopeBarUI();
            updateSelectionTelemetry();
        }
        updateSettingsSummary();
        saveSettings();
        if (currentAppState === 'built') buildSelectedContext(lastBuildSummaryOnly);
    });
});

if (dom.commentScopeBar) {
    dom.commentScopeBar.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-scope]');
        if (!b) return;
        if (dom.commentScope) {
            dom.commentScope.value = b.dataset.scope;
            updateCommentScopeBarUI();
            dom.commentScope.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });
}

dom.aiInstructions.addEventListener('input', () => {
    dom.instructionsCharCount.textContent = `${dom.aiInstructions.value.length} chars`;
    saveSettings();
    if (currentAppState === 'built') {
        if (inputDebounceTimer) clearTimeout(inputDebounceTimer);
        inputDebounceTimer = setTimeout(() => {
            buildSelectedContext(lastBuildSummaryOnly);
        }, 300);
    }
});

if (dom.tabIssuesBtn && dom.tabOutputBtn) {
    dom.tabIssuesBtn.addEventListener('click', () => {
        switchTab(dom.tabIssuesBtn, dom.tabOutputBtn, dom.issuesCard, dom.outputCard);
    });

    dom.tabOutputBtn.addEventListener('click', () => {
        switchTab(dom.tabOutputBtn, dom.tabIssuesBtn, dom.outputCard, dom.issuesCard);
    });

    const tabs = [dom.tabIssuesBtn, dom.tabOutputBtn];
    tabs.forEach((tab, index) => {
        tab.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const nextIndex = (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                tabs[nextIndex].focus();
                tabs[nextIndex].click();
            }
        });
    });
}

if (dom.mobilePrimaryBtn) {
    dom.mobilePrimaryBtn.addEventListener('click', async () => {
        if (currentAppState === 'empty') {
            dom.loadIssuesBtn.click();
        } else if (currentAppState === 'loaded') {
            await buildSelectedContext(false);
            if (dom.tabOutputBtn) dom.tabOutputBtn.click();
        } else if (currentAppState === 'built') {
            dom.copyBtn.click();
        }
    });
}

dom.clearInstructionsBtn.addEventListener('click', () => {
    dom.aiInstructions.value = '';
    dom.instructionsCharCount.textContent = '0 chars';
    saveSettings();
    if (currentAppState === 'built') buildSelectedContext(lastBuildSummaryOnly);
});

document.querySelectorAll('.preset-buttons button[data-instruction]').forEach(btn => {
    btn.addEventListener('click', () => {
        dom.aiInstructions.value = btn.getAttribute('data-instruction');
        dom.instructionsCharCount.textContent = `${dom.aiInstructions.value.length} chars`;
        saveSettings();
        if (currentAppState === 'built') buildSelectedContext(lastBuildSummaryOnly);
    });
});

document.querySelectorAll('.budget-presets .preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const val = parseInt(btn.getAttribute('data-preset'), 10);
        if (val) {
            currentBudgetWindow = val;
            dom.targetBudgetDisplay.textContent = `of ${val.toLocaleString()} estimated tokens`;
            if (dom.chunkLimit) {
                dom.chunkLimit.value = val.toString();
                dom.chunkLimit.dispatchEvent(new Event('change', { bubbles: true }));
            }
            const detected = detectTarget(dom.format ? dom.format.value : '', val);
            applyTarget(detected);
            saveSettings();
            if (currentAppState === 'built') buildSelectedContext(lastBuildSummaryOnly);
        }
    });
});

function updateActiveChunkView(index) {
    if (index < 0 || index >= generatedChunks.length) return;
    activeChunkIndex = index;
    if (dom.chunkSelect) dom.chunkSelect.value = String(activeChunkIndex);
    const chunk = generatedChunks[activeChunkIndex];
    if (!chunk) return;
    packedOutputText = chunk.text;
    outputExt = chunk.ext;
    outputMime = chunk.mime;

    updateCopyBtnLabel(activeChunkIndex);
    if (generatedChunks.length > 1) {
        if (dom.nextPartBtn) {
            dom.nextPartBtn.style.display = activeChunkIndex < generatedChunks.length - 1 ? 'inline-flex' : 'none';
        }
    } else {
        if (dom.nextPartBtn) dom.nextPartBtn.style.display = 'none';
    }

    dom.previewArea.value = packedOutputText.slice(0, 45000) + (packedOutputText.length > 45000 ? '\n\n... [Truncated for preview] ...' : '');
    const isExpanded = dom.togglePreviewBtn && dom.togglePreviewBtn.getAttribute('aria-expanded') === 'true';
    if (dom.previewNotice) dom.previewNotice.style.display = isExpanded && packedOutputText.length > 45000 ? 'block' : 'none';
    if (dom.previewArea) dom.previewArea.style.display = isExpanded ? 'block' : 'none';
}

dom.chunkSelect.addEventListener('change', () => {
    const idx = parseInt(dom.chunkSelect.value, 10) || 0;
    updateActiveChunkView(idx);
});

if (dom.nextPartBtn) {
    dom.nextPartBtn.addEventListener('click', () => {
        if (activeChunkIndex < generatedChunks.length - 1) {
            updateActiveChunkView(activeChunkIndex + 1);
        }
    });
}

function triggerDownload(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

dom.downloadBtn.addEventListener('click', () => {
    const repoName = currentRepoInfo ? currentRepoInfo.repo : W.noun;
    const suffix = generatedChunks.length > 1 ? `-part${activeChunkIndex + 1}-of-${generatedChunks.length}` : '';
    triggerDownload(packedOutputText, `${repoName}-${W.noun}${suffix}.${outputExt}`, outputMime);
});

dom.downloadAllBtn.addEventListener('click', async () => {
    const repoName = currentRepoInfo ? currentRepoInfo.repo : W.noun;
    for (let i = 0; i < generatedChunks.length; i++) {
        triggerDownload(generatedChunks[i].text, `${repoName}-${W.noun}-part${i + 1}-of-${generatedChunks.length}.${generatedChunks[i].ext}`, generatedChunks[i].mime);
        await sleep(150);
    }
});

dom.copyBtn.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(packedOutputText);
        const numParts = generatedChunks.length;
        if (numParts > 1) {
            showToast(`Copied part ${activeChunkIndex + 1} of ${numParts}. Pick the next part from the Part menu.`, 'info');
        } else {
            showToast(`Copied ${W.noun} context to clipboard!`, 'info');
        }
        dom.copyBtn.textContent = 'Copied!';
        showCopyHint(dom.copyBtn, currentTargetKey, { part: activeChunkIndex + 1, parts: Math.max(1, numParts) });
        setTimeout(() => updateCopyBtnLabel(activeChunkIndex), 2000);
    } catch (_) {
        showToast('Unable to copy automatically.', 'error');
    }
});

if (dom.togglePreviewBtn && dom.previewArea) {
    dom.togglePreviewBtn.addEventListener('click', () => {
        const isExpanded = dom.togglePreviewBtn.getAttribute('aria-expanded') === 'true';
        if (isExpanded) {
            dom.togglePreviewBtn.setAttribute('aria-expanded', 'false');
            dom.togglePreviewBtn.textContent = 'Show preview';
            dom.previewArea.style.display = 'none';
            if (dom.previewNotice) dom.previewNotice.style.display = 'none';
        } else {
            dom.togglePreviewBtn.setAttribute('aria-expanded', 'true');
            dom.togglePreviewBtn.textContent = 'Hide preview';
            dom.previewArea.style.display = 'block';
            if (dom.previewNotice) dom.previewNotice.style.display = packedOutputText.length > 45000 ? 'block' : 'none';
        }
    });
}

dom.wrapToggleBtn.addEventListener('click', () => {
    const isWrapped = dom.previewArea.classList.toggle('wrap');
    dom.wrapToggleBtn.setAttribute('aria-pressed', isWrapped ? 'true' : 'false');
});

dom.shareUrlBtn.addEventListener('click', async () => {
    const url = new URL(window.location.href.split('?')[0]);
    const repoVal = dom.repoUrl.value.trim();
    if (repoVal) url.searchParams.set('repo', repoVal);
    // Only non-default options go in the link; a format makes the recipient land on "Custom".
    if (currentTargetKey === 'custom' && dom.format) url.searchParams.set('format', dom.format.value);
    if (dom.commentScope && dom.commentScope.value !== 'all') url.searchParams.set('commentScope', dom.commentScope.value);
    if (dom.includePrs && dom.includePrs.value !== 'issues') url.searchParams.set('includePrs', dom.includePrs.value);
    try {
        await navigator.clipboard.writeText(url.toString());
        showToast('Deep-link URL copied!', 'info');
    } catch (_) {}
});

loadSavedSettings();
// URL parameters win over saved settings.
if (dom.format && VALID_FORMATS.includes(urlParams.get('format'))) dom.format.value = urlParams.get('format');
if (dom.commentScope && VALID_COMMENT_SCOPES.includes(urlParams.get('commentScope'))) dom.commentScope.value = urlParams.get('commentScope');
if (dom.includePrs && VALID_ITEM_TYPES.includes(urlParams.get('includePrs'))) dom.includePrs.value = urlParams.get('includePrs');
syncRedactLevelFromCheckboxes();
updateCommentScopeBarUI();

// Startup target resolution:
// ?format= in URL -> 'custom'; else saved cfg_target; else 'claude'
if (VALID_FORMATS.includes(urlParams.get('format'))) {
    applyTarget('custom');
} else {
    let savedTarget = null;
    try { savedTarget = localStorage.getItem('cfg_target'); } catch (_) {}
    if (savedTarget && (savedTarget in TARGETS)) {
        applyTarget(savedTarget);
    } else {
        // Returning user from before targets existed: keep their saved format and split size.
        let hasLegacySettings = false;
        try { hasLegacySettings = localStorage.getItem('cfg_format') !== null || localStorage.getItem('cfg_chunkLimit') !== null; } catch (_) {}
        applyTarget(hasLegacySettings
            ? detectTarget(dom.format ? dom.format.value : '', parseInt(dom.chunkLimit ? dom.chunkLimit.value : '0', 10) || 0)
            : 'claude');
    }
}

updateSettingsSummary();
updateCopyBtnLabel(0);
setAppState('empty');
initTokenLinks(showTokenPanel);
startFromShortcut(dom.loadIssuesBtn, dom.repoUrl);
initShortcuts({
    main: () => (currentAppState === 'empty' ? dom.loadIssuesBtn : dom.buildContextBtn),
    copy: dom.copyBtn,
    mainButtons: [dom.loadIssuesBtn, dom.buildContextBtn]
});
// The token field starts open on the Discussions page; its help text explains why (official API).
if (IS_DISCUSSIONS) showTokenPanel('');

// Settings drawer token link
if (dom.drawerTokenLink) {
    dom.drawerTokenLink.addEventListener('click', (e) => {
        e.preventDefault();
        showTokenPanel('');
    });
}

// Delegated click listener on #exampleRepos
const exampleReposEl = dom.exampleRepos || document.getElementById('exampleRepos');
if (exampleReposEl) {
    exampleReposEl.addEventListener('click', (e) => {
        const b = e.target.closest('[data-repo]');
        if (!b) return;
        if (dom.repoUrl) {
            dom.repoUrl.value = b.dataset.repo;
            if (dom.repoInputError) dom.repoInputError.style.display = 'none';
        }
        if (dom.loadIssuesBtn) {
            dom.loadIssuesBtn.click();
        }
    });
}
