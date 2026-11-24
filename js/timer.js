/**
 * StudyPlan — Focus Timer module.
 * Drift-free, timestamp-based Pomodoro / block countdown that survives tab throttling,
 * date switching and page reloads. Focus time is credited to Store in whole minutes
 * without double counting.
 * Exposed as window.StudyPlan.Timer (classic script, works on file://).
 */
(function (global) {
  'use strict';

  const StudyPlan = (global.StudyPlan = global.StudyPlan || {});
  const Utils = StudyPlan.Utils;

  const STORAGE_KEY = 'daily_study_plan_timer_v1';
  const FOCUS_MS = 25 * 60 * 1000; // 1500000
  const BREAK_MS = 5 * 60 * 1000; // 300000
  const MINUTE_MS = 60000;
  const ROUND_UP_MS = 30000;
  const TICK_MS = 250;
  const LATE_CHIME_LIMIT_MS = 60000;

  /**
   * @typedef {'pomodoro'|'block'} TimerMode
   * @typedef {'focus'|'break'} TimerPhase
   * @typedef {'idle'|'running'|'paused'} TimerStatus
   *
   * @typedef {Object} PersistedTimer
   * @property {1} version
   * @property {TimerStatus} status
   * @property {TimerMode} mode
   * @property {TimerPhase} phase
   * @property {string|null} dateKey
   * @property {string|null} blockId
   * @property {string} blockTitle Cached title (fallback if the block disappears)
   * @property {number} durationMs Total length of the current phase
   * @property {number} remainingMsAtStart Remaining ms at `startedAt` (or frozen remaining while paused)
   * @property {number|null} startedAt Epoch ms when the current running segment began
   * @property {number|null} lastAccountedAt Epoch ms up to which focus time has been accounted
   * @property {number} unflushedFocusMs Accounted focus ms not yet credited as whole minutes
   * @property {number} creditedFocusMinutes Minutes credited to the block during this session
   * @property {number} completedPomodoros Focus phases finished during this session
   * @property {boolean} muted
   *
   * @typedef {Object} TimerSnapshot
   * @property {boolean} active True when running or paused
   * @property {TimerStatus} status
   * @property {boolean} isRunning
   * @property {boolean} isPaused
   * @property {TimerMode} mode
   * @property {TimerPhase} phase
   * @property {string} phaseLabel Vietnamese phase label ('Tập trung' | 'Nghỉ ngắn')
   * @property {string|null} dateKey
   * @property {string|null} blockId
   * @property {string} blockTitle
   * @property {string} color Subject color token of the block ('slate' fallback)
   * @property {number} remainingMs
   * @property {number} durationMs
   * @property {number} elapsedMs
   * @property {number} progress 0..1 of the current phase
   * @property {string} clock 'MM:SS'
   * @property {number} creditedFocusMinutes
   * @property {number} completedPomodoros
   * @property {boolean} muted
   *
   * @typedef {Object} TimerCompleteEvent
   * @property {'focus'|'break'|'block'} type Which phase finished
   * @property {TimerMode} mode
   * @property {string|null} dateKey
   * @property {string|null} blockId
   * @property {string} blockTitle
   * @property {TimerPhase|null} nextPhase Phase that follows (null when the timer stopped)
   * @property {number} creditedFocusMinutes Minutes credited during the session so far
   * @property {number} completedPomodoros
   * @property {boolean} late True if the phase ended while the page was closed / hidden long ago
   * @property {string} message Ready-to-show Vietnamese toast message
   *
   * @typedef {(snapshot: TimerSnapshot) => void} TimerListener
   * @typedef {(event: TimerCompleteEvent) => void} CompleteListener
   */

  /** @type {PersistedTimer} */
  let t = createIdle(false, 'pomodoro');
  /** @type {Set<TimerListener>} */
  const listeners = new Set();
  /** @type {Set<CompleteListener>} */
  const completeListeners = new Set();
  let initialized = false;
  /** @type {number|undefined} */
  let intervalId;
  /** @type {string|null} */
  let lastWrittenRaw = null;
  let lastEmittedKey = '';
  /** @type {AudioContext|null} */
  let audioCtx = null;

  /**
   * @param {boolean} muted
   * @param {TimerMode} mode
   * @returns {PersistedTimer}
   */
  function createIdle(muted, mode) {
    return {
      version: 1,
      status: 'idle',
      mode: mode === 'block' ? 'block' : 'pomodoro',
      phase: 'focus',
      dateKey: null,
      blockId: null,
      blockTitle: '',
      durationMs: FOCUS_MS,
      remainingMsAtStart: FOCUS_MS,
      startedAt: null,
      lastAccountedAt: null,
      unflushedFocusMs: 0,
      creditedFocusMinutes: 0,
      completedPomodoros: 0,
      muted: !!muted
    };
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /**
   * @param {unknown} raw
   * @returns {PersistedTimer|null}
   */
  function sanitize(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    /** @type {Record<string, unknown>} */
    const r = /** @type {Record<string, unknown>} */ (raw);
    const num = (/** @type {unknown} */ v, /** @type {number} */ d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const status = r.status === 'running' || r.status === 'paused' ? r.status : 'idle';
    /** @type {PersistedTimer} */
    const out = {
      version: 1,
      status: status,
      mode: r.mode === 'block' ? 'block' : 'pomodoro',
      phase: r.phase === 'break' ? 'break' : 'focus',
      dateKey: Utils.isValidDateKey(r.dateKey) ? /** @type {string} */ (r.dateKey) : null,
      blockId: typeof r.blockId === 'string' && r.blockId ? r.blockId : null,
      blockTitle: typeof r.blockTitle === 'string' ? r.blockTitle : '',
      durationMs: Math.max(0, num(r.durationMs, FOCUS_MS)),
      remainingMsAtStart: Math.max(0, num(r.remainingMsAtStart, FOCUS_MS)),
      startedAt: typeof r.startedAt === 'number' && Number.isFinite(r.startedAt) ? r.startedAt : null,
      lastAccountedAt: typeof r.lastAccountedAt === 'number' && Number.isFinite(r.lastAccountedAt) ? r.lastAccountedAt : null,
      unflushedFocusMs: Math.max(0, num(r.unflushedFocusMs, 0)),
      creditedFocusMinutes: Math.max(0, Math.round(num(r.creditedFocusMinutes, 0))),
      completedPomodoros: Math.max(0, Math.round(num(r.completedPomodoros, 0))),
      muted: r.muted === true
    };
    if (out.status !== 'idle' && (!out.dateKey || !out.blockId)) return createIdle(out.muted, out.mode);
    if (out.status === 'running' && out.startedAt === null) out.status = 'paused';
    return out;
  }

  function persist() {
    try {
      const raw = JSON.stringify(t);
      global.localStorage.setItem(STORAGE_KEY, raw);
      lastWrittenRaw = raw;
    } catch (e) {
      console.warn('[StudyPlan.Timer] Failed to persist timer:', e);
    }
  }

  /** Adopt timer state written by another tab (prevents double crediting). */
  function syncFromStorage() {
    /** @type {string|null} */
    let raw = null;
    try {
      raw = global.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return;
    }
    if (raw === null || raw === lastWrittenRaw) return;
    try {
      const next = sanitize(JSON.parse(raw));
      if (next) t = next;
      lastWrittenRaw = raw;
    } catch (e) {
      /* ignore malformed data */
    }
  }

  // ---------------------------------------------------------------------------
  // Core time math
  // ---------------------------------------------------------------------------

  /**
   * Remaining ms of the current phase at time `now`.
   * @param {number} now
   * @returns {number}
   */
  function remainingAt(now) {
    if (t.status === 'running' && t.startedAt !== null) {
      return Math.max(0, t.remainingMsAtStart - (now - t.startedAt));
    }
    return t.remainingMsAtStart;
  }

  /** @returns {number|null} epoch ms when the running phase ends */
  function phaseEndAt() {
    return t.status === 'running' && t.startedAt !== null ? t.startedAt + t.remainingMsAtStart : null;
  }

  /**
   * Move focus time up to `until` into the unflushed bucket.
   * @param {number} until
   */
  function accountFocus(until) {
    if (t.status !== 'running' || t.phase !== 'focus' || t.lastAccountedAt === null) return;
    const end = phaseEndAt();
    const cap = end === null ? until : Math.min(until, end);
    const delta = cap - t.lastAccountedAt;
    if (delta > 0) {
      t.unflushedFocusMs += delta;
      t.lastAccountedAt = cap;
    }
  }

  /**
   * Credit focus minutes to the Store. Timer state is persisted BEFORE crediting so a crash
   * can at worst lose a minute, never double count it.
   * @param {boolean} final When true, a remainder >= 30s rounds up to 1 minute and the bucket is cleared.
   */
  function flushCredit(final) {
    let mins = Math.floor(t.unflushedFocusMs / MINUTE_MS);
    t.unflushedFocusMs -= mins * MINUTE_MS;
    if (final) {
      if (t.unflushedFocusMs >= ROUND_UP_MS) mins += 1;
      t.unflushedFocusMs = 0;
    }
    if (mins <= 0) return;
    t.creditedFocusMinutes += mins;
    persist();
    creditStore(mins);
  }

  /**
   * @param {number} mins
   */
  function creditStore(mins) {
    const Store = StudyPlan.Store;
    if (!Store || !t.blockId) return;
    let dateKey = t.dateKey;
    if (!dateKey || !Store.getBlockById(dateKey, t.blockId)) {
      // The block may have been moved to another day; follow it.
      dateKey = Store.findBlockDateKey ? Store.findBlockDateKey(t.blockId) : null;
      if (!dateKey) return;
      t.dateKey = dateKey;
      persist();
    }
    Store.addFocusedMinutes(dateKey, t.blockId, mins);
  }

  /**
   * Compute the block-mode countdown for a block.
   * @param {{ startMin: number, endMin: number, focusedMin: number }} block
   * @returns {number}
   */
  function blockDurationMs(block) {
    const full = Math.max(Utils.MIN_DURATION, block.endMin - block.startMin) * MINUTE_MS;
    const remaining = full - Math.max(0, block.focusedMin) * MINUTE_MS;
    return remaining >= 5 * MINUTE_MS ? remaining : full;
  }

  /**
   * @returns {{ id: string, title: string, subjectId: string|null, startMin: number, endMin: number, focusedMin: number }|null}
   */
  function getCurrentBlock() {
    const Store = StudyPlan.Store;
    if (!Store || !t.blockId) return null;
    let b = t.dateKey ? Store.getBlockById(t.dateKey, t.blockId) : null;
    if (!b && Store.findBlockDateKey) {
      const key = Store.findBlockDateKey(t.blockId);
      if (key) b = Store.getBlockById(key, t.blockId);
    }
    return b;
  }

  // ---------------------------------------------------------------------------
  // Phase completion
  // ---------------------------------------------------------------------------

  /**
   * Handle every phase that has ended by `now` (may cascade after long absences).
   * @param {number} now
   * @returns {TimerCompleteEvent[]}
   */
  function processCompletions(now) {
    /** @type {TimerCompleteEvent[]} */
    const events = [];
    let guard = 0;
    while (guard++ < 10) {
      const end = phaseEndAt();
      if (end === null || now < end) break;
      const late = now - end > LATE_CHIME_LIMIT_MS;
      const title = resolveTitle();

      if (t.phase === 'focus') {
        accountFocus(end);
        flushCredit(true);
        t.completedPomodoros += 1;
        if (t.mode === 'pomodoro') {
          t.phase = 'break';
          t.durationMs = BREAK_MS;
          t.remainingMsAtStart = BREAK_MS;
          t.startedAt = end; // break starts exactly when focus ended (no drift)
          t.lastAccountedAt = null;
          events.push(makeEvent('focus', 'break', late, 'Hoàn thành 25 phút tập trung cho "' + title + '"! Nghỉ ngơi 5 phút nhé ☕'));
        } else {
          const ev = makeEvent('block', null, late, 'Đã hết thời gian khung giờ "' + title + '". Làm tốt lắm! 🎉');
          t = createIdle(t.muted, t.mode);
          events.push(ev);
        }
      } else {
        t.phase = 'focus';
        t.durationMs = FOCUS_MS;
        t.remainingMsAtStart = FOCUS_MS;
        t.status = 'paused';
        t.startedAt = null;
        t.lastAccountedAt = null;
        events.push(makeEvent('break', 'focus', late, 'Hết giờ nghỉ! Sẵn sàng cho phiên tập trung tiếp theo 💪'));
      }
      persist();
    }
    return events;
  }

  /** @returns {string} */
  function resolveTitle() {
    const b = getCurrentBlock();
    if (b && b.title && b.title !== t.blockTitle) t.blockTitle = b.title;
    return t.blockTitle || 'Khung giờ học';
  }

  /**
   * @param {'focus'|'break'|'block'} type
   * @param {TimerPhase|null} nextPhase
   * @param {boolean} late
   * @param {string} message
   * @returns {TimerCompleteEvent}
   */
  function makeEvent(type, nextPhase, late, message) {
    return {
      type: type,
      mode: t.mode,
      dateKey: t.dateKey,
      blockId: t.blockId,
      blockTitle: t.blockTitle || 'Khung giờ học',
      nextPhase: nextPhase,
      creditedFocusMinutes: t.creditedFocusMinutes,
      completedPomodoros: t.completedPomodoros,
      late: late,
      message: message
    };
  }

  /**
   * @param {TimerCompleteEvent[]} events
   */
  function dispatchCompletions(events) {
    if (events.length === 0) return;
    if (events.some((e) => !e.late)) playChime();
    events.forEach((ev) => {
      completeListeners.forEach((fn) => {
        try {
          fn(ev);
        } catch (e) {
          console.error('[StudyPlan.Timer] onComplete listener error:', e);
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Tick & notification
  // ---------------------------------------------------------------------------

  /**
   * @param {boolean} [force=false] notify even if the displayed second did not change
   */
  function tick(force) {
    syncFromStorage();
    const now = Date.now();
    const events = processCompletions(now);
    if (t.status === 'running' && t.phase === 'focus') {
      const before = t.unflushedFocusMs;
      accountFocus(now);
      if (t.unflushedFocusMs >= MINUTE_MS) flushCredit(false);
      else if (t.unflushedFocusMs !== before && force) persist();
    }
    emitChange(force || events.length > 0);
    dispatchCompletions(events);
  }

  /**
   * @param {boolean} force
   */
  function emitChange(force) {
    const snap = getSnapshot();
    const key = [snap.status, snap.mode, snap.phase, snap.blockId, snap.clock, snap.muted, snap.blockTitle].join('|');
    if (!force && key === lastEmittedKey) return;
    lastEmittedKey = key;
    listeners.forEach((fn) => {
      try {
        fn(snap);
      } catch (e) {
        console.error('[StudyPlan.Timer] Listener error:', e);
      }
    });
  }

  /** Finalize current focus (round remainder) before switching blocks / stopping. */
  function finalizeSession() {
    const now = Date.now();
    accountFocus(now);
    flushCredit(true);
  }

  // ---------------------------------------------------------------------------
  // Audio
  // ---------------------------------------------------------------------------

  /** Create / resume the AudioContext (call from user gestures so chimes can play later). */
  function ensureAudio() {
    try {
      const Ctor = global.AudioContext || /** @type {typeof AudioContext|undefined} */ (/** @type {Record<string, unknown>} */ (/** @type {unknown} */ (global)).webkitAudioContext);
      if (!Ctor) return null;
      if (!audioCtx) audioCtx = new Ctor();
      if (audioCtx.state === 'suspended') {
        const pending = audioCtx.resume();
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      }
      return audioCtx;
    } catch (e) {
      return null;
    }
  }

  /** Play a gentle two-tone chime (no-op when muted or unsupported). */
  function playChime() {
    if (t.muted) return;
    try {
      const ctx = ensureAudio();
      if (!ctx) return;
      const start = ctx.currentTime + 0.02;
      [
        { freq: 659.25, at: 0 },
        { freq: 987.77, at: 0.22 }
      ].forEach((tone) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = tone.freq;
        const t0 = start + tone.at;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.1);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 1.15);
      });
    } catch (e) {
      /* audio is optional */
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Initialize the timer (idempotent). Catch-up of missed phases runs on the next macrotask. */
  function init() {
    if (initialized) return;
    initialized = true;
    try {
      const raw = global.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const loaded = sanitize(JSON.parse(raw));
        if (loaded) t = loaded;
        lastWrittenRaw = raw;
      }
    } catch (e) {
      t = createIdle(false, 'pomodoro');
    }
    intervalId = global.setInterval(() => tick(false), TICK_MS);
    // Deferred so UI can subscribe / register onComplete before catch-up events fire.
    global.setTimeout(() => tick(true), 0);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') tick(true);
      else if (t.status === 'running') {
        accountFocus(Date.now());
        persist();
      }
    });
    global.addEventListener('pagehide', () => {
      if (t.status === 'running') {
        accountFocus(Date.now());
        persist();
      }
    });
    global.addEventListener('storage', (event) => {
      if (event.key === STORAGE_KEY) tick(true);
    });
  }

  /**
   * @param {TimerListener} fn
   * @returns {() => void} unsubscribe
   */
  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.add(fn);
    return function () {
      listeners.delete(fn);
    };
  }

  /**
   * @param {CompleteListener} fn
   * @returns {() => void} unregister
   */
  function onComplete(fn) {
    if (typeof fn !== 'function') return function () {};
    completeListeners.add(fn);
    return function () {
      completeListeners.delete(fn);
    };
  }

  /** @returns {TimerSnapshot} */
  function getSnapshot() {
    const now = Date.now();
    const remaining = remainingAt(now);
    const duration = Math.max(1, t.durationMs);
    const block = t.status !== 'idle' ? getCurrentBlock() : null;
    const Store = StudyPlan.Store;
    return {
      active: t.status !== 'idle',
      status: t.status,
      isRunning: t.status === 'running',
      isPaused: t.status === 'paused',
      mode: t.mode,
      phase: t.phase,
      phaseLabel: t.phase === 'break' ? 'Nghỉ ngắn' : 'Tập trung',
      dateKey: t.dateKey,
      blockId: t.blockId,
      blockTitle: (block && block.title) || t.blockTitle || '',
      color: block && Store && Store.getBlockColor ? Store.getBlockColor(block) : 'slate',
      remainingMs: remaining,
      durationMs: t.durationMs,
      elapsedMs: Math.max(0, t.durationMs - remaining),
      progress: Utils.clamp(1 - remaining / duration, 0, 1),
      clock: Utils.formatTimerClock(remaining),
      creditedFocusMinutes: t.creditedFocusMinutes,
      completedPomodoros: t.completedPomodoros,
      muted: t.muted
    };
  }

  /**
   * Start (or restart) a focus session for a block.
   * @param {string} dateKey
   * @param {string} blockId
   * @param {TimerMode} [mode='pomodoro']
   * @returns {TimerSnapshot|null} null when the block does not exist
   */
  function startForBlock(dateKey, blockId, mode) {
    syncFromStorage();
    const Store = StudyPlan.Store;
    const block = Store ? Store.getBlockById(dateKey, blockId) : null;
    if (!block) return null;
    ensureAudio();
    const nextMode = mode === 'block' ? 'block' : 'pomodoro';

    // Same block already active in the same mode: just make sure it runs.
    if (t.status !== 'idle' && t.blockId === blockId && t.dateKey === dateKey && t.mode === nextMode) {
      if (t.status === 'paused') resume();
      return getSnapshot();
    }
    if (t.status !== 'idle') finalizeSession();

    const now = Date.now();
    const duration = nextMode === 'block' ? blockDurationMs(block) : FOCUS_MS;
    const muted = t.muted;
    t = createIdle(muted, nextMode);
    t.status = 'running';
    t.dateKey = dateKey;
    t.blockId = blockId;
    t.blockTitle = block.title;
    t.durationMs = duration;
    t.remainingMsAtStart = duration;
    t.startedAt = now;
    t.lastAccountedAt = now;
    persist();
    emitChange(true);
    return getSnapshot();
  }

  /** Pause the running timer. */
  function pause() {
    syncFromStorage();
    if (t.status !== 'running') return;
    const now = Date.now();
    const events = processCompletions(now);
    if (t.status === 'running') {
      accountFocus(now);
      flushCredit(false); // whole minutes now; the sub-minute remainder carries over (not lost, not inflated)
      t.remainingMsAtStart = remainingAt(now);
      t.status = 'paused';
      t.startedAt = null;
      t.lastAccountedAt = null;
      persist();
    }
    emitChange(true);
    dispatchCompletions(events);
  }

  /** Resume a paused timer. */
  function resume() {
    syncFromStorage();
    if (t.status !== 'paused') return;
    ensureAudio();
    const now = Date.now();
    t.status = 'running';
    t.startedAt = now;
    t.lastAccountedAt = t.phase === 'focus' ? now : null;
    persist();
    emitChange(true);
  }

  /** Toggle between running and paused. */
  function togglePause() {
    if (t.status === 'running') pause();
    else if (t.status === 'paused') resume();
  }

  /**
   * Stop the session, crediting remaining focus time (>= 30s rounds up to a minute).
   * @returns {{ creditedFocusMinutes: number, blockId: string|null, dateKey: string|null }}
   */
  function stop() {
    syncFromStorage();
    const summary = { creditedFocusMinutes: 0, blockId: t.blockId, dateKey: t.dateKey };
    if (t.status === 'idle') return summary;
    finalizeSession();
    summary.creditedFocusMinutes = t.creditedFocusMinutes;
    summary.dateKey = t.dateKey;
    t = createIdle(t.muted, t.mode);
    persist();
    emitChange(true);
    return summary;
  }

  /**
   * Switch between 'pomodoro' and 'block' mode. When active, restarts the countdown in the
   * new mode (keeping running/paused status) after banking the focus time so far.
   * @param {TimerMode} mode
   */
  function setMode(mode) {
    syncFromStorage();
    const nextMode = mode === 'block' ? 'block' : 'pomodoro';
    if (t.mode === nextMode) return;
    if (t.status === 'idle') {
      t.mode = nextMode;
      persist();
      emitChange(true);
      return;
    }
    const now = Date.now();
    accountFocus(now);
    flushCredit(false);
    const block = getCurrentBlock();
    const duration = nextMode === 'block' && block ? blockDurationMs(block) : FOCUS_MS;
    t.mode = nextMode;
    t.phase = 'focus';
    t.durationMs = duration;
    t.remainingMsAtStart = duration;
    if (t.status === 'running') {
      t.startedAt = now;
      t.lastAccountedAt = now;
    } else {
      t.startedAt = null;
      t.lastAccountedAt = null;
    }
    persist();
    emitChange(true);
  }

  /** Skip the current break and immediately start the next focus phase. */
  function skipBreak() {
    syncFromStorage();
    if (t.status === 'idle' || t.phase !== 'break') return;
    ensureAudio();
    const now = Date.now();
    t.phase = 'focus';
    t.durationMs = FOCUS_MS;
    t.remainingMsAtStart = FOCUS_MS;
    t.status = 'running';
    t.startedAt = now;
    t.lastAccountedAt = now;
    persist();
    emitChange(true);
  }

  /**
   * Toggle chime sound.
   * @returns {boolean} new muted state
   */
  function toggleMute() {
    syncFromStorage();
    t.muted = !t.muted;
    if (!t.muted) ensureAudio();
    persist();
    emitChange(true);
    return t.muted;
  }

  /** @returns {boolean} */
  function isActiveForBlock(/** @type {string} */ blockId) {
    return t.status !== 'idle' && t.blockId === blockId;
  }

  StudyPlan.Timer = Object.freeze({
    STORAGE_KEY: STORAGE_KEY,
    FOCUS_MS: FOCUS_MS,
    BREAK_MS: BREAK_MS,
    init: init,
    subscribe: subscribe,
    onComplete: onComplete,
    getSnapshot: getSnapshot,
    startForBlock: startForBlock,
    pause: pause,
    resume: resume,
    togglePause: togglePause,
    stop: stop,
    setMode: setMode,
    skipBreak: skipBreak,
    toggleMute: toggleMute,
    playChime: playChime,
    isActiveForBlock: isActiveForBlock
  });
})(window);
