/**
 * Logger - debug-gated console output.
 *
 * Chatty diagnostics (turn flow, spawns, network traffic...) go through
 * log.debug(), which stays silent unless debugging is switched on:
 *   - add ?debug to the page URL, or
 *   - localStorage.setItem('koala_debug', '1'), or
 *   - window.KOALA_DEBUG = true from the console (takes effect immediately).
 * Warnings and errors always print.
 */

function readInitialFlag() {
    try {
        if (new URLSearchParams(location.search).has('debug')) return true;
        return localStorage.getItem('koala_debug') === '1';
    } catch (e) {
        return false;
    }
}

if (typeof window !== 'undefined' && window.KOALA_DEBUG === undefined) {
    window.KOALA_DEBUG = readInitialFlag();
}

export const log = {
    get enabled() {
        return typeof window !== 'undefined' && !!window.KOALA_DEBUG;
    },
    debug(...args) {
        if (this.enabled) console.log(...args);
    },
    info(...args) {
        console.info(...args);
    },
    warn(...args) {
        console.warn(...args);
    },
    error(...args) {
        console.error(...args);
    }
};
