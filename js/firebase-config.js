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
    apiKey: 'AIzaSyCeJiYyAO1AN-Qnx0jcJ8k3BZo1igldpUA',
    authDomain: 'daily-study-plan-cfc40.firebaseapp.com',
    projectId: 'daily-study-plan-cfc40',
    storageBucket: 'daily-study-plan-cfc40.firebasestorage.app',
    messagingSenderId: '864845084081',
    appId: '1:864845084081:web:b92fbc9dbd20effd70f990',
    measurementId: 'G-WJQGX4HJH8'
  };
})(window);
