// Core logic: geofencing task, talking to the Google Sheet, offline queue.
// This file is imported from index.js so the background task is defined
// at the top level (required for it to run when the app is closed).

import { Platform } from 'react-native';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BACKEND_URL, IOS_MAX_REGIONS, ANDROID_MAX_REGIONS } from './config';

export const GEOFENCE_TASK = 'GEO_ATTENDANCE_GEOFENCE';
const IS_NATIVE = Platform.OS === 'ios' || Platform.OS === 'android';

const K = {
  PROFILE: 'ga.profile',   // { staffId, name, code }
  SITES: 'ga.sites',       // [{ name, latitude, longitude, radius }]
  QUEUE: 'ga.queue',       // events not yet sent
  HISTORY: 'ga.history',   // last 30 results from the server
  STATUS: 'ga.status',     // { status: 'IN'|'OUT', site, clockIn }
};

/* ---------------- storage helpers ---------------- */

async function getJSON(key, fallback) {
  try {
    const v = await AsyncStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
const setJSON = (key, value) => AsyncStorage.setItem(key, JSON.stringify(value));

export const getProfile = () => getJSON(K.PROFILE, null);
export const getSites = () => getJSON(K.SITES, []);
export const getQueue = () => getJSON(K.QUEUE, []);
export const getHistory = () => getJSON(K.HISTORY, []);
export const getStatus = () => getJSON(K.STATUS, { status: 'OUT' });

/* ---------------- talking to the Google Sheet ---------------- */

async function post(body) {
  const res = await fetch(BACKEND_URL, {
    method: 'POST',
    // text/plain avoids a CORS pre-flight that Apps Script cannot answer
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Server error');
  return data;
}

async function saveStatusFrom(data) {
  if (data && data.status) {
    await setJSON(K.STATUS, { status: data.status, site: data.site || '', clockIn: data.clockIn || '' });
  }
}

/** First-time sign up. Saves the profile and the list of sites. */
export async function register({ code, staffId, name }) {
  const profile = { code: code.trim(), staffId: staffId.trim().toUpperCase(), name: name.trim() };
  const data = await post({ action: 'register', ...profile, platform: Platform.OS });
  await setJSON(K.PROFILE, profile);
  await setJSON(K.SITES, data.sites || []);
  await saveStatusFrom(data);
  return data;
}

/** Downloads the latest site list and status from the sheet. */
export async function refreshFromServer() {
  const profile = await getProfile();
  if (!profile) return null;
  const data = await post({ action: 'register', ...profile, platform: Platform.OS });
  await setJSON(K.SITES, data.sites || []);
  await saveStatusFrom(data);
  return data;
}

/* ---------------- offline queue ---------------- */

let flushing = false;

/** Adds an event to the queue and tries to send everything that is waiting. */
export async function recordEvent(type, site, source, coords) {
  const event = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type, // 'ENTER' | 'EXIT'
    site,
    source, // 'auto' | 'manual' | 'startup'
    time: new Date().toISOString(),
    lat: coords?.latitude ?? null,
    lng: coords?.longitude ?? null,
    acc: coords?.accuracy ?? null,
  };
  const queue = await getQueue();
  queue.push(event);
  await setJSON(K.QUEUE, queue);
  // Show the change straight away, even before the server answers
  await setJSON(K.STATUS, type === 'ENTER'
    ? { status: 'IN', site, clockIn: event.time }
    : { status: 'OUT', site: '', clockIn: '' });
  return flushQueue();
}

/** Sends waiting events. Returns { sent, results } or { sent: 0, error }. */
export async function flushQueue() {
  if (flushing) return { sent: 0 };
  flushing = true;
  try {
    const profile = await getProfile();
    const queue = await getQueue();
    if (!profile || queue.length === 0) return { sent: 0 };

    const data = await post({ action: 'events', ...profile, platform: Platform.OS, events: queue });

    const sentIds = new Set(queue.map((e) => e.id));
    const remaining = (await getQueue()).filter((e) => !sentIds.has(e.id));
    await setJSON(K.QUEUE, remaining);

    const history = await getHistory();
    (data.results || []).forEach((r) => {
      const ev = queue.find((e) => e.id === r.id);
      if (ev) history.unshift({ time: ev.time, type: ev.type, site: ev.site, source: ev.source, result: r.result });
    });
    await setJSON(K.HISTORY, history.slice(0, 30));
    await saveStatusFrom(data);
    return { sent: queue.length, results: data.results || [] };
  } catch (e) {
    return { sent: 0, error: e.message };
  } finally {
    flushing = false;
  }
}

/* ---------------- distance + geofencing ---------------- */

export function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Nearest site to a position, with distance in metres. */
export function nearestSite(sites, coords) {
  let best = null;
  sites.forEach((s) => {
    const d = distanceMeters(coords, s);
    if (!best || d < best.distance) best = { site: s, distance: d };
  });
  return best;
}

export async function getPermissionState() {
  if (!IS_NATIVE) return { foreground: false, background: false };
  try {
    const fg = await Location.getForegroundPermissionsAsync();
    const bg = await Location.getBackgroundPermissionsAsync();
    return { foreground: fg.status === 'granted', background: bg.status === 'granted' };
  } catch {
    return { foreground: false, background: false };
  }
}

/** Asks for location (foreground, then "Always") and notification permission. */
export async function requestPermissions() {
  if (!IS_NATIVE) return { foreground: false, background: false };
  const fg = await Location.requestForegroundPermissionsAsync();
  let bg = { status: 'denied' };
  if (fg.status === 'granted') bg = await Location.requestBackgroundPermissionsAsync();
  try { await Notifications.requestPermissionsAsync(); } catch {}
  return { foreground: fg.status === 'granted', background: bg.status === 'granted' };
}

/** Registers the sites with the phone's geofencing. Safe to call repeatedly. */
export async function startAutoTracking() {
  if (!IS_NATIVE) return false;
  const perms = await getPermissionState();
  if (!perms.background) return false;

  let sites = await getSites();
  if (sites.length === 0) return false;

  const max = Platform.OS === 'ios' ? IOS_MAX_REGIONS : ANDROID_MAX_REGIONS;
  if (sites.length > max) {
    try {
      const pos = await Location.getLastKnownPositionAsync();
      if (pos) sites = [...sites].sort((a, b) => distanceMeters(pos.coords, a) - distanceMeters(pos.coords, b));
    } catch {}
    sites = sites.slice(0, max);
  }

  await Location.startGeofencingAsync(
    GEOFENCE_TASK,
    sites.map((s) => ({
      identifier: s.name,
      latitude: s.latitude,
      longitude: s.longitude,
      radius: s.radius || 500,
      notifyOnEnter: true,
      notifyOnExit: true,
    }))
  );
  return true;
}

export async function stopAutoTracking() {
  if (!IS_NATIVE) return;
  try {
    if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK)) {
      await Location.stopGeofencingAsync(GEOFENCE_TASK);
    }
  } catch {}
}

export async function isAutoTrackingOn() {
  if (!IS_NATIVE) return false;
  try { return await Location.hasStartedGeofencingAsync(GEOFENCE_TASK); } catch { return false; }
}

export async function getCurrentPosition() {
  return Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
}

/**
 * When the app is opened: if the phone is already inside a site but the
 * record says clocked out (e.g. geofencing was just switched on), clock in.
 * It never clocks out on its own here, because indoor GPS can be off by
 * a few hundred metres; the app shows a reminder instead.
 */
export async function checkNow() {
  if (!IS_NATIVE) return null;
  const perms = await getPermissionState();
  if (!perms.foreground) return null;
  const sites = await getSites();
  if (sites.length === 0) return null;
  const pos = await getCurrentPosition();
  const near = nearestSite(sites, pos.coords);
  const inside = near && near.distance <= (near.site.radius || 500);
  const status = await getStatus();
  if (inside && status.status !== 'IN') {
    await recordEvent('ENTER', near.site.name, 'startup', pos.coords);
  }
  return { ...near, inside, accuracy: pos.coords.accuracy };
}

/* ---------------- local notification ---------------- */

export async function notify(title, body) {
  if (!IS_NATIVE) return;
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('attendance', {
        name: 'Attendance',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    await Notifications.scheduleNotificationAsync({
      content: { title, body },
      trigger: Platform.OS === 'android' ? { channelId: 'attendance' } : null,
    });
  } catch {}
}

if (IS_NATIVE) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

/* ---------------- the background task ---------------- */

function timeNow() {
  return new Date().toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit' });
}

if (IS_NATIVE) {
  TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
    if (error || !data) return;
    const { eventType, region } = data;
    const type = eventType === Location.GeofencingEventType.Enter ? 'ENTER'
      : eventType === Location.GeofencingEventType.Exit ? 'EXIT' : null;
    if (!type || !region) return;

    const profile = await getProfile();
    if (!profile) return;

    // On iOS the starting state of every region is reported at app start.
    // Skip an "enter" if we are already clocked in at that site.
    const status = await getStatus();
    if (type === 'ENTER' && status.status === 'IN' && status.site === region.identifier) return;
    if (type === 'EXIT' && status.status !== 'IN') return;

    let coords = null;
    try {
      const last = await Location.getLastKnownPositionAsync();
      coords = last?.coords || null;
    } catch {}

    const res = await recordEvent(type, region.identifier, 'auto', coords);
    const verb = type === 'ENTER' ? 'Clocked in at' : 'Clocked out of';
    const extra = res.error ? ' (no signal, will sync later)' : '';
    await notify(`${verb} ${region.identifier}`, `${timeNow()}${extra}`);
  });
}
