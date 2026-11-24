/**
 * StudyPlan — Utilities module.
 * Pure helpers for IDs, numbers, local-timezone-safe dates, time formatting and HTML escaping.
 * Exposed as window.StudyPlan.Utils (classic script, works on file://).
 */
(function (global) {
  'use strict';

  const StudyPlan = (global.StudyPlan = global.StudyPlan || {});

  /** Earliest minute shown on the timeline (05:00). */
  const START_MIN = 300;
  /** Latest minute shown on the timeline (24:00). */
  const END_MIN = 1440;
  /** Drag / resize snapping step in minutes. */
  const SNAP_MIN = 15;
  /** Minimum duration of a study block in minutes. */
  const MIN_DURATION = 15;
  /** Height of one hour on the timeline, in pixels. */
  const HOUR_HEIGHT = 64;
  /** Allowed subject / block color tokens. */
  const COLORS = Object.freeze(['blue', 'purple', 'emerald', 'amber', 'rose', 'cyan', 'orange', 'slate']);

  const WEEKDAYS_VI = Object.freeze(['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy']);
  const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  let uidCounter = 0;

  /**
   * Generate a reasonably unique string ID.
   * @param {string} [prefix='id']
   * @returns {string}
   */
  function uid(prefix) {
    const p = typeof prefix === 'string' && prefix ? prefix : 'id';
    uidCounter = (uidCounter + 1) % 1679616;
    const time = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return p + '_' + time + rand + uidCounter.toString(36);
  }

  /**
   * Clamp a number into [min, max].
   * @param {number} val
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  function clamp(val, min, max) {
    const n = Number(val);
    if (Number.isNaN(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  /**
   * Snap minutes to the nearest step.
   * @param {number} min
   * @param {number} [step=15]
   * @returns {number}
   */
  function snapMinutes(min, step) {
    const s = typeof step === 'number' && step > 0 ? step : SNAP_MIN;
    return Math.round(Number(min) / s) * s;
  }

  /**
   * Left-pad a number to 2 digits.
   * @param {number} n
   * @returns {string}
   */
  function pad2(n) {
    return String(Math.floor(Math.abs(n))).padStart(2, '0');
  }

  /**
   * Check whether a string is a valid 'YYYY-MM-DD' key.
   * @param {unknown} dateKey
   * @returns {boolean}
   */
  function isValidDateKey(dateKey) {
    if (typeof dateKey !== 'string') return false;
    const m = DATE_KEY_RE.exec(dateKey);
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    const date = new Date(y, mo - 1, d, 12, 0, 0);
    return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
  }

  /**
   * Convert a Date to a local 'YYYY-MM-DD' key (never UTC-based).
   * @param {Date} date
   * @returns {string}
   */
  function toDateKey(date) {
    const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /**
   * Parse a 'YYYY-MM-DD' key into a local Date at noon (avoids DST edge cases).
   * Falls back to today at noon for invalid input.
   * @param {string} dateKey
   * @returns {Date}
   */
  function parseDateKey(dateKey) {
    const m = typeof dateKey === 'string' ? DATE_KEY_RE.exec(dateKey) : null;
    if (!m) {
      const now = new Date();
      return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
    }
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  }

  /**
   * Today's local date key.
   * @returns {string}
   */
  function getTodayKey() {
    return toDateKey(new Date());
  }

  /**
   * Shift a date key by a number of days.
   * @param {string} dateKey
   * @param {number} deltaDays
   * @returns {string}
   */
  function addDays(dateKey, deltaDays) {
    const d = parseDateKey(dateKey);
    d.setDate(d.getDate() + Math.round(Number(deltaDays) || 0));
    return toDateKey(d);
  }

  /**
   * Whole-day difference (b - a) between two date keys.
   * @param {string} a
   * @param {string} b
   * @returns {number}
   */
  function diffDays(a, b) {
    const da = parseDateKey(a);
    const db = parseDateKey(b);
    return Math.round((db.getTime() - da.getTime()) / 86400000);
  }

  /**
   * Format a date key in Vietnamese, e.g. 'Thứ Ba, 24 tháng 11, 2026'.
   * @param {string} dateKey
   * @returns {string}
   */
  function formatFullDateVi(dateKey) {
    const d = parseDateKey(dateKey);
    return WEEKDAYS_VI[d.getDay()] + ', ' + d.getDate() + ' tháng ' + (d.getMonth() + 1) + ', ' + d.getFullYear();
  }

  /**
   * Format a month title in Vietnamese, e.g. 'Tháng 11, 2026'.
   * @param {number} year
   * @param {number} monthIndex0 0-based month index
   * @returns {string}
   */
  function formatMonthYearVi(year, monthIndex0) {
    const d = new Date(Number(year), Number(monthIndex0), 1, 12, 0, 0);
    return 'Tháng ' + (d.getMonth() + 1) + ', ' + d.getFullYear();
  }

  /**
   * Relative label for a date key compared to today.
   * @param {string} dateKey
   * @returns {'Hôm nay'|'Hôm qua'|'Ngày mai'|''}
   */
  function getRelativeDayLabelVi(dateKey) {
    const today = getTodayKey();
    if (dateKey === today) return 'Hôm nay';
    if (dateKey === addDays(today, -1)) return 'Hôm qua';
    if (dateKey === addDays(today, 1)) return 'Ngày mai';
    return '';
  }

  /**
   * Minutes since local midnight for "now".
   * @returns {number}
   */
  function getNowMinutes() {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  }

  /**
   * Format minutes-from-midnight as 'HH:MM' (1440 -> '24:00').
   * @param {number} min
   * @returns {string}
   */
  function minutesToTime(min) {
    const m = Math.round(clamp(min, 0, 1440));
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  }

  /**
   * Format minutes for an <input type="time"> value (>= 1440 -> '23:59').
   * @param {number} min
   * @returns {string}
   */
  function minutesToInputTime(min) {
    const m = Math.round(clamp(min, 0, 1440));
    if (m >= 1440) return '23:59';
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  }

  /**
   * Parse an 'HH:MM' string to minutes. '23:59' and '24:00' map to 1440.
   * @param {string} str
   * @returns {number} minutes, or NaN when invalid
   */
  function inputTimeToMinutes(str) {
    if (typeof str !== 'string') return NaN;
    const m = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*$/.exec(str);
    if (!m) return NaN;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (mi > 59 || h > 24) return NaN;
    if (h === 24) return mi === 0 ? 1440 : NaN;
    if (h === 23 && mi === 59) return 1440;
    return h * 60 + mi;
  }

  /**
   * Compact Vietnamese duration: '1g 30p', '45p', '2g', '0p'.
   * @param {number} mins
   * @returns {string}
   */
  function formatDurationVi(mins) {
    const total = Math.round(Number(mins) || 0);
    if (total <= 0) return '0p';
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (h === 0) return m + 'p';
    if (m === 0) return h + 'g';
    return h + 'g ' + m + 'p';
  }

  /**
   * Format milliseconds as a countdown clock 'MM:SS' (minutes may exceed 59).
   * @param {number} ms
   * @returns {string}
   */
  function formatTimerClock(ms) {
    const totalSec = Math.ceil(Math.max(0, Number(ms) || 0) / 1000);
    return pad2(Math.floor(totalSec / 60)) + ':' + pad2(totalSec % 60);
  }

  /**
   * Escape a value for safe HTML insertion.
   * @param {unknown} str
   * @returns {string}
   */
  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Deep clone plain JSON-compatible data.
   * @template T
   * @param {T} value
   * @returns {T}
   */
  function deepClone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  /**
   * Debounce a function.
   * @template {(...args: never[]) => void} F
   * @param {F} fn
   * @param {number} waitMs
   * @returns {F}
   */
  function debounce(fn, waitMs) {
    /** @type {number|undefined} */
    let timer;
    return /** @type {F} */ (function () {
      const args = arguments;
      const ctx = this;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fn.apply(ctx, args);
      }, waitMs);
    });
  }

  /**
   * Check whether a value is a known color token.
   * @param {unknown} color
   * @returns {boolean}
   */
  function isValidColor(color) {
    return typeof color === 'string' && COLORS.indexOf(color) !== -1;
  }

  StudyPlan.Utils = Object.freeze({
    START_MIN: START_MIN,
    END_MIN: END_MIN,
    SNAP_MIN: SNAP_MIN,
    MIN_DURATION: MIN_DURATION,
    HOUR_HEIGHT: HOUR_HEIGHT,
    COLORS: COLORS,
    WEEKDAYS_VI: WEEKDAYS_VI,
    uid: uid,
    clamp: clamp,
    snapMinutes: snapMinutes,
    pad2: pad2,
    isValidDateKey: isValidDateKey,
    toDateKey: toDateKey,
    parseDateKey: parseDateKey,
    getTodayKey: getTodayKey,
    addDays: addDays,
    diffDays: diffDays,
    formatFullDateVi: formatFullDateVi,
    formatMonthYearVi: formatMonthYearVi,
    getRelativeDayLabelVi: getRelativeDayLabelVi,
    getNowMinutes: getNowMinutes,
    minutesToTime: minutesToTime,
    minutesToInputTime: minutesToInputTime,
    inputTimeToMinutes: inputTimeToMinutes,
    formatDurationVi: formatDurationVi,
    formatTimerClock: formatTimerClock,
    escapeHtml: escapeHtml,
    deepClone: deepClone,
    debounce: debounce,
    isValidColor: isValidColor
  });
})(window);
