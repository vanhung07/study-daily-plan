/**
 * StudyPlan — Cloud Sync module (Firebase Auth + Cloud Firestore).
 * Provides real-time two-way synchronization across desktop and mobile devices
 * while keeping localStorage as the instant offline-first cache.
 * Attached to window.StudyPlan.Sync as a classic IIFE (no ES modules).
 */
(function (global) {
  'use strict';

  var StudyPlan = (global.StudyPlan = global.StudyPlan || {});

  var RUNTIME_CONFIG_KEY = 'daily_study_plan_firebase_config_v1';
  var COLLECTION_NAME = 'studyPlans';
  var PUSH_DEBOUNCE_MS = 450;
  var CLIENT_ID = 'cli_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);

  /** @typedef {'unconfigured'|'signed-out'|'connecting'|'syncing'|'synced'|'offline'|'error'} SyncState */

  var firebaseApp = null;
  var auth = null;
  var db = null;
  var unsubscribeSnapshot = null;
  var unsubscribeAuth = null;
  var pushTimer = 0;
  var initialized = false;
  var isApplyingRemote = false;

  var status = {
    configured: false,
    /** @type {'file'|'local'|'none'} */
    configSource: 'none',
    sdkReady: false,
    /** @type {{ uid: string, displayName: string, email: string, photoURL: string }|null} */
    user: null,
    /** @type {SyncState} */
    syncState: 'unconfigured',
    /** @type {number|null} */
    lastSyncedAt: null,
    /** @type {string} */
    errorMessage: ''
  };

  /** @type {Set<function(typeof status): void>} */
  var listeners = new Set();

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function notify() {
    var snapshot = {
      configured: status.configured,
      configSource: status.configSource,
      sdkReady: status.sdkReady,
      user: status.user ? Object.assign({}, status.user) : null,
      syncState: status.syncState,
      lastSyncedAt: status.lastSyncedAt,
      errorMessage: status.errorMessage
    };
    listeners.forEach(function (fn) {
      try {
        fn(snapshot);
      } catch (e) {
        console.error('[StudyPlan.Sync] Listener error:', e);
      }
    });
  }

  function showToast(message) {
    if (StudyPlan.UI && typeof StudyPlan.UI.showToast === 'function') {
      StudyPlan.UI.showToast(message);
    }
  }

  /**
   * Validate minimal Firebase config fields.
   * @param {unknown} cfg
   * @returns {Record<string, string>|null}
   */
  function normalizeConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return null;
    var obj = /** @type {Record<string, unknown>} */ (cfg);
    var apiKey = typeof obj.apiKey === 'string' ? obj.apiKey.trim() : '';
    var authDomain = typeof obj.authDomain === 'string' ? obj.authDomain.trim() : '';
    var projectId = typeof obj.projectId === 'string' ? obj.projectId.trim() : '';
    if (!apiKey || !authDomain || !projectId) return null;

    var clean = {
      apiKey: apiKey,
      authDomain: authDomain,
      projectId: projectId
    };
    if (typeof obj.storageBucket === 'string' && obj.storageBucket.trim()) {
      clean.storageBucket = obj.storageBucket.trim();
    }
    if (typeof obj.messagingSenderId === 'string' && obj.messagingSenderId.trim()) {
      clean.messagingSenderId = obj.messagingSenderId.trim();
    }
    if (typeof obj.appId === 'string' && obj.appId.trim()) {
      clean.appId = obj.appId.trim();
    }
    return clean;
  }

  /**
   * Parse Firebase config pasted as either JSON or the JS object snippet from Firebase Console.
   * @param {string} rawText
   * @returns {Record<string, string>|null}
   */
  function parseConfigInput(rawText) {
    if (typeof rawText !== 'string' || !rawText.trim()) return null;
    var trimmed = rawText.trim();

    // Try strict JSON first
    try {
      var parsed = JSON.parse(trimmed);
      var valid = normalizeConfig(parsed);
      if (valid) return valid;
    } catch (e) {
      /* fallback to key-value extraction */
    }

    // Extract standard Firebase keys from JS snippet (const firebaseConfig = { apiKey: "...", ... })
    var keys = ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'];
    /** @type {Record<string, string>} */
    var extracted = {};
    keys.forEach(function (key) {
      var regex = new RegExp('["\']?' + key + '["\']?\\s*:\\s*["\']([^"\']+)["\']');
      var match = trimmed.match(regex);
      if (match && match[1]) {
        extracted[key] = match[1].trim();
      }
    });
    return normalizeConfig(extracted);
  }

  /**
   * Resolve active Firebase config (file config takes precedence, then localStorage override).
   * @returns {{ config: Record<string, string>|null, source: 'file'|'local'|'none' }}
   */
  function resolveConfig() {
    var fromFile = normalizeConfig(StudyPlan.FIREBASE_CONFIG);
    if (fromFile) {
      return { config: fromFile, source: 'file' };
    }
    try {
      var raw = global.localStorage.getItem(RUNTIME_CONFIG_KEY);
      if (raw) {
        var fromLocal = normalizeConfig(JSON.parse(raw));
        if (fromLocal) return { config: fromLocal, source: 'local' };
      }
    } catch (e) {
      /* ignore storage errors */
    }
    return { config: null, source: 'none' };
  }

  function mapAuthError(err) {
    var code = err && err.code ? String(err.code) : '';
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      return 'Bạn đã đóng cửa sổ đăng nhập Google.';
    }
    if (code === 'auth/unauthorized-domain') {
      return 'Tên miền này chưa được thêm vào Authorized Domains trong Firebase Authentication.';
    }
    if (code === 'auth/network-request-failed') {
      return 'Không có kết nối mạng. Vui lòng thử lại khi có Internet.';
    }
    if (code === 'auth/invalid-api-key' || code === 'auth/configuration-not-found') {
      return 'Cấu hình Firebase chưa chính xác hoặc chưa bật đăng nhập Google.';
    }
    if (code === 'permission-denied') {
      return 'Chưa cấp quyền đọc/ghi trong Firestore Rules cho tài khoản này.';
    }
    return 'Lỗi đồng bộ: ' + (err && err.message ? err.message : 'Không xác định');
  }

  // ---------------------------------------------------------------------------
  // Firestore Sync Engine
  // ---------------------------------------------------------------------------

  function getDocRef(uid) {
    if (!db || !uid) return null;
    return db.collection(COLLECTION_NAME).doc(uid);
  }

  function detachFirestoreListener() {
    if (typeof unsubscribeSnapshot === 'function') {
      unsubscribeSnapshot();
      unsubscribeSnapshot = null;
    }
    if (pushTimer) {
      global.clearTimeout(pushTimer);
      pushTimer = 0;
    }
  }

  /**
   * Push current Store state to Firestore.
   * @param {boolean} [showFeedback]
   * @returns {Promise<boolean>}
   */
  function pushLocalState(showFeedback) {
    if (!status.user || !db || !StudyPlan.Store) return Promise.resolve(false);
    if (global.navigator && global.navigator.onLine === false) {
      status.syncState = 'offline';
      notify();
      return Promise.resolve(false);
    }

    var ref = getDocRef(status.user.uid);
    if (!ref) return Promise.resolve(false);

    status.syncState = 'syncing';
    status.errorMessage = '';
    notify();

    var stateObj = StudyPlan.Store.getState();
    var payload = {
      stateJson: JSON.stringify(stateObj),
      updatedAtMs: Date.now(),
      clientId: CLIENT_ID,
      updatedAt: global.firebase.firestore.FieldValue.serverTimestamp()
    };

    return ref
      .set(payload, { merge: true })
      .then(function () {
        status.syncState = 'synced';
        status.lastSyncedAt = Date.now();
        status.errorMessage = '';
        notify();
        if (showFeedback) {
          showToast('Đã đồng bộ dữ liệu lên đám mây.');
        }
        return true;
      })
      .catch(function (err) {
        console.error('[StudyPlan.Sync] Push failed:', err);
        status.syncState = 'error';
        status.errorMessage = mapAuthError(err);
        notify();
        if (showFeedback) {
          showToast(status.errorMessage);
        }
        return false;
      });
  }

  /**
   * Apply remote state JSON into Store without echoing back to Firestore.
   * @param {string} stateJson
   * @param {'replace'|'merge'} mode
   * @returns {boolean}
   */
  function applyRemoteJson(stateJson, mode) {
    if (!stateJson || typeof stateJson !== 'string' || !StudyPlan.Store) return false;
    try {
      var parsed = JSON.parse(stateJson);
      var currentJson = JSON.stringify(StudyPlan.Store.getState());
      if (currentJson === stateJson) return false;

      isApplyingRemote = true;
      var changed = mode === 'merge'
        ? StudyPlan.Store.mergeCloudState(parsed)
        : StudyPlan.Store.applyCloudState(parsed);
      if (changed) {
        document.documentElement.setAttribute(
          'data-theme',
          StudyPlan.Store.getTheme() === 'dark' ? 'dark' : 'light'
        );
      }
      return changed;
    } catch (e) {
      console.warn('[StudyPlan.Sync] Failed to parse remote state:', e);
      return false;
    } finally {
      isApplyingRemote = false;
    }
  }

  /**
   * Perform initial sync on sign-in, then subscribe to real-time updates.
   * @param {string} uid
   */
  function startRealtimeSync(uid) {
    detachFirestoreListener();
    var ref = getDocRef(uid);
    if (!ref) return;

    status.syncState = 'connecting';
    status.errorMessage = '';
    notify();

    ref
      .get()
      .then(function (doc) {
        if (!status.user || status.user.uid !== uid) return;

        if (!doc.exists || !doc.data() || !doc.data().stateJson) {
          // First time this account syncs: upload current local state.
          return pushLocalState(false);
        }

        var remoteJson = doc.data().stateJson;
        var localEdited = StudyPlan.Store.hasUserEdited();
        var localJson = JSON.stringify(StudyPlan.Store.getState());

        if (!localEdited) {
          // Fresh device (still showing default seed): adopt cloud state cleanly.
          applyRemoteJson(remoteJson, 'replace');
          status.syncState = 'synced';
          status.lastSyncedAt = Date.now();
          notify();
          return;
        }

        if (localJson !== remoteJson) {
          // Both devices have real edits: merge safely and upload merged result so nothing is lost.
          applyRemoteJson(remoteJson, 'merge');
          return pushLocalState(false);
        }

        status.syncState = 'synced';
        status.lastSyncedAt = Date.now();
        notify();
      })
      .then(function () {
        if (!status.user || status.user.uid !== uid) return;
        // Listen for real-time updates from other devices.
        unsubscribeSnapshot = ref.onSnapshot(
          function (doc) {
            if (!doc.exists) return;
            var data = doc.data();
            if (!data || !data.stateJson) return;
            if (doc.metadata && doc.metadata.hasPendingWrites) return;
            if (data.clientId === CLIENT_ID) return;

            var changed = applyRemoteJson(data.stateJson, 'replace');
            status.syncState = 'synced';
            status.lastSyncedAt = Date.now();
            status.errorMessage = '';
            notify();
            if (changed) {
              showToast('Đã cập nhật dữ liệu mới từ thiết bị khác.');
            }
          },
          function (err) {
            console.error('[StudyPlan.Sync] Snapshot listener error:', err);
            status.syncState = 'error';
            status.errorMessage = mapAuthError(err);
            notify();
          }
        );
      })
      .catch(function (err) {
        console.error('[StudyPlan.Sync] Initial sync error:', err);
        status.syncState = 'error';
        status.errorMessage = mapAuthError(err);
        notify();
        showToast(status.errorMessage);
      });
  }

  function handleStoreChange(_snapshot, reason) {
    if (isApplyingRemote || reason === 'cloud-sync' || reason === 'external-sync') return;
    if (!status.user || !db) return;

    if (pushTimer) global.clearTimeout(pushTimer);
    pushTimer = global.setTimeout(function () {
      pushTimer = 0;
      pushLocalState(false);
    }, PUSH_DEBOUNCE_MS);
  }

  function handleAuthStateChange(fbUser) {
    if (fbUser) {
      status.user = {
        uid: fbUser.uid,
        displayName: fbUser.displayName || fbUser.email || 'Người dùng',
        email: fbUser.email || '',
        photoURL: fbUser.photoURL || ''
      };
      notify();
      startRealtimeSync(fbUser.uid);
    } else {
      detachFirestoreListener();
      status.user = null;
      status.syncState = status.configured ? 'signed-out' : 'unconfigured';
      status.errorMessage = '';
      notify();
    }
  }

  // ---------------------------------------------------------------------------
  // Firebase Initialization
  // ---------------------------------------------------------------------------

  function setupFirebase() {
    detachFirestoreListener();
    if (typeof unsubscribeAuth === 'function') {
      unsubscribeAuth();
      unsubscribeAuth = null;
    }

    var resolved = resolveConfig();
    status.configured = !!resolved.config;
    status.configSource = resolved.source;
    status.sdkReady = !!(global.firebase && global.firebase.auth && global.firebase.firestore);

    if (!resolved.config) {
      status.syncState = 'unconfigured';
      status.user = null;
      status.errorMessage = '';
      notify();
      return false;
    }

    if (!status.sdkReady) {
      status.syncState = 'offline';
      status.errorMessage = 'Không tải được thư viện Firebase (đang ngoại tuyến).';
      notify();
      return false;
    }

    try {
      var existingApps = global.firebase.apps || [];
      if (existingApps.length > 0) {
        firebaseApp = existingApps[0];
      } else {
        firebaseApp = global.firebase.initializeApp(resolved.config);
      }
      auth = firebaseApp.auth();
      db = firebaseApp.firestore();

      // Enable local persistence in Firestore when supported (ignore multi-tab warnings).
      db.enablePersistence({ synchronizeTabs: true }).catch(function () {
        /* ignore unsupported browser / multi-tab persistence */
      });

      status.syncState = 'signed-out';
      status.errorMessage = '';

      // Handle redirect login result (commonly used on mobile Safari/Chrome).
      auth.getRedirectResult().catch(function (err) {
        if (err && err.code) {
          status.errorMessage = mapAuthError(err);
          showToast(status.errorMessage);
          notify();
        }
      });

      unsubscribeAuth = auth.onAuthStateChanged(handleAuthStateChange);
      notify();
      return true;
    } catch (err) {
      console.error('[StudyPlan.Sync] Firebase init failed:', err);
      status.syncState = 'error';
      status.errorMessage = mapAuthError(err);
      notify();
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function init() {
    if (initialized) return;
    initialized = true;

    if (StudyPlan.Store && typeof StudyPlan.Store.subscribe === 'function') {
      StudyPlan.Store.subscribe(handleStoreChange);
    }

    global.addEventListener('online', function () {
      if (status.user && db) {
        pushLocalState(false);
      }
    });

    global.addEventListener('offline', function () {
      if (status.user) {
        status.syncState = 'offline';
        notify();
      }
    });

    setupFirebase();
  }

  function signInWithGoogle() {
    if (global.location && global.location.protocol === 'file:') {
      showToast('Đăng nhập Google chỉ hoạt động qua đường link web (GitHub Pages / localhost), không hỗ trợ mở trực tiếp file://.');
      return Promise.resolve(false);
    }
    if (!status.configured || !auth) {
      showToast('Vui lòng cấu hình Firebase trước khi đăng nhập.');
      return Promise.resolve(false);
    }

    var provider = new global.firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });

    status.syncState = 'connecting';
    status.errorMessage = '';
    notify();

    return auth
      .signInWithPopup(provider)
      .then(function () {
        showToast('Đăng nhập thành công! Đang đồng bộ dữ liệu...');
        return true;
      })
      .catch(function (err) {
        var code = err && err.code ? String(err.code) : '';
        if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
          return auth.signInWithRedirect(provider).then(function () {
            return true;
          });
        }
        status.syncState = 'signed-out';
        status.errorMessage = mapAuthError(err);
        notify();
        showToast(status.errorMessage);
        return false;
      });
  }

  function signOut() {
    if (!auth) return Promise.resolve();
    detachFirestoreListener();
    return auth
      .signOut()
      .then(function () {
        showToast('Đã đăng xuất. Lịch học hiện tại vẫn được lưu trên máy này.');
      })
      .catch(function (err) {
        showToast(mapAuthError(err));
      });
  }

  function syncNow() {
    if (!status.user) return Promise.resolve(false);
    return pushLocalState(true);
  }

  /**
   * Save Firebase config in browser localStorage and initialize immediately.
   * @param {string} rawInput
   * @returns {{ ok: boolean, error?: string }}
   */
  function saveRuntimeConfig(rawInput) {
    var parsed = parseConfigInput(rawInput);
    if (!parsed) {
      return {
        ok: false,
        error: 'Cấu hình không hợp lệ. Cần có đủ apiKey, authDomain và projectId.'
      };
    }
    try {
      global.localStorage.setItem(RUNTIME_CONFIG_KEY, JSON.stringify(parsed));
    } catch (e) {
      return { ok: false, error: 'Không thể lưu cấu hình vào trình duyệt.' };
    }
    // If Firebase was already initialized with a different config, reload is safest.
    if (firebaseApp) {
      global.location.reload();
      return { ok: true };
    }
    setupFirebase();
    return { ok: true };
  }

  function clearRuntimeConfig() {
    try {
      global.localStorage.removeItem(RUNTIME_CONFIG_KEY);
    } catch (e) {
      /* ignore */
    }
    if (firebaseApp) {
      global.location.reload();
      return;
    }
    setupFirebase();
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.add(fn);
    return function () {
      listeners.delete(fn);
    };
  }

  function getStatus() {
    return {
      configured: status.configured,
      configSource: status.configSource,
      sdkReady: status.sdkReady,
      user: status.user ? Object.assign({}, status.user) : null,
      syncState: status.syncState,
      lastSyncedAt: status.lastSyncedAt,
      errorMessage: status.errorMessage
    };
  }

  StudyPlan.Sync = Object.freeze({
    init: init,
    subscribe: subscribe,
    getStatus: getStatus,
    signInWithGoogle: signInWithGoogle,
    signOut: signOut,
    syncNow: syncNow,
    saveRuntimeConfig: saveRuntimeConfig,
    clearRuntimeConfig: clearRuntimeConfig
  });
})(window);
