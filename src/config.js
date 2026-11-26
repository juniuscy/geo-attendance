// ============================================================
//  SET THIS ONCE before building the app.
//  Paste the Web app URL you get from Apps Script:
//  Deploy > New deployment > Web app > copy the URL ending in /exec
// ============================================================
export const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbywgMqAvnwF6tLsUGAQplEMmb0leE8MFVz4UA100BFbR-kOFGAjzTxb3BOmYAiZTjm6/exec';

// Name shown at the top of the app
export const APP_TITLE = 'Geo Attendance';

// iPhones can only watch 20 places at once. If you have more sites,
// the app watches the 20 closest to the phone.
export const IOS_MAX_REGIONS = 20;
export const ANDROID_MAX_REGIONS = 100;
