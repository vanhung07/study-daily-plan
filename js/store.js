/**
 * StudyPlan — Store module.
 * Single source of truth for subjects, daily plans and study blocks, persisted to localStorage.
 * Exposed as window.StudyPlan.Store (classic script, works on file://).
 */
(function (global) {
  'use strict';

  const StudyPlan = (global.StudyPlan = global.StudyPlan || {});
  const Utils = StudyPlan.Utils;

  const STORAGE_KEY = 'daily_study_plan_v1';
  const USER_EDITED_KEY = STORAGE_KEY + '_user_edited';
  const STATE_VERSION = 1;
  const PRIORITIES = ['low', 'medium', 'high'];
  const MAX_STREAK_LOOKBACK = 3660;

  /**
   * @typedef {'blue'|'purple'|'emerald'|'amber'|'rose'|'cyan'|'orange'|'slate'} ColorToken
   * @typedef {'low'|'medium'|'high'} Priority
   * @typedef {'light'|'dark'} Theme
   *
   * @typedef {Object} Subject
   * @property {string} id
   * @property {string} name
   * @property {ColorToken} color
   *
   * @typedef {Object} SubTask
   * @property {string} id
   * @property {string} text
   * @property {boolean} done
   *
   * @typedef {Object} StudyBlock
   * @property {string} id
   * @property {string} title
   * @property {string|null} subjectId
   * @property {number} startMin Minutes from local midnight (300..1425)
   * @property {number} endMin Minutes from local midnight (startMin+15..1440)
   * @property {Priority} priority
   * @property {string} notes
   * @property {SubTask[]} subtasks
   * @property {number} focusedMin Minutes actually focused via the timer
   * @property {boolean} completed
   *
   * @typedef {Object} DayPlan
   * @property {string} focus
   * @property {StudyBlock[]} blocks
   *
   * @typedef {Object} AppState
   * @property {1} version
   * @property {Theme} theme
   * @property {Subject[]} subjects
   * @property {Record<string, DayPlan>} days
   *
   * @typedef {Object} BlockInput
   * @property {string} [id]
   * @property {string} [title]
   * @property {string|null} [subjectId]
   * @property {number} [startMin]
   * @property {number} [endMin]
   * @property {Priority} [priority]
   * @property {string} [notes]
   * @property {Array<Partial<SubTask>>} [subtasks]
   * @property {number} [focusedMin]
   * @property {boolean} [completed]
   *
   * @typedef {Object} DayStats
   * @property {number} plannedMin
   * @property {number} completedMin
   * @property {number} focusedMin
   * @property {number} totalCount
   * @property {number} completedCount
   * @property {number} percent 0..100
   *
   * @typedef {Object} ImportPreview
   * @property {boolean} ok
   * @property {string} [error]
   * @property {number} [dayCount]
   * @property {number} [blockCount]
   * @property {number} [subjectCount]
   *
   * @typedef {Object} ImportResult
   * @property {boolean} ok
   * @property {string} [error]
   * @property {number} [importedDays]
   * @property {number} [importedBlocks]
   *
   * @typedef {(state: AppState, reason: string) => void} StoreListener
   */

  /** @type {AppState} */
  let state = createEmptyState('light');
  /** @type {Set<StoreListener>} */
  const listeners = new Set();
  let initialized = false;
  /** @type {string|null} */
  let lastWrittenRaw = null;

  // ---------------------------------------------------------------------------
  // Sanitizers
  // ---------------------------------------------------------------------------

  /**
   * @param {Theme} theme
   * @returns {AppState}
   */
  function createEmptyState(theme) {
    return { version: STATE_VERSION, theme: theme === 'dark' ? 'dark' : 'light', subjects: [], days: {} };
  }

  /**
   * @param {unknown} v
   * @returns {v is Record<string, unknown>}
   */
  function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  /**
   * @param {unknown} v
   * @param {number} maxLen
   * @returns {string}
   */
  function cleanText(v, maxLen) {
    if (typeof v !== 'string') return '';
    return v.slice(0, maxLen);
  }

  /**
   * @param {unknown} v
   * @returns {number}
   */
  function nonNegativeInt(v) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * @param {unknown} raw
   * @returns {Subject|null}
   */
  function sanitizeSubject(raw) {
    if (!isPlainObject(raw)) return null;
    const name = cleanText(raw.name, 60).trim();
    if (!name) return null;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : Utils.uid('sub'),
      name: name,
      color: /** @type {ColorToken} */ (Utils.isValidColor(raw.color) ? raw.color : 'slate')
    };
  }

  /**
   * @param {unknown} raw
   * @param {boolean} keepId
   * @returns {SubTask|null}
   */
  function sanitizeSubtask(raw, keepId) {
    if (!isPlainObject(raw)) return null;
    const text = cleanText(raw.text, 200).trim();
    if (!text) return null;
    return {
      id: keepId && typeof raw.id === 'string' && raw.id ? raw.id : Utils.uid('st'),
      text: text,
      done: raw.done === true
    };
  }

  /**
   * Normalize start/end minutes into the valid timeline window.
   * @param {unknown} startRaw
   * @param {unknown} endRaw
   * @returns {{ startMin: number, endMin: number }}
   */
  function sanitizeRange(startRaw, endRaw) {
    let start = Math.round(Number(startRaw));
    if (!Number.isFinite(start)) start = 8 * 60;
    start = Utils.clamp(start, Utils.START_MIN, Utils.END_MIN - Utils.MIN_DURATION);
    let end = Math.round(Number(endRaw));
    if (!Number.isFinite(end)) end = start + 60;
    end = Utils.clamp(end, start + Utils.MIN_DURATION, Utils.END_MIN);
    return { startMin: start, endMin: end };
  }

  /**
   * Build a fully valid StudyBlock from arbitrary input.
   * @param {unknown} raw
   * @param {{ keepId?: boolean }} [opts]
   * @returns {StudyBlock}
   */
  function sanitizeBlock(raw, opts) {
    const src = isPlainObject(raw) ? raw : {};
    const keepId = !!(opts && opts.keepId);
    const range = sanitizeRange(src.startMin, src.endMin);
    const subtasks = Array.isArray(src.subtasks)
      ? /** @type {SubTask[]} */ (src.subtasks.map((s) => sanitizeSubtask(s, true)).filter(Boolean))
      : [];
    const title = cleanText(src.title, 120).trim();
    return {
      id: keepId && typeof src.id === 'string' && src.id ? src.id : Utils.uid('blk'),
      title: title || 'Khung giờ học',
      subjectId: typeof src.subjectId === 'string' && src.subjectId ? src.subjectId : null,
      startMin: range.startMin,
      endMin: range.endMin,
      priority: /** @type {Priority} */ (PRIORITIES.indexOf(/** @type {string} */ (src.priority)) !== -1 ? src.priority : 'medium'),
      notes: cleanText(src.notes, 4000),
      subtasks: subtasks,
      focusedMin: nonNegativeInt(src.focusedMin),
      completed: src.completed === true
    };
  }

  /**
   * @param {unknown} raw
   * @returns {DayPlan}
   */
  function sanitizeDay(raw) {
    const src = isPlainObject(raw) ? raw : {};
    const seen = new Set();
    /** @type {StudyBlock[]} */
    const blocks = [];
    if (Array.isArray(src.blocks)) {
      src.blocks.forEach((b) => {
        const block = sanitizeBlock(b, { keepId: true });
        if (seen.has(block.id)) block.id = Utils.uid('blk');
        seen.add(block.id);
        blocks.push(block);
      });
    }
    return { focus: cleanText(src.focus, 500), blocks: blocks };
  }

  /**
   * Validate and normalize a full AppState from unknown data.
   * @param {unknown} raw
   * @param {Theme} fallbackTheme
   * @returns {AppState}
   */
  function sanitizeState(raw, fallbackTheme) {
    const src = isPlainObject(raw) ? raw : {};
    const result = createEmptyState(src.theme === 'dark' || src.theme === 'light' ? src.theme : fallbackTheme);
    const ids = new Set();
    if (Array.isArray(src.subjects)) {
      src.subjects.forEach((s) => {
        const subj = sanitizeSubject(s);
        if (subj && !ids.has(subj.id)) {
          ids.add(subj.id);
          result.subjects.push(subj);
        }
      });
    }
    if (isPlainObject(src.days)) {
      Object.keys(src.days).forEach((key) => {
        if (!Utils.isValidDateKey(key)) return;
        const day = sanitizeDay(src.days[key]);
        day.blocks.forEach((b) => {
          if (b.subjectId && !ids.has(b.subjectId)) b.subjectId = null;
        });
        if (day.blocks.length > 0 || day.focus) result.days[key] = day;
      });
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  /** @returns {Theme} */
  function detectPreferredTheme() {
    try {
      if (global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    } catch (e) {
      /* ignore */
    }
    return 'light';
  }

  /**
   * Build first-visit demo data.
   * @param {Theme} theme
   * @returns {AppState}
   */
  function createSeedState(theme) {
    const today = Utils.getTodayKey();
    const sMath = { id: Utils.uid('sub'), name: 'Toán & Thuật toán', color: /** @type {ColorToken} */ ('blue') };
    const sEng = { id: Utils.uid('sub'), name: 'Tiếng Anh', color: /** @type {ColorToken} */ ('purple') };
    const sMajor = { id: Utils.uid('sub'), name: 'Chuyên ngành', color: /** @type {ColorToken} */ ('emerald') };
    const sReview = { id: Utils.uid('sub'), name: 'Ôn tập & Đọc sách', color: /** @type {ColorToken} */ ('amber') };

    /**
     * @param {string[]} texts
     * @param {number} doneCount
     * @returns {SubTask[]}
     */
    const makeSubtasks = (texts, doneCount) =>
      texts.map((text, i) => ({ id: Utils.uid('st'), text: text, done: i < doneCount }));

    /** @type {StudyBlock[]} */
    const blocks = [
      {
        id: Utils.uid('blk'),
        title: 'Giải tích: Ôn chương Đạo hàm',
        subjectId: sMath.id,
        startMin: 7 * 60 + 30,
        endMin: 9 * 60,
        priority: 'high',
        notes: 'Tập trung vào quy tắc đạo hàm hàm hợp và bài tập ứng dụng.',
        subtasks: makeSubtasks(['Xem lại lý thuyết đạo hàm', 'Làm 10 bài tập SGK', 'Ghi lại các lỗi sai'], 3),
        focusedMin: 75,
        completed: true
      },
      {
        id: Utils.uid('blk'),
        title: 'IELTS Reading: Luyện 2 passage',
        subjectId: sEng.id,
        startMin: 14 * 60,
        endMin: 15 * 60 + 30,
        priority: 'medium',
        notes: 'Bấm giờ 20 phút mỗi passage, chú ý dạng True/False/Not Given.',
        subtasks: makeSubtasks(['Passage 1: Skimming & Scanning', 'Passage 2: True/False/Not Given', 'Ghi chép 15 từ vựng mới'], 1),
        focusedMin: 0,
        completed: false
      },
      {
        id: Utils.uid('blk'),
        title: 'Cấu trúc dữ liệu: Cây nhị phân',
        subjectId: sMajor.id,
        startMin: 20 * 60,
        endMin: 21 * 60 + 30,
        priority: 'high',
        notes: 'Cài đặt duyệt cây theo thứ tự trước, giữa, sau.',
        subtasks: makeSubtasks(['Đọc slide bài giảng', 'Code lại Binary Search Tree'], 0),
        focusedMin: 0,
        completed: false
      }
    ];

    /** @type {AppState} */
    const seeded = createEmptyState(theme);
    seeded.subjects = [sMath, sEng, sMajor, sReview];
    seeded.days[today] = {
      focus: 'Hoàn thành chương Đạo hàm và luyện 2 bài IELTS Reading',
      blocks: blocks
    };
    return seeded;
  }

  /**
   * Persist the current state.
   * @returns {boolean} success
   */
  function save() {
    try {
      const raw = JSON.stringify(state);
      global.localStorage.setItem(STORAGE_KEY, raw);
      lastWrittenRaw = raw;
      return true;
    } catch (e) {
      console.warn('[StudyPlan.Store] Failed to save state:', e);
      return false;
    }
  }

  /**
   * Notify all subscribers.
   * @param {string} reason
   */
  function emit(reason) {
    const snapshot = Utils.deepClone(state);
    listeners.forEach((fn) => {
      try {
        fn(snapshot, reason);
      } catch (e) {
        console.error('[StudyPlan.Store] Listener error:', e);
      }
    });
  }

  /**
   * Mark that the user has actively modified local data (distinguishes real data from initial seed).
   */
  function markUserEdited() {
    try {
      global.localStorage.setItem(USER_EDITED_KEY, '1');
    } catch (e) {
      /* ignore storage errors */
    }
  }

  /**
   * Check whether local data has been modified by the user (or synced from cloud).
   * @returns {boolean}
   */
  function hasUserEdited() {
    try {
      return global.localStorage.getItem(USER_EDITED_KEY) === '1';
    } catch (e) {
      return true;
    }
  }

  /**
   * Save and notify in one step.
   * @param {string} reason
   */
  function commit(reason) {
    markUserEdited();
    save();
    emit(reason);
  }

  /**
   * Load state from localStorage (seeding on first visit).
   */
  function load() {
    /** @type {string|null} */
    let raw = null;
    try {
      raw = global.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      console.warn('[StudyPlan.Store] localStorage unavailable:', e);
    }
    if (raw === null) {
      state = createSeedState(detectPreferredTheme());
      save();
      return;
    }
    try {
      state = sanitizeState(JSON.parse(raw), detectPreferredTheme());
      lastWrittenRaw = raw;
    } catch (e) {
      console.warn('[StudyPlan.Store] Corrupted data, backing up and resetting:', e);
      try {
        global.localStorage.setItem(STORAGE_KEY + '_corrupt_backup', raw);
      } catch (err) {
        /* ignore */
      }
      state = createEmptyState(detectPreferredTheme());
      save();
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Get (optionally creating) the mutable day plan.
   * @param {string} dateKey
   * @param {boolean} create
   * @returns {DayPlan|null}
   */
  function getDayRef(dateKey, create) {
    if (!Utils.isValidDateKey(dateKey)) return null;
    if (!state.days[dateKey] && create) state.days[dateKey] = { focus: '', blocks: [] };
    return state.days[dateKey] || null;
  }

  /**
   * Remove empty day entries to keep storage lean.
   * @param {string} dateKey
   */
  function pruneDay(dateKey) {
    const day = state.days[dateKey];
    if (day && day.blocks.length === 0 && !day.focus) delete state.days[dateKey];
  }

  /**
   * @param {string} dateKey
   * @param {string} blockId
   * @returns {StudyBlock|null}
   */
  function findBlockRef(dateKey, blockId) {
    const day = getDayRef(dateKey, false);
    if (!day) return null;
    return day.blocks.find((b) => b.id === blockId) || null;
  }

  /**
   * @param {string|null|undefined} subjectId
   * @returns {string|null}
   */
  function validSubjectIdOrNull(subjectId) {
    if (typeof subjectId !== 'string' || !subjectId) return null;
    return state.subjects.some((s) => s.id === subjectId) ? subjectId : null;
  }

  /**
   * @param {StudyBlock[]} blocks
   * @returns {StudyBlock[]}
   */
  function sortBlocks(blocks) {
    return blocks.sort((a, b) => a.startMin - b.startMin || b.endMin - b.startMin - (a.endMin - a.startMin));
  }

  /**
   * @param {DayPlan|null} day
   * @returns {boolean}
   */
  function isDayActive(day) {
    if (!day) return false;
    return day.blocks.some((b) => b.completed || b.focusedMin > 0);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Initialize the store (idempotent). */
  function init() {
    if (initialized) return;
    initialized = true;
    load();
    // Keep multiple open tabs in sync.
    global.addEventListener('storage', (event) => {
      if (event.key !== STORAGE_KEY || event.newValue === null || event.newValue === lastWrittenRaw) return;
      try {
        state = sanitizeState(JSON.parse(event.newValue), state.theme);
        lastWrittenRaw = event.newValue;
        emit('external-sync');
      } catch (e) {
        /* ignore malformed external writes */
      }
    });
  }

  /**
   * Subscribe to state changes.
   * @param {StoreListener} fn
   * @returns {() => void} unsubscribe
   */
  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.add(fn);
    return function () {
      listeners.delete(fn);
    };
  }

  /** @returns {AppState} deep clone of the full state */
  function getState() {
    return Utils.deepClone(state);
  }

  /** @returns {Theme} */
  function getTheme() {
    return state.theme;
  }

  /**
   * @param {Theme} theme
   * @returns {Theme}
   */
  function setTheme(theme) {
    const next = theme === 'dark' ? 'dark' : 'light';
    if (state.theme !== next) {
      state.theme = next;
      commit('theme');
    }
    return next;
  }

  /** @returns {Subject[]} */
  function getSubjects() {
    return Utils.deepClone(state.subjects);
  }

  /**
   * @param {string|null|undefined} id
   * @returns {Subject|null}
   */
  function getSubjectById(id) {
    if (!id) return null;
    const s = state.subjects.find((x) => x.id === id);
    return s ? Utils.deepClone(s) : null;
  }

  /**
   * Resolve the display color of a block (subject color or 'slate' fallback).
   * @param {Partial<StudyBlock>|null|undefined} block
   * @returns {ColorToken}
   */
  function getBlockColor(block) {
    const s = block && block.subjectId ? state.subjects.find((x) => x.id === block.subjectId) : null;
    return s ? s.color : 'slate';
  }

  /**
   * Add a subject. Returns null for an empty name; returns the existing subject on duplicate name.
   * @param {string} name
   * @param {ColorToken} color
   * @returns {Subject|null}
   */
  function addSubject(name, color) {
    const clean = cleanText(name, 60).trim();
    if (!clean) return null;
    const existing = state.subjects.find((s) => s.name.toLowerCase() === clean.toLowerCase());
    if (existing) return Utils.deepClone(existing);
    /** @type {Subject} */
    const subject = { id: Utils.uid('sub'), name: clean, color: Utils.isValidColor(color) ? color : 'slate' };
    state.subjects.push(subject);
    commit('subject-add');
    return Utils.deepClone(subject);
  }

  /**
   * Delete a subject. Blocks using it keep existing with subjectId = null (slate style).
   * @param {string} id
   * @returns {{ subject: Subject, affectedBlocks: number }|null}
   */
  function deleteSubject(id) {
    const idx = state.subjects.findIndex((s) => s.id === id);
    if (idx === -1) return null;
    const removed = state.subjects.splice(idx, 1)[0];
    let affected = 0;
    Object.keys(state.days).forEach((key) => {
      state.days[key].blocks.forEach((b) => {
        if (b.subjectId === id) {
          b.subjectId = null;
          affected++;
        }
      });
    });
    commit('subject-delete');
    return { subject: Utils.deepClone(removed), affectedBlocks: affected };
  }

  /**
   * @param {string} dateKey
   * @returns {DayPlan} cloned plan, or an empty one
   */
  function getDay(dateKey) {
    const day = getDayRef(dateKey, false);
    if (!day) return { focus: '', blocks: [] };
    const clone = Utils.deepClone(day);
    sortBlocks(clone.blocks);
    return clone;
  }

  /**
   * @param {string} dateKey
   * @returns {boolean}
   */
  function hasBlocksOnDate(dateKey) {
    const day = state.days[dateKey];
    return !!day && day.blocks.length > 0;
  }

  /**
   * @param {string} dateKey
   * @param {string} focusText
   * @returns {string} saved focus text
   */
  function setDailyFocus(dateKey, focusText) {
    const text = cleanText(focusText, 500);
    const day = getDayRef(dateKey, !!text);
    if (!day) return '';
    if (day.focus === text) return text;
    day.focus = text;
    pruneDay(dateKey);
    commit('focus');
    return text;
  }

  /**
   * @param {string} dateKey
   * @param {string|null} [subjectFilterId=null]
   * @returns {StudyBlock[]} sorted clones
   */
  function getBlocks(dateKey, subjectFilterId) {
    const day = getDayRef(dateKey, false);
    if (!day) return [];
    let blocks = day.blocks;
    if (subjectFilterId) blocks = blocks.filter((b) => b.subjectId === subjectFilterId);
    return sortBlocks(Utils.deepClone(blocks));
  }

  /**
   * @param {string} dateKey
   * @param {string} blockId
   * @returns {StudyBlock|null}
   */
  function getBlockById(dateKey, blockId) {
    const b = findBlockRef(dateKey, blockId);
    return b ? Utils.deepClone(b) : null;
  }

  /**
   * Find which date currently holds a block ID (used by the timer to follow moved blocks).
   * @param {string} blockId
   * @returns {string|null}
   */
  function findBlockDateKey(blockId) {
    const keys = Object.keys(state.days);
    for (let i = 0; i < keys.length; i++) {
      if (state.days[keys[i]].blocks.some((b) => b.id === blockId)) return keys[i];
    }
    return null;
  }

  /**
   * @param {string} dateKey
   * @param {BlockInput} blockInput
   * @returns {StudyBlock|null}
   */
  function addBlock(dateKey, blockInput) {
    const day = getDayRef(dateKey, true);
    if (!day) return null;
    const block = sanitizeBlock(blockInput, { keepId: false });
    block.subjectId = validSubjectIdOrNull(block.subjectId);
    day.blocks.push(block);
    commit('block-add');
    return Utils.deepClone(block);
  }

  /**
   * @param {string} dateKey
   * @param {string} blockId
   * @param {BlockInput} patch
   * @returns {StudyBlock|null}
   */
  function updateBlock(dateKey, blockId, patch) {
    const day = getDayRef(dateKey, false);
    if (!day || !isPlainObject(patch)) return null;
    const idx = day.blocks.findIndex((b) => b.id === blockId);
    if (idx === -1) return null;
    // focusedMin is owned by the timer (addFocusedMinutes); never let a stale edit form overwrite it.
    const merged = Object.assign({}, day.blocks[idx], patch, { id: blockId, focusedMin: day.blocks[idx].focusedMin });
    const next = sanitizeBlock(merged, { keepId: true });
    next.subjectId = validSubjectIdOrNull(next.subjectId);
    day.blocks[idx] = next;
    commit('block-update');
    return Utils.deepClone(next);
  }

  /**
   * @param {string} dateKey
   * @param {string} blockId
   * @returns {StudyBlock|null} removed block
   */
  function deleteBlock(dateKey, blockId) {
    const day = getDayRef(dateKey, false);
    if (!day) return null;
    const idx = day.blocks.findIndex((b) => b.id === blockId);
    if (idx === -1) return null;
    const removed = day.blocks.splice(idx, 1)[0];
    pruneDay(dateKey);
    commit('block-delete');
    return Utils.deepClone(removed);
  }

  /**
   * Restore a previously removed block (undo). Replaces a block with the same ID if present.
   * @param {string} dateKey
   * @param {StudyBlock} blockObj
   * @returns {StudyBlock|null}
   */
  function restoreBlock(dateKey, blockObj) {
    const day = getDayRef(dateKey, true);
    if (!day || !isPlainObject(blockObj)) return null;
    const block = sanitizeBlock(blockObj, { keepId: true });
    block.subjectId = validSubjectIdOrNull(block.subjectId);
    const idx = day.blocks.findIndex((b) => b.id === block.id);
    if (idx === -1) day.blocks.push(block);
    else day.blocks[idx] = block;
    commit('block-restore');
    return Utils.deepClone(block);
  }

  /**
   * @param {string} dateKey
   * @param {string} blockId
   * @returns {StudyBlock|null}
   */
  function toggleBlockCompleted(dateKey, blockId) {
    const b = findBlockRef(dateKey, blockId);
    if (!b) return null;
    b.completed = !b.completed;
    commit('block-toggle');
    return Utils.deepClone(b);
  }

  /**
   * @param {string} dateKey
   * @param {string} blockId
   * @param {string} subtaskId
   * @returns {StudyBlock|null}
   */
  function toggleSubtask(dateKey, blockId, subtaskId) {
    const b = findBlockRef(dateKey, blockId);
    if (!b) return null;
    const st = b.subtasks.find((s) => s.id === subtaskId);
    if (!st) return null;
    st.done = !st.done;
    commit('subtask-toggle');
    return Utils.deepClone(b);
  }

  /**
   * Add positive whole focused minutes to a block.
   * @param {string} dateKey
   * @param {string} blockId
   * @param {number} deltaMin
   * @returns {StudyBlock|null}
   */
  function addFocusedMinutes(dateKey, blockId, deltaMin) {
    const delta = nonNegativeInt(deltaMin);
    const b = findBlockRef(dateKey, blockId);
    if (!b || delta <= 0) return b ? Utils.deepClone(b) : null;
    b.focusedMin = nonNegativeInt(b.focusedMin + delta);
    commit('focus-minutes');
    return Utils.deepClone(b);
  }

  /**
   * Copy yesterday's blocks into the target day as fresh, unfinished blocks.
   * @param {string} targetDateKey
   * @returns {{ copiedCount: number, blocks: StudyBlock[] }}
   */
  function copyFromYesterday(targetDateKey) {
    const sourceKey = Utils.addDays(targetDateKey, -1);
    const source = getDayRef(sourceKey, false);
    if (!source || source.blocks.length === 0 || !Utils.isValidDateKey(targetDateKey)) {
      return { copiedCount: 0, blocks: [] };
    }
    const day = /** @type {DayPlan} */ (getDayRef(targetDateKey, true));
    /** @type {StudyBlock[]} */
    const copies = sortBlocks(Utils.deepClone(source.blocks)).map((b) => {
      const copy = sanitizeBlock(b, { keepId: false });
      copy.completed = false;
      copy.focusedMin = 0;
      copy.subtasks = copy.subtasks.map((s) => ({ id: Utils.uid('st'), text: s.text, done: false }));
      copy.subjectId = validSubjectIdOrNull(copy.subjectId);
      return copy;
    });
    copies.forEach((c) => day.blocks.push(c));
    commit('copy-yesterday');
    return { copiedCount: copies.length, blocks: Utils.deepClone(copies) };
  }

  /**
   * Move a block to the next day (keeps subtasks & notes, resets completion).
   * @param {string} dateKey
   * @param {string} blockId
   * @returns {{ movedBlock: StudyBlock, fromDateKey: string, targetDateKey: string }|null}
   */
  function moveBlockToTomorrow(dateKey, blockId) {
    const day = getDayRef(dateKey, false);
    if (!day) return null;
    const idx = day.blocks.findIndex((b) => b.id === blockId);
    if (idx === -1) return null;
    const targetDateKey = Utils.addDays(dateKey, 1);
    const block = day.blocks.splice(idx, 1)[0];
    block.completed = false;
    const target = /** @type {DayPlan} */ (getDayRef(targetDateKey, true));
    if (target.blocks.some((b) => b.id === block.id)) block.id = Utils.uid('blk');
    target.blocks.push(block);
    pruneDay(dateKey);
    commit('block-move');
    return { movedBlock: Utils.deepClone(block), fromDateKey: dateKey, targetDateKey: targetDateKey };
  }

  /**
   * @param {string} dateKey
   * @returns {DayStats}
   */
  function getDayStats(dateKey) {
    const day = getDayRef(dateKey, false);
    /** @type {DayStats} */
    const stats = { plannedMin: 0, completedMin: 0, focusedMin: 0, totalCount: 0, completedCount: 0, percent: 0 };
    if (!day) return stats;
    day.blocks.forEach((b) => {
      const dur = b.endMin - b.startMin;
      stats.plannedMin += dur;
      stats.focusedMin += b.focusedMin;
      stats.totalCount++;
      if (b.completed) {
        stats.completedMin += dur;
        stats.completedCount++;
      }
    });
    stats.percent = stats.plannedMin > 0 ? Math.round((stats.completedMin / stats.plannedMin) * 100) : 0;
    return stats;
  }

  /**
   * Consecutive active days ending today (or yesterday, if today has no activity yet).
   * @returns {number}
   */
  function getStudyStreak() {
    let key = Utils.getTodayKey();
    if (!isDayActive(state.days[key] || null)) key = Utils.addDays(key, -1);
    let streak = 0;
    while (streak < MAX_STREAK_LOOKBACK && isDayActive(state.days[key] || null)) {
      streak++;
      key = Utils.addDays(key, -1);
    }
    return streak;
  }

  /** @returns {string} */
  function exportJSONString() {
    return JSON.stringify(state, null, 2);
  }

  /**
   * Parse & validate raw import text.
   * @param {string} rawText
   * @returns {{ ok: true, data: Record<string, unknown> } | { ok: false, error: string }}
   */
  function parseImport(rawText) {
    if (typeof rawText !== 'string' || !rawText.trim()) return { ok: false, error: 'Tệp trống hoặc không đọc được.' };
    /** @type {unknown} */
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      return { ok: false, error: 'Tệp không phải JSON hợp lệ.' };
    }
    if (!isPlainObject(parsed)) return { ok: false, error: 'Cấu trúc dữ liệu không hợp lệ.' };
    const hasDays = isPlainObject(parsed.days);
    const hasSubjects = Array.isArray(parsed.subjects);
    if (!hasDays && !hasSubjects) {
      return { ok: false, error: 'Không tìm thấy dữ liệu kế hoạch học tập (thiếu "days" hoặc "subjects").' };
    }
    if (parsed.days !== undefined && !hasDays) return { ok: false, error: 'Trường "days" không đúng định dạng.' };
    if (parsed.subjects !== undefined && !hasSubjects) return { ok: false, error: 'Trường "subjects" không đúng định dạng.' };
    if (typeof parsed.version === 'number' && parsed.version > STATE_VERSION) {
      return { ok: false, error: 'Tệp được tạo từ phiên bản mới hơn, không thể nhập.' };
    }
    return { ok: true, data: parsed };
  }

  /**
   * Validate import text without mutating state.
   * @param {string} rawText
   * @returns {ImportPreview}
   */
  function previewImportJSON(rawText) {
    const res = parseImport(rawText);
    if (!res.ok) return { ok: false, error: res.error };
    const clean = sanitizeState(res.data, state.theme);
    const keys = Object.keys(clean.days);
    const blockCount = keys.reduce((sum, k) => sum + clean.days[k].blocks.length, 0);
    if (keys.length === 0 && clean.subjects.length === 0) {
      return { ok: false, error: 'Tệp không chứa môn học hay khung giờ học nào.' };
    }
    return { ok: true, dayCount: keys.length, blockCount: blockCount, subjectCount: clean.subjects.length };
  }

  /**
   * Import state from JSON text.
   * @param {string} rawText
   * @param {'merge'|'replace'} [mode='merge']
   * @returns {ImportResult}
   */
  function importJSONString(rawText, mode) {
    const res = parseImport(rawText);
    if (!res.ok) return { ok: false, error: res.error };
    const incoming = sanitizeState(res.data, state.theme);
    const dayKeys = Object.keys(incoming.days);
    const blockCount = dayKeys.reduce((sum, k) => sum + incoming.days[k].blocks.length, 0);

    if (mode === 'replace') {
      state = incoming;
      commit('import-replace');
      return { ok: true, importedDays: dayKeys.length, importedBlocks: blockCount };
    }

    // Merge subjects by ID, then by case-insensitive name; remap block subject IDs accordingly.
    /** @type {Record<string, string>} */
    const subjectIdMap = {};
    incoming.subjects.forEach((s) => {
      const byId = state.subjects.find((x) => x.id === s.id);
      if (byId) {
        subjectIdMap[s.id] = byId.id;
        return;
      }
      const byName = state.subjects.find((x) => x.name.toLowerCase() === s.name.toLowerCase());
      if (byName) {
        subjectIdMap[s.id] = byName.id;
        return;
      }
      state.subjects.push(s);
      subjectIdMap[s.id] = s.id;
    });

    // Merge days by key and blocks by ID (imported block wins on ID conflict).
    dayKeys.forEach((key) => {
      const inDay = incoming.days[key];
      inDay.blocks.forEach((b) => {
        b.subjectId = b.subjectId ? subjectIdMap[b.subjectId] || null : null;
      });
      const existing = state.days[key];
      if (!existing) {
        state.days[key] = inDay;
        return;
      }
      if (!existing.focus && inDay.focus) existing.focus = inDay.focus;
      inDay.blocks.forEach((b) => {
        const idx = existing.blocks.findIndex((x) => x.id === b.id);
        if (idx === -1) existing.blocks.push(b);
        else existing.blocks[idx] = b;
      });
    });

    commit('import-merge');
    return { ok: true, importedDays: dayKeys.length, importedBlocks: blockCount };
  }

  /**
   * Replace local state with sanitized state received from cloud sync.
   * Does not trigger a cloud re-upload because listeners see reason === 'cloud-sync'.
   * @param {unknown} rawData
   * @returns {boolean}
   */
  function applyCloudState(rawData) {
    if (!isPlainObject(rawData)) return false;
    state = sanitizeState(rawData, state.theme);
    markUserEdited();
    save();
    emit('cloud-sync');
    return true;
  }

  /**
   * Merge sanitized cloud state into current local state without losing local items.
   * Emits 'cloud-sync' so callers can explicitly push the merged result back up.
   * @param {unknown} rawData
   * @returns {boolean}
   */
  function mergeCloudState(rawData) {
    if (!isPlainObject(rawData)) return false;
    const incoming = sanitizeState(rawData, state.theme);
    /** @type {Record<string, string>} */
    const subjectIdMap = {};
    incoming.subjects.forEach((s) => {
      const byId = state.subjects.find((x) => x.id === s.id);
      if (byId) {
        subjectIdMap[s.id] = byId.id;
        return;
      }
      const byName = state.subjects.find((x) => x.name.toLowerCase() === s.name.toLowerCase());
      if (byName) {
        subjectIdMap[s.id] = byName.id;
        return;
      }
      state.subjects.push(s);
      subjectIdMap[s.id] = s.id;
    });

    Object.keys(incoming.days).forEach((key) => {
      const inDay = incoming.days[key];
      inDay.blocks.forEach((b) => {
        b.subjectId = b.subjectId ? subjectIdMap[b.subjectId] || null : null;
      });
      const existing = state.days[key];
      if (!existing) {
        state.days[key] = inDay;
        return;
      }
      if (!existing.focus && inDay.focus) existing.focus = inDay.focus;
      inDay.blocks.forEach((b) => {
        const idx = existing.blocks.findIndex((x) => x.id === b.id);
        if (idx === -1) existing.blocks.push(b);
        else existing.blocks[idx] = b;
      });
    });

    markUserEdited();
    save();
    emit('cloud-sync');
    return true;
  }

  StudyPlan.Store = Object.freeze({
    STORAGE_KEY: STORAGE_KEY,
    init: init,
    subscribe: subscribe,
    getState: getState,
    getTheme: getTheme,
    setTheme: setTheme,
    getSubjects: getSubjects,
    getSubjectById: getSubjectById,
    getBlockColor: getBlockColor,
    addSubject: addSubject,
    deleteSubject: deleteSubject,
    getDay: getDay,
    hasBlocksOnDate: hasBlocksOnDate,
    setDailyFocus: setDailyFocus,
    getBlocks: getBlocks,
    getBlockById: getBlockById,
    findBlockDateKey: findBlockDateKey,
    addBlock: addBlock,
    updateBlock: updateBlock,
    deleteBlock: deleteBlock,
    restoreBlock: restoreBlock,
    toggleBlockCompleted: toggleBlockCompleted,
    toggleSubtask: toggleSubtask,
    addFocusedMinutes: addFocusedMinutes,
    copyFromYesterday: copyFromYesterday,
    moveBlockToTomorrow: moveBlockToTomorrow,
    getDayStats: getDayStats,
    getStudyStreak: getStudyStreak,
    exportJSONString: exportJSONString,
    previewImportJSON: previewImportJSON,
    importJSONString: importJSONString,
    hasUserEdited: hasUserEdited,
    applyCloudState: applyCloudState,
    mergeCloudState: mergeCloudState
  });
})(window);
