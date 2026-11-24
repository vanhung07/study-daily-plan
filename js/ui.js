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
    /** @type {string} */
    pendingImportText: '',
    newSubjectColor: Utils.COLORS[0],
    /** @type {function(boolean): void|null} */
    confirmResolver: null,
    sidebarOpen: false,
    lastTimerKey: ''
  };

  /** @type {Object<string, HTMLElement|null>} */
  var el = {};
  var lastFocusedBeforeModal = null;
  var focusSaveTimer = 0;
  var initialized = false;

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
      isModalOpen(el.cloudSetupModal)
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
  // Theme & sidebar drawer
  // ---------------------------------------------------------------------

  /**
   * Applies a theme to the <html> element.
   * @param {string} theme
   */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : DEFAULT_THEME);
  }

  /** Toggles between light and dark theme and persists the choice. */
  function toggleTheme() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    var next = isDark ? 'light' : 'dark';
    applyTheme(next);
    Store.setTheme(next);
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
    renderHeader();
    renderStreak();
    renderCalendar();
    renderDailyFocus();
    renderStats();
    renderSubjects();
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

    el.blockModalTitle.textContent = block ? 'Ch\u1EC9nh s\u1EEDa khung gi\u1EDD' : 'Th\u00EAm khung gi\u1EDD h\u1ECDc';
    el.blockTitle.value = block ? block.title : '';
    el.blockStart.value = Utils.minutesToInputTime(startMin);
    el.blockEnd.value = Utils.minutesToInputTime(endMin);
    el.blockNotes.value = block ? block.notes || '' : '';
    if (el.blockCompleted) el.blockCompleted.checked = block ? Boolean(block.completed) : false;
    el.subtaskInput.value = '';

    // Edit-only actions.
    if (el.btnDeleteBlock) el.btnDeleteBlock.classList.toggle('hidden', !block);
    if (el.btnMoveTomorrow) el.btnMoveTomorrow.classList.toggle('hidden', !block);
    if (el.blockCompletedRow) el.blockCompletedRow.classList.toggle('hidden', !block);

    renderModalSubjects();
    renderModalPriority();
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
    [el.blockModal, el.importModal, el.cloudSetupModal].forEach(function (modal) {
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
      streakCount: 'streak-count',
      calTitle: 'mini-cal-title',
      calPrev: 'cal-prev-month',
      calNext: 'cal-next-month',
      calGrid: 'mini-cal-grid',
      dailyFocus: 'daily-focus-input',
      progressPercent: 'progress-percent',
      progressFill: 'progress-bar-fill',
      statCompleted: 'stat-completed',
      statPlanned: 'stat-planned',
      statFocused: 'stat-focused',
      statTasks: 'stat-tasks',
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
      subtaskInput: 'subtask-input',
      btnAddSubtask: 'btn-add-subtask',
      modalSubtaskList: 'modal-subtask-list',
      blockNotes: 'block-notes',
      blockCompleted: 'block-completed',
      blockFormError: 'block-form-error',
      btnDeleteBlock: 'btn-delete-block',
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
    document.addEventListener('keydown', onKeyDown);

    Timeline.init({
      onRequestCreate: function (startMin, endMin) { openBlockModal('add', { startMin: startMin, endMin: endMin }); },
      onRequestEdit: function (blockId) { openBlockModal('edit', { blockId: blockId }); },
      onRequestFocus: handleRequestFocus,
      onToggleComplete: handleToggleComplete,
      onBlockMoved: handleBlockMoved,
      onBlockResized: handleBlockResized,
      onCopyYesterday: handleCopyYesterday
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
