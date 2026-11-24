/**
 * Application bootstrapper.
 * Initializes Store, Timer and UI in order once the DOM is ready,
 * then scrolls the timeline to the current hour (today) or the morning.
 * Attached to window.StudyPlan.App as a classic IIFE (no ES modules).
 */
(function () {
  'use strict';

  window.StudyPlan = window.StudyPlan || {};

  var started = false;

  /** Boots every module in dependency order. */
  function start() {
    if (started) return;
    started = true;

    var sp = window.StudyPlan;
    var missing = ['Utils', 'Store', 'Timer', 'Timeline', 'UI'].filter(function (name) {
      return !sp[name];
    });
    if (missing.length > 0) {
      console.error('[App] Missing modules: ' + missing.join(', '));
      return;
    }

    sp.Store.init();
    document.documentElement.setAttribute('data-theme', sp.Store.getTheme() === 'dark' ? 'dark' : 'light');
    sp.Timer.init();
    sp.UI.init();
    sp.UI.render();

    // Wait one frame so the layout is final before scrolling.
    window.requestAnimationFrame(function () {
      sp.Timeline.scrollToCurrentOrMorning(sp.UI.getCurrentDateKey());
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  window.StudyPlan.App = { start: start };
})();
