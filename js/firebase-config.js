/**
 * Firebase configuration for StudyPlan cloud sync.
 *
 * Replace the empty strings below with your Firebase Web App config from:
 * Firebase Console -> Project Settings -> General -> Your apps -> SDK setup and configuration.
 *
 * Note: Firebase client-side web config is public by design; data privacy is
 * enforced by Firestore Security Rules (each user can only access their own UID).
 */
(function (global) {
  'use strict';

  var StudyPlan = (global.StudyPlan = global.StudyPlan || {});

  StudyPlan.FIREBASE_CONFIG = {
    apiKey: '',
    authDomain: '',
    projectId: '',
    storageBucket: '',
    messagingSenderId: '',
    appId: ''
  };
})(window);
