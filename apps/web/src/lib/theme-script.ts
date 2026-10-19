import { THEME_DEFAULT_KEY, THEME_STORAGE_KEY } from './appearance-utils'

/**
 * Runs in <head> before the first paint, so the page never flashes the wrong color mode. Order of precedence:
 * the user's own choice, then the admin default last seen on this browser, then dark (the built-in look).
 * Kept as a string because it must run before any bundle loads; tests evaluate it against a fake browser.
 */
export const themeScript = `
(function() {
  try {
    var modes = ['light', 'dark', 'system'];
    var own = localStorage.getItem('${THEME_STORAGE_KEY}');
    var adminDefault = localStorage.getItem('${THEME_DEFAULT_KEY}');
    var pref = modes.indexOf(own) > -1 ? own : (modes.indexOf(adminDefault) > -1 ? adminDefault : 'dark');
    var theme = pref === 'light' ? 'light' : (pref === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.classList.add(theme + '-theme');

    var storedLang = localStorage.getItem('hexalyte-language-preference');
    var lang = storedLang === 'si' ? 'si' : 'en';
    document.documentElement.setAttribute('lang', lang);
    document.documentElement.setAttribute('data-lang', lang);
  } catch (e) {}
})();
`
