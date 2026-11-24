/**
 * Timeline module: renders the day grid, lays out study blocks (including
 * overlapping ones) and handles pointer interactions (create / move / resize).
 * Attached to window.StudyPlan.Timeline as a classic IIFE (no ES modules).
 */
(function () {
  'use strict';

  window.StudyPlan = window.StudyPlan || {};

  var Utils = window.StudyPlan.Utils;
  var Store = window.StudyPlan.Store;
  var Timer = window.StudyPlan.Timer;

  /**
   * @typedef {Object} TimelineCallbacks
   * @property {function(number, number): void} onRequestCreate
   * @property {function(string): void} onRequestEdit
   * @property {function(string): void} onRequestFocus
   * @property {function(string): void} onToggleComplete
   * @property {function(Object, number, number): void} onBlockMoved
   * @property {function(Object, number): void} onBlockResized
   * @property {function(): void} onCopyYesterday
   * @property {function(): void} onCopyLastWeek
   */

  /**
   * @typedef {Object} Gesture
   * @property {'create'|'move'|'resize'} type
   * @property {number} pointerId
   * @property {string} pointerType
   * @property {number} startX
   * @property {number} startY
   * @property {number} startPointerMin
   * @property {boolean} armed
   * @property {boolean} moved
   * @property {number} longPressTimer
   * @property {string} [blockId]
   * @property {HTMLElement} [el]
   * @property {number} [origStart]
   * @property {number} [origEnd]
   * @property {number} [curStart]
   * @property {number} [curEnd]
   */

  var DRAG_THRESHOLD_PX = 5;
  var TOUCH_CANCEL_PX = 8;
  var LONG_PRESS_MS = 280;
  var EDGE_SCROLL_ZONE = 44;
  var EDGE_SCROLL_STEP = 14;
  var TIME_LINE_INTERVAL_MS = 30000;

  /** @type {TimelineCallbacks} */
  var callbacks = {
    onRequestCreate: function () {},
    onRequestEdit: function () {},
    onRequestFocus: function () {},
    onToggleComplete: function () {},
    onBlockMoved: function () {},
    onBlockResized: function () {},
    onCopyYesterday: function () {},
    onCopyLastWeek: function () {}
  };

  var dom = {
    scroll: null,
    gutter: null,
    canvas: null,
    grid: null,
    layer: null,
    selection: null,
    selectionLabel: null,
    timeLine: null,
    timeBadge: null,
    empty: null,
    btnEmptyAdd: null,
    btnCopyYesterday: null,
    copyCount: null,
    btnCopyLastWeek: null,
    copyLastWeekCount: null,
    filterHint: null
  };

  var currentDateKey = '';
  var currentFilter = null;
  /** @type {Gesture|null} */
  var gesture = null;
  var pendingRender = false;
  var timeLineHandle = 0;
  var initialized = false;

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  /**
   * Converts a minute-of-day value to a vertical pixel offset in the canvas.
   * @param {number} min
   * @returns {number}
   */
  function minToPx(min) {
    return ((min - Utils.START_MIN) / 60) * Utils.HOUR_HEIGHT;
  }

  /**
   * Formats a time range such as "08:00 – 09:30".
   * @param {number} startMin
   * @param {number} endMin
   * @returns {string}
   */
  function formatRange(startMin, endMin) {
    return Utils.minutesToTime(startMin) + ' \u2013 ' + Utils.minutesToTime(endMin);
  }

  /**
   * Converts a viewport Y coordinate into a (fractional) minute-of-day value.
   * @param {number} clientY
   * @returns {number}
   */
  function pointerToMinutes(clientY) {
    var rect = dom.canvas.getBoundingClientRect();
    return Utils.START_MIN + ((clientY - rect.top) / Utils.HOUR_HEIGHT) * 60;
  }

  /**
   * Floors a minute value onto the snap grid.
   * @param {number} min
   * @returns {number}
   */
  function floorSnap(min) {
    return Math.floor(min / Utils.SNAP_MIN) * Utils.SNAP_MIN;
  }

  /**
   * Returns true when the focus timer is currently bound to the given block.
   * @param {string} blockId
   * @returns {boolean}
   */
  function isTimerActiveFor(blockId) {
    var snap = Timer.getSnapshot();
    return Boolean(snap && snap.blockId === blockId && snap.status !== 'idle');
  }

  /**
   * Returns true when the focus timer is bound to the block and is paused.
   * @param {string} blockId
   * @returns {boolean}
   */
  function isTimerPausedFor(blockId) {
    var snap = Timer.getSnapshot();
    return Boolean(snap && snap.blockId === blockId && snap.status === 'paused');
  }

  /**
   * Builds the label for a block's focus button.
   * @param {string} blockId
   * @returns {string}
   */
  function focusButtonLabel(blockId) {
    if (!isTimerActiveFor(blockId)) return '\u25B6 T\u1EADp trung';
    return isTimerPausedFor(blockId) ? '\u25B6 Ti\u1EBFp t\u1EE5c' : '\u23F8 \u0110ang h\u1ECDc';
  }

  // ---------------------------------------------------------------------
  // Static grid (gutter + hour slots)
  // ---------------------------------------------------------------------

  /** Renders the time gutter labels and the hour grid slots once. */
  function renderGrid() {
    var hourCount = (Utils.END_MIN - Utils.START_MIN) / 60;
    var totalHeight = hourCount * Utils.HOUR_HEIGHT;
    var gutterHtml = '';
    var gridHtml = '';

    for (var i = 0; i <= hourCount; i += 1) {
      var hour = Utils.START_MIN / 60 + i;
      var label = (hour < 10 ? '0' : '') + hour + ':00';
      gutterHtml +=
        '<div class="time-label" data-hour="' + hour + '" style="top:' +
        i * Utils.HOUR_HEIGHT + 'px">' + label + '</div>';
      if (i < hourCount) {
        gridHtml +=
          '<div class="grid-hour-slot" data-hour="' + hour + '" style="height:' +
          Utils.HOUR_HEIGHT + 'px"></div>';
      }
    }

    dom.gutter.innerHTML = gutterHtml;
    dom.grid.innerHTML = gridHtml;
    dom.gutter.style.height = totalHeight + 'px';
    dom.canvas.style.height = totalHeight + 'px';
  }

  // ---------------------------------------------------------------------
  // Overlap layout
  // ---------------------------------------------------------------------

  /**
   * @typedef {Object} PlacedBlock
   * @property {Object} block
   * @property {number} colIndex
   * @property {number} colCount
   */

  /**
   * Groups transitively overlapping blocks into clusters and assigns each
   * block a greedy column inside its cluster.
   * @param {Object[]} blocks Blocks sorted by startMin asc, duration desc.
   * @returns {PlacedBlock[]}
   */
  function computeLayout(blocks) {
    /** @type {PlacedBlock[]} */
    var placed = [];
    var cluster = [];
    var clusterEnd = -1;

    /** Finalizes the current cluster by assigning columns. */
    function flushCluster() {
      if (cluster.length === 0) return;
      var columnEnds = [];
      var entries = cluster.map(function (block) {
        var colIndex = -1;
        for (var c = 0; c < columnEnds.length; c += 1) {
          if (columnEnds[c] <= block.startMin) {
            colIndex = c;
            break;
          }
        }
        if (colIndex === -1) {
          colIndex = columnEnds.length;
          columnEnds.push(block.endMin);
        } else {
          columnEnds[colIndex] = block.endMin;
        }
        return { block: block, colIndex: colIndex, colCount: 1 };
      });
      entries.forEach(function (entry) {
        entry.colCount = columnEnds.length;
        placed.push(entry);
      });
      cluster = [];
      clusterEnd = -1;
    }

    blocks.forEach(function (block) {
      if (cluster.length > 0 && block.startMin >= clusterEnd) flushCluster();
      cluster.push(block);
      clusterEnd = Math.max(clusterEnd, block.endMin);
    });
    flushCluster();
    return placed;
  }

  // ---------------------------------------------------------------------
  // Block rendering
  // ---------------------------------------------------------------------

  /**
   * Builds the HTML for a single block.
   * @param {PlacedBlock} entry
   * @returns {string}
   */
  function blockHtml(entry) {
    var block = entry.block;
    var duration = block.endMin - block.startMin;
    var subject = block.subjectId ? Store.getSubjectById(block.subjectId) : null;
    var color = (subject && subject.color) || 'slate';
    var topPx = minToPx(block.startMin) + 1;
    var heightPx = Math.max(14, (duration / 60) * Utils.HOUR_HEIGHT - 2);
    var leftPct = (entry.colIndex / entry.colCount) * 100;
    var widthPct = 100 / entry.colCount;
    var classes = ['time-block'];
    if (block.completed) classes.push('is-completed');
    if (duration <= 30) classes.push('is-compact');
    if (isTimerActiveFor(block.id)) classes.push('is-timer-active');

    var showMeta = duration >= 45;
    var isRepeating = Boolean(
      block.seriesId ||
      block.isWeeklyAuto ||
      (typeof Store.getWeeklyRepeat === 'function' && Store.getWeeklyRepeat())
    );
    var subtasks = block.subtasks || [];
    var meta = '';
    if (showMeta) {
      if (subject) {
        meta += '<span class="block-subject-pill">' + Utils.escapeHtml(subject.name) + '</span>';
      }
      if (isRepeating) {
        meta += '<span class="block-repeat-badge" title="L\u1EB7p l\u1EA1i h\u00E0ng tu\u1EA7n">\u21BB Tu\u1EA7n</span>';
      }
      if (subtasks.length > 0) {
        var doneCount = subtasks.filter(function (s) { return s.done; }).length;
        meta += '<span class="block-subtask-badge">\u2713 ' + doneCount + '/' + subtasks.length + '</span>';
      }
      if (block.focusedMin > 0) {
        meta += '<span class="block-focused-badge">\u23F1 ' + Utils.formatDurationVi(block.focusedMin) + '</span>';
      }
      if (block.priority === 'high') {
        meta += '<span class="block-priority-tag">\u01AFu ti\u00EAn cao</span>';
      }
    }
    var notes = '';
    if (showMeta && duration >= 60 && block.notes && String(block.notes).trim()) {
      notes = '<div class="block-notes-preview">' + Utils.escapeHtml(String(block.notes).trim()) + '</div>';
    }

    var checkLabel = block.completed ? 'B\u1ECF \u0111\u00E1nh d\u1EA5u ho\u00E0n th\u00E0nh' : '\u0110\u00E1nh d\u1EA5u ho\u00E0n th\u00E0nh';
    var title = Utils.escapeHtml(block.title);
    var compactRepeat = !showMeta && isRepeating
      ? '<span class="block-time-repeat-icon" title="L\u1EB7p l\u1EA1i h\u00E0ng tu\u1EA7n">\u21BB</span>'
      : '';

    return (
      '<div class="' + classes.join(' ') + '" data-block-id="' + Utils.escapeHtml(block.id) +
      '" data-color="' + Utils.escapeHtml(color) + '" tabindex="0" role="button" aria-label="' +
      title + ', ' + formatRange(block.startMin, block.endMin) + '" ' +
      'style="top:' + topPx + 'px;height:' + heightPx + 'px;left:calc(' + leftPct + '% + 4px);' +
      'width:calc(' + widthPct + '% - 8px)">' +
        '<div class="block-header">' +
          '<button type="button" class="block-check" aria-label="' + checkLabel + '" role="checkbox" aria-checked="' +
            (block.completed ? 'true' : 'false') + '"></button>' +
          '<div class="block-main">' +
            '<div class="block-title-row"><span class="block-title">' + title + '</span></div>' +
            '<div class="block-time">' + formatRange(block.startMin, block.endMin) + compactRepeat + '</div>' +
          '</div>' +
          '<div class="block-actions">' +
            '<button type="button" class="block-focus-btn">' + focusButtonLabel(block.id) + '</button>' +
          '</div>' +
        '</div>' +
        (meta ? '<div class="block-meta">' + meta + '</div>' : '') +
        notes +
        '<div class="block-resize-handle" aria-hidden="true"></div>' +
      '</div>'
    );
  }

  /**
   * Re-renders all blocks, the empty state and the current-time line.
   * @param {string} [dateKey] Defaults to the last rendered date.
   * @param {string|null} [subjectFilterId] Defaults to the last used filter.
   */
  function render(dateKey, subjectFilterId) {
    if (!initialized) return;
    if (typeof dateKey === 'string') currentDateKey = dateKey;
    if (subjectFilterId !== undefined) currentFilter = subjectFilterId || null;
    if (!currentDateKey) currentDateKey = Utils.getTodayKey();

    if (gesture && gesture.moved) {
      // Do not rebuild the DOM under an active drag; render once it ends.
      pendingRender = true;
      return;
    }
    pendingRender = false;

    var blocks = Store.getBlocks(currentDateKey, currentFilter);
    var placed = computeLayout(blocks);
    dom.layer.innerHTML = placed.map(blockHtml).join('');

    var dayHasBlocks = Store.getBlocks(currentDateKey, null).length > 0;
    updateEmptyState(dayHasBlocks, blocks.length);
    updateCurrentTimeLine();
  }

  /**
   * Toggles the empty state card and the filtered-empty hint.
   * @param {boolean} dayHasBlocks True if the day has any block regardless of the filter.
   * @param {number} visibleCount Number of blocks visible after filtering.
   */
  function updateEmptyState(dayHasBlocks, visibleCount) {
    var showEmpty = !dayHasBlocks;
    if (dom.empty) dom.empty.classList.toggle('hidden', !showEmpty);

    if (showEmpty && dom.btnCopyYesterday) {
      var yesterdayCount = Store.getBlocks(Utils.addDays(currentDateKey, -1), null).length;
      dom.btnCopyYesterday.classList.toggle('hidden', yesterdayCount === 0);
      if (dom.copyCount) dom.copyCount.textContent = String(yesterdayCount);
    }
    if (showEmpty && dom.btnCopyLastWeek) {
      var lastWeekCount = Store.getBlocks(Utils.addDays(currentDateKey, -7), null).length;
      dom.btnCopyLastWeek.classList.toggle('hidden', lastWeekCount === 0);
      if (dom.copyLastWeekCount) dom.copyLastWeekCount.textContent = String(lastWeekCount);
    }

    var showFilterHint = dayHasBlocks && visibleCount === 0;
    if (!dom.filterHint) {
      dom.filterHint = document.createElement('div');
      dom.filterHint.className = 'timeline-filter-hint hidden';
      dom.filterHint.style.cssText =
        'position:absolute;left:50%;top:96px;transform:translateX(-50%);padding:10px 16px;' +
        'border-radius:10px;font-size:13px;opacity:.75;pointer-events:none;text-align:center;';
      dom.filterHint.textContent =
        'Kh\u00F4ng c\u00F3 khung gi\u1EDD n\u00E0o c\u1EE7a m\u00F4n n\u00E0y trong ng\u00E0y.';
      dom.canvas.appendChild(dom.filterHint);
    }
    dom.filterHint.classList.toggle('hidden', !showFilterHint);
  }

  /**
   * Updates only timer-dependent state (active class and focus button label)
   * without rebuilding the DOM.
   */
  function refreshTimerState() {
    if (!initialized) return;
    var els = dom.layer.querySelectorAll('.time-block');
    for (var i = 0; i < els.length; i += 1) {
      var el = els[i];
      var id = el.getAttribute('data-block-id') || '';
      el.classList.toggle('is-timer-active', isTimerActiveFor(id));
      var btn = el.querySelector('.block-focus-btn');
      var label = focusButtonLabel(id);
      if (btn && btn.textContent !== label) btn.textContent = label;
    }
  }

  // ---------------------------------------------------------------------
  // Current time line
  // ---------------------------------------------------------------------

  /** Positions (or hides) the "now" indicator. */
  function updateCurrentTimeLine() {
    if (!dom.timeLine) return;
    var now = new Date();
    var nowMin = now.getHours() * 60 + now.getMinutes();
    var visible =
      currentDateKey === Utils.getTodayKey() &&
      nowMin >= Utils.START_MIN &&
      nowMin <= Utils.END_MIN;
    dom.timeLine.classList.toggle('hidden', !visible);
    if (!visible) return;
    dom.timeLine.style.top = minToPx(nowMin) + 'px';
    if (dom.timeBadge) dom.timeBadge.textContent = Utils.minutesToTime(nowMin);
  }

  /**
   * Smoothly scrolls the viewport near the current hour (today) or 07:30.
   * @param {string} dateKey
   */
  function scrollToCurrentOrMorning(dateKey) {
    if (!initialized) return;
    var targetMin = 7 * 60 + 30;
    if (dateKey === Utils.getTodayKey()) {
      var now = new Date();
      targetMin = now.getHours() * 60 + now.getMinutes() - 90;
    }
    targetMin = Utils.clamp(targetMin, Utils.START_MIN, Utils.END_MIN);
    var top = Math.max(0, minToPx(targetMin));
    if (typeof dom.scroll.scrollTo === 'function') {
      dom.scroll.scrollTo({ top: top, behavior: 'smooth' });
    } else {
      dom.scroll.scrollTop = top;
    }
  }

  /**
   * Suggests a sensible default range for a new block on the given date.
   * @param {string} dateKey
   * @returns {{startMin: number, endMin: number}}
   */
  function getDefaultRange(dateKey) {
    var startMin = 8 * 60;
    if (dateKey === Utils.getTodayKey()) {
      var now = new Date();
      var rounded = Math.ceil((now.getHours() * 60 + now.getMinutes()) / Utils.SNAP_MIN) * Utils.SNAP_MIN;
      startMin = Utils.clamp(rounded, Utils.START_MIN, Utils.END_MIN - 60);
    }
    return { startMin: startMin, endMin: Math.min(Utils.END_MIN, startMin + 60) };
  }

  // ---------------------------------------------------------------------
  // Pointer gestures
  // ---------------------------------------------------------------------

  /** Shows the selection preview for a create gesture. */
  function showSelection(startMin, endMin) {
    dom.selection.classList.remove('hidden');
    dom.selection.style.top = minToPx(startMin) + 'px';
    dom.selection.style.height = ((endMin - startMin) / 60) * Utils.HOUR_HEIGHT + 'px';
    if (dom.selectionLabel) {
      dom.selectionLabel.textContent =
        formatRange(startMin, endMin) + ' \u00B7 ' + Utils.formatDurationVi(endMin - startMin);
    }
  }

  /** Hides the selection preview. */
  function hideSelection() {
    dom.selection.classList.add('hidden');
  }

  /** Disables text selection while a gesture is in progress. */
  function lockSelection(lock) {
    document.body.style.userSelect = lock ? 'none' : '';
    document.body.style.webkitUserSelect = lock ? 'none' : '';
    if (lock && window.getSelection) {
      var sel = window.getSelection();
      if (sel) sel.removeAllRanges();
    }
  }

  /** Clears the active gesture and detaches document listeners. */
  function endGesture() {
    if (gesture) window.clearTimeout(gesture.longPressTimer);
    gesture = null;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
    lockSelection(false);
  }

  /**
   * @param {PointerEvent} e
   */
  function onPointerDown(e) {
    if (gesture) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    var target = /** @type {HTMLElement} */ (e.target);
    if (!target || !target.closest) return;
    if (target.closest('.block-check') || target.closest('.block-focus-btn')) return;
    if (target.closest('#timeline-empty-state')) return;

    var blockEl = /** @type {HTMLElement|null} */ (target.closest('.time-block'));
    var type = 'create';
    if (blockEl) type = target.closest('.block-resize-handle') ? 'resize' : 'move';

    /** @type {Gesture} */
    var g = {
      type: /** @type {'create'|'move'|'resize'} */ (type),
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      startX: e.clientX,
      startY: e.clientY,
      startPointerMin: pointerToMinutes(e.clientY),
      armed: e.pointerType !== 'touch',
      moved: false,
      longPressTimer: 0
    };

    if (blockEl) {
      var blockId = blockEl.getAttribute('data-block-id') || '';
      var block = Store.getBlockById(currentDateKey, blockId);
      if (!block) return;
      g.blockId = blockId;
      g.el = blockEl;
      g.origStart = block.startMin;
      g.origEnd = block.endMin;
      g.curStart = block.startMin;
      g.curEnd = block.endMin;
    }

    if (!g.armed) {
      g.longPressTimer = window.setTimeout(function () {
        if (gesture === g) {
          g.armed = true;
          if (navigator.vibrate) navigator.vibrate(12);
        }
      }, LONG_PRESS_MS);
    } else {
      lockSelection(true);
    }

    gesture = g;
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
  }

  /** Scrolls the viewport when the pointer is near its top/bottom edge. */
  function autoScroll(clientY) {
    var rect = dom.scroll.getBoundingClientRect();
    if (clientY < rect.top + EDGE_SCROLL_ZONE) {
      dom.scroll.scrollTop -= EDGE_SCROLL_STEP;
    } else if (clientY > rect.bottom - EDGE_SCROLL_ZONE) {
      dom.scroll.scrollTop += EDGE_SCROLL_STEP;
    }
  }

  /**
   * @param {PointerEvent} e
   */
  function onPointerMove(e) {
    var g = gesture;
    if (!g || e.pointerId !== g.pointerId) return;

    var dist = Math.hypot(e.clientX - g.startX, e.clientY - g.startY);
    if (!g.armed) {
      // Touch before long-press: the user is scrolling, abandon the gesture.
      if (dist > TOUCH_CANCEL_PX) endGesture();
      return;
    }
    if (!g.moved && dist < DRAG_THRESHOLD_PX) return;
    if (!g.moved) {
      g.moved = true;
      lockSelection(true);
      if (g.el) g.el.classList.add(g.type === 'resize' ? 'is-resizing' : 'is-dragging');
    }

    autoScroll(e.clientY);
    var nowMin = pointerToMinutes(e.clientY);

    if (g.type === 'create') {
      var anchor = floorSnap(g.startPointerMin);
      var current = Utils.snapMinutes(nowMin, Utils.SNAP_MIN);
      var s = anchor;
      var en = anchor + Utils.SNAP_MIN;
      if (current > anchor) {
        en = current;
      } else if (current < anchor) {
        s = current;
      }
      s = Utils.clamp(s, Utils.START_MIN, Utils.END_MIN - Utils.MIN_DURATION);
      en = Utils.clamp(en, s + Utils.MIN_DURATION, Utils.END_MIN);
      g.curStart = s;
      g.curEnd = en;
      showSelection(s, en);
    } else if (g.type === 'move' && g.el) {
      var duration = g.origEnd - g.origStart;
      var delta = nowMin - g.startPointerMin;
      var newStart = Utils.snapMinutes(g.origStart + delta, Utils.SNAP_MIN);
      newStart = Utils.clamp(newStart, Utils.START_MIN, Utils.END_MIN - duration);
      g.curStart = newStart;
      g.curEnd = newStart + duration;
      g.el.style.top = minToPx(newStart) + 1 + 'px';
      var timeEl = g.el.querySelector('.block-time');
      if (timeEl) timeEl.textContent = formatRange(g.curStart, g.curEnd);
    } else if (g.type === 'resize' && g.el) {
      var resizeDelta = nowMin - g.startPointerMin;
      var newEnd = Utils.snapMinutes(g.origEnd + resizeDelta, Utils.SNAP_MIN);
      newEnd = Utils.clamp(newEnd, g.origStart + Utils.MIN_DURATION, Utils.END_MIN);
      g.curEnd = newEnd;
      g.el.style.height = Math.max(14, ((newEnd - g.origStart) / 60) * Utils.HOUR_HEIGHT - 2) + 'px';
      var resizeTimeEl = g.el.querySelector('.block-time');
      if (resizeTimeEl) resizeTimeEl.textContent = formatRange(g.origStart, newEnd);
    }
  }

  /**
   * @param {PointerEvent} e
   */
  function onPointerUp(e) {
    var g = gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    var type = g.type;
    var moved = g.moved;
    var blockId = g.blockId;
    var origStart = g.origStart;
    var origEnd = g.origEnd;
    var curStart = g.curStart;
    var curEnd = g.curEnd;
    var startPointerMin = g.startPointerMin;
    var el = g.el;

    hideSelection();
    if (el) el.classList.remove('is-dragging', 'is-resizing');
    endGesture();

    if (pendingRender) render();

    if (type === 'create') {
      if (moved) {
        callbacks.onRequestCreate(curStart, curEnd);
      } else {
        var start = Utils.clamp(
          floorSnap(startPointerMin),
          Utils.START_MIN,
          Utils.END_MIN - Utils.MIN_DURATION
        );
        callbacks.onRequestCreate(start, Math.min(Utils.END_MIN, start + 60));
      }
      return;
    }

    if (!blockId) return;

    if (!moved) {
      // A resize handle press without movement is not an edit request.
      if (type === 'move') callbacks.onRequestEdit(blockId);
      return;
    }

    if (type === 'move') {
      if (curStart === origStart) {
        flushPendingRender();
        render();
        return;
      }
      var movedBlock = Store.updateBlock(currentDateKey, blockId, { startMin: curStart, endMin: curEnd });
      if (movedBlock) callbacks.onBlockMoved(movedBlock, origStart, origEnd);
    } else {
      if (curEnd === origEnd) {
        flushPendingRender();
        render();
        return;
      }
      var resizedBlock = Store.updateBlock(currentDateKey, blockId, { endMin: curEnd });
      if (resizedBlock) callbacks.onBlockResized(resizedBlock, origEnd);
    }
    // Store.subscribe usually re-renders; make sure the DOM reflects the result.
    flushPendingRender();
    render();
  }

  /** Clears the deferred render flag. */
  function flushPendingRender() {
    pendingRender = false;
  }

  /**
   * @param {PointerEvent} e
   */
  function onPointerCancel(e) {
    var g = gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    var wasMoved = g.moved;
    hideSelection();
    if (g.el) g.el.classList.remove('is-dragging', 'is-resizing');
    endGesture();
    if (wasMoved) render();
  }

  /**
   * Blocks native scrolling while a long-press drag is active on touch devices.
   * @param {TouchEvent} e
   */
  function onTouchMove(e) {
    if (gesture && gesture.armed && gesture.pointerType === 'touch' && e.cancelable) {
      e.preventDefault();
    }
  }

  // ---------------------------------------------------------------------
  // Click / keyboard handlers on blocks
  // ---------------------------------------------------------------------

  /**
   * @param {MouseEvent} e
   */
  function onLayerClick(e) {
    var target = /** @type {HTMLElement} */ (e.target);
    if (!target || !target.closest) return;
    var blockEl = target.closest('.time-block');
    if (!blockEl) return;
    var blockId = blockEl.getAttribute('data-block-id') || '';
    if (target.closest('.block-check')) {
      e.stopPropagation();
      callbacks.onToggleComplete(blockId);
    } else if (target.closest('.block-focus-btn')) {
      e.stopPropagation();
      callbacks.onRequestFocus(blockId);
    }
  }

  /**
   * @param {KeyboardEvent} e
   */
  function onLayerKeydown(e) {
    var target = /** @type {HTMLElement} */ (e.target);
    if (!target || !target.classList || !target.classList.contains('time-block')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      callbacks.onRequestEdit(target.getAttribute('data-block-id') || '');
    }
  }

  // ---------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------

  /**
   * Initializes the timeline and wires up all DOM listeners.
   * @param {Partial<TimelineCallbacks>} cbs
   */
  function init(cbs) {
    Object.keys(callbacks).forEach(function (key) {
      if (cbs && typeof cbs[key] === 'function') callbacks[key] = cbs[key];
    });

    dom.scroll = document.getElementById('timeline-scroll');
    dom.gutter = document.getElementById('time-gutter');
    dom.canvas = document.getElementById('timeline-canvas');
    dom.grid = document.getElementById('timeline-grid');
    dom.layer = document.getElementById('blocks-layer');
    dom.selection = document.getElementById('selection-preview');
    dom.selectionLabel = document.getElementById('selection-preview-label');
    dom.timeLine = document.getElementById('current-time-line');
    dom.timeBadge = document.getElementById('current-time-badge');
    dom.empty = document.getElementById('timeline-empty-state');
    dom.btnEmptyAdd = document.getElementById('btn-empty-add');
    dom.btnCopyYesterday = document.getElementById('btn-copy-yesterday');
    dom.copyCount = document.getElementById('copy-yesterday-count');
    dom.btnCopyLastWeek = document.getElementById('btn-copy-last-week');
    dom.copyLastWeekCount = document.getElementById('copy-last-week-count');

    if (!dom.scroll || !dom.canvas || !dom.layer || !dom.grid || !dom.gutter || !dom.selection) {
      console.error('[Timeline] Required DOM elements are missing.');
      return;
    }
    initialized = true;
    currentDateKey = Utils.getTodayKey();

    renderGrid();

    dom.canvas.addEventListener('pointerdown', onPointerDown);
    dom.layer.addEventListener('click', onLayerClick);
    dom.layer.addEventListener('keydown', onLayerKeydown);
    document.addEventListener('touchmove', onTouchMove, { passive: false });

    if (dom.btnEmptyAdd) {
      dom.btnEmptyAdd.addEventListener('click', function () {
        var range = getDefaultRange(currentDateKey);
        callbacks.onRequestCreate(range.startMin, range.endMin);
      });
    }
    if (dom.btnCopyYesterday) {
      dom.btnCopyYesterday.addEventListener('click', function () {
        callbacks.onCopyYesterday();
      });
    }
    if (dom.btnCopyLastWeek) {
      dom.btnCopyLastWeek.addEventListener('click', function () {
        callbacks.onCopyLastWeek();
      });
    }

    window.clearInterval(timeLineHandle);
    timeLineHandle = window.setInterval(updateCurrentTimeLine, TIME_LINE_INTERVAL_MS);
  }

  window.StudyPlan.Timeline = {
    init: init,
    render: render,
    refreshTimerState: refreshTimerState,
    updateCurrentTimeLine: updateCurrentTimeLine,
    scrollToCurrentOrMorning: scrollToCurrentOrMorning,
    getDefaultRange: getDefaultRange
  };
})();
