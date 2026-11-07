/**
 * The status bar at the bottom of each tool (#logCard): what is happening now, a progress bar,
 * and the activity log behind "Activity log".
 *
 * While work is running the bar is shown even before the first load (body.is-busy), the message
 * gets a spinner, and the button that started the work shows one too. When the total is unknown
 * (e.g. "up to 300 issues") the bar slides instead of showing a made-up percentage. When the work
 * ends the bar fills, then hides, and the message says what happened.
 *
 * Several things can run at once (loading, then topic clustering in the background), so each
 * begin() returns a token; end() and progress() only act for the work that is current.
 */

const $ = id => (typeof document !== 'undefined' ? document.getElementById(id) : null);

let current = 0;
let busyButton = null;
let hideTimer = null;

function setMessage(text) {
    const el = $('logSummary');
    if (el && text) el.textContent = String(text).replace(/^\[[A-Z]+\]\s*/, '');
}

function setBar(percent) {
    const track = $('progressTrack');
    const fill = $('progressFill');
    if (!track || !fill) return;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    track.style.display = 'block';
    if (percent === null || percent === undefined || !Number.isFinite(percent)) {
        track.classList.add('indeterminate');
        track.removeAttribute('aria-valuenow');
        fill.style.width = '';
        return;
    }
    const v = Math.min(100, Math.max(0, Math.round(percent)));
    track.classList.remove('indeterminate');
    track.setAttribute('aria-valuenow', String(v));
    fill.style.width = `${v}%`;
}

function setBusy(on) {
    if (typeof document === 'undefined' || !document.body) return;
    document.body.classList.toggle('is-busy', on);
    const card = $('logCard');
    if (card) {
        card.classList.toggle('is-busy', on);
        card.setAttribute('aria-busy', on ? 'true' : 'false');
    }
}

function releaseButton() {
    if (busyButton) {
        busyButton.classList.remove('is-loading');
        busyButton.removeAttribute('aria-busy');
        busyButton = null;
    }
}

/**
 * Starts a piece of work.
 * @param {string} message e.g. "Loading issues from owner/repo…"
 * @param {{ button?: HTMLElement, percent?: number|null }} [opts] percent null = unknown total
 * @returns {number} token for progress() and end()
 */
export function begin(message, { button = null, percent = null } = {}) {
    current += 1;
    releaseButton();
    if (button) {
        busyButton = button;
        button.classList.add('is-loading');
        button.setAttribute('aria-busy', 'true');
    }
    setBusy(true);
    setMessage(message);
    setBar(percent);
    return current;
}

/** Updates the running work's message and/or progress (percent null = unknown total). */
export function progress(token, { message, percent } = {}) {
    if (token !== current) return;
    if (message) setMessage(message);
    if (percent !== undefined) setBar(percent);
}

/**
 * Ends the work: the bar fills and hides, spinners stop, and the message says what happened.
 * Does nothing if newer work has started since (its status stays on screen).
 */
export function end(token, message) {
    if (token !== current) return false;
    releaseButton();
    setBusy(false);
    if (message) setMessage(message);
    const track = $('progressTrack');
    if (track && track.style.display !== 'none') {
        setBar(100);
        hideTimer = setTimeout(() => {
            track.style.display = 'none';
            track.classList.remove('indeterminate');
            hideTimer = null;
        }, 700);
    }
    return true;
}

/** True while the given work is the latest one started. */
export function isCurrent(token) {
    return token === current;
}

/**
 * "Add a GitHub token" links in the page intro: show the token field (normally shown only after
 * a request fails) and put the cursor in it.
 */
export function initTokenLinks(showTokenPanel) {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('[data-show-token]').forEach(btn => {
        btn.addEventListener('click', () => {
            showTokenPanel('A token lets GitDoco read private repositories and raises GitHub\'s limit from 60 to 5,000 requests an hour.');
            const pat = $('pat');
            if (pat) pat.focus();
        });
    });
}

/**
 * Clicking the status bar header toggles the activity log (via its button), except when the click
 * is on a link in it ("Report a problem").
 */
export function bindLogHeader(header, toggleButton) {
    if (!header || !toggleButton) return;
    header.addEventListener('click', (e) => {
        if (e.target && typeof e.target.closest === 'function' && e.target.closest('a')) return;
        toggleButton.click();
    });
}

/**
 * Called on every app state change. Once results exist, the repo bar shrinks to one line
 * (body.has-results, see css/style.css), and the first time a load produces results the page
 * scrolls to them, so they are the first thing on screen rather than the intro and settings.
 */
export function showResults(previous, next) {
    if (typeof document === 'undefined' || !document.body) return;
    document.body.classList.toggle('has-results', next !== 'empty');
    if (previous !== 'empty' || next === 'empty') return;
    if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function' || typeof window.requestAnimationFrame !== 'function') return;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Look for the target a frame later: the results only appear once the page leaves the empty
    // state, which the caller does right after this.
    window.requestAnimationFrame(() => {
        const target = ['nlpBanner', 'budgetBanner', 'workspacePanes']
            .map(id => document.getElementById(id))
            .find(el => el && el.offsetParent && window.getComputedStyle(el).display !== 'none');
        if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    });
}
