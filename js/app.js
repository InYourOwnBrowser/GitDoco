/**
 * Main Application Controller & DOM Orchestration
 */
import { ALWAYS_IGNORED_DIRS, ROOT_IGNORED_DIRS, IGNORED_FILES } from './config.js';

function isIgnoredDirPath(dirParts) {
    if (!dirParts || dirParts.length === 0) return false;
    for (let i = 0; i < dirParts.length; i++) {
        const seg = dirParts[i].toLowerCase();
        if (ALWAYS_IGNORED_DIRS.has(seg)) return true;
        if (i === 0 && ROOT_IGNORED_DIRS.has(seg)) return true;
    }
    return false;
}
import { switchTab } from './ui-tabs.js';
import { estimateTokens, estimateTokensAsync } from './tokenizer.js';
import { generateTree, renderInteractiveTree } from './tree.js';
import { buildContextOutput, chunkContextOutput, escapeXml } from './formatters.js';
import { minifyCode } from './minifier.js';
import { scanForSecrets, redactSecrets } from './secrets.js';
import { buildBannerItems, renderBanner } from './ui-banner.js';
import { TARGETS, detectTarget } from './targets.js';
import { buildSettingsSummary } from './settings-summary.js';
import { defaultExcludedPaths, rankSuggestions } from './suggestions.js';
import { buildSummaryLines } from './ui-summary.js';
import { buildTabHref, startFromShortcut } from './nav.js';
import { parseZipArchive } from './zip-loader.js';
import { githubFileUrl } from './links.js';
import { confirmFirstUse } from './first-use.js';
import * as status from './ui-status.js';
import { showCopyHint, hideCopyHint, initShortcuts } from './ui-actions.js';
import {
    parseRepoInput,
    isSafeBranchName,
    fetchRateLimit,
    resolveDefaultBranch,
    fetchRepoTree,
    fetchFileContent,
    sleep
} from './github-api.js';

let abortController = null;
let generatedChunks = [];
let activeChunkIndex = 0;
let packedOutputText = "";
let outputExt = "xml";
let outputMime = "application/xml";

let cachedRawFiles = []; // [{ path: string, rawContent: string }]
let secretsMap = new Map(); // path -> Array<{ type, line, preview }>
let activeTreeControls = null;

let cachedSkippedPaths = new Set();
let cachedRepoInfo = null;
let activeZip = null; // parsed local .zip archive while one is loaded, else null
let cachedBranch = "";
let cachedFailedCount = 0;
let isTreeTruncated = false;
let countSkippedLarge = 0;
let currentActiveSelection = [];
let isPrivateRepo = false;
let currentGeneration = 0;
let repackGeneration = 0;
let isDownloading = false;
let activeFetchCount = 0;

let currentBudgetWindow = 200000;
let currentAppState = 'empty'; // 'empty' | 'loaded' | 'built'
let totalTokensAllChunks = 0;
let currentTargetKey = 'claude';

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
    branchTokenGroup: document.getElementById('branchTokenGroup'),
    repoUrl: document.getElementById('repoUrl'),
    branch: document.getElementById('branch'),
    pat: document.getElementById('pat'),
    rateBadge: document.getElementById('rateBadge'),
    quotaVal: document.getElementById('quotaVal'),
    quotaRemainingText: document.getElementById('quotaRemainingText'),
    resetVal: document.getElementById('resetVal'),
    budgetBanner: document.getElementById('budgetBanner'),
    budgetSuggestions: document.getElementById('budgetSuggestions'),
    budgetPresets: document.querySelector('.budget-presets'),
    workspacePanes: document.getElementById('workspacePanes'),
    logCard: document.getElementById('logCard'),
    targetBar: document.getElementById('targetBar'),
    formatField: document.getElementById('formatField'),
    format: document.getElementById('format'),
    maxKb: document.getElementById('maxKb'),
    throttleMs: document.getElementById('throttleMs'),
    ignoreExt: document.getElementById('ignoreExt'),
    minifyMode: document.getElementById('minifyMode'),
    chunkLimitField: document.getElementById('chunkLimitField'),
    chunkLimit: document.getElementById('chunkLimit'),
    redactLevel: document.getElementById('redactLevel'),
    secretsControl: document.getElementById('secretsControl'),
    redactSecrets: document.getElementById('redactSecrets'),
    aggressiveRedact: document.getElementById('aggressiveRedact'),
    aiInstructions: document.getElementById('aiInstructions'),
    clearInstructionsBtn: document.getElementById('clearInstructionsBtn'),
    instructionsCharCount: document.getElementById('instructionsCharCount'),
    summaryCard: document.getElementById('summaryCard'),
    togglePreviewBtn: document.getElementById('togglePreviewBtn'),
    secretsWarningPanel: document.getElementById('secretsWarningPanel'),
    secretsWarningSummary: document.getElementById('secretsWarningSummary'),
    excludeAllSecretsBtn: document.getElementById('excludeAllSecretsBtn'),
    secretsTableBody: document.getElementById('secretsTableBody'),
    packBtn: document.getElementById('packBtn'),
    uploadZipBtn: document.getElementById('uploadZipBtn'),
    zipFileInput: document.getElementById('zipFileInput'),
    zipSourceNote: document.getElementById('zipSourceNote'),
    shareUrlBtn: document.getElementById('shareUrlBtn'),
    persistentWarningBanner: document.getElementById('persistentWarningBanner'),
    warningBannerText: document.getElementById('warningBannerText'),
    warningBannerTokenBtn: document.getElementById('warningBannerTokenBtn'),
    warningBannerRetryBtn: document.getElementById('warningBannerRetryBtn'),
    warningBannerDismissBtn: document.getElementById('warningBannerDismissBtn'),
    abortBtn: document.getElementById('abortBtn'),
    optionsToggleBtn: document.getElementById('optionsToggleBtn'),
    optionsToggleSummary: document.getElementById('optionsToggleSummary'),
    optionsDrawer: document.getElementById('optionsDrawer'),
    drawerDoneBtn: document.getElementById('drawerDoneBtn'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    repoInputError: document.getElementById('repoInputError'),
    progressTrack: document.getElementById('progressTrack'),
    progressFill: document.getElementById('progressFill'),
    logHeader: document.getElementById('logHeader'),
    logSummary: document.getElementById('logSummary'),
    logToggleBtn: document.getElementById('logToggleBtn'),
    log: document.getElementById('log'),
    treeCard: document.getElementById('treeCard'),
    treeEmptyState: document.getElementById('treeEmptyState'),
    treeContainer: document.getElementById('treeContainer'),
    manifestCount: document.getElementById('manifestCount'),
    selectedCount: document.getElementById('selectedCount'),
    selectedTokensBadge: document.getElementById('selectedTokensBadge'),
    defaultsNote: document.getElementById('defaultsNote'),
    selectAllBtn: document.getElementById('selectAllBtn'),
    deselectAllBtn: document.getElementById('deselectAllBtn'),
    deselectLargeBtn: document.getElementById('deselectLargeBtn'),
    largeFileThresholdKb: document.getElementById('largeFileThresholdKb'),
    expandAllBtn: document.getElementById('expandAllBtn'),
    collapseAllBtn: document.getElementById('collapseAllBtn'),
    treeFilterInput: document.getElementById('treeFilterInput'),
    searchMatchCount: document.getElementById('searchMatchCount'),
    startDownloadBtn: document.getElementById('startDownloadBtn'),
    outputCard: document.getElementById('outputCard'),
    outputEmptyState: document.getElementById('outputEmptyState'),
    statFiles: document.getElementById('statFiles'),
    statTokens: document.getElementById('statTokens'),
    statChars: document.getElementById('statChars'),
    statChunks: document.getElementById('statChunks'),
    targetBudgetDisplay: document.getElementById('targetBudgetDisplay'),
    budgetFill: document.getElementById('budgetFill'),
    budgetStatusText: document.getElementById('budgetStatusText'),
    chunkSelectLabel: document.getElementById('chunkSelectLabel'),
    chunkSelect: document.getElementById('chunkSelect'),
    previewNotice: document.getElementById('previewNotice'),
    previewArea: document.getElementById('previewArea'),
    wrapToggleBtn: document.getElementById('wrapToggleBtn'),
    copyBtn: document.getElementById('copyBtn'),
    nextPartBtn: document.getElementById('nextPartBtn'),
    downloadBtn: document.getElementById('downloadBtn'),
    downloadAllBtn: document.getElementById('downloadAllBtn'),
    warningBanner: document.getElementById('warningBanner'),
    toastContainer: document.getElementById('toastContainer'),
    tabFilesBtn: document.getElementById('tabFilesBtn'),
    tabOutputBtn: document.getElementById('tabOutputBtn'),
    stickyActionBar: document.getElementById('stickyActionBar'),
    mobilePrimaryBtn: document.getElementById('mobilePrimaryBtn'),
    step1: document.getElementById('step1'),
    step2: document.getElementById('step2'),
    step3: document.getElementById('step3')
};

// --- Toast & Inline Notifications ---
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

function showInlineError(msg) {
    if (dom.repoInputError) {
        if (msg) {
            dom.repoInputError.textContent = msg;
            dom.repoInputError.style.display = 'block';
        } else {
            dom.repoInputError.style.display = 'none';
        }
    }
}

// --- Theme Management ---
function initTheme() {
    try {
        const savedTheme = localStorage.getItem('app_theme');
        if (savedTheme === 'dark' || savedTheme === 'light') {
            document.documentElement.setAttribute('data-theme', savedTheme);
        }
    } catch (_) {}
}

if (dom.themeToggleBtn) {
    dom.themeToggleBtn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        let next = 'dark';
        if (current === 'dark') next = 'light';
        else if (current === 'light') next = 'dark';
        else {
            const isDarkSystem = window.matchMedia('(prefers-color-scheme: dark)').matches;
            next = isDarkSystem ? 'light' : 'dark';
        }
        document.documentElement.setAttribute('data-theme', next);
        try {
            localStorage.setItem('app_theme', next);
        } catch (_) {}
    });
}
initTheme();

// --- Persistence ---
function updateCharCount() {
    if (dom.instructionsCharCount && dom.aiInstructions) {
        dom.instructionsCharCount.textContent = `${dom.aiInstructions.value.length} chars`;
    }
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

export function formatSettingsSummaryCode({ format, minifyMode, secretsMode }) {
    const targetKey = detectTarget(format, currentBudgetWindow);
    const targetLabel = TARGETS[targetKey]?.label || 'Custom';
    return 'Settings: ' + buildSettingsSummary({
        targetLabel,
        minifyMode,
        redactLevel: secretsMode,
        chunkLimit: parseInt(dom.chunkLimit ? dom.chunkLimit.value : '0', 10) || 0
    });
}

function updateSettingsSummary() {
    const target = TARGETS[currentTargetKey] || TARGETS.custom;
    const targetLabel = target.label;
    const minifyMode = dom.minifyMode ? dom.minifyMode.value : 'none';
    const redactLevel = dom.redactLevel ? dom.redactLevel.value : 'standard';
    const chunkLimit = parseInt(dom.chunkLimit ? dom.chunkLimit.value : '0', 10) || 0;

    const summaryText = 'Settings: ' + buildSettingsSummary({
        targetLabel,
        minifyMode,
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
    const isAggressive = dom.aggressiveRedact ? dom.aggressiveRedact.checked : false;
    const level = !isRedact ? 'off' : (isAggressive ? 'strict' : 'standard');
    if (dom.redactLevel) dom.redactLevel.value = level;
    if (dom.secretsControl) dom.secretsControl.value = level;
}

function syncCheckboxesFromRedactLevel() {
    const level = dom.redactLevel ? dom.redactLevel.value : (dom.secretsControl ? dom.secretsControl.value : 'standard');
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

    if (currentAppState === 'built') {
        updateBudgetMeterUI(totalTokensAllChunks, generatedChunks.length || 1, false);
    } else {
        const preBuildTokens = activeTreeControls && activeTreeControls.getSelectedStats
            ? activeTreeControls.getSelectedStats().estTokens
            : 0;
        updateBudgetMeterUI(preBuildTokens, 1, true);
    }
    updateSettingsSummary();
    updateCopyBtnLabel(activeChunkIndex);
}

function updateCopyBtnLabel(activeIndex = 0) {
    const label = getCopyButtonLabel(currentTargetKey, activeIndex, generatedChunks.length);
    if (dom.copyBtn) dom.copyBtn.textContent = label;
    if (dom.mobilePrimaryBtn && currentAppState === 'built') dom.mobilePrimaryBtn.textContent = label;
}

function loadSavedSettings() {
    try {
        if (dom.format && localStorage.getItem('cfg_format')) dom.format.value = localStorage.getItem('cfg_format');
        if (dom.minifyMode && localStorage.getItem('cfg_minifyMode')) dom.minifyMode.value = localStorage.getItem('cfg_minifyMode');
        if (dom.chunkLimit && localStorage.getItem('cfg_chunkLimit')) dom.chunkLimit.value = localStorage.getItem('cfg_chunkLimit');
        if (dom.maxKb && localStorage.getItem('cfg_maxKb')) dom.maxKb.value = localStorage.getItem('cfg_maxKb');
        if (dom.throttleMs && localStorage.getItem('cfg_throttleMs')) dom.throttleMs.value = localStorage.getItem('cfg_throttleMs');
        if (dom.ignoreExt && localStorage.getItem('cfg_ignoreExt')) dom.ignoreExt.value = localStorage.getItem('cfg_ignoreExt');
        if (dom.redactSecrets && localStorage.getItem('cfg_redactSecrets') !== null) {
            dom.redactSecrets.checked = localStorage.getItem('cfg_redactSecrets') !== 'false';
        }
        if (dom.aggressiveRedact && localStorage.getItem('cfg_aggressiveRedact') !== null) {
            dom.aggressiveRedact.checked = localStorage.getItem('cfg_aggressiveRedact') === 'true';
        }
        syncRedactLevelFromCheckboxes();
        if (dom.aiInstructions && localStorage.getItem('cfg_aiInstructions') !== null) {
            dom.aiInstructions.value = localStorage.getItem('cfg_aiInstructions');
            updateCharCount();
        }
        if (localStorage.getItem('cfg_budgetWindow')) {
            currentBudgetWindow = parseInt(localStorage.getItem('cfg_budgetWindow'), 10) || 200000;
        }
        updateSettingsSummary();
    } catch (_) {}
}

function saveSettings() {
    try {
        if (dom.format) localStorage.setItem('cfg_format', dom.format.value);
        if (dom.minifyMode) localStorage.setItem('cfg_minifyMode', dom.minifyMode.value);
        if (dom.chunkLimit) localStorage.setItem('cfg_chunkLimit', dom.chunkLimit.value);
        if (dom.maxKb) localStorage.setItem('cfg_maxKb', dom.maxKb.value);
        if (dom.throttleMs) localStorage.setItem('cfg_throttleMs', dom.throttleMs.value);
        if (dom.ignoreExt) localStorage.setItem('cfg_ignoreExt', dom.ignoreExt.value);
        if (dom.redactSecrets) localStorage.setItem('cfg_redactSecrets', dom.redactSecrets.checked ? 'true' : 'false');
        if (dom.aggressiveRedact) localStorage.setItem('cfg_aggressiveRedact', dom.aggressiveRedact.checked ? 'true' : 'false');
        if (dom.aiInstructions) localStorage.setItem('cfg_aiInstructions', dom.aiInstructions.value);
        localStorage.setItem('cfg_budgetWindow', currentBudgetWindow.toString());
        updateSettingsSummary();
    } catch (_) {}
}

// Options Drawer Toggle
if (dom.optionsToggleBtn && dom.optionsDrawer) {
    dom.optionsToggleBtn.addEventListener('click', () => {
        const isOpen = dom.optionsDrawer.classList.contains('open');
        if (isOpen) {
            dom.optionsDrawer.classList.remove('open');
            dom.optionsToggleBtn.setAttribute('aria-expanded', 'false');
        } else {
            dom.optionsDrawer.classList.add('open');
            dom.optionsToggleBtn.setAttribute('aria-expanded', 'true');
        }
    });
}

if (dom.drawerDoneBtn && dom.optionsToggleBtn) {
    dom.drawerDoneBtn.addEventListener('click', () => {
        dom.optionsToggleBtn.click();
    });
}

// Log Details Toggle
let logOpen = false;
if (dom.logToggleBtn && dom.log) {
    dom.logToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        logOpen = !logOpen;
        dom.log.style.display = logOpen ? 'block' : 'none';
        dom.logToggleBtn.textContent = logOpen ? 'Hide log' : 'Activity log';
    dom.logToggleBtn.setAttribute('aria-expanded', logOpen ? 'true' : 'false');
    });
}
status.bindLogHeader(dom.logHeader, dom.logToggleBtn);

// The work shown in the status bar now (js/ui-status.js).
let codeStatus = 0;
function updateProgressBar(percent, message) {
    status.progress(codeStatus, { percent, message });
}

function log(msg) {
    if (dom.log) {
        dom.log.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
        dom.log.scrollTop = dom.log.scrollHeight;
    }
    if (dom.logSummary) {
        const cleanMsg = msg.replace(/^\[[A-Z]+\]\s*/, '');
        dom.logSummary.textContent = cleanMsg;
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

// --- App State & Sequence Steps ---
function setAppState(state, note = '') {
    status.showResults(currentAppState, state);
    currentAppState = state;
    if (document.body) {
        document.body.classList.toggle('is-empty', state === 'empty');
    }
    if (dom.step1) dom.step1.classList.toggle('active', state === 'empty');
    if (dom.step2) dom.step2.classList.toggle('active', state === 'loaded');
    if (dom.step3) dom.step3.classList.toggle('active', state === 'built');

    if (dom.mobilePrimaryBtn) {
        if (state === 'empty') {
            dom.mobilePrimaryBtn.textContent = 'Load files';
        } else if (state === 'loaded') {
            dom.mobilePrimaryBtn.textContent = note ? note : 'Build context';
        } else if (state === 'built') {
            dom.mobilePrimaryBtn.textContent = getCopyButtonLabel(currentTargetKey, activeChunkIndex, generatedChunks.length);
        }
    }
    if (dom.startDownloadBtn) {
        const textSpan = dom.startDownloadBtn.querySelector('span') || dom.startDownloadBtn;
        if (state === 'loaded' && note) {
            textSpan.textContent = note;
        } else {
            textSpan.textContent = 'Build context';
        }
    }
}

// --- Mobile Tab Switching & Accessible Tabs ---
if (dom.tabFilesBtn && dom.tabOutputBtn) {
    dom.tabFilesBtn.addEventListener('click', () => {
        switchTab(dom.tabFilesBtn, dom.tabOutputBtn, dom.treeCard, dom.outputCard);
    });

    dom.tabOutputBtn.addEventListener('click', () => {
        switchTab(dom.tabOutputBtn, dom.tabFilesBtn, dom.outputCard, dom.treeCard);
    });

    const tabs = [dom.tabFilesBtn, dom.tabOutputBtn];
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
    dom.mobilePrimaryBtn.addEventListener('click', () => {
        if (currentAppState === 'empty') {
            dom.packBtn.click();
        } else if (currentAppState === 'loaded') {
            dom.startDownloadBtn.click();
            if (dom.tabOutputBtn) dom.tabOutputBtn.click();
        } else if (currentAppState === 'built') {
            dom.copyBtn.click();
        }
    });
}

// Preview toggle
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

// Wrap toggle
if (dom.wrapToggleBtn && dom.previewArea) {
    dom.wrapToggleBtn.addEventListener('click', () => {
        const isWrapped = dom.previewArea.classList.contains('wrap');
        if (isWrapped) {
            dom.previewArea.classList.remove('wrap');
            dom.wrapToggleBtn.setAttribute('aria-pressed', 'false');
        } else {
            dom.previewArea.classList.add('wrap');
            dom.wrapToggleBtn.setAttribute('aria-pressed', 'true');
        }
    });
}

// Budget Meter Presets
document.querySelectorAll('.budget-presets .preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const val = parseInt(btn.getAttribute('data-preset'), 10);
        if (val) {
            currentBudgetWindow = val;
            if (dom.chunkLimit) {
                dom.chunkLimit.value = val.toString();
                dom.chunkLimit.dispatchEvent(new Event('change', { bubbles: true }));
            }
            const detected = detectTarget(dom.format ? dom.format.value : '', val);
            applyTarget(detected);
            saveSettings();
        }
    });
});

function updateBudgetMeterUI(totalTokens, numChunks = 1, isPreBuild = false, maxChunkTokens = 0, hasOversizedChunk = false) {
    if (dom.targetBudgetDisplay) {
        dom.targetBudgetDisplay.textContent = `of ${currentBudgetWindow.toLocaleString()} estimated tokens${isPreBuild ? ' (pre-build estimate)' : ''}`;
    }
    // Keep the big number in step with the bar before a build too.
    if (isPreBuild && dom.statTokens && currentAppState !== 'built') dom.statTokens.textContent = totalTokens.toLocaleString();

    const chunkLimitVal = parseInt(dom.chunkLimit ? dom.chunkLimit.value : '0', 10) || 0;

    const isSplit = numChunks > 1 || (chunkLimitVal > 0 && totalTokens > chunkLimitVal);
    const evaluatedTokens = isSplit ? (maxChunkTokens || (chunkLimitVal > 0 ? Math.min(totalTokens, chunkLimitVal) : Math.round(totalTokens / numChunks))) : totalTokens;

    const ratio = currentBudgetWindow > 0 ? (evaluatedTokens / currentBudgetWindow) : 0;
    const pct = Math.min(Math.round((totalTokens / currentBudgetWindow) * 100), 100);

    const isOver = hasOversizedChunk || ratio > 1.0;

    if (dom.budgetFill) {
        dom.budgetFill.style.width = `${pct}%`;
        dom.budgetFill.className = 'budget-fill ' + (
            isOver ? 'over' : ratio <= 0.85 ? 'fits' : 'near'
        );
    }

    if (dom.budgetStatusText) {
        if (isPreBuild && isSplit) {
            const estChunks = Math.ceil(totalTokens / chunkLimitVal);
            dom.budgetStatusText.textContent = `About ${totalTokens.toLocaleString()} tokens, will split into about ${estChunks} parts`;
            dom.budgetStatusText.className = 'budget-status-text ' + (
                isOver ? 'status-over' : ratio <= 0.85 ? 'status-fits' : 'status-near'
            );
        } else if (isSplit && numChunks > 1) {
            const displayTokens = maxChunkTokens || Math.round(totalTokens / numChunks);
            if (hasOversizedChunk) {
                dom.budgetStatusText.textContent = `Split into ${numChunks} parts (largest: ${displayTokens.toLocaleString()} tok) - 1+ part exceeds split limit`;
                dom.budgetStatusText.className = 'budget-status-text status-over';
            } else {
                dom.budgetStatusText.textContent = `Split into ${numChunks} parts (largest: ${displayTokens.toLocaleString()} tok) - fits target window`;
                dom.budgetStatusText.className = 'budget-status-text status-fits';
            }
        } else if (ratio <= 0.85) {
            dom.budgetStatusText.textContent = 'Fits context window';
            dom.budgetStatusText.className = 'budget-status-text status-fits';
        } else if (ratio <= 1.0) {
            dom.budgetStatusText.textContent = 'Near context limit';
            dom.budgetStatusText.className = 'budget-status-text status-near';
        } else {
            const overTokens = (totalTokens - currentBudgetWindow).toLocaleString();
            dom.budgetStatusText.textContent = `Over by ${overTokens} tokens. Split into parts or deselect files.`;
            dom.budgetStatusText.className = 'budget-status-text status-over';
        }
    }

    if (dom.budgetSuggestions) {
        if (isOver && activeTreeControls) {
            const selectedNodes = activeTreeControls.getSelectedNodes();
            const files = selectedNodes.map(node => ({
                path: node.path,
                tokens: Math.round((node.size || 0) / 3.8)
            }));
            const suggestions = rankSuggestions(files, 3, 0.05);
            if (suggestions.length > 0) {
                dom.budgetSuggestions.innerHTML = '';
                suggestions.forEach(s => {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.textContent = `${s.path} is ~${Math.round(s.tokens / 1000)}k tokens. Exclude it?`;
                    btn.onclick = () => {
                        const currentNodes = activeTreeControls.getSelectedNodes();
                        const toExclude = currentNodes
                            .filter(n => n.path === s.path || n.path.startsWith(s.path + '/'))
                            .map(n => n.path);
                        if (toExclude.length > 0) {
                            activeTreeControls.setPathsChecked(toExclude, false);
                        }
                    };
                    dom.budgetSuggestions.appendChild(btn);
                });
            } else {
                dom.budgetSuggestions.innerHTML = '';
            }
        } else {
            dom.budgetSuggestions.innerHTML = '';
        }
    }
}

function incrementActiveFetches() {
    activeFetchCount++;
    if (dom.abortBtn) dom.abortBtn.style.display = 'inline-flex';
}

function decrementActiveFetches() {
    activeFetchCount = Math.max(0, activeFetchCount - 1);
    if (activeFetchCount === 0 && dom.abortBtn) {
        dom.abortBtn.style.display = 'none';
    }
}

function updateCachedRawFiles(newFiles) {
    const map = new Map(cachedRawFiles.map(f => [f.path, f]));
    for (const f of newFiles) {
        if (f && f.path) {
            map.set(f.path, f);
            if (!secretsMap.has(f.path)) {
                const findings = scanForSecrets(f.path, f.rawContent);
                secretsMap.set(f.path, findings);
            }
        }
    }
    cachedRawFiles = Array.from(map.values());
}

function isBinaryContent(content) {
    if (!content) return false;
    const sample = content.slice(0, 1024);
    if (sample.includes('\0')) return true;
    let nonPrintable = 0;
    for (let i = 0; i < sample.length; i++) {
        const code = sample.charCodeAt(i);
        if (code < 9 || (code > 13 && code < 32) || code === 65533) {
            nonPrintable++;
        }
    }
    return sample.length > 0 && (nonPrintable / sample.length) > 0.05;
}

function showPersistentWarning(message, options = {}) {
    if (!dom.persistentWarningBanner) return;
    const { showTokenBtn = false, showRetryBtn = false, onRetry = null } = options;
    if (dom.warningBannerText) dom.warningBannerText.textContent = message;
    if (dom.warningBannerTokenBtn) dom.warningBannerTokenBtn.style.display = showTokenBtn ? 'inline-block' : 'none';
    if (dom.warningBannerRetryBtn) {
        dom.warningBannerRetryBtn.style.display = showRetryBtn ? 'inline-block' : 'none';
        dom.warningBannerRetryBtn.onclick = onRetry || null;
    }
    dom.persistentWarningBanner.style.display = 'flex';
}

function hidePersistentWarning() {
    if (dom.persistentWarningBanner) {
        dom.persistentWarningBanner.style.display = 'none';
    }
}

function clearOutputState() {
    hideCopyHint();
    generatedChunks = [];
    activeChunkIndex = 0;
    packedOutputText = "";
    totalTokensAllChunks = 0;
    if (dom.summaryCard) {
        dom.summaryCard.hidden = true;
        dom.summaryCard.innerHTML = '';
    }
    if (dom.togglePreviewBtn) {
        dom.togglePreviewBtn.style.display = 'none';
        dom.togglePreviewBtn.setAttribute('aria-expanded', 'false');
        dom.togglePreviewBtn.textContent = 'Show preview';
    }
    if (dom.previewArea) dom.previewArea.value = "";
    if (dom.outputEmptyState) dom.outputEmptyState.style.display = 'flex';
    if (dom.previewNotice) dom.previewNotice.style.display = 'none';
    if (dom.previewArea) dom.previewArea.style.display = 'none';
    if (dom.secretsWarningPanel) dom.secretsWarningPanel.style.display = 'none';
    if (dom.statFiles) dom.statFiles.textContent = '0';
    if (dom.statChars) dom.statChars.textContent = '0';
    if (dom.statTokens) dom.statTokens.textContent = '0';
    if (dom.statChunks) dom.statChunks.textContent = '0';
    if (dom.chunkSelectLabel) dom.chunkSelectLabel.style.display = 'none';
    if (dom.chunkSelect) dom.chunkSelect.style.display = 'none';
    if (dom.downloadAllBtn) dom.downloadAllBtn.style.display = 'none';
    if (dom.chunkSelect) dom.chunkSelect.innerHTML = '';
    if (dom.downloadBtn) dom.downloadBtn.disabled = true;
    if (dom.copyBtn) {
        dom.copyBtn.disabled = true;
        updateCopyBtnLabel(0);
    }
    if (dom.nextPartBtn) dom.nextPartBtn.style.display = 'none';
    updateBudgetMeterUI(0, 1, false);
}

export function formatQuotaBadgeText(remaining, resetTimeStr) {
    return `${remaining} requests left, resets ${resetTimeStr}`;
}

function updateRateLimitUI(meta) {
    if (!meta) return;
    let resetTimeStr = '--:--';
    if (meta.reset) {
        const resetSec = typeof meta.reset === 'number' ? meta.reset : parseInt(meta.reset, 10);
        if (!Number.isNaN(resetSec)) {
            const resetDate = new Date(resetSec * 1000);
            resetTimeStr = resetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            if (dom.resetVal) dom.resetVal.textContent = resetTimeStr;
        }
    }

    if (meta.remaining !== null && meta.remaining !== undefined) {
        const remaining = typeof meta.remaining === 'number' ? meta.remaining : parseInt(meta.remaining, 10);
        if (!Number.isNaN(remaining)) {
            if (dom.quotaVal) {
                dom.quotaVal.textContent = `${remaining} / ${meta.limit || '--'}`;
                dom.quotaVal.className = (
                    remaining < 5 ? 'rate-critical' : remaining < 10 ? 'rate-warning' : 'rate-normal'
                );
            }
            if (dom.quotaRemainingText) {
                dom.quotaRemainingText.innerHTML = `${remaining} requests left, resets <span id="resetVal">${resetTimeStr}</span>`;
            }
            if (dom.rateBadge) {
                dom.rateBadge.style.display = remaining < 30 ? 'flex' : 'none';
            }
            if (remaining < 10) {
                showTokenPanel('');
            }
        }
    }
}

async function refreshRateLimitBadge() {
    try {
        const pat = dom.pat.value.trim();
        const info = await fetchRateLimit(pat);
        updateRateLimitUI(info);
    } catch (_) {}
}

// Check the quota when the user enters a token, not on page open: opening a page must not
// contact GitHub. Loading a repo updates the quota from GitHub's response headers anyway.
dom.pat.addEventListener('change', refreshRateLimitBadge);
loadSavedSettings();

if (dom.warningBannerDismissBtn) {
    dom.warningBannerDismissBtn.addEventListener('click', hidePersistentWarning);
}
if (dom.warningBannerTokenBtn) {
    dom.warningBannerTokenBtn.addEventListener('click', () => {
        showTokenPanel('');
    });
}

function applyUrlParams() {
    const params = new URLSearchParams(window.location.search);
    const repoParam = params.get('repo');
    const branchParam = params.get('branch');
    const formatParam = params.get('format');
    const minifyParam = params.get('minify');

    const validFormats = ['claude-xml', 'markdown', 'generic-xml', 'json'];
    const validMinify = ['none', 'basic', 'aggressive'];

    if (repoParam && dom.repoUrl) dom.repoUrl.value = repoParam;
    if (branchParam && isSafeBranchName(branchParam) && dom.branch) dom.branch.value = branchParam;
    if (formatParam && validFormats.includes(formatParam) && dom.format) dom.format.value = formatParam;
    if (minifyParam && validMinify.includes(minifyParam) && dom.minifyMode) dom.minifyMode.value = minifyParam;

    if (!repoParam && dom.repoUrl && !dom.repoUrl.value.trim()) {
        try {
            const lastRepo = localStorage.getItem('cfg_lastRepo');
            if (lastRepo) dom.repoUrl.value = lastRepo;
        } catch (_) {}
    }
}

clearOutputState();
loadSavedSettings();

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

const initialParams = new URLSearchParams(window.location.search);
applyUrlParams();
if (initialParams.has('format')) {
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
updateCopyBtnLabel();
setAppState('empty');
status.initTokenLinks(showTokenPanel);
startFromShortcut(dom.packBtn, dom.repoUrl);
initShortcuts({
    main: () => (currentAppState === 'empty' ? dom.packBtn : dom.startDownloadBtn),
    copy: dom.copyBtn,
    mainButtons: [dom.packBtn, dom.startDownloadBtn]
});

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
            showInlineError(false);
        }
        if (dom.packBtn) {
            dom.packBtn.click();
        }
    });
}

function outputRepoInfo() {
    if (cachedRepoInfo && cachedRepoInfo.isZip) return cachedRepoInfo;
    return parseRepoInput(dom.repoUrl.value) || { repo: 'bundle' };
}

function updateZipSourceNote() {
    if (!dom.zipSourceNote) return;
    if (activeZip) {
        dom.zipSourceNote.hidden = false;
        dom.zipSourceNote.textContent = `Showing files from ${activeZip.fileName}. It is read in your browser and nothing is uploaded.`;
    } else {
        dom.zipSourceNote.hidden = true;
        dom.zipSourceNote.textContent = '';
    }
}

async function openZipFile(file) {
    if (!file) return;
    if (!/\.zip$/i.test(file.name || '')) {
        showInlineError('Choose a .zip file.');
        return;
    }
    let archive;
    try {
        archive = await parseZipArchive(file);
    } catch (err) {
        showInlineError(err.message || 'Could not read that .zip file.');
        showToast(err.message || 'Could not read that .zip file.', 'error');
        return;
    }
    if (archive.treeNodes.length === 0) {
        showInlineError('That .zip file has no files in it.');
        return;
    }
    await loadSource(archive);
}

if (dom.uploadZipBtn && dom.zipFileInput) {
    dom.uploadZipBtn.addEventListener('click', () => dom.zipFileInput.click());
    dom.zipFileInput.addEventListener('change', () => {
        const file = dom.zipFileInput.files && dom.zipFileInput.files[0];
        dom.zipFileInput.value = ''; // allow picking the same file again
        openZipFile(file);
    });
}

// Drop a .zip anywhere on the page to load it.
if (typeof document.addEventListener === 'function') {
    const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    let dragDepth = 0;
    document.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        dragDepth++;
        document.body.classList.add('zip-drag-over');
    });
    document.addEventListener('dragleave', (e) => {
        if (!hasFiles(e)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) document.body.classList.remove('zip-drag-over');
    });
    document.addEventListener('dragover', (e) => {
        if (hasFiles(e)) e.preventDefault();
    });
    document.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth = 0;
        document.body.classList.remove('zip-drag-over');
        const file = Array.from(e.dataTransfer.files || []).find(f => /\.zip$/i.test(f.name));
        if (file) openZipFile(file);
        else showToast('Drop a .zip file to load it.', 'warn');
    });
}

function getDeepLinkUrl() {
    const repo = dom.repoUrl ? dom.repoUrl.value.trim() : '';
    const branch = dom.branch ? dom.branch.value.trim() : '';
    const format = dom.format ? dom.format.value : '';
    const minify = dom.minifyMode ? dom.minifyMode.value : '';

    const url = new URL(window.location.href.split('?')[0]);
    if (repo) url.searchParams.set('repo', repo);
    if (branch) url.searchParams.set('branch', branch);
    if (format) url.searchParams.set('format', format);
    if (minify) url.searchParams.set('minify', minify);
    return url.toString();
}

function updateSecretsWarningPanel(selectedFiles) {
    if (!dom.secretsWarningPanel || !dom.secretsTableBody || !dom.secretsWarningSummary) return;

    const selectedPaths = new Set(selectedFiles.map(f => f.path));
    let totalFindings = 0;
    const flaggedPaths = new Set();
    const rows = [];

    for (const file of selectedFiles) {
        const findings = secretsMap.get(file.path) || [];
        if (findings.length > 0) {
            flaggedPaths.add(file.path);
            totalFindings += findings.length;
            for (const f of findings) {
                rows.push({
                    path: file.path,
                    type: f.type,
                    line: f.line,
                    preview: f.preview
                });
            }
        }
    }

    if (totalFindings === 0) {
        dom.secretsWarningPanel.style.display = 'none';
        return;
    }

    dom.secretsWarningPanel.style.display = 'block';
    const isRedactOn = dom.redactSecrets ? dom.redactSecrets.checked : true;
    const isAggressiveOn = dom.aggressiveRedact ? dom.aggressiveRedact.checked : false;

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
            ? ' (enable Aggressive redaction or exclude the file)'
            : ' (enable Redact secrets or exclude the file)';
        dom.secretsWarningSummary.textContent = `${redactedCount} redacted, ${presentCount} still present${hint}.`;
    } else {
        dom.secretsWarningSummary.textContent = `${totalFindings} possible secret${totalFindings === 1 ? '' : 's'} in ${flaggedPaths.size} file${flaggedPaths.size === 1 ? '' : 's'} (all redacted).`;
    }

    dom.secretsTableBody.innerHTML = rowData.map(r => `
        <tr>
            <td>${escapeXml(r.path)}</td>
            <td>${escapeXml(r.type)}</td>
            <td>${r.line}</td>
            <td>${escapeXml(r.preview)}</td>
            <td>${r.isRedacted ? '<span class="status-fits" style="font-weight:600;">Redacted</span>' : '<span class="status-over" style="font-weight:600;">Present in output</span>'}</td>
            <td><button type="button" class="secondary btn-xs exclude-secret-btn" data-path="${escapeXml(r.path)}">Exclude file</button></td>
        </tr>
    `).join('');

    dom.secretsTableBody.querySelectorAll('.exclude-secret-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const path = btn.getAttribute('data-path');
            if (path && activeTreeControls) {
                activeTreeControls.setPathsChecked([path], false);
            }
        });
    });

    if (dom.excludeAllSecretsBtn) {
        dom.excludeAllSecretsBtn.onclick = () => {
            if (activeTreeControls && flaggedPaths.size > 0) {
                activeTreeControls.setPathsChecked(Array.from(flaggedPaths), false);
            }
        };
    }
}

async function repackBundleInMemory(activeSelectionNodes = currentActiveSelection) {
    repackGeneration++;
    const thisRepackGen = repackGeneration;

    let selection = activeSelectionNodes || currentActiveSelection;

    if (!cachedRawFiles || cachedRawFiles.length === 0 || !cachedRepoInfo || !selection || selection.length === 0) {
        clearOutputState();
        if (selection && selection.length === 0) {
            log(`[WARN] No files selected for context build.`);
        }
        return;
    }

    const selectedPaths = new Set(selection.map(n => n.path));
    const targetFiles = cachedRawFiles.filter(f => selectedPaths.has(f.path));

    if (targetFiles.length === 0) {
        clearOutputState();
        return;
    }

    const minifyMode = dom.minifyMode ? dom.minifyMode.value : 'none';
    const isRedact = dom.redactSecrets ? dom.redactSecrets.checked : true;
    const isAggressive = dom.aggressiveRedact ? dom.aggressiveRedact.checked : false;
    const instructions = dom.aiInstructions ? dom.aiInstructions.value : '';

    log(`[PACK] Building context from ${targetFiles.length} files (${dom.format.value}, shrink: ${minifyMode}, redact: ${isRedact})...`);

    const processedFiles = targetFiles.map(f => {
        let content = f.rawContent;
        if (isRedact) {
            content = redactSecrets(content, f.path, { aggressiveRedact: isAggressive });
        }
        if (minifyMode !== 'none') {
            content = minifyCode(content, f.path, minifyMode);
        }
        return {
            path: f.path,
            content
        };
    });

    const paths = processedFiles.map(f => f.path);
    const treeAscii = generateTree(paths);
    const chunkLimitVal = parseInt(dom.chunkLimit ? dom.chunkLimit.value : '0', 10) || 0;

    const repoUrl = cachedRepoInfo.isZip
        ? null
        : (cachedRepoInfo.owner && cachedRepoInfo.repo)
            ? `https://github.com/${cachedRepoInfo.owner}/${cachedRepoInfo.repo}`
            : getDeepLinkUrl();

    const repoWithUrl = { ...cachedRepoInfo, url: repoUrl };

    const newChunks = chunkContextOutput(
        dom.format.value,
        repoWithUrl,
        cachedBranch,
        treeAscii,
        processedFiles,
        chunkLimitVal,
        estimateTokens,
        { instructions, failedFilesCount: cachedFailedCount }
    );

    const firstChunk = newChunks[0];
    const newPackedOutputText = firstChunk.text;

    const estTokens = await estimateTokensAsync(newPackedOutputText);

    if (thisRepackGen !== repackGeneration) {
        return;
    }

    const totalChars = newChunks.reduce((acc, c) => acc + c.text.length, 0);
    const chunkTokensPromises = newChunks.map(c => estimateTokensAsync(c.text));
    const chunkTokensList = await Promise.all(chunkTokensPromises);

    if (thisRepackGen !== repackGeneration) {
        return;
    }

    generatedChunks = newChunks;
    activeChunkIndex = 0;
    packedOutputText = newPackedOutputText;
    outputExt = firstChunk.ext;
    outputMime = firstChunk.mime;
    totalTokensAllChunks = chunkTokensList.reduce((a, b) => a + b, 0);

    let maxChunkTokens = 0;
    let hasOversizedChunk = false;
    newChunks.forEach((c, idx) => {
        const cTokens = chunkTokensList[idx];
        if (cTokens > maxChunkTokens) maxChunkTokens = cTokens;
        if (c.exceedsLimit || (chunkLimitVal > 0 && cTokens > chunkLimitVal)) {
            hasOversizedChunk = true;
            log(`[WARN] Chunk part ${idx + 1}/${newChunks.length} (~${cTokens.toLocaleString()} tokens) exceeds limit of ${chunkLimitVal.toLocaleString()} tokens.`);
        }
    });

    dom.statFiles.textContent = processedFiles.length;
    dom.statChars.textContent = totalChars.toLocaleString();
    dom.statTokens.textContent = totalTokensAllChunks.toLocaleString();
    dom.statChunks.textContent = generatedChunks.length;

    updateBudgetMeterUI(totalTokensAllChunks, generatedChunks.length, false, maxChunkTokens, hasOversizedChunk);
    updateSecretsWarningPanel(targetFiles);

    if (generatedChunks.length > 1) {
        dom.chunkSelectLabel.style.display = 'inline-block';
        dom.chunkSelect.style.display = 'inline-block';
        dom.downloadAllBtn.style.display = 'inline-flex';
        dom.chunkSelect.innerHTML = generatedChunks.map((_, idx) => `<option value="${idx}">Part ${idx + 1} of ${generatedChunks.length}</option>`).join('');
        updateCopyBtnLabel(0);
        if (dom.nextPartBtn) dom.nextPartBtn.style.display = 'inline-flex';
    } else {
        dom.chunkSelectLabel.style.display = 'none';
        dom.chunkSelect.style.display = 'none';
        dom.downloadAllBtn.style.display = 'none';
        dom.chunkSelect.innerHTML = '';
        updateCopyBtnLabel(0);
        if (dom.nextPartBtn) dom.nextPartBtn.style.display = 'none';
    }

    dom.previewArea.value = packedOutputText.slice(0, 45000) + (packedOutputText.length > 45000 ? '\n\n... [Truncated for preview; complete text will download] ...' : '');
    if (dom.outputEmptyState) dom.outputEmptyState.style.display = 'none';
    if (dom.previewNotice) dom.previewNotice.style.display = 'none';
    if (dom.previewArea) dom.previewArea.style.display = 'none';
    if (dom.togglePreviewBtn) {
        dom.togglePreviewBtn.style.display = 'inline-flex';
        dom.togglePreviewBtn.setAttribute('aria-expanded', 'false');
        dom.togglePreviewBtn.textContent = 'Show preview';
    }
    if (dom.downloadBtn) dom.downloadBtn.disabled = false;
    if (dom.copyBtn) dom.copyBtn.disabled = false;

    let totalFindings = 0;
    let redactedFindings = 0;
    targetFiles.forEach(f => {
        const fileSecrets = secretsMap.get(f.path) || [];
        fileSecrets.forEach(sec => {
            totalFindings++;
            const isRedacted = isRedact && (sec.type !== 'generic-secret' || isAggressive);
            if (isRedacted) redactedFindings++;
        });
    });

    let bannerItems = [];
    if (dom.warningBanner) {
        const redactionOff = dom.redactSecrets ? !dom.redactSecrets.checked : false;
        bannerItems = buildBannerItems({
            truncatedTree: isTreeTruncated,
            skippedLarge: countSkippedLarge,
            redactionOff,
            secretCount: totalFindings
        });
        renderBanner(dom.warningBanner, bannerItems);
    }

    if (dom.summaryCard) {
        const summaryLines = buildSummaryLines({
            kind: 'files',
            items: processedFiles.length,
            tokens: totalTokensAllChunks,
            parts: generatedChunks.length,
            secretsHidden: redactedFindings,
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
    log(`[SUCCESS] Context ready: ${generatedChunks.length} part(s), ~${totalTokensAllChunks.toLocaleString()} total tokens.`);
}

// Delegated listener on #targetBar
if (dom.targetBar) {
    dom.targetBar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-target]');
        if (!b) return;
        applyTarget(b.dataset.target);
        repackBundleInMemory();
    });
}

if (dom.redactLevel) {
    dom.redactLevel.addEventListener('change', () => {
        syncCheckboxesFromRedactLevel();
        saveSettings();
        updateSettingsSummary();
        repackBundleInMemory();
    });
}

if (dom.secretsControl) {
    dom.secretsControl.addEventListener('change', () => {
        if (dom.redactLevel) dom.redactLevel.value = dom.secretsControl.value;
        syncCheckboxesFromRedactLevel();
        saveSettings();
        updateSettingsSummary();
        repackBundleInMemory();
    });
}

// Auto-repack on setting changes if files are already cached
[dom.format, dom.chunkLimit].forEach(el => {
    if (el) {
        el.addEventListener('change', () => {
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
            updateCopyBtnLabel();
            updateSettingsSummary();
            saveSettings();
            repackBundleInMemory();
        });
    }
});
if (dom.minifyMode) {
    dom.minifyMode.addEventListener('change', () => {
        updateSettingsSummary();
        saveSettings();
        repackBundleInMemory();
    });
}
[dom.maxKb, dom.throttleMs, dom.ignoreExt].forEach(el => {
    if (el) {
        el.addEventListener('change', () => {
            saveSettings();
        });
    }
});
if (dom.redactSecrets) {
    dom.redactSecrets.addEventListener('change', () => {
        syncRedactLevelFromCheckboxes();
        updateSettingsSummary();
        saveSettings();
        repackBundleInMemory();
    });
}
if (dom.aggressiveRedact) {
    dom.aggressiveRedact.addEventListener('change', () => {
        syncRedactLevelFromCheckboxes();
        updateSettingsSummary();
        saveSettings();
        repackBundleInMemory();
    });
}
let instructionsDebounceTimeout = null;
if (dom.aiInstructions) {
    dom.aiInstructions.addEventListener('input', () => {
        updateCharCount();
        saveSettings();
        if (instructionsDebounceTimeout) clearTimeout(instructionsDebounceTimeout);
        instructionsDebounceTimeout = setTimeout(() => {
            repackBundleInMemory();
        }, 300);
    });
}

if (dom.clearInstructionsBtn) {
    dom.clearInstructionsBtn.addEventListener('click', () => {
        if (dom.aiInstructions) {
            dom.aiInstructions.value = '';
            updateCharCount();
        }
        try {
            localStorage.removeItem('cfg_aiInstructions');
        } catch (_) {}
        saveSettings();
        repackBundleInMemory();
    });
}

document.querySelectorAll('.preset-buttons button[data-instruction]').forEach(btn => {
    btn.addEventListener('click', () => {
        const instText = btn.getAttribute('data-instruction');
        if (instText && dom.aiInstructions) {
            dom.aiInstructions.value = instText;
            updateCharCount();
            saveSettings();
            repackBundleInMemory();
        }
    });
});

// --- Main Processing Pipeline ---
dom.packBtn.addEventListener('click', () => loadSource(null));

// The repo form never submits (Enter is handled by the buttons); kept out of HTML for the CSP.
const sourceFormEl = document.getElementById('sourceForm');
if (sourceFormEl) sourceFormEl.addEventListener('submit', (e) => e.preventDefault());


/**
 * Loads a file list and waits for "Build context". The source is either the GitHub repo in the
 * input box (zipArchive = null) or a local .zip archive parsed by js/zip-loader.js.
 */
async function loadSource(zipArchive = null) {
    showInlineError('');
    const typedBranch = (dom.branch && !zipArchive) ? dom.branch.value.trim() : '';
    if (typedBranch && !isSafeBranchName(typedBranch)) {
        showInlineError('That branch or tag name is not valid.');
        return;
    }
    // First contact with GitHub: one-time notice (a local .zip contacts nothing).
    if (!zipArchive && parseRepoInput(dom.repoUrl.value) && !(await confirmFirstUse('github'))) return;
    if (abortController) {
        abortController.abort();
    }

    const repoInfo = zipArchive
        ? { owner: '', repo: zipArchive.label, branch: '', subpath: null, isZip: true, source: `local archive ${zipArchive.fileName}` }
        : parseRepoInput(dom.repoUrl.value);
    if (!repoInfo) {
        showInlineError("Enter a repo as owner/name or a GitHub URL.");
        return;
    }
    activeZip = zipArchive;
    updateZipSourceNote();

    currentGeneration++;
    const thisGen = currentGeneration;

    cachedRawFiles = [];
    secretsMap.clear();
    cachedSkippedPaths.clear();
    cachedRepoInfo = null;
    cachedBranch = "";
    cachedFailedCount = 0;
    isTreeTruncated = false;
    countSkippedLarge = 0;
    currentActiveSelection = [];
    isPrivateRepo = false;
    clearOutputState();
    if (dom.warningBanner) renderBanner(dom.warningBanner, []);

    const userTypedBranch = (dom.branch && !zipArchive) ? dom.branch.value.trim() : '';

    if (dom.branch && !zipArchive) {
        const parsedWithOverride = parseRepoInput(dom.repoUrl.value, userTypedBranch);
        if (parsedWithOverride && parsedWithOverride.branch) {
            repoInfo.branch = parsedWithOverride.branch;
            repoInfo.subpath = parsedWithOverride.subpath;
        }
        if (repoInfo.branch && !userTypedBranch) {
            dom.branch.value = repoInfo.branch;
        }
    }

    const pat = dom.pat.value.trim();
    const maxKb = parseInt(dom.maxKb.value, 10) || 150;
    // Local archives need no request throttling.
    const throttleMs = zipArchive ? 0 : (parseInt(dom.throttleMs.value, 10) || 80);
    const customIgnoredExts = Array.from(new Set(
        dom.ignoreExt.value.split(',').map(s => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean)
    ));

    abortController = new AbortController();
    dom.packBtn.disabled = true;
    dom.abortBtn.style.display = 'inline-flex';
    dom.log.textContent = '';
    const listStatus = codeStatus = status.begin(zipArchive
        ? `Reading ${zipArchive.fileName}…`
        : `Reading the file list of ${repoInfo.owner}/${repoInfo.repo}…`, { button: zipArchive ? dom.uploadZipBtn : dom.packBtn });
    if (dom.outputEmptyState) dom.outputEmptyState.style.display = 'flex';
    if (dom.previewArea) dom.previewArea.style.display = 'none';

    try {
        let targetBranch = userTypedBranch || repoInfo.branch || '';
        let rawTree = null;

        if (zipArchive) {
            log(`[ZIP] Reading ${zipArchive.fileName} in your browser (${zipArchive.treeNodes.length} files). Nothing is uploaded.`);
            if (zipArchive.encryptedCount > 0) {
                log(`[WARN] ${zipArchive.encryptedCount} password-protected file(s) in the archive will be skipped.`);
            }
            rawTree = zipArchive.treeNodes;
        } else {
            log(`[FETCH] Querying GitHub API for ${repoInfo.owner}/${repoInfo.repo}...`);

            try {
                const repoMeta = await resolveDefaultBranch(
                    repoInfo.owner,
                    repoInfo.repo,
                    pat,
                    abortController.signal,
                    updateRateLimitUI
                );
                if (!targetBranch) targetBranch = repoMeta.branch;
                isPrivateRepo = repoMeta.isPrivate;
                if (isPrivateRepo && !pat) {
                    showTokenPanel("If this is a private repo, add a token.");
                }
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                if (err.isRateLimit || (err.message && (err.message.includes('rate limit') || err.message.includes('403') || err.message.includes('429')))) {
                    showTokenPanel('');
                } else if (err.status === 404 || (err.message && err.message.includes('404'))) {
                    showTokenPanel("If this is a private repo, add a token.");
                }
                if (!targetBranch) {
                    if (err.status === 404 || (err.message && err.message.includes('404'))) {
                        showToast("Can't find that repo or branch. For a private repo, add a token with read access to contents.", "error");
                    } else if (err.isRateLimit || (err.message && (err.message.includes('rate limit') || err.message.includes('403') || err.message.includes('429')))) {
                        showToast("GitHub rate limit reached or access forbidden. Add a token to raise the limit.", "error");
                    } else {
                        showToast(err.message, "error");
                    }
                    throw err;
                }
                log(`[WARN] Repository default branch lookup warning: ${err.message}`);
            }

            log(`[FETCH] Target branch: ${targetBranch}${isPrivateRepo ? ' (Private Repository)' : ''}`);

            try {
                rawTree = await fetchRepoTree(
                    repoInfo.owner,
                    repoInfo.repo,
                    targetBranch,
                    pat,
                    abortController.signal,
                    updateRateLimitUI
                );
            } catch (err) {
                if (!userTypedBranch && repoInfo.treeTail && repoInfo.treeTail.includes('/')) {
                    const tailParts = repoInfo.treeTail.split('/');
                    for (let len = tailParts.length; len >= 1; len--) {
                        const candidateBranch = tailParts.slice(0, len).join('/');
                        if (candidateBranch === targetBranch) continue;
                        const candidateSubpath = tailParts.slice(len).join('/') || null;
                        try {
                            rawTree = await fetchRepoTree(
                                repoInfo.owner,
                                repoInfo.repo,
                                candidateBranch,
                                pat,
                                abortController.signal,
                                updateRateLimitUI
                            );
                            targetBranch = candidateBranch;
                            repoInfo.branch = candidateBranch;
                            repoInfo.subpath = candidateSubpath;
                            if (dom.branch) dom.branch.value = candidateBranch;
                            log(`[FETCH] Resolved branch with slash: ${targetBranch}`);
                            break;
                        } catch (_) {}
                    }
                }
                if (!rawTree) throw err;
            }
        }

        isTreeTruncated = Boolean(rawTree.truncated);
        if (rawTree.truncated) {
            log(`[WARN] GitHub returned a partial file list. Narrow the path or pick a branch with fewer files.`);
            showToast("GitHub returned a partial file list. Narrow the path or pick a branch with fewer files.", "warn");
            showPersistentWarning("GitHub returned a partial file list (repository exceeds tree size limit). Output will be incomplete.", {
                showTokenBtn: !dom.pat.value.trim(),
                showRetryBtn: true,
                onRetry: () => dom.packBtn.click()
            });
        }

        let ignoredDirCount = 0;
        let ignoredFileCount = 0;
        let ignoredExtCount = 0;
        let ignoredSizeCount = 0;

        const processable = rawTree.filter(node => {
            if (node.type !== 'blob') return false;
            if (node.mode === '120000') return false;
            const pathParts = node.path.split('/');
            const filename = pathParts[pathParts.length - 1].toLowerCase();
            const dirParts = pathParts.slice(0, -1);

            if (isIgnoredDirPath(dirParts)) {
                ignoredDirCount++;
                return false;
            }
            if (IGNORED_FILES.has(filename)) {
                ignoredFileCount++;
                return false;
            }
            if (customIgnoredExts.some(ext => filename === ext || filename.endsWith('.' + ext))) {
                ignoredExtCount++;
                return false;
            }
            if (node.size !== undefined && node.size > maxKb * 1024) {
                ignoredSizeCount++;
                return false;
            }

            return true;
        });
        countSkippedLarge = ignoredSizeCount;

        log(`[FETCH] Discovered ${rawTree.length} objects. Excluded: ${ignoredDirCount} in ignored dirs, ${ignoredFileCount} ignored files, ${ignoredExtCount} ignored exts, ${ignoredSizeCount} >${maxKb}KB. Selected ${processable.length} files.`);

        dom.manifestCount.textContent = processable.length;
        dom.selectedCount.textContent = processable.length;
        if (dom.treeEmptyState) dom.treeEmptyState.style.display = 'none';
        if (dom.treeContainer) dom.treeContainer.style.display = 'block';

        let activeSelection = [...processable];

        const treeControls = renderInteractiveTree(
            processable,
            dom.treeContainer,
            async (selectedNodes) => {
                activeSelection = selectedNodes;
                currentActiveSelection = selectedNodes;
                dom.selectedCount.textContent = activeSelection.length;
                if (treeControls.getSelectedStats && dom.selectedTokensBadge) {
                    const stats = treeControls.getSelectedStats();
                    dom.selectedTokensBadge.textContent = `~${stats.estTokens.toLocaleString()} estimated tokens selected`;
                    updateBudgetMeterUI(stats.estTokens, 1, true);
                }
                if (currentAppState === 'built') {
                    setAppState('loaded', 'Rebuild context');
                }
                if (cachedRawFiles && cachedRawFiles.length > 0) {
                    if (currentActiveSelection && currentActiveSelection.length > 0) {
                        await fetchSelectedFilesDelta(currentActiveSelection);
                    }
                    repackBundleInMemory(currentActiveSelection);
                }
            },
            parseInt(dom.largeFileThresholdKb ? dom.largeFileThresholdKb.value : '50', 10) || 50,
            // Local .zip files have no GitHub page to link to.
            { fileUrl: zipArchive ? null : (path) => githubFileUrl(repoInfo.owner, repoInfo.repo, targetBranch, path) }
        );
        activeTreeControls = treeControls;
        currentActiveSelection = activeSelection;

        if (!repoInfo.subpath) {
            const allFilePaths = processable.map(f => f.path);
            const { excluded, folders } = defaultExcludedPaths(allFilePaths);
            if (excluded.length > 0) {
                treeControls.setPathsChecked(excluded, false);
                if (dom.defaultsNote) {
                    dom.defaultsNote.hidden = false;
                    dom.defaultsNote.innerHTML = '';
                    const noteText = document.createTextNode(`Left out ${folders.length} folder(s): ${folders.slice(0, 4).join(', ')}. `);
                    const incBtn = document.createElement('button');
                    incBtn.type = 'button';
                    incBtn.textContent = 'Include them';
                    incBtn.onclick = () => {
                        treeControls.setPathsChecked(excluded, true);
                        dom.defaultsNote.hidden = true;
                        dom.defaultsNote.innerHTML = '';
                    };
                    dom.defaultsNote.appendChild(noteText);
                    dom.defaultsNote.appendChild(incBtn);
                }
            } else if (dom.defaultsNote) {
                dom.defaultsNote.hidden = true;
                dom.defaultsNote.innerHTML = '';
            }
        } else if (dom.defaultsNote) {
            dom.defaultsNote.hidden = true;
            dom.defaultsNote.innerHTML = '';
        }

        if (treeControls.getSelectedStats && dom.selectedTokensBadge) {
            const stats = treeControls.getSelectedStats();
            dom.selectedTokensBadge.textContent = `~${stats.estTokens.toLocaleString()} estimated tokens selected`;
            updateBudgetMeterUI(stats.estTokens, 1, true);
        }

        dom.selectAllBtn.onclick = () => treeControls.selectAll(true);
        dom.deselectAllBtn.onclick = () => treeControls.selectAll(false);
        if (dom.deselectLargeBtn) {
            dom.deselectLargeBtn.onclick = () => {
                const kbVal = parseInt(dom.largeFileThresholdKb ? dom.largeFileThresholdKb.value : '50', 10) || 50;
                treeControls.deselectLarge(kbVal * 1024);
            };
        }
        if (dom.largeFileThresholdKb) {
            dom.largeFileThresholdKb.onchange = () => {
                const kbVal = parseInt(dom.largeFileThresholdKb.value, 10) || 50;
                treeControls.setLargeThresholdKb(kbVal);
            };
        }
        if (dom.expandAllBtn) dom.expandAllBtn.onclick = () => treeControls.expandAll(true);
        if (dom.collapseAllBtn) dom.collapseAllBtn.onclick = () => treeControls.expandAll(false);

        if (dom.treeFilterInput) {
            dom.treeFilterInput.value = repoInfo.subpath || '';
            const doFilter = () => {
                const count = treeControls.filter(dom.treeFilterInput.value, false);
                if (dom.searchMatchCount) {
                    dom.searchMatchCount.textContent = dom.treeFilterInput.value ? `${count} matches` : '';
                }
            };
            dom.treeFilterInput.oninput = doFilter;
            if (repoInfo.subpath) {
                const subpathCount = treeControls.filter(repoInfo.subpath, true);
                if (treeControls.selectBySubpath) {
                    treeControls.selectBySubpath(repoInfo.subpath);
                }
                if (dom.searchMatchCount) {
                    dom.searchMatchCount.textContent = `${subpathCount} matches`;
                }
            }
        }

        window.onkeydown = (e) => {
            if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
                e.preventDefault();
                if (dom.treeFilterInput) dom.treeFilterInput.focus();
            }
        };

        setAppState('loaded');
        // Remember the repo for next time, but not a private one or one loaded with a token.
        if (!zipArchive && !pat && !isPrivateRepo) {
            try {
                localStorage.setItem('cfg_lastRepo', `${repoInfo.owner}/${repoInfo.repo}`);
            } catch (_) {}
        }
        showToast(`${zipArchive ? `Opened ${zipArchive.fileName}` : 'Listed the repository'}: ${processable.length} files.`, 'info');

        let hasDownloaded = false;

        // Reads one file's text from the zip archive or from GitHub, in fetchFileContent's result shape.
        const readNodeContent = async (node, signal) => {
            if (zipArchive) {
                try {
                    return { success: true, content: await zipArchive.readText(node.path) };
                } catch (err) {
                    // status 404 marks the path as skipped so it is not retried.
                    return { success: false, error: err.message || String(err), status: 404 };
                }
            }
            return fetchFileContent(
                repoInfo.owner,
                repoInfo.repo,
                targetBranch,
                node.path,
                pat,
                signal,
                updateRateLimitUI,
                isPrivateRepo
            );
        };

        let deltaFetchQueue = Promise.resolve();
        function fetchSelectedFilesDelta(selectionToFetch) {
            deltaFetchQueue = deltaFetchQueue.then(async () => {
                if (thisGen !== currentGeneration) return;
                const cachedPaths = new Set(cachedRawFiles.map(f => f.path));
                const missingNodes = selectionToFetch.filter(n => !cachedPaths.has(n.path) && !cachedSkippedPaths.has(n.path));

                if (missingNodes.length === 0) return;

                log(`[FETCH] Fetching ${missingNodes.length} newly checked file(s)...`);
                const concurrency = 5;
                let index = 0;
                const results = new Array(missingNodes.length);

                if (!abortController || abortController.signal.aborted) {
                    abortController = new AbortController();
                }
                const signal = abortController.signal;
                incrementActiveFetches();
                const deltaStatus = codeStatus = status.begin(`Downloading ${missingNodes.length} newly checked file(s)…`, { percent: 0 });
                let completedDelta = 0;
                let deltaFailedCount = 0;

                try {
                    async function worker() {
                        while (index < missingNodes.length) {
                            if (signal.aborted) break;
                            if (thisGen !== currentGeneration) break;
                            const i = index++;
                            const node = missingNodes[i];

                            let retries = 0;
                            let result = null;
                            while (retries < 3) {
                                result = await readNodeContent(node, signal);
                                if (result && result.isPrivate) {
                                    isPrivateRepo = true;
                                }
                                if (result && result.backoff) {
                                    retries++;
                                    await sleep(Math.min(result.backoff, 60) * 1000, signal);
                                    continue;
                                }
                                break;
                            }
                            if (result && result.success) {
                                if (isBinaryContent(result.content)) {
                                    cachedSkippedPaths.add(node.path);
                                    log(`[WARN] Delta skip ${node.path}: Binary content detected.`);
                                } else {
                                    results[i] = { path: node.path, rawContent: result.content };
                                }
                            } else {
                                if (result && result.status === 404) {
                                    cachedSkippedPaths.add(node.path);
                                }
                                deltaFailedCount++;
                                log(`[ERROR] Failed to fetch delta ${node.path}${result && result.error ? `: ${result.error}` : ''}`);
                            }

                            completedDelta++;
                            updateProgressBar((completedDelta / missingNodes.length) * 100, `Downloading newly checked files… ${completedDelta} of ${missingNodes.length}`);

                            if (throttleMs > 0) {
                                await sleep(throttleMs, signal);
                            }
                        }
                    }

                    const workers = Array.from({ length: Math.min(concurrency, missingNodes.length) }, () => worker());
                    await Promise.all(workers);

                    if (thisGen === currentGeneration) {
                        const newlyFetched = results.filter(Boolean);
                        updateCachedRawFiles(newlyFetched);
                        if (deltaFailedCount > 0) {
                            cachedFailedCount += deltaFailedCount;
                            log(`[WARN] ${deltaFailedCount} newly checked file(s) failed to download.`);
                            showToast(`${deltaFailedCount} newly checked file(s) failed to download.`, "warn");
                            showPersistentWarning(`${cachedFailedCount} file(s) failed to download. Check rate limits or permissions.`, {
                                showTokenBtn: !dom.pat.value.trim(),
                                showRetryBtn: true,
                                onRetry: () => repackBundleInMemory()
                            });
                        }
                    }
                } finally {
                    status.end(deltaStatus);
                    decrementActiveFetches();
                }
            }).catch((err) => {
                if (err.name === 'AbortError') {
                    log('[CANCEL] Delta fetch cancelled.');
                } else {
                    log(`[ERROR] Delta fetch error: ${err.message || err}`);
                }
            });
            return deltaFetchQueue;
        }

        // The file list is on screen; the download starts when the user clicks Build context.
        status.end(listStatus, `${processable.length} files listed. Choose what to include, then Build context.`);
        await new Promise((resolve, reject) => {
            const onStart = async () => {
                if (isDownloading) {
                    log('[WARN] Download already in progress...');
                    return;
                }
                if (!hasDownloaded) {
                    hasDownloaded = true;
                    isDownloading = true;
                    cleanup();
                    resolve();
                } else {
                    isDownloading = true;
                    const rebuildStatus = codeStatus = status.begin('Building context…', { button: dom.startDownloadBtn });
                    try {
                        if (currentActiveSelection && currentActiveSelection.length > 0) {
                            await fetchSelectedFilesDelta(currentActiveSelection);
                        }
                        await repackBundleInMemory(currentActiveSelection);
                    } finally {
                        isDownloading = false;
                        status.end(rebuildStatus);
                    }
                }
            };
            const onAbort = () => {
                cleanup();
                reject(new DOMException('Aborted by user', 'AbortError'));
            };
            const cleanup = () => {
                if (abortController.signal) {
                    abortController.signal.removeEventListener('abort', onAbort);
                }
            };
            dom.startDownloadBtn.onclick = onStart;
            if (abortController.signal) {
                abortController.signal.addEventListener('abort', onAbort);
            }
        });

        const selectionSnapshot = [...currentActiveSelection];

        if (selectionSnapshot.length === 0) {
            log('[WARN] No files selected for context build.');
            clearOutputState();
            return;
        }

        log(`[FETCH] Starting download for ${selectionSnapshot.length} selected file(s)...`);
        const downloadStatus = codeStatus = status.begin(`Downloading ${selectionSnapshot.length} file(s)…`, { button: dom.startDownloadBtn, percent: 0 });

        const results = new Array(selectionSnapshot.length);
        let emptyCount = 0;
        let failedCount = 0;
        let completedCount = 0;

        const concurrency = 5;
        let index = 0;

        async function worker() {
            while (index < selectionSnapshot.length) {
                if (abortController.signal && abortController.signal.aborted) break;
                const i = index++;
                const node = selectionSnapshot[i];

                let retries = 0;
                let result = null;

                while (retries < 3) {
                    result = await readNodeContent(node, abortController.signal);

                    if (result && result.isPrivate) {
                        isPrivateRepo = true;
                    }

                    if (result && result.backoff) {
                        retries++;
                        const backoffTime = Math.min(result.backoff, 60);
                        log(`[RETRY] Cooling down for ${backoffTime}s...`);
                        await sleep(backoffTime * 1000, abortController.signal);
                        continue;
                    }
                    break;
                }

                if (result && result.success) {
                    const rawContent = result.content;
                    if (rawContent.length === 0) {
                        emptyCount++;
                    }
                    if (isBinaryContent(rawContent)) {
                        cachedSkippedPaths.add(node.path);
                        log(`[WARN] Skipping ${node.path}: Binary content.`);
                    } else {
                        results[i] = { path: node.path, rawContent: rawContent };
                    }
                } else {
                    if (result && result.status === 404) {
                        cachedSkippedPaths.add(node.path);
                    }
                    failedCount++;
                    log(`[ERROR] Failed to fetch ${node.path}${result && result.error ? `: ${result.error}` : ''}`);
                }

                completedCount++;
                updateProgressBar((completedCount / selectionSnapshot.length) * 100, `Downloading files… ${completedCount} of ${selectionSnapshot.length}`);

                if (throttleMs > 0) {
                    await sleep(throttleMs, abortController.signal);
                }
            }
        }

        const workers = Array.from({ length: Math.min(concurrency, selectionSnapshot.length) }, () => worker());
        await Promise.all(workers);

        const collectedFiles = results.filter(Boolean);

        log(`[SUCCESS] Download complete: ${collectedFiles.length} file(s) fetched.`);

        cachedFailedCount = failedCount;
        if (failedCount > 0) {
            log(`[WARN] ${failedCount} file(s) failed to download.`);
            showToast(`${failedCount} file(s) failed to download. Check rate limits or permissions.`, "warn");
            showPersistentWarning(`${failedCount} file(s) failed to download. Output context is incomplete.`, {
                showTokenBtn: !dom.pat.value.trim(),
                showRetryBtn: true,
                onRetry: () => dom.startDownloadBtn.click()
            });
        }

        if (collectedFiles.length === 0) {
            showToast("No content could be fetched from selected files.", "warn");
            return;
        }

        cachedRawFiles = collectedFiles;
        secretsMap.clear();
        for (const f of collectedFiles) {
            secretsMap.set(f.path, scanForSecrets(f.path, f.rawContent));
        }

        cachedRepoInfo = repoInfo;
        cachedBranch = targetBranch;

        if (currentActiveSelection && currentActiveSelection.length > 0) {
            await fetchSelectedFilesDelta(currentActiveSelection);
        }

        status.progress(downloadStatus, { message: 'Building context…' });
        await repackBundleInMemory();
        status.end(downloadStatus);

    } catch (err) {
        if (err.name === 'AbortError') {
            log('[CANCEL] Process cancelled.');
            // A newer load (e.g. opening another .zip) aborts this one; only report a user cancel.
            if (thisGen === currentGeneration) showToast("Cancelled.", "info");
        } else {
            log(`[ERROR] Error: ${err.message}`);
            showToast(`Error: ${err.message}`, "error");
        }
    } finally {
        // Whatever was running for this load (listing or downloading) has stopped.
        status.end(codeStatus);
        if (thisGen === currentGeneration) {
            isDownloading = false;
            dom.packBtn.disabled = false;
            dom.abortBtn.style.display = 'none';
        }
    }
}

dom.abortBtn.addEventListener('click', () => {
    if (abortController) abortController.abort();
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

    const totalChars = generatedChunks.reduce((acc, c) => acc + c.text.length, 0);
    dom.statChars.textContent = generatedChunks.length > 1
        ? `${packedOutputText.length.toLocaleString()} (Part ${activeChunkIndex + 1}) / ${totalChars.toLocaleString()} total`
        : totalChars.toLocaleString();

    updateCopyBtnLabel(activeChunkIndex);
    if (generatedChunks.length > 1) {
        if (dom.nextPartBtn) {
            dom.nextPartBtn.style.display = activeChunkIndex < generatedChunks.length - 1 ? 'inline-flex' : 'none';
        }
    } else {
        if (dom.nextPartBtn) dom.nextPartBtn.style.display = 'none';
    }

    dom.previewArea.value = packedOutputText.slice(0, 45000) + (packedOutputText.length > 45000 ? '\n\n... [Truncated for preview; complete text will download] ...' : '');
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
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

dom.downloadBtn.addEventListener('click', () => {
    const repoInfo = outputRepoInfo();
    const suffix = generatedChunks.length > 1 ? `-part${activeChunkIndex + 1}-of-${generatedChunks.length}` : '';
    const filename = `${repoInfo.repo}${suffix}-llm-context.${outputExt}`;
    triggerDownload(packedOutputText, filename, outputMime);
    showToast(`Downloaded ${filename}`, 'info');
});

dom.downloadAllBtn.addEventListener('click', async () => {
    const repoInfo = outputRepoInfo();
    for (let i = 0; i < generatedChunks.length; i++) {
        const chunk = generatedChunks[i];
        const filename = `${repoInfo.repo}-part${i + 1}-of-${generatedChunks.length}-llm-context.${chunk.ext}`;
        triggerDownload(chunk.text, filename, chunk.mime);
        await sleep(150);
    }
    showToast("Downloaded all parts", "info");
});

dom.copyBtn.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(packedOutputText);
        const numParts = generatedChunks.length;
        if (numParts > 1) {
            showToast(`Copied part ${activeChunkIndex + 1} of ${numParts}. Pick the next part from the Part menu.`, 'info');
        } else {
            showToast('Copied context to clipboard!', "info");
        }
        dom.copyBtn.textContent = 'Copied!';
        showCopyHint(dom.copyBtn, currentTargetKey, { part: activeChunkIndex + 1, parts: Math.max(1, numParts) });
        setTimeout(() => updateCopyBtnLabel(activeChunkIndex), 2000);
    } catch (_) {
        showToast('Unable to copy automatically. Please copy directly from preview.', 'error');
    }
});

if (dom.shareUrlBtn) {
    dom.shareUrlBtn.addEventListener('click', async () => {
        const deepLink = getDeepLinkUrl();
        try {
            await navigator.clipboard.writeText(deepLink);
            showToast("Deep-link URL copied!", "info");
        } catch (_) {
            showToast(`Link: ${deepLink}`, "info");
        }
    });
}
