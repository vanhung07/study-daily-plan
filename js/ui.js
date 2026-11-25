/**
 * UI controller: sidebar, header, focus timer bar, modals, toasts, import/export,
 * theme and keyboard shortcuts. Glues Store, Timer and Timeline together.
 * Attached to window.StudyPlan.UI as a classic IIFE (no ES modules).
 */
(function () {
  'use strict';

  window.StudyPlan = window.StudyPlan || {};

  var Utils = window.StudyPlan.Utils;
  var Store = window.StudyPlan.Store;
  var Timer = window.StudyPlan.Timer;
  var Timeline = window.StudyPlan.Timeline;

  /**
   * @typedef {Object} SubTask
   * @property {string} id
   * @property {string} text
   * @property {boolean} done
   */

  /**
   * @typedef {Object} ToastOptions
   * @property {string} [actionLabel]
   * @property {function(): void} [onAction]
   * @property {number} [duration]
   */

  var TOAST_DURATION_MS = 4500;
  var TOAST_ACTION_DURATION_MS = 7000;
  var FOCUS_SAVE_DELAY_MS = 350;
  var DEFAULT_THEME = 'light';
  var CLICK_FX_SELECTOR =
    '.btn, .nav-seg-btn, .weekday-chip, .preset-chip, .subject-chip, .block-focus-btn, .theme-card';

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  var state = {
    currentDateKey: Utils.getTodayKey(),
    calendarYear: 0,
    calendarMonth: 0,
    /** @type {string|null} */
    selectedSubjectFilter: null,
    /** @type {'add'|'edit'} */
    modalMode: 'add',
    /** @type {string|null} */
    editingBlockId: null,
    modalDateKey: Utils.getTodayKey(),
    /** @type {SubTask[]} */
    modalSubtasks: [],
    /** @type {string} */
    modalSubjectId: '',
    modalPriority: 'medium',
    /** @type {number[]} */
    modalRepeatDays: [],
    /** @type {string|null} */
    editingSeriesId: null,
    /** @type {string} */
    pendingImportText: '',
    newSubjectColor: Utils.COLORS[0],
    /** @type {function(boolean): void|null} */
    confirmResolver: null,
    sidebarOpen: false,
    lastTimerKey: '',
    lastLightTheme: 'light',
    lastDarkTheme: 'dark'
  };

  /** @type {Object<string, HTMLElement|null>} */
  var el = {};
  var lastFocusedBeforeModal = null;
  var focusSaveTimer = 0;
  var initialized = false;
  /** @type {AudioContext|null} */
  var sharedAudioCtx = null;

  /**
   * Shortcut for document.getElementById.
   * @param {string} id
   * @returns {HTMLElement|null}
   */
  function byId(id) {
    return document.getElementById(id);
  }

  /**
   * Escapes text for safe HTML insertion.
   * @param {string} text
   * @returns {string}
   */
  function esc(text) {
    return Utils.escapeHtml(String(text == null ? '' : text));
  }

  // ---------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------

  /**
   * Shows a toast message with an optional action button (e.g. Undo).
   * @param {string} message
   * @param {ToastOptions} [options]
   */
  function showToast(message, options) {
    var container = el.toastContainer;
    if (!container) return;
    var opts = options || {};
    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');

    var text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;
    toast.appendChild(text);

    var removed = false;
    var timeoutId = 0;
    function dismiss() {
      if (removed) return;
      removed = true;
      window.clearTimeout(timeoutId);
      toast.classList.add('is-leaving');
      toast.style.transition = 'opacity 200ms ease, transform 200ms ease';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(6px)';
      window.setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 220);
    }

    if (opts.actionLabel && typeof opts.onAction === 'function') {
      var action = document.createElement('button');
      action.type = 'button';
      action.className = 'toast-action';
      action.textContent = opts.actionLabel;
      action.addEventListener('click', function () {
        var handler = opts.onAction;
        dismiss();
        if (handler) handler();
      });
      toast.appendChild(action);
    }

    container.appendChild(toast);
    // Keep the stack short: drop the oldest toasts beyond 4.
    while (container.children.length > 4) container.removeChild(container.firstChild);

    var duration = opts.duration || (opts.actionLabel ? TOAST_ACTION_DURATION_MS : TOAST_DURATION_MS);
    timeoutId = window.setTimeout(dismiss, duration);
  }

  // ---------------------------------------------------------------------
  // Modals (generic)
  // ---------------------------------------------------------------------

  /**
   * Returns true when the modal overlay is visible.
   * @param {HTMLElement|null} modal
   * @returns {boolean}
   */
  function isModalOpen(modal) {
    return Boolean(modal && !modal.classList.contains('hidden'));
  }

  /** @returns {boolean} True if any modal is currently visible. */
  function anyModalOpen() {
    return (
      isModalOpen(el.blockModal) ||
      isModalOpen(el.importModal) ||
      isModalOpen(el.confirmModal) ||
      isModalOpen(el.cloudSetupModal) ||
      isModalOpen(el.themeModal) ||
      isModalOpen(el.weeklyStatsModal)
    );
  }

  /** Locks body scrolling while a modal is open. */
  function syncBodyLock() {
    document.body.style.overflow = anyModalOpen() ? 'hidden' : '';
  }

  /**
   * @param {HTMLElement|null} modal
   */
  function openModal(modal) {
    if (!modal) return;
    if (!anyModalOpen()) lastFocusedBeforeModal = document.activeElement;
    modal.classList.remove('hidden');
    syncBodyLock();
  }

  /**
   * @param {HTMLElement|null} modal
   */
  function closeModal(modal) {
    if (!modal) return;
    modal.classList.add('hidden');
    syncBodyLock();
    if (!anyModalOpen() && lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === 'function') {
      try {
        lastFocusedBeforeModal.focus();
      } catch (err) {
        /* element may be gone; ignore */
      }
    }
  }

  /**
   * Opens the confirm modal and resolves with the user's choice.
   * @param {{title: string, message: string, okLabel?: string}} config
   * @returns {Promise<boolean>}
   */
  function confirmDialog(config) {
    return new Promise(function (resolve) {
      if (!el.confirmModal) {
        resolve(window.confirm(config.message));
        return;
      }
      if (state.confirmResolver) state.confirmResolver(false);
      state.confirmResolver = resolve;
      if (el.confirmTitle) el.confirmTitle.textContent = config.title;
      if (el.confirmMessage) el.confirmMessage.textContent = config.message;
      if (el.confirmOk) el.confirmOk.textContent = config.okLabel || '\u0110\u1ED3ng \u00FD';
      openModal(el.confirmModal);
      if (el.confirmOk) el.confirmOk.focus();
    });
  }

  /**
   * Closes the confirm modal and settles the pending promise.
   * @param {boolean} result
   */
  function resolveConfirm(result) {
    var resolver = state.confirmResolver;
    state.confirmResolver = null;
    closeModal(el.confirmModal);
    if (resolver) resolver(result);
  }

  // ---------------------------------------------------------------------
  // Theme, gallery & tactile click FX
  // ---------------------------------------------------------------------

  /**
   * Lazily initializes and returns the shared Web Audio context.
   * @returns {AudioContext|null}
   */
  function getSharedAudioContext() {
    if (sharedAudioCtx) return sharedAudioCtx;
    var Ctx =
      window.AudioContext ||
      /** @type {typeof AudioContext|undefined} */ (/** @type {unknown} */ (window).webkitAudioContext);
    if (!Ctx) return null;
    sharedAudioCtx = new Ctx();
    return sharedAudioCtx;
  }

  /**
   * Checks whether subtle UI sound effects are currently permitted.
   * @returns {boolean}
   */
  function canPlayUiSound() {
    if (typeof Store.getClickFx === 'function' && !Store.getClickFx()) return false;
    var snap = Timer && typeof Timer.getSnapshot === 'function' ? Timer.getSnapshot() : null;
    if (snap && snap.muted) return false;
    return true;
  }

  /** Plays a soft 35ms tactile UI pop sound when click FX and sound are enabled. */
  function playClickPop() {
    if (!canPlayUiSound()) return;
    try {
      var ctx = getSharedAudioContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(function () {});
      }
      var now = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(780, now + 0.035);
      gain.gain.setValueAtTime(0.028, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.038);
    } catch (err) {
      /* ignore Web Audio restrictions */
    }
  }

  /** Plays a gentle two-note chime when selecting a theme card. */
  function playThemeChime() {
    if (!canPlayUiSound()) return;
    try {
      var ctx = getSharedAudioContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(function () {});
      }
      var now = ctx.currentTime;
      var notes = [587.33, 880];
      for (var i = 0; i < notes.length; i += 1) {
        var start = now + i * 0.055;
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(notes[i], start);
        gain.gain.setValueAtTime(0.03, start);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.115);
      }
    } catch (err) {
      /* ignore Web Audio restrictions */
    }
  }

  /**
   * Delegated pointerdown handler for tactile button ripple and subtle pop sound.
   * @param {PointerEvent} e
   */
  function onDocumentPointerDown(e) {
    if (typeof e.button === 'number' && e.button !== 0) return;
    var rawTarget = /** @type {HTMLElement|null} */ (e.target);
    if (!rawTarget || typeof rawTarget.closest !== 'function') return;
    var btn = /** @type {HTMLButtonElement|HTMLElement|null} */ (rawTarget.closest(CLICK_FX_SELECTOR));
    if (!btn) return;
    if (/** @type {HTMLButtonElement} */ (btn).disabled || btn.getAttribute('aria-disabled') === 'true') return;

    var fxEnabled = typeof Store.getClickFx === 'function' ? Store.getClickFx() : true;
    if (!fxEnabled) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    var rect = btn.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      var diameter = Math.max(rect.width, rect.height);
      var x = e.clientX === 0 && e.clientY === 0 ? rect.width / 2 : e.clientX - rect.left;
      var y = e.clientY === 0 && e.clientY === 0 ? rect.height / 2 : e.clientY - rect.top;
      var wave = document.createElement('span');
      wave.className = 'btn-ripple-wave';
      wave.style.width = diameter + 'px';
      wave.style.height = diameter + 'px';
      wave.style.left = x + 'px';
      wave.style.top = y + 'px';
      btn.appendChild(wave);
      window.setTimeout(function () {
        if (wave.parentNode) wave.parentNode.removeChild(wave);
      }, 560);
    }

    playClickPop();
  }

  /**
   * Applies a theme to the <html> element and updates theme UI labels.
   * @param {string} theme
   */
  function applyTheme(theme) {
    var meta = Utils.getThemeMeta(theme);
    document.documentElement.setAttribute('data-theme', meta.id);
    document.documentElement.setAttribute('data-color-scheme', meta.scheme);
    if (meta.scheme === 'dark') {
      state.lastDarkTheme = meta.id;
    } else {
      state.lastLightTheme = meta.id;
    }
    if (el.currentThemeLabel) {
      el.currentThemeLabel.textContent = meta.name;
    }
  }

  /** Smartly switches between the user's chosen light theme and chosen dark theme. */
  function toggleTheme() {
    var currentMeta = Utils.getThemeMeta(Store.getTheme());
    var next =
      currentMeta.scheme === 'dark'
        ? state.lastLightTheme || DEFAULT_THEME
        : state.lastDarkTheme || 'dark';
    applyTheme(next);
    Store.setTheme(next);
    if (isModalOpen(el.themeModal)) renderThemeModal();
  }

  /** Renders all 8 theme cards and click FX switch inside the theme gallery modal. */
  function renderThemeModal() {
    var activeId = Utils.getThemeMeta(Store.getTheme()).id;
    if (el.themeGrid && Array.isArray(Utils.THEMES)) {
      el.themeGrid.innerHTML = Utils.THEMES.map(function (t) {
        var isActive = t.id === activeId;
        var p = t.preview || ['#ffffff', '#f7f6f3', '#2383e2', '#0f7b6c'];
        return (
          '<button type="button" class="theme-card' + (isActive ? ' is-active' : '') +
          '" data-theme-id="' + esc(t.id) + '" role="radio" aria-checked="' + (isActive ? 'true' : 'false') + '">' +
          '<div class="theme-preview" style="background: ' + esc(p[0]) + '; --preview-accent: ' + esc(p[2]) + ';">' +
          '<span class="theme-preview-sidebar" style="background: ' + esc(p[1]) + ';">' +
          '<span class="theme-preview-dots"><span></span><span></span><span></span></span>' +
          '<span class="theme-preview-line"></span>' +
          '<span class="theme-preview-line" style="width: 55%;"></span>' +
          '</span>' +
          '<span class="theme-preview-main">' +
          '<span class="theme-preview-accent" style="background: ' + esc(p[2]) + ';"></span>' +
          '<span class="theme-preview-pill" style="background: ' + esc(p[3]) + '24; border-left-color: ' + esc(p[2]) + ';"></span>' +
          '</span>' +
          '</div>' +
          '<div class="theme-card-body">' +
          '<div class="theme-card-title-row">' +
          '<span class="theme-card-name">' + esc(t.name) + '</span>' +
          '<span class="theme-card-badge">' + esc(t.badge) + '</span>' +
          '</div>' +
          '<p class="theme-card-desc">' + esc(t.desc) + '</p>' +
          '</div>' +
          '</button>'
        );
      }).join('');
    }
    if (el.toggleClickFx) {
      var fxOn = typeof Store.getClickFx === 'function' ? Store.getClickFx() : true;
      el.toggleClickFx.setAttribute('aria-checked', fxOn ? 'true' : 'false');
      el.toggleClickFx.classList.toggle('is-active', fxOn);
    }
  }

  /** Opens the theme gallery modal. */
  function openThemeModal() {
    if (!el.themeModal) return;
    if (state.sidebarOpen) setSidebarOpen(false);
    renderThemeModal();
    openModal(el.themeModal);
  }

  /**
   * Opens or closes the mobile sidebar drawer.
   * @param {boolean} open
   */
  function setSidebarOpen(open) {
    state.sidebarOpen = open;
    if (el.sidebar) el.sidebar.classList.toggle('is-open', open);
    if (el.sidebarBackdrop) {
      el.sidebarBackdrop.classList.toggle('hidden', !open);
      el.sidebarBackdrop.classList.toggle('is-open', open);
    }
    document.body.classList.toggle('sidebar-open', open);
  }

  // ---------------------------------------------------------------------
  // Date navigation
  // ---------------------------------------------------------------------

  /** Persists any pending daily-focus text immediately. */
  function flushDailyFocus() {
    if (!el.dailyFocus) return;
    window.clearTimeout(focusSaveTimer);
    focusSaveTimer = 0;
    var day = Store.getDay(state.currentDateKey);
    if (day.focus !== el.dailyFocus.value) {
      Store.setDailyFocus(state.currentDateKey, el.dailyFocus.value);
    }
  }

  /**
   * Switches the visible day.
   * @param {string} dateKey
   * @param {boolean} [scroll=true] Whether to scroll the timeline.
   */
  function setDate(dateKey, scroll) {
    if (!Utils.isValidDateKey(dateKey)) return;
    flushDailyFocus();
    state.currentDateKey = dateKey;
    var parsed = Utils.parseDateKey(dateKey);
    state.calendarYear = parsed.getFullYear();
    state.calendarMonth = parsed.getMonth();
    if (el.dailyFocus) el.dailyFocus.value = Store.getDay(dateKey).focus || '';
    renderAll();
    if (scroll !== false) Timeline.scrollToCurrentOrMorning(dateKey);
  }

  /** Jumps to today. */
  function goToToday() {
    setDate(Utils.getTodayKey(), true);
  }

  /**
   * Moves the visible day by a number of days.
   * @param {number} delta
   */
  function shiftDay(delta) {
    setDate(Utils.addDays(state.currentDateKey, delta), false);
  }

  // ---------------------------------------------------------------------
  // Rendering: header
  // ---------------------------------------------------------------------

  /** Renders the date title, relative badge and filter chip. */
  function renderHeader() {
    if (el.dateTitle) el.dateTitle.textContent = Utils.formatFullDateVi(state.currentDateKey);
    if (el.relativeBadge) {
      var label = Utils.getRelativeDayLabelVi(state.currentDateKey);
      el.relativeBadge.textContent = label;
      el.relativeBadge.classList.toggle('hidden', !label);
    }
    renderFilterChip();
  }

  /** Shows or hides the active subject filter chip. */
  function renderFilterChip() {
    if (!el.filterChip) return;
    var subject = state.selectedSubjectFilter ? Store.getSubjectById(state.selectedSubjectFilter) : null;
    if (state.selectedSubjectFilter && !subject) state.selectedSubjectFilter = null;
    el.filterChip.classList.toggle('hidden', !subject);
    if (!subject) return;
    if (el.filterDot) el.filterDot.setAttribute('data-color', subject.color || 'slate');
    if (el.filterName) el.filterName.textContent = subject.name;
  }

  // ---------------------------------------------------------------------
  // Rendering: sidebar
  // ---------------------------------------------------------------------

  /** Renders the study streak count. */
  function renderStreak() {
    if (el.streakCount) el.streakCount.textContent = String(Store.getStudyStreak());
  }

  /** Renders the sidebar weekly auto-repeat switch and caption. */
  function renderWeeklyRepeat() {
    if (!el.toggleWeeklyRepeat) return;
    var active = typeof Store.getWeeklyRepeat === 'function' ? Store.getWeeklyRepeat() : false;
    el.toggleWeeklyRepeat.setAttribute('aria-checked', active ? 'true' : 'false');
    var card = el.toggleWeeklyRepeat.closest('.weekly-repeat-card');
    if (card) card.classList.toggle('is-active', active);
    if (el.weeklyRepeatDesc) {
      el.weeklyRepeatDesc.textContent = active
        ? 'Đang bật: lịch tuần này sẽ tự lặp sang tuần sau.'
        : 'Bật để tuần sau tự động lặp lại lịch tuần này.';
    }
  }

  /** Renders the mini calendar for the selected month. */
  function renderCalendar() {
    if (!el.calGrid) return;
    if (el.calTitle) el.calTitle.textContent = Utils.formatMonthYearVi(state.calendarYear, state.calendarMonth);

    var firstKey = Utils.toDateKey(new Date(state.calendarYear, state.calendarMonth, 1, 12, 0, 0));
    var daysInMonth = new Date(state.calendarYear, state.calendarMonth + 1, 0).getDate();
    var offset = (Utils.parseDateKey(firstKey).getDay() + 6) % 7; // Monday first
    var cellCount = offset + daysInMonth <= 35 ? 35 : 42;
    var gridStart = Utils.addDays(firstKey, -offset);
    var todayKey = Utils.getTodayKey();
    var html = '';

    for (var i = 0; i < cellCount; i += 1) {
      var key = Utils.addDays(gridStart, i);
      var parsed = Utils.parseDateKey(key);
      var classes = ['cal-day'];
      if (parsed.getMonth() !== state.calendarMonth) classes.push('other-month');
      if (key === todayKey) classes.push('is-today');
      if (key === state.currentDateKey) classes.push('is-selected');
      if (Store.hasBlocksOnDate(key)) classes.push('has-blocks');
      html +=
        '<button type="button" class="' + classes.join(' ') + '" data-date="' + key +
        '" aria-label="' + esc(Utils.formatFullDateVi(key)) + '">' + parsed.getDate() + '</button>';
    }
    el.calGrid.innerHTML = html;
  }

  /** Syncs the daily focus textarea without clobbering active typing. */
  function renderDailyFocus() {
    if (!el.dailyFocus) return;
    if (document.activeElement === el.dailyFocus) return;
    var value = Store.getDay(state.currentDateKey).focus || '';
    if (el.dailyFocus.value !== value) el.dailyFocus.value = value;
  }

  /** Renders the daily progress bar and metrics. */
  function renderStats() {
    var stats = Store.getDayStats(state.currentDateKey);
    if (el.progressPercent) el.progressPercent.textContent = stats.percent + '%';
    if (el.progressFill) {
      el.progressFill.style.width = stats.percent + '%';
      if (el.progressFill.parentElement) {
        el.progressFill.parentElement.setAttribute('aria-valuenow', String(stats.percent));
      }
    }
    if (el.statCompleted) el.statCompleted.textContent = Utils.formatDurationVi(stats.completedMin);
    if (el.statPlanned) el.statPlanned.textContent = Utils.formatDurationVi(stats.plannedMin);
    if (el.statFocused) el.statFocused.textContent = Utils.formatDurationVi(stats.focusedMin);
    if (el.statTasks) el.statTasks.textContent = stats.completedCount + '/' + stats.totalCount;
    renderWeeklyMiniStats();
    if (isModalOpen(el.weeklyStatsModal)) renderWeeklyStatsModal();
  }

  var weeklyStatsAnchor = Utils.getTodayKey();
  /** @type {'completed'|'pending'} */
  var weeklyTaskTab = 'completed';

  /** Renders the compact 7-day weekly progress mini-chart in the sidebar. */
  function renderWeeklyMiniStats() {
    if (!el.weeklyMiniBars || typeof Store.getWeekStats !== 'function') return;
    var wk = Store.getWeekStats(state.currentDateKey);
    if (el.weeklyMiniTasks) {
      el.weeklyMiniTasks.textContent = wk.completedCount + '/' + wk.totalCount + ' task';
    }
    if (el.weeklyMiniPercent) {
      el.weeklyMiniPercent.textContent = wk.taskPercent + '%';
    }
    var maxPlanned = wk.days.reduce(function (m, d) { return Math.max(m, d.plannedMin); }, 60);
    el.weeklyMiniBars.innerHTML = wk.days.map(function (d) {
      var plannedPct = d.plannedMin > 0 ? Math.max(14, Math.round((d.plannedMin / maxPlanned) * 100)) : 0;
      var donePct = d.completedMin > 0 ? Math.max(14, Math.round((d.completedMin / maxPlanned) * 100)) : 0;
      return (
        '<button type="button" class="wk-mini-col' + (d.isToday ? ' is-today' : '') +
        '" data-date="' + d.dateKey + '" title="' + esc(d.shortLabel + ' ' + d.dateShort + ': ' + d.completedCount + '/' + d.totalCount + ' task') + '">' +
        '<span class="wk-mini-track">' +
        (plannedPct > 0 ? '<span class="wk-mini-planned" style="height:' + plannedPct + '%"></span>' : '') +
        (donePct > 0 ? '<span class="wk-mini-done" style="height:' + donePct + '%"></span>' : '') +
        '</span>' +
        '<span class="wk-mini-label">' + d.shortLabel + '</span>' +
        '</button>'
      );
    }).join('');
  }

  /** Opens the full Weekly Analytics modal anchored to the currently viewed week. */
  function openWeeklyStatsModal() {
    if (!el.weeklyStatsModal) return;
    weeklyStatsAnchor = state.currentDateKey;
    renderWeeklyStatsModal();
    openModal(el.weeklyStatsModal);
  }

  /** Renders all KPIs, 7-day chart, subject breakdown and task list inside the Weekly Analytics modal. */
  function renderWeeklyStatsModal() {
    if (!el.weeklyStatsModal || typeof Store.getWeekStats !== 'function') return;
    var wk = Store.getWeekStats(weeklyStatsAnchor);
    var startD = Utils.parseDateKey(wk.startDateKey);
    var endD = Utils.parseDateKey(wk.endDateKey);
    var rangeText =
      Utils.pad2(startD.getDate()) + '/' + Utils.pad2(startD.getMonth() + 1) +
      ' \u2013 ' +
      Utils.pad2(endD.getDate()) + '/' + Utils.pad2(endD.getMonth() + 1);

    if (el.weeklyRangeBadge) el.weeklyRangeBadge.textContent = rangeText;
    if (el.weeklyActiveDaysLabel) el.weeklyActiveDaysLabel.textContent = wk.activeDays + '/7 ng\u00E0y c\u00F3 h\u1ECDc';
    if (el.wkKpiTasks) el.wkKpiTasks.textContent = wk.completedCount + '/' + wk.totalCount;
    if (el.wkKpiTaskRate) el.wkKpiTaskRate.textContent = wk.taskPercent + '% ho\u00E0n th\u00E0nh';
    if (el.wkKpiHours) el.wkKpiHours.textContent = Utils.formatDurationVi(wk.completedMin);
    if (el.wkKpiPlanned) el.wkKpiPlanned.textContent = 'tr\u00EAn ' + Utils.formatDurationVi(wk.plannedMin) + ' l\u00EAn l\u1ECBch';
    if (el.wkKpiFocused) el.wkKpiFocused.textContent = Utils.formatDurationVi(wk.focusedMin);
    if (el.wkKpiSubtasks) el.wkKpiSubtasks.textContent = wk.subtasksDone + '/' + wk.subtasksTotal;

    // 7-day chart bars
    if (el.weeklyChartBars) {
      var maxMin = wk.days.reduce(function (m, d) { return Math.max(m, d.plannedMin); }, 60);
      el.weeklyChartBars.innerHTML = wk.days.map(function (d) {
        var plannedPct = d.plannedMin > 0 ? Math.max(10, Math.round((d.plannedMin / maxMin) * 100)) : 0;
        var donePct = d.completedMin > 0 ? Math.max(10, Math.round((d.completedMin / maxMin) * 100)) : 0;
        return (
          '<button type="button" class="wk-bar-col' + (d.isToday ? ' is-today' : '') +
          '" data-date="' + d.dateKey + '" title="' + esc(d.shortLabel + ' (' + d.dateShort + '): ' + d.completedCount + '/' + d.totalCount + ' task \u00B7 ' + Utils.formatDurationVi(d.completedMin)) + '">' +
          '<span class="wk-bar-count">' + d.completedCount + '/' + d.totalCount + '</span>' +
          '<span class="wk-bar-track">' +
          (plannedPct > 0 ? '<span class="wk-bar-planned" style="height:' + plannedPct + '%"></span>' : '') +
          (donePct > 0 ? '<span class="wk-bar-done" style="height:' + donePct + '%"></span>' : '') +
          '</span>' +
          '<span class="wk-bar-day">' + d.shortLabel + '</span>' +
          '<span class="wk-bar-date">' + d.dateShort + '</span>' +
          '</button>'
        );
      }).join('');
    }

    // Subject distribution
    if (el.weeklySubjectBreakdown) {
      if (wk.bySubject.length === 0) {
        el.weeklySubjectBreakdown.innerHTML = '<p class="weekly-empty-msg">Tu\u1EA7n n\u00E0y ch\u01B0a c\u00F3 khung gi\u1EDD h\u1ECDc n\u00E0o.</p>';
      } else {
        el.weeklySubjectBreakdown.innerHTML = wk.bySubject.map(function (s) {
          return (
            '<div class="wk-subject-row" data-color="' + esc(s.color) + '">' +
            '<div class="wk-subject-top">' +
            '<span class="wk-subject-name"><span class="subject-dot" data-color="' + esc(s.color) + '"></span>' + esc(s.name) + '</span>' +
            '<span class="wk-subject-meta">' + s.completedCount + '/' + s.totalCount + ' task \u00B7 ' + Utils.formatDurationVi(s.completedMin) + '/' + Utils.formatDurationVi(s.plannedMin) + ' (' + s.percent + '%)</span>' +
            '</div>' +
            '<div class="wk-subject-track"><div class="wk-subject-fill" style="width:' + s.percent + '%"></div></div>' +
            '</div>'
          );
        }).join('');
      }
    }

    // Task tabs & list
    if (el.wkTabCompletedCount) el.wkTabCompletedCount.textContent = String(wk.completedTasks.length);
    if (el.wkTabPendingCount) el.wkTabPendingCount.textContent = String(wk.pendingTasks.length);
    if (el.wkTabCompleted) {
      el.wkTabCompleted.classList.toggle('active', weeklyTaskTab === 'completed');
      el.wkTabCompleted.setAttribute('aria-selected', weeklyTaskTab === 'completed' ? 'true' : 'false');
    }
    if (el.wkTabPending) {
      el.wkTabPending.classList.toggle('active', weeklyTaskTab === 'pending');
      el.wkTabPending.setAttribute('aria-selected', weeklyTaskTab === 'pending' ? 'true' : 'false');
    }

    if (el.weeklyTaskList) {
      var list = weeklyTaskTab === 'pending' ? wk.pendingTasks : wk.completedTasks;
      if (list.length === 0) {
        el.weeklyTaskList.innerHTML =
          '<li class="weekly-empty-msg">' +
          (weeklyTaskTab === 'completed'
            ? 'Ch\u01B0a c\u00F3 task n\u00E0o \u0111\u01B0\u1EE3c \u0111\u00E1nh d\u1EA5u ho\u00E0n th\u00E0nh trong tu\u1EA7n n\u00E0y.'
            : 'Tuy\u1EC7t v\u1EDDi! Kh\u00F4ng c\u00F2n task n\u00E0o ch\u01B0a ho\u00E0n th\u00E0nh trong tu\u1EA7n n\u00E0y.') +
          '</li>';
      } else {
        el.weeklyTaskList.innerHTML = list.map(function (t) {
          var subInfo = t.subtasksTotal > 0 ? ' \u00B7 \u2713 ' + t.subtasksDone + '/' + t.subtasksTotal : '';
          var focusInfo = t.focusedMin > 0 ? ' \u00B7 \u23F1 ' + Utils.formatDurationVi(t.focusedMin) : '';
          return (
            '<li class="wk-task-item" data-color="' + esc(t.subjectColor) + '" data-date="' + t.dateKey + '">' +
            '<div class="wk-task-left">' +
            '<span class="wk-task-title">' + (t.completed ? '\u2713 ' : '') + esc(t.title) + '</span>' +
            '<span class="wk-task-sub">' +
            '<span class="wk-task-day-pill">' + t.shortDayLabel + ' ' + t.dateShort + '</span>' +
            '<span>' + esc(t.subjectName) + '</span>' +
            '<span>' + Utils.minutesToTime(t.startMin) + ' \u2013 ' + Utils.minutesToTime(t.endMin) + subInfo + focusInfo + '</span>' +
            '</span>' +
            '</div>' +
            '<span class="wk-task-right">' + Utils.formatDurationVi(t.durationMin) + '</span>' +
            '</li>'
          );
        }).join('');
      }
    }
  }

  /** Renders the subject list (with the "all subjects" item). */
  function renderSubjects() {
    if (!el.subjectList) return;
    var subjects = Store.getSubjects();
    var dayBlocks = Store.getBlocks(state.currentDateKey, null);
    if (el.subjectEmpty) el.subjectEmpty.classList.toggle('hidden', subjects.length > 0);

    if (subjects.length === 0) {
      el.subjectList.innerHTML = '';
      return;
    }

    var html =
      '<div class="subject-item' + (state.selectedSubjectFilter ? '' : ' active') +
      '" role="button" tabindex="0" data-subject-id="">' +
      '<span class="subject-dot" data-color="slate"></span>' +
      '<span class="subject-name">T\u1EA5t c\u1EA3 m\u00F4n h\u1ECDc</span>' +
      '<span class="subject-count">' + dayBlocks.length + '</span></div>';

    subjects.forEach(function (subject) {
      var count = dayBlocks.filter(function (b) { return b.subjectId === subject.id; }).length;
      var active = state.selectedSubjectFilter === subject.id;
      html +=
        '<div class="subject-item' + (active ? ' active' : '') + '" role="button" tabindex="0" ' +
        'data-subject-id="' + esc(subject.id) + '" data-color="' + esc(subject.color) + '">' +
        '<span class="subject-dot" data-color="' + esc(subject.color) + '"></span>' +
        '<span class="subject-name">' + esc(subject.name) + '</span>' +
        '<span class="subject-count">' + count + '</span>' +
        '<button type="button" class="subject-delete" data-delete-subject="' + esc(subject.id) +
        '" aria-label="Xo\u00E1 m\u00F4n ' + esc(subject.name) + '" title="Xo\u00E1 m\u00F4n h\u1ECDc">\u00D7</button>' +
        '</div>';
    });
    el.subjectList.innerHTML = html;
  }

  /** Renders the color swatches of the add-subject form. */
  function renderSubjectSwatches() {
    if (!el.newSubjectSwatches) return;
    el.newSubjectSwatches.innerHTML = Utils.COLORS.map(function (color) {
      return (
        '<button type="button" class="color-swatch' + (color === state.newSubjectColor ? ' active' : '') +
        '" data-color="' + color + '" aria-label="M\u00E0u ' + color + '" aria-pressed="' +
        (color === state.newSubjectColor ? 'true' : 'false') + '"></button>'
      );
    }).join('');
  }

  // ---------------------------------------------------------------------
  // Rendering: focus timer bar
  // ---------------------------------------------------------------------

  /** Updates the integrated focus timer bar from the Timer snapshot. */
  function renderTimerBar() {
    if (!el.timerBar) return;
    var snap = Timer.getSnapshot();
    var active = Boolean(snap && snap.status && snap.status !== 'idle');
    el.timerBar.classList.toggle('hidden', !active);

    var timerKey = active ? snap.blockId + '|' + snap.status + '|' + snap.phase : 'idle';
    if (timerKey !== state.lastTimerKey) {
      state.lastTimerKey = timerKey;
      Timeline.refreshTimerState();
    }
    if (!active) return;

    var isBreak = snap.phase === 'break';
    var isPaused = snap.status === 'paused';

    if (el.timerClock) el.timerClock.textContent = Utils.formatTimerClock(snap.remainingMs);
    if (el.timerPhase) {
      el.timerPhase.textContent = isBreak ? 'Ngh\u1EC9 ng\u1EAFn' : 'T\u1EADp trung';
      el.timerPhase.classList.toggle('is-break', isBreak);
      el.timerPhase.setAttribute('data-phase', isBreak ? 'break' : 'focus');
    }
    if (el.timerBlockTitle) {
      var block = snap.blockId ? Store.getBlockById(snap.dateKey || state.currentDateKey, snap.blockId) : null;
      el.timerBlockTitle.textContent = snap.blockTitle || (block ? block.title : '');
    }
    var mode = snap.mode === 'block' ? 'block' : 'pomodoro';
    setActiveButton(el.timerModePomodoro, mode === 'pomodoro');
    setActiveButton(el.timerModeBlock, mode === 'block');
    if (el.timerToggle) el.timerToggle.textContent = isPaused ? 'Ti\u1EBFp t\u1EE5c' : 'T\u1EA1m d\u1EEBng';
    if (el.timerSkip) el.timerSkip.classList.toggle('hidden', !isBreak);
    if (el.timerMute) {
      var muted = Boolean(snap.muted);
      el.timerMute.classList.toggle('is-muted', muted);
      el.timerMute.setAttribute('aria-pressed', muted ? 'true' : 'false');
      el.timerMute.title = muted ? 'B\u1EADt chu\u00F4ng' : 'T\u1EAFt chu\u00F4ng';
    }
  }

  /**
   * Toggles the active state of a toggle-like button.
   * @param {HTMLElement|null} button
   * @param {boolean} active
   */
  function setActiveButton(button, active) {
    if (!button) return;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  /**
   * Handles a finished focus/break phase from the Timer.
   * @param {Object} info
   */
  function handleTimerComplete(info) {
    var data = info || {};
    var kind = data.type || data.phase || '';
    if (data.message) {
      showToast(data.message);
    } else if (kind === 'break') {
      showToast('H\u1EBFt gi\u1EDD ngh\u1EC9 \u2014 s\u1EB5n s\u00E0ng h\u1ECDc ti\u1EBFp ch\u1EE9?');
    } else if (kind === 'block' || data.mode === 'block') {
      showToast('\uD83C\uDF89 B\u1EA1n \u0111\u00E3 h\u1ECDc xong khung gi\u1EDD n\u00E0y. Tuy\u1EC7t v\u1EDDi!');
    } else {
      showToast('\uD83C\uDF89 Ho\u00E0n th\u00E0nh m\u1ED9t phi\u00EAn t\u1EADp trung! Ngh\u1EC9 ng\u01A1i m\u1ED9t ch\u00FAt nh\u00E9.');
    }
    renderTimerBar();
  }

  // ---------------------------------------------------------------------
  // Render all
  // ---------------------------------------------------------------------

  /** Re-renders every dynamic area from current state. */
  function renderAll() {
    if (!initialized) return;
    applyTheme(Store.getTheme());
    renderHeader();
    renderStreak();
    renderWeeklyRepeat();
    renderCalendar();
    renderDailyFocus();
    renderStats();
    renderSubjects();
    if (isModalOpen(el.themeModal)) renderThemeModal();
    Timeline.render(state.currentDateKey, state.selectedSubjectFilter);
    renderTimerBar();
  }

  // ---------------------------------------------------------------------
  // Block modal
  // ---------------------------------------------------------------------

  /** Updates the duration pill and highlights the matching preset chip. */
  function updateDurationPill() {
    var start = Utils.inputTimeToMinutes(el.blockStart.value);
    var end = Utils.inputTimeToMinutes(el.blockEnd.value);
    var valid = !Number.isNaN(start) && !Number.isNaN(end) && end > start;
    if (el.durationPill) {
      el.durationPill.textContent = valid ? Utils.formatDurationVi(end - start) : '\u2014';
    }
    if (el.durationPresets) {
      var chips = el.durationPresets.querySelectorAll('.preset-chip');
      for (var i = 0; i < chips.length; i += 1) {
        var duration = Number(chips[i].getAttribute('data-duration'));
        chips[i].classList.toggle('active', valid && end - start === duration);
      }
    }
  }

  /** Renders subject chips inside the block modal. */
  function renderModalSubjects() {
    if (!el.modalSubjectPicker) return;
    var html =
      '<button type="button" class="subject-chip' + (state.modalSubjectId ? '' : ' active') +
      '" data-subject-id="" data-color="slate">Kh\u00F4ng ch\u1ECDn</button>';
    Store.getSubjects().forEach(function (subject) {
      html +=
        '<button type="button" class="subject-chip' + (state.modalSubjectId === subject.id ? ' active' : '') +
        '" data-subject-id="' + esc(subject.id) + '" data-color="' + esc(subject.color) + '">' +
        '<span class="subject-dot" data-color="' + esc(subject.color) + '"></span>' +
        esc(subject.name) + '</button>';
    });
    el.modalSubjectPicker.innerHTML = html;
  }

  /** Highlights the selected priority option. */
  function renderModalPriority() {
    if (!el.priorityPicker) return;
    var options = el.priorityPicker.querySelectorAll('.seg-option');
    for (var i = 0; i < options.length; i += 1) {
      var active = options[i].getAttribute('data-priority') === state.modalPriority;
      options[i].classList.toggle('active', active);
      options[i].setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  /** Renders weekday repeat chips and smart helper text inside the block modal. */
  function renderModalRepeatDays() {
    if (el.repeatDaysPicker) {
      var chips = el.repeatDaysPicker.querySelectorAll('.weekday-chip');
      for (var i = 0; i < chips.length; i += 1) {
        var dow = Number(chips[i].getAttribute('data-dow'));
        var isSelected = state.modalRepeatDays.indexOf(dow) !== -1;
        chips[i].classList.toggle('active', isSelected);
        chips[i].setAttribute('aria-pressed', isSelected ? 'true' : 'false');
      }
    }
    if (el.btnRepeatQuick) {
      el.btnRepeatQuick.textContent = state.modalRepeatDays.length > 0 ? 'Bỏ lặp' : 'Lặp thứ này';
    }
    if (el.repeatDaysHint) {
      if (state.modalRepeatDays.length > 0) {
        var displayOrder = [1, 2, 3, 4, 5, 6, 0];
        var names = displayOrder
          .filter(function (d) { return state.modalRepeatDays.indexOf(d) !== -1; })
          .map(function (d) { return Utils.WEEKDAYS_VI[d]; });
        el.repeatDaysHint.textContent =
          names.length === 7
            ? 'Tự động lặp lại vào tất cả các ngày trong tuần.'
            : 'Tự động lặp vào ' + names.join(', ') + ' hàng tuần.';
      } else if (typeof Store.getWeeklyRepeat === 'function' && Store.getWeeklyRepeat()) {
        var modalDow = Utils.parseDateKey(state.modalDateKey).getDay();
        el.repeatDaysHint.textContent =
          'Đang tự lặp mỗi ' + Utils.WEEKDAYS_VI[modalDow] + ' (theo cài đặt Lặp lại tuần). Chọn thêm thứ nếu học nhiều buổi/tuần.';
      } else {
        el.repeatDaysHint.textContent = 'Không lặp riêng (chỉ tạo cho ngày đang chọn).';
      }
    }
  }

  /** Renders the sub-task checklist inside the modal. */
  function renderModalSubtasks() {
    if (!el.modalSubtaskList) return;
    el.modalSubtaskList.innerHTML = state.modalSubtasks.map(function (task) {
      return (
        '<li class="subtask-item' + (task.done ? ' is-done' : '') + '" data-subtask-id="' + esc(task.id) + '">' +
        '<input type="checkbox" class="subtask-check"' + (task.done ? ' checked' : '') +
        ' aria-label="Ho\u00E0n th\u00E0nh: ' + esc(task.text) + '">' +
        '<span class="subtask-text">' + esc(task.text) + '</span>' +
        '<button type="button" class="subtask-remove" aria-label="Xo\u00E1 vi\u1EC7c nh\u1ECF" title="Xo\u00E1">\u00D7</button>' +
        '</li>'
      );
    }).join('');
  }

  /** Adds the text in the sub-task input to the working list. */
  function addModalSubtask() {
    var text = el.subtaskInput.value.trim();
    if (!text) return;
    state.modalSubtasks.push({ id: Utils.uid('st'), text: text, done: false });
    el.subtaskInput.value = '';
    renderModalSubtasks();
    el.subtaskInput.focus();
  }

  /**
   * Shows or clears the form error message.
   * @param {string} message Empty string hides the error.
   */
  function setFormError(message) {
    if (!el.blockFormError) return;
    el.blockFormError.textContent = message;
    el.blockFormError.classList.toggle('hidden', !message);
  }

  /**
   * Opens the block modal in add or edit mode.
   * @param {'add'|'edit'} mode
   * @param {{startMin?: number, endMin?: number, blockId?: string}} [options]
   */
  function openBlockModal(mode, options) {
    var opts = options || {};
    var block = null;
    if (mode === 'edit' && opts.blockId) {
      block = Store.getBlockById(state.currentDateKey, opts.blockId);
      if (!block) return;
    }

    state.modalMode = block ? 'edit' : 'add';
    state.editingBlockId = block ? block.id : null;
    state.modalDateKey = state.currentDateKey;
    setFormError('');

    var range = Timeline.getDefaultRange(state.currentDateKey);
    var startMin = block ? block.startMin : typeof opts.startMin === 'number' ? opts.startMin : range.startMin;
    var endMin = block ? block.endMin : typeof opts.endMin === 'number' ? opts.endMin : startMin + 60;

    state.modalSubjectId = block ? block.subjectId || '' : state.selectedSubjectFilter || '';
    state.modalPriority = block ? block.priority || 'medium' : 'medium';
    state.modalSubtasks = block
      ? (block.subtasks || []).map(function (t) { return { id: t.id, text: t.text, done: Boolean(t.done) }; })
      : [];

    var existingRule = block && block.seriesId && typeof Store.getRecurringRuleById === 'function'
      ? Store.getRecurringRuleById(block.seriesId)
      : null;
    state.editingSeriesId = existingRule ? existingRule.id : null;
    state.modalRepeatDays = existingRule ? existingRule.daysOfWeek.slice() : [];

    el.blockModalTitle.textContent = block ? 'Ch\u1EC9nh s\u1EEDa khung gi\u1EDD' : 'Th\u00EAm khung gi\u1EDD h\u1ECDc';
    el.blockTitle.value = block ? block.title : '';
    el.blockStart.value = Utils.minutesToInputTime(startMin);
    el.blockEnd.value = Utils.minutesToInputTime(endMin);
    el.blockNotes.value = block ? block.notes || '' : '';
    if (el.blockCompleted) el.blockCompleted.checked = block ? Boolean(block.completed) : false;
    el.subtaskInput.value = '';

    // Edit-only actions.
    if (el.btnDeleteBlock) {
      el.btnDeleteBlock.classList.toggle('hidden', !block);
      el.btnDeleteBlock.textContent = state.editingSeriesId ? 'Xóa buổi này' : 'Xóa';
    }
    if (el.btnDeleteSeries) el.btnDeleteSeries.classList.toggle('hidden', !Boolean(block && state.editingSeriesId));
    if (el.btnMoveTomorrow) el.btnMoveTomorrow.classList.toggle('hidden', !block);
    if (el.blockCompletedRow) el.blockCompletedRow.classList.toggle('hidden', !block);

    renderModalSubjects();
    renderModalPriority();
    renderModalRepeatDays();
    renderModalSubtasks();
    updateDurationPill();
    openModal(el.blockModal);
    window.setTimeout(function () {
      el.blockTitle.focus();
      if (block) el.blockTitle.select();
    }, 30);
  }

  /** Closes the block modal without saving. */
  function closeBlockModal() {
    closeModal(el.blockModal);
    state.editingBlockId = null;
  }

  /** Validates and saves the block form. */
  function saveBlockFromForm() {
    var title = el.blockTitle.value.trim();
    var startMin = Utils.inputTimeToMinutes(el.blockStart.value);
    var endMin = Utils.inputTimeToMinutes(el.blockEnd.value);

    if (!title) {
      setFormError('Vui l\u00F2ng nh\u1EADp t\u00EAn khung gi\u1EDD.');
      el.blockTitle.focus();
      return;
    }
    if (Number.isNaN(startMin) || Number.isNaN(endMin)) {
      setFormError('Gi\u1EDD b\u1EAFt \u0111\u1EA7u ho\u1EB7c k\u1EBFt th\u00FAc ch\u01B0a h\u1EE3p l\u1EC7.');
      return;
    }
    if (endMin <= startMin) {
      setFormError('Gi\u1EDD k\u1EBFt th\u00FAc ph\u1EA3i sau gi\u1EDD b\u1EAFt \u0111\u1EA7u.');
      el.blockEnd.focus();
      return;
    }
    if (startMin < Utils.START_MIN || endMin > Utils.END_MIN) {
      setFormError('Khung gi\u1EDD ph\u1EA3i n\u1EB1m trong kho\u1EA3ng 05:00 \u2013 24:00.');
      return;
    }
    setFormError('');

    var payload = {
      title: title,
      subjectId: state.modalSubjectId || '',
      startMin: startMin,
      endMin: endMin,
      priority: state.modalPriority,
      notes: el.blockNotes.value.trim(),
      subtasks: state.modalSubtasks.map(function (t) { return { id: t.id, text: t.text, done: t.done }; })
    };

    var dateKey = state.modalDateKey;
    var currentDow = Utils.parseDateKey(dateKey).getDay();
    var repeatDays = state.modalRepeatDays.slice();

    if (repeatDays.length > 0 && typeof Store.saveRecurringRule === 'function') {
      var prevRule = state.editingSeriesId ? Store.getRecurringRuleById(state.editingSeriesId) : null;
      var startKey = prevRule && prevRule.startDateKey < dateKey ? prevRule.startDateKey : dateKey;
      var savedRule = Store.saveRecurringRule({
        id: state.editingSeriesId || undefined,
        title: title,
        subjectId: state.modalSubjectId || null,
        startMin: startMin,
        endMin: endMin,
        priority: state.modalPriority,
        notes: el.blockNotes.value.trim(),
        subtasks: state.modalSubtasks.map(function (t) { return { id: t.id, text: t.text }; }),
        daysOfWeek: repeatDays,
        startDateKey: startKey
      });
      if (savedRule) payload.seriesId = savedRule.id;

      if (state.modalMode === 'edit' && state.editingBlockId) {
        if (repeatDays.indexOf(currentDow) !== -1) {
          payload.completed = el.blockCompleted ? el.blockCompleted.checked : false;
          Store.updateBlock(dateKey, state.editingBlockId, payload);
        } else {
          Store.deleteBlock(dateKey, state.editingBlockId);
        }
        showToast('Đã cập nhật lịch lặp hàng tuần.');
      } else {
        if (repeatDays.indexOf(currentDow) !== -1) {
          payload.completed = el.blockCompleted ? el.blockCompleted.checked : false;
          Store.addBlock(dateKey, payload);
        }
        showToast('Đã tạo khung giờ lặp lại hàng tuần.');
      }
      closeBlockModal();
      return;
    }

    if (state.editingSeriesId && typeof Store.deleteRecurringRule === 'function') {
      Store.deleteRecurringRule(state.editingSeriesId);
      payload.seriesId = null;
    }

    if (state.modalMode === 'edit' && state.editingBlockId) {
      payload.completed = el.blockCompleted ? el.blockCompleted.checked : false;
      Store.updateBlock(dateKey, state.editingBlockId, payload);
      showToast('\u0110\u00E3 c\u1EADp nh\u1EADt khung gi\u1EDD.');
    } else {
      payload.completed = el.blockCompleted ? el.blockCompleted.checked : false;
      Store.addBlock(dateKey, payload);
      showToast('\u0110\u00E3 th\u00EAm khung gi\u1EDD m\u1EDBi.');
    }
    closeBlockModal();
  }

  /** Deletes the entire weekly recurring series (and current day's block) with undo. */
  function deleteEditingSeries() {
    var seriesId = state.editingSeriesId;
    var blockId = state.editingBlockId;
    var dateKey = state.modalDateKey;
    if (!seriesId || typeof Store.deleteRecurringRule !== 'function') return;
    var snap = Timer.getSnapshot();
    if (snap && snap.blockId === blockId && snap.status !== 'idle') Timer.stop();
    var removedRule = Store.deleteRecurringRule(seriesId);
    var removedBlock = blockId ? Store.deleteBlock(dateKey, blockId) : null;
    closeBlockModal();
    if (!removedRule) return;
    showToast('Đã xóa toàn bộ chuỗi lặp hàng tuần.', {
      actionLabel: 'Hoàn tác',
      onAction: function () {
        var restoredRule = Store.saveRecurringRule(removedRule);
        if (removedBlock) {
          if (restoredRule) removedBlock.seriesId = restoredRule.id;
          Store.restoreBlock(dateKey, removedBlock);
        }
      }
    });
  }

  /** Deletes the block being edited and offers undo. */
  function deleteEditingBlock() {
    var blockId = state.editingBlockId;
    if (!blockId) return;
    var dateKey = state.modalDateKey;
    var snap = Timer.getSnapshot();
    if (snap && snap.blockId === blockId && snap.status !== 'idle') Timer.stop();
    var removed = Store.deleteBlock(dateKey, blockId);
    closeBlockModal();
    if (!removed) return;
    showToast('\u0110\u00E3 xo\u00E1 khung gi\u1EDD.', {
      actionLabel: 'Ho\u00E0n t\u00E1c',
      onAction: function () {
        Store.restoreBlock(dateKey, removed);
      }
    });
  }

  /** Moves the block being edited to tomorrow and offers undo. */
  function moveEditingBlockToTomorrow() {
    var blockId = state.editingBlockId;
    if (!blockId) return;
    var dateKey = state.modalDateKey;
    var original = Store.getBlockById(dateKey, blockId);
    var originalCopy = original ? Utils.deepClone(original) : null;
    var result = Store.moveBlockToTomorrow(dateKey, blockId);
    closeBlockModal();
    if (!result || !originalCopy) return;
    showToast('\u0110\u00E3 chuy\u1EC3n sang ng\u00E0y mai', {
      actionLabel: 'Ho\u00E0n t\u00E1c',
      onAction: function () {
        Store.deleteBlock(result.targetDateKey, result.movedBlock.id);
        Store.restoreBlock(result.fromDateKey, originalCopy);
      }
    });
  }

  // ---------------------------------------------------------------------
  // Timeline callbacks
  // ---------------------------------------------------------------------

  /**
   * Starts, pauses or resumes the focus timer for a block.
   * @param {string} blockId
   */
  function handleRequestFocus(blockId) {
    var snap = Timer.getSnapshot();
    if (snap && snap.blockId === blockId && snap.status !== 'idle') {
      Timer.togglePause();
      return;
    }
    var mode = snap && snap.mode === 'block' ? 'block' : 'pomodoro';
    Timer.startForBlock(state.currentDateKey, blockId, mode);
  }

  /**
   * Toggles block completion with a gentle confirmation toast.
   * @param {string} blockId
   */
  function handleToggleComplete(blockId) {
    var updated = Store.toggleBlockCompleted(state.currentDateKey, blockId);
    if (updated && updated.completed) showToast('Tuy\u1EC7t v\u1EDDi! \u0110\u00E3 ho\u00E0n th\u00E0nh "' + updated.title + '".');
  }

  /**
   * Shows an undo toast after a block was dragged to a new time.
   * @param {{id: string, startMin: number, endMin: number}} block
   * @param {number} prevStart
   * @param {number} prevEnd
   */
  function handleBlockMoved(block, prevStart, prevEnd) {
    var dateKey = state.currentDateKey;
    showToast('\u0110\u00E3 d\u1EDDi sang ' + Utils.minutesToTime(block.startMin) + ' \u2013 ' + Utils.minutesToTime(block.endMin), {
      actionLabel: 'Ho\u00E0n t\u00E1c',
      onAction: function () {
        Store.updateBlock(dateKey, block.id, { startMin: prevStart, endMin: prevEnd });
      }
    });
  }

  /**
   * Shows an undo toast after a block was resized.
   * @param {{id: string, startMin: number, endMin: number}} block
   * @param {number} prevEnd
   */
  function handleBlockResized(block, prevEnd) {
    var dateKey = state.currentDateKey;
    showToast('Th\u1EDDi l\u01B0\u1EE3ng m\u1EDBi: ' + Utils.formatDurationVi(block.endMin - block.startMin), {
      actionLabel: 'Ho\u00E0n t\u00E1c',
      onAction: function () {
        Store.updateBlock(dateKey, block.id, { endMin: prevEnd });
      }
    });
  }

  /** Copies yesterday's blocks into the current day. */
  function handleCopyYesterday() {
    var dateKey = state.currentDateKey;
    var result = Store.copyFromYesterday(dateKey);
    if (!result || !result.copiedCount) {
      showToast('H\u00F4m qua ch\u01B0a c\u00F3 khung gi\u1EDD n\u00E0o \u0111\u1EC3 ch\u00E9p.');
      return;
    }
    showToast('\u0110\u00E3 ch\u00E9p ' + result.copiedCount + ' khung gi\u1EDD t\u1EEB h\u00F4m qua.', {
      actionLabel: 'Ho\u00E0n t\u00E1c',
      onAction: function () {
        result.blocks.forEach(function (b) {
          Store.deleteBlock(dateKey, b.id);
        });
      }
    });
  }

  /** Copies blocks from 7 days ago into the current day. */
  function handleCopyLastWeek() {
    if (typeof Store.copyFromLastWeek !== 'function') return;
    var dateKey = state.currentDateKey;
    var result = Store.copyFromLastWeek(dateKey);
    if (!result || !result.copiedCount) {
      showToast('Tuần trước chưa có khung giờ nào vào thứ này để chép.');
      return;
    }
    showToast('Đã chép ' + result.copiedCount + ' khung giờ từ tuần trước.', {
      actionLabel: 'Hoàn tác',
      onAction: function () {
        result.blocks.forEach(function (b) {
          Store.deleteBlock(dateKey, b.id);
        });
      }
    });
  }

  // ---------------------------------------------------------------------
  // Subjects
  // ---------------------------------------------------------------------

  /**
   * Sets (or clears) the active subject filter.
   * @param {string|null} subjectId
   */
  function setSubjectFilter(subjectId) {
    state.selectedSubjectFilter = subjectId || null;
    renderAll();
    if (state.sidebarOpen) setSidebarOpen(false);
  }

  /** Shows or hides the inline add-subject form. */
  function toggleAddSubjectForm(show) {
    if (!el.addSubjectForm) return;
    var visible = typeof show === 'boolean' ? show : el.addSubjectForm.classList.contains('hidden');
    el.addSubjectForm.classList.toggle('hidden', !visible);
    if (visible) {
      renderSubjectSwatches();
      if (el.newSubjectName) el.newSubjectName.focus();
    } else if (el.newSubjectName) {
      el.newSubjectName.value = '';
    }
  }

  /** Creates a subject from the inline form. */
  function submitNewSubject() {
    var name = el.newSubjectName.value.trim();
    if (!name) {
      showToast('Vui l\u00F2ng nh\u1EADp t\u00EAn m\u00F4n h\u1ECDc.');
      el.newSubjectName.focus();
      return;
    }
    var exists = Store.getSubjects().some(function (s) {
      return s.name.toLowerCase() === name.toLowerCase();
    });
    Store.addSubject(name, state.newSubjectColor);
    toggleAddSubjectForm(false);
    showToast(exists ? 'M\u00F4n "' + name + '" \u0111\u00E3 c\u00F3 trong danh s\u00E1ch.' : '\u0110\u00E3 th\u00EAm m\u00F4n "' + name + '".');
  }

  /**
   * Deletes a subject after confirmation.
   * @param {string} subjectId
   */
  function requestDeleteSubject(subjectId) {
    var subject = Store.getSubjectById(subjectId);
    if (!subject) return;
    confirmDialog({
      title: 'Xo\u00E1 m\u00F4n h\u1ECDc?',
      message: 'M\u00F4n "' + subject.name + '" s\u1EBD b\u1ECB xo\u00E1. C\u00E1c khung gi\u1EDD thu\u1ED9c m\u00F4n n\u00E0y v\u1EABn \u0111\u01B0\u1EE3c gi\u1EEF l\u1EA1i.',
      okLabel: 'Xo\u00E1 m\u00F4n'
    }).then(function (ok) {
      if (!ok) return;
      if (state.selectedSubjectFilter === subjectId) state.selectedSubjectFilter = null;
      Store.deleteSubject(subjectId);
      renderAll();
      showToast('\u0110\u00E3 xo\u00E1 m\u00F4n "' + subject.name + '".');
    });
  }

  // ---------------------------------------------------------------------
  // Export / Import
  // ---------------------------------------------------------------------

  /** Downloads the whole state as a JSON file. */
  function exportJSON() {
    var json = Store.exportJSONString();
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'daily-study-plan-' + Utils.getTodayKey() + '.json';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    showToast('\u0110\u00E3 xu\u1EA5t d\u1EEF li\u1EC7u ra t\u1EC7p JSON.');
  }

  /**
   * Reads the chosen file and opens the import modal after validation.
   * @param {File} file
   */
  function handleImportFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result || '');
      var preview = Store.previewImportJSON(text);
      if (!preview || !preview.ok) {
        showToast((preview && preview.error) || 'T\u1EC7p JSON kh\u00F4ng h\u1EE3p l\u1EC7.');
        return;
      }
      state.pendingImportText = text;
      if (el.importSummary) {
        el.importSummary.textContent =
          'T\u1EC7p ch\u1EE9a ' + (preview.blockCount || 0) + ' khung gi\u1EDD trong ' + (preview.dayCount || 0) +
          ' ng\u00E0y v\u00E0 ' + (preview.subjectCount || 0) + ' m\u00F4n h\u1ECDc.';
      }
      openModal(el.importModal);
    };
    reader.onerror = function () {
      showToast('Kh\u00F4ng \u0111\u1ECDc \u0111\u01B0\u1EE3c t\u1EC7p \u0111\u00E3 ch\u1ECDn.');
    };
    reader.readAsText(file);
  }

  /**
   * Applies the pending import.
   * @param {'merge'|'replace'} mode
   */
  function applyImport(mode) {
    var text = state.pendingImportText;
    if (!text) return;
    var result = Store.importJSONString(text, mode);
    state.pendingImportText = '';
    closeModal(el.importModal);
    if (!result || !result.ok) {
      showToast((result && result.error) || 'Nh\u1EADp d\u1EEF li\u1EC7u th\u1EA5t b\u1EA1i.');
      return;
    }
    applyTheme(Store.getTheme());
    state.selectedSubjectFilter = null;
    if (el.dailyFocus) el.dailyFocus.value = Store.getDay(state.currentDateKey).focus || '';
    renderAll();
    showToast(
      '\u0110\u00E3 nh\u1EADp ' + (result.importedBlocks || 0) + ' khung gi\u1EDD (' + (result.importedDays || 0) + ' ng\u00E0y).'
    );
  }

  // ---------------------------------------------------------------------
  // Event wiring
  // ---------------------------------------------------------------------

  /**
   * Returns true when the event target is a text-entry control.
   * @param {EventTarget|null} target
   * @returns {boolean}
   */
  function isTypingTarget(target) {
    var node = /** @type {HTMLElement|null} */ (target);
    if (!node || !node.tagName) return false;
    var tag = node.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || node.isContentEditable === true;
  }

  /**
   * Adds a click listener if the element exists.
   * @param {HTMLElement|null} node
   * @param {function(MouseEvent): void} handler
   */
  function onClick(node, handler) {
    if (node) node.addEventListener('click', handler);
  }

  /** Wires sidebar, header and timer bar events. */
  function bindShellEvents() {
    onClick(el.themeToggle, toggleTheme);
    onClick(el.btnThemeGallery, openThemeModal);
    onClick(el.btnSidebarTheme, openThemeModal);
    onClick(el.btnCloseThemeModal, function () { closeModal(el.themeModal); });
    onClick(el.btnThemeDone, function () { closeModal(el.themeModal); });
    if (el.themeGrid) {
      el.themeGrid.addEventListener('click', function (e) {
        var card = /** @type {HTMLElement} */ (e.target).closest('.theme-card');
        if (!card) return;
        var themeId = card.getAttribute('data-theme-id') || '';
        if (!Utils.isValidTheme(themeId)) return;
        var meta = Utils.getThemeMeta(themeId);
        applyTheme(meta.id);
        Store.setTheme(meta.id);
        renderThemeModal();
        playThemeChime();
        showToast('Đã áp dụng giao diện "' + meta.name + '"!');
      });
    }
    onClick(el.toggleClickFx, function () {
      if (typeof Store.setClickFx !== 'function') return;
      var nextFx = !Store.getClickFx();
      Store.setClickFx(nextFx);
      renderThemeModal();
      if (nextFx) playClickPop();
    });
    onClick(el.btnOpenSidebar, function () { setSidebarOpen(true); });
    onClick(el.btnCloseSidebar, function () { setSidebarOpen(false); });
    onClick(el.sidebarBackdrop, function () { setSidebarOpen(false); });

    onClick(el.headerPrevDay, function () { shiftDay(-1); });
    onClick(el.headerNextDay, function () { shiftDay(1); });
    onClick(el.headerToday, goToToday);
    onClick(el.btnAddBlock, function () {
      var range = Timeline.getDefaultRange(state.currentDateKey);
      openBlockModal('add', range);
    });
    onClick(el.btnClearFilter, function () { setSubjectFilter(null); });

    // Weekly repeat toggle
    onClick(el.toggleWeeklyRepeat, function () {
      if (typeof Store.setWeeklyRepeat !== 'function') return;
      var next = !Store.getWeeklyRepeat();
      Store.setWeeklyRepeat(next);
      showToast(
        next
          ? 'Đã bật tự động lặp lại lịch hàng tuần cho các tuần tiếp theo.'
          : 'Đã tắt tự động lặp lại lịch tuần.'
      );
    });

    // Weekly stats modal & sidebar mini-chart
    onClick(el.btnOpenWeeklyStats, openWeeklyStatsModal);
    onClick(el.btnHeaderStats, openWeeklyStatsModal);
    onClick(el.btnCloseWeeklyStats, function () { closeModal(el.weeklyStatsModal); });
    onClick(el.btnWeeklyStatsDone, function () { closeModal(el.weeklyStatsModal); });
    onClick(el.btnWeekPrev, function () {
      weeklyStatsAnchor = Utils.addDays(weeklyStatsAnchor, -7);
      renderWeeklyStatsModal();
    });
    onClick(el.btnWeekCurrent, function () {
      weeklyStatsAnchor = Utils.getTodayKey();
      renderWeeklyStatsModal();
    });
    onClick(el.btnWeekNext, function () {
      weeklyStatsAnchor = Utils.addDays(weeklyStatsAnchor, 7);
      renderWeeklyStatsModal();
    });
    onClick(el.wkTabCompleted, function () {
      weeklyTaskTab = 'completed';
      renderWeeklyStatsModal();
    });
    onClick(el.wkTabPending, function () {
      weeklyTaskTab = 'pending';
      renderWeeklyStatsModal();
    });
    if (el.weeklyMiniBars) {
      el.weeklyMiniBars.addEventListener('click', function (e) {
        var col = /** @type {HTMLElement} */ (e.target).closest('.wk-mini-col');
        if (!col) return;
        setDate(col.getAttribute('data-date') || state.currentDateKey, true);
        if (state.sidebarOpen) setSidebarOpen(false);
      });
    }
    if (el.weeklyChartBars) {
      el.weeklyChartBars.addEventListener('click', function (e) {
        var col = /** @type {HTMLElement} */ (e.target).closest('.wk-bar-col');
        if (!col) return;
        closeModal(el.weeklyStatsModal);
        setDate(col.getAttribute('data-date') || state.currentDateKey, true);
      });
    }
    if (el.weeklyTaskList) {
      el.weeklyTaskList.addEventListener('click', function (e) {
        var item = /** @type {HTMLElement} */ (e.target).closest('.wk-task-item');
        if (!item) return;
        var dk = item.getAttribute('data-date');
        if (!dk) return;
        closeModal(el.weeklyStatsModal);
        setDate(dk, true);
      });
    }

    // Mini calendar
    onClick(el.calPrev, function () {
      state.calendarMonth -= 1;
      if (state.calendarMonth < 0) {
        state.calendarMonth = 11;
        state.calendarYear -= 1;
      }
      renderCalendar();
    });
    onClick(el.calNext, function () {
      state.calendarMonth += 1;
      if (state.calendarMonth > 11) {
        state.calendarMonth = 0;
        state.calendarYear += 1;
      }
      renderCalendar();
    });
    if (el.calGrid) {
      el.calGrid.addEventListener('click', function (e) {
        var cell = /** @type {HTMLElement} */ (e.target).closest('.cal-day');
        if (!cell) return;
        setDate(cell.getAttribute('data-date') || state.currentDateKey, true);
        if (state.sidebarOpen) setSidebarOpen(false);
      });
    }

    // Daily focus
    if (el.dailyFocus) {
      el.dailyFocus.addEventListener('input', function () {
        window.clearTimeout(focusSaveTimer);
        focusSaveTimer = window.setTimeout(flushDailyFocus, FOCUS_SAVE_DELAY_MS);
      });
      el.dailyFocus.addEventListener('blur', flushDailyFocus);
    }

    // Subjects
    if (el.subjectList) {
      el.subjectList.addEventListener('click', function (e) {
        var target = /** @type {HTMLElement} */ (e.target);
        var del = target.closest('.subject-delete');
        if (del) {
          e.stopPropagation();
          requestDeleteSubject(del.getAttribute('data-delete-subject') || '');
          return;
        }
        var item = target.closest('.subject-item');
        if (!item) return;
        var id = item.getAttribute('data-subject-id') || '';
        setSubjectFilter(id && id !== state.selectedSubjectFilter ? id : null);
      });
      el.subjectList.addEventListener('keydown', function (e) {
        var target = /** @type {HTMLElement} */ (e.target);
        if ((e.key === 'Enter' || e.key === ' ') && target.classList.contains('subject-item')) {
          e.preventDefault();
          var id = target.getAttribute('data-subject-id') || '';
          setSubjectFilter(id && id !== state.selectedSubjectFilter ? id : null);
        }
      });
    }
    onClick(el.btnToggleAddSubject, function () { toggleAddSubjectForm(); });
    onClick(el.btnCancelSubject, function () { toggleAddSubjectForm(false); });
    if (el.newSubjectSwatches) {
      el.newSubjectSwatches.addEventListener('click', function (e) {
        var swatch = /** @type {HTMLElement} */ (e.target).closest('.color-swatch');
        if (!swatch) return;
        state.newSubjectColor = swatch.getAttribute('data-color') || Utils.COLORS[0];
        renderSubjectSwatches();
      });
    }
    if (el.addSubjectForm) {
      el.addSubjectForm.addEventListener('submit', function (e) {
        e.preventDefault();
        submitNewSubject();
      });
    }

    // Export / Import
    onClick(el.btnExport, exportJSON);
    onClick(el.btnImport, function () {
      if (el.importFileInput) el.importFileInput.click();
    });
    if (el.importFileInput) {
      el.importFileInput.addEventListener('change', function () {
        var file = el.importFileInput.files && el.importFileInput.files[0];
        if (file) handleImportFile(file);
        el.importFileInput.value = '';
      });
    }
    onClick(el.btnImportCancel, function () {
      state.pendingImportText = '';
      closeModal(el.importModal);
    });
    onClick(el.btnImportMerge, function () { applyImport('merge'); });
    onClick(el.btnImportReplace, function () {
      confirmDialog({
        title: 'Ghi \u0111\u00E8 to\u00E0n b\u1ED9 d\u1EEF li\u1EC7u?',
        message: 'D\u1EEF li\u1EC7u hi\u1EC7n t\u1EA1i s\u1EBD b\u1ECB thay th\u1EBF ho\u00E0n to\u00E0n b\u1EDFi n\u1ED9i dung t\u1EC7p. B\u1EA1n n\u00EAn xu\u1EA5t b\u1EA3n sao l\u01B0u tr\u01B0\u1EDBc.',
        okLabel: 'Ghi \u0111\u00E8'
      }).then(function (ok) {
        if (ok) applyImport('replace');
      });
    });

    // Confirm modal
    onClick(el.confirmCancel, function () { resolveConfirm(false); });
    onClick(el.confirmOk, function () { resolveConfirm(true); });

    // Timer bar
    onClick(el.timerToggle, function () { Timer.togglePause(); });
    onClick(el.timerSkip, function () { Timer.skipBreak(); });
    onClick(el.timerMute, function () { Timer.toggleMute(); });
    onClick(el.timerStop, function () { Timer.stop(); });
    onClick(el.timerModePomodoro, function () { Timer.setMode('pomodoro'); });
    onClick(el.timerModeBlock, function () { Timer.setMode('block'); });
  }

  /** Wires the block modal form events. */
  function bindBlockModalEvents() {
    onClick(el.btnCloseBlockModal, closeBlockModal);
    onClick(el.btnCancelBlock, closeBlockModal);
    if (el.blockForm) {
      el.blockForm.addEventListener('submit', function (e) {
        e.preventDefault();
        saveBlockFromForm();
      });
    }
    onClick(el.btnDeleteBlock, deleteEditingBlock);
    onClick(el.btnDeleteSeries, deleteEditingSeries);
    onClick(el.btnMoveTomorrow, moveEditingBlockToTomorrow);

    el.blockStart.addEventListener('input', updateDurationPill);
    el.blockEnd.addEventListener('input', updateDurationPill);
    el.blockStart.addEventListener('change', updateDurationPill);
    el.blockEnd.addEventListener('change', updateDurationPill);

    if (el.durationPresets) {
      el.durationPresets.addEventListener('click', function (e) {
        var chip = /** @type {HTMLElement} */ (e.target).closest('.preset-chip');
        if (!chip) return;
        var duration = Number(chip.getAttribute('data-duration'));
        var start = Utils.inputTimeToMinutes(el.blockStart.value);
        if (Number.isNaN(start) || !duration) return;
        var end = Math.min(Utils.END_MIN, start + duration);
        el.blockEnd.value = Utils.minutesToInputTime(end);
        updateDurationPill();
      });
    }

    if (el.modalSubjectPicker) {
      el.modalSubjectPicker.addEventListener('click', function (e) {
        var chip = /** @type {HTMLElement} */ (e.target).closest('.subject-chip');
        if (!chip) return;
        state.modalSubjectId = chip.getAttribute('data-subject-id') || '';
        renderModalSubjects();
      });
    }
    if (el.priorityPicker) {
      el.priorityPicker.addEventListener('click', function (e) {
        var option = /** @type {HTMLElement} */ (e.target).closest('.seg-option');
        if (!option) return;
        state.modalPriority = option.getAttribute('data-priority') || 'medium';
        renderModalPriority();
      });
    }

    if (el.repeatDaysPicker) {
      el.repeatDaysPicker.addEventListener('click', function (e) {
        var chip = /** @type {HTMLElement} */ (e.target).closest('.weekday-chip');
        if (!chip) return;
        var dow = Number(chip.getAttribute('data-dow'));
        if (!Number.isInteger(dow) || dow < 0 || dow > 6) return;
        var idx = state.modalRepeatDays.indexOf(dow);
        if (idx === -1) state.modalRepeatDays.push(dow);
        else state.modalRepeatDays.splice(idx, 1);
        state.modalRepeatDays.sort(function (a, b) { return a - b; });
        renderModalRepeatDays();
      });
    }
    onClick(el.btnRepeatQuick, function () {
      if (state.modalRepeatDays.length > 0) {
        state.modalRepeatDays = [];
      } else {
        var currentDow = Utils.parseDateKey(state.modalDateKey).getDay();
        state.modalRepeatDays = [currentDow];
      }
      renderModalRepeatDays();
    });

    // Sub-tasks
    onClick(el.btnAddSubtask, addModalSubtask);
    el.subtaskInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault(); // Do not submit the whole form.
        addModalSubtask();
      }
    });
    if (el.modalSubtaskList) {
      el.modalSubtaskList.addEventListener('change', function (e) {
        var target = /** @type {HTMLInputElement} */ (e.target);
        if (!target.classList.contains('subtask-check')) return;
        var item = target.closest('.subtask-item');
        var id = item ? item.getAttribute('data-subtask-id') : null;
        state.modalSubtasks.forEach(function (task) {
          if (task.id === id) task.done = target.checked;
        });
        if (item) item.classList.toggle('is-done', target.checked);
      });
      el.modalSubtaskList.addEventListener('click', function (e) {
        var remove = /** @type {HTMLElement} */ (e.target).closest('.subtask-remove');
        if (!remove) return;
        var item = remove.closest('.subtask-item');
        var id = item ? item.getAttribute('data-subtask-id') : null;
        state.modalSubtasks = state.modalSubtasks.filter(function (task) { return task.id !== id; });
        renderModalSubtasks();
      });
    }

    // Close on overlay click.
    [el.blockModal, el.importModal, el.cloudSetupModal, el.themeModal, el.weeklyStatsModal].forEach(function (modal) {
      if (!modal) return;
      modal.addEventListener('mousedown', function (e) {
        if (e.target !== modal) return;
        if (modal === el.blockModal) closeBlockModal();
        else if (modal === el.importModal) {
          state.pendingImportText = '';
          closeModal(modal);
        } else {
          closeModal(modal);
        }
      });
    });
    if (el.confirmModal) {
      el.confirmModal.addEventListener('mousedown', function (e) {
        if (e.target === el.confirmModal) resolveConfirm(false);
      });
    }
  }

  /**
   * Renders the cloud sync status card in the sidebar footer.
   * @param {{ configured: boolean, configSource: string, sdkReady: boolean, user: { displayName: string, email: string, photoURL: string }|null, syncState: string, errorMessage: string }} [syncStatus]
   */
  function renderCloudSync(syncStatus) {
    var Sync = window.StudyPlan.Sync;
    var s = syncStatus || (Sync ? Sync.getStatus() : null);
    if (!s || !el.cloudSyncBox) return;

    var isSignedIn = Boolean(s.user);
    var isConfigured = Boolean(s.configured);

    if (el.btnCloudSetup) el.btnCloudSetup.classList.toggle('hidden', isConfigured);
    if (el.cloudSignedOut) el.cloudSignedOut.classList.toggle('hidden', !isConfigured || isSignedIn);
    if (el.cloudSignedIn) el.cloudSignedIn.classList.toggle('hidden', !isSignedIn);

    if (el.btnCloudConfigEdit) {
      el.btnCloudConfigEdit.classList.toggle('hidden', s.configSource === 'file');
    }
    if (el.btnCloudConfigClear) {
      el.btnCloudConfigClear.classList.toggle('hidden', s.configSource !== 'local');
    }

    if (isSignedIn && s.user) {
      if (el.cloudUserName) {
        el.cloudUserName.textContent = s.user.displayName || s.user.email || 'Người dùng';
        el.cloudUserName.title = s.user.email || '';
      }
      if (el.cloudUserAvatar) {
        if (s.user.photoURL) {
          el.cloudUserAvatar.innerHTML = '<img src="' + esc(s.user.photoURL) + '" alt="" referrerpolicy="no-referrer" />';
        } else {
          var initial = (s.user.displayName || s.user.email || 'U').trim().charAt(0).toUpperCase();
          el.cloudUserAvatar.textContent = initial;
        }
      }
      var labelMap = {
        connecting: 'Đang kết nối...',
        syncing: 'Đang đồng bộ...',
        synced: 'Đã đồng bộ',
        offline: 'Ngoại tuyến',
        error: 'Lỗi đồng bộ'
      };
      if (el.cloudSyncStatus) {
        el.cloudSyncStatus.textContent = labelMap[s.syncState] || 'Đã đồng bộ';
        el.cloudSyncStatus.title = s.errorMessage || '';
      }
      if (el.cloudSyncDot) {
        el.cloudSyncDot.className = 'cloud-sync-dot cloud-sync-dot--' + (s.syncState || 'synced');
      }
    }
  }

  /** Opens the Firebase setup modal. */
  function openCloudSetupModal() {
    if (!el.cloudSetupModal) return;
    if (el.cloudConfigError) {
      el.cloudConfigError.textContent = '';
      el.cloudConfigError.classList.add('hidden');
    }
    if (el.cloudConfigInput) el.cloudConfigInput.value = '';
    renderCloudSync();
    openModal(el.cloudSetupModal);
    if (el.cloudConfigInput) el.cloudConfigInput.focus();
  }

  /** Binds cloud sync buttons and setup modal events. */
  function bindCloudSyncEvents() {
    var Sync = window.StudyPlan.Sync;
    if (!Sync) return;

    if (el.btnCloudSetup) {
      el.btnCloudSetup.addEventListener('click', openCloudSetupModal);
    }
    if (el.btnCloudConfigEdit) {
      el.btnCloudConfigEdit.addEventListener('click', openCloudSetupModal);
    }
    if (el.btnCloseCloudSetup) {
      el.btnCloseCloudSetup.addEventListener('click', function () { closeModal(el.cloudSetupModal); });
    }
    if (el.btnCloudSetupCancel) {
      el.btnCloudSetupCancel.addEventListener('click', function () { closeModal(el.cloudSetupModal); });
    }
    if (el.btnCloudConfigSave) {
      el.btnCloudConfigSave.addEventListener('click', function () {
        var raw = el.cloudConfigInput ? el.cloudConfigInput.value : '';
        var res = Sync.saveRuntimeConfig(raw);
        if (!res.ok) {
          if (el.cloudConfigError) {
            el.cloudConfigError.textContent = res.error || 'Cấu hình không hợp lệ.';
            el.cloudConfigError.classList.remove('hidden');
          }
          return;
        }
        closeModal(el.cloudSetupModal);
        showToast('Đã lưu cấu hình Firebase. Bạn có thể đăng nhập Google ngay!');
      });
    }
    if (el.btnCloudConfigClear) {
      el.btnCloudConfigClear.addEventListener('click', function () {
        Sync.clearRuntimeConfig();
        closeModal(el.cloudSetupModal);
        showToast('Đã xóa cấu hình Firebase trên trình duyệt này.');
      });
    }
    if (el.btnGoogleSignIn) {
      el.btnGoogleSignIn.addEventListener('click', function () {
        Sync.signInWithGoogle();
      });
    }
    if (el.btnCloudSyncNow) {
      el.btnCloudSyncNow.addEventListener('click', function () {
        Sync.syncNow();
      });
    }
    if (el.btnCloudSignOut) {
      el.btnCloudSignOut.addEventListener('click', function () {
        Sync.signOut();
      });
    }
  }

  /**
   * Global keyboard shortcuts.
   * @param {KeyboardEvent} e
   */
  function onKeyDown(e) {
    if (e.key === 'Escape') {
      if (isModalOpen(el.confirmModal)) resolveConfirm(false);
      else if (isModalOpen(el.weeklyStatsModal)) closeModal(el.weeklyStatsModal);
      else if (isModalOpen(el.themeModal)) closeModal(el.themeModal);
      else if (isModalOpen(el.cloudSetupModal)) closeModal(el.cloudSetupModal);
      else if (isModalOpen(el.importModal)) {
        state.pendingImportText = '';
        closeModal(el.importModal);
      } else if (isModalOpen(el.blockModal)) closeBlockModal();
      else if (state.sidebarOpen) setSidebarOpen(false);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (anyModalOpen() || isTypingTarget(e.target)) return;

    var key = e.key;
    if (key === 'n' || key === 'N') {
      e.preventDefault();
      openBlockModal('add', Timeline.getDefaultRange(state.currentDateKey));
    } else if (key === 't' || key === 'T') {
      e.preventDefault();
      goToToday();
    } else if (key === 'ArrowLeft') {
      e.preventDefault();
      shiftDay(-1);
    } else if (key === 'ArrowRight') {
      e.preventDefault();
      shiftDay(1);
    }
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  /** Caches all DOM references used by the UI controller. */
  function cacheDom() {
    var ids = {
      sidebar: 'sidebar',
      sidebarBackdrop: 'sidebar-backdrop',
      btnOpenSidebar: 'btn-open-sidebar',
      btnCloseSidebar: 'btn-close-sidebar',
      themeToggle: 'theme-toggle',
      btnThemeGallery: 'btn-theme-gallery',
      btnSidebarTheme: 'btn-sidebar-theme',
      currentThemeLabel: 'current-theme-label',
      themeModal: 'theme-modal',
      btnCloseThemeModal: 'btn-close-theme-modal',
      themeGrid: 'theme-grid',
      toggleClickFx: 'toggle-click-fx',
      btnThemeDone: 'btn-theme-done',
      streakCount: 'streak-count',
      calTitle: 'mini-cal-title',
      calPrev: 'cal-prev-month',
      calNext: 'cal-next-month',
      calGrid: 'mini-cal-grid',
      toggleWeeklyRepeat: 'toggle-weekly-repeat',
      weeklyRepeatDesc: 'weekly-repeat-desc',
      dailyFocus: 'daily-focus-input',
      progressPercent: 'progress-percent',
      progressFill: 'progress-bar-fill',
      statCompleted: 'stat-completed',
      statPlanned: 'stat-planned',
      statFocused: 'stat-focused',
      statTasks: 'stat-tasks',
      btnOpenWeeklyStats: 'btn-open-weekly-stats',
      weeklyMiniTasks: 'weekly-mini-tasks',
      weeklyMiniPercent: 'weekly-mini-percent',
      weeklyMiniBars: 'weekly-mini-bars',
      btnHeaderStats: 'btn-header-stats',
      weeklyStatsModal: 'weekly-stats-modal',
      btnCloseWeeklyStats: 'btn-close-weekly-stats',
      btnWeeklyStatsDone: 'btn-weekly-stats-done',
      weeklyRangeBadge: 'weekly-range-badge',
      btnWeekPrev: 'btn-week-prev',
      btnWeekCurrent: 'btn-week-current',
      btnWeekNext: 'btn-week-next',
      weeklyActiveDaysLabel: 'weekly-active-days-label',
      wkKpiTasks: 'wk-kpi-tasks',
      wkKpiTaskRate: 'wk-kpi-task-rate',
      wkKpiHours: 'wk-kpi-hours',
      wkKpiPlanned: 'wk-kpi-planned',
      wkKpiFocused: 'wk-kpi-focused',
      wkKpiSubtasks: 'wk-kpi-subtasks',
      weeklyChartBars: 'weekly-chart-bars',
      weeklySubjectBreakdown: 'weekly-subject-breakdown',
      wkTabCompleted: 'wk-tab-completed',
      wkTabPending: 'wk-tab-pending',
      wkTabCompletedCount: 'wk-tab-completed-count',
      wkTabPendingCount: 'wk-tab-pending-count',
      weeklyTaskList: 'weekly-task-list',
      btnToggleAddSubject: 'btn-toggle-add-subject',
      addSubjectForm: 'add-subject-form',
      newSubjectName: 'new-subject-name',
      newSubjectSwatches: 'new-subject-swatches',
      btnCancelSubject: 'btn-cancel-subject',
      subjectList: 'subject-list',
      subjectEmpty: 'subject-empty-state',
      btnExport: 'btn-export',
      btnImport: 'btn-import',
      importFileInput: 'import-file-input',
      dateTitle: 'current-date-title',
      relativeBadge: 'relative-day-badge',
      filterChip: 'active-filter-chip',
      filterDot: 'active-filter-dot',
      filterName: 'active-filter-name',
      btnClearFilter: 'btn-clear-filter',
      headerPrevDay: 'header-prev-day',
      headerToday: 'header-today',
      headerNextDay: 'header-next-day',
      btnAddBlock: 'btn-add-block',
      timerBar: 'focus-timer-bar',
      timerPhase: 'timer-phase-badge',
      timerBlockTitle: 'timer-block-title',
      timerClock: 'timer-clock',
      timerModePomodoro: 'timer-mode-pomodoro',
      timerModeBlock: 'timer-mode-block',
      timerToggle: 'timer-btn-toggle',
      timerSkip: 'timer-btn-skip-break',
      timerMute: 'timer-btn-mute',
      timerStop: 'timer-btn-stop',
      blockModal: 'block-modal',
      blockModalTitle: 'block-modal-title',
      btnCloseBlockModal: 'btn-close-block-modal',
      blockForm: 'block-form',
      blockTitle: 'block-title',
      durationPill: 'modal-duration-pill',
      blockStart: 'block-start',
      blockEnd: 'block-end',
      durationPresets: 'duration-presets',
      modalSubjectPicker: 'modal-subject-picker',
      priorityPicker: 'priority-picker',
      repeatDaysPicker: 'repeat-days-picker',
      btnRepeatQuick: 'btn-repeat-quick',
      repeatDaysHint: 'repeat-days-hint',
      subtaskInput: 'subtask-input',
      btnAddSubtask: 'btn-add-subtask',
      modalSubtaskList: 'modal-subtask-list',
      blockNotes: 'block-notes',
      blockCompleted: 'block-completed',
      blockFormError: 'block-form-error',
      btnDeleteBlock: 'btn-delete-block',
      btnDeleteSeries: 'btn-delete-series',
      btnMoveTomorrow: 'btn-move-tomorrow',
      btnCancelBlock: 'btn-cancel-block',
      importModal: 'import-modal',
      importSummary: 'import-summary-text',
      btnImportCancel: 'btn-import-cancel',
      btnImportMerge: 'btn-import-merge',
      btnImportReplace: 'btn-import-replace',
      confirmModal: 'confirm-modal',
      confirmTitle: 'confirm-modal-title',
      confirmMessage: 'confirm-modal-message',
      confirmCancel: 'btn-confirm-cancel',
      confirmOk: 'btn-confirm-ok',
      cloudSyncBox: 'cloud-sync-box',
      btnCloudSetup: 'btn-cloud-setup',
      cloudSignedOut: 'cloud-signed-out',
      btnGoogleSignIn: 'btn-google-signin',
      btnCloudConfigEdit: 'btn-cloud-config-edit',
      cloudSignedIn: 'cloud-signed-in',
      cloudUserAvatar: 'cloud-user-avatar',
      cloudUserName: 'cloud-user-name',
      cloudSyncDot: 'cloud-sync-dot',
      cloudSyncStatus: 'cloud-sync-status',
      btnCloudSyncNow: 'btn-cloud-sync-now',
      btnCloudSignOut: 'btn-cloud-signout',
      cloudSetupModal: 'cloud-setup-modal',
      btnCloseCloudSetup: 'btn-close-cloud-setup',
      cloudConfigInput: 'cloud-config-input',
      cloudConfigError: 'cloud-config-error',
      btnCloudConfigClear: 'btn-cloud-config-clear',
      btnCloudSetupCancel: 'btn-cloud-setup-cancel',
      btnCloudConfigSave: 'btn-cloud-config-save',
      toastContainer: 'toast-container'
    };
    Object.keys(ids).forEach(function (key) {
      el[key] = byId(ids[key]);
    });
    // The "completed" checkbox usually sits inside a labelled row; hide that row in add mode.
    el.blockCompletedRow = el.blockCompleted ? /** @type {HTMLElement|null} */ (el.blockCompleted.closest('label')) : null;
  }

  /** Initializes the UI controller (call after Store.init and Timer.init). */
  function init() {
    cacheDom();

    var required = ['blockModal', 'blockTitle', 'blockStart', 'blockEnd', 'subtaskInput', 'blockModalTitle', 'blockNotes'];
    for (var i = 0; i < required.length; i += 1) {
      if (!el[required[i]]) {
        console.error('[UI] Missing required element: ' + required[i]);
        return;
      }
    }

    var today = Utils.parseDateKey(state.currentDateKey);
    state.calendarYear = today.getFullYear();
    state.calendarMonth = today.getMonth();

    applyTheme(Store.getTheme());
    renderSubjectSwatches();
    bindShellEvents();
    bindBlockModalEvents();
    bindCloudSyncEvents();
    document.addEventListener('pointerdown', onDocumentPointerDown);
    document.addEventListener('keydown', onKeyDown);

    Timeline.init({
      onRequestCreate: function (startMin, endMin) { openBlockModal('add', { startMin: startMin, endMin: endMin }); },
      onRequestEdit: function (blockId) { openBlockModal('edit', { blockId: blockId }); },
      onRequestFocus: handleRequestFocus,
      onToggleComplete: handleToggleComplete,
      onBlockMoved: handleBlockMoved,
      onBlockResized: handleBlockResized,
      onCopyYesterday: handleCopyYesterday,
      onCopyLastWeek: handleCopyLastWeek
    });

    Store.subscribe(renderAll);
    Timer.subscribe(renderTimerBar);
    Timer.onComplete(handleTimerComplete);
    if (window.StudyPlan.Sync && typeof window.StudyPlan.Sync.subscribe === 'function') {
      window.StudyPlan.Sync.subscribe(renderCloudSync);
      renderCloudSync();
    }

    initialized = true;
    if (el.dailyFocus) el.dailyFocus.value = Store.getDay(state.currentDateKey).focus || '';
    renderAll();
  }

  window.StudyPlan.UI = {
    init: init,
    render: renderAll,
    showToast: showToast,
    confirm: confirmDialog,
    setDate: setDate,
    getCurrentDateKey: function () { return state.currentDateKey; }
  };
})();
