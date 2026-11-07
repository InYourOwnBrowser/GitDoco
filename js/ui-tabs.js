/**
 * Shared Mobile Tab Switching & Accessible Tab Navigation
 */
export function switchTab(activeTabBtn, inactiveTabBtn, activeCard, inactiveCard) {
    if (!activeTabBtn || !inactiveTabBtn || !activeCard || !inactiveCard) return;

    activeTabBtn.classList.add('active');
    activeTabBtn.setAttribute('aria-selected', 'true');
    activeTabBtn.setAttribute('tabindex', '0');

    inactiveTabBtn.classList.remove('active');
    inactiveTabBtn.setAttribute('aria-selected', 'false');
    inactiveTabBtn.setAttribute('tabindex', '-1');

    activeCard.classList.add('active-mobile');
    inactiveCard.classList.remove('active-mobile');
}
