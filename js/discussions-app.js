/**
 * Entry point for discussions.html. The Discussions Explorer shares its controller with the
 * Issues Explorer: this flag switches js/issues-app.js into discussions mode (GitHub Discussions
 * API, categories, answered filter, accepted-answer comment scopes and discussion wording).
 */
globalThis.__THREAD_EXPLORER_KIND__ = 'discussions';
await import('./issues-app.js');
