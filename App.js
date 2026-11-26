import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, Alert, AppState, KeyboardAvoidingView, Linking, Platform,
  Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as A from './src/attendance';
import { APP_TITLE } from './src/config';

const C = {
  bg: '#f3f4f6', card: '#ffffff', text: '#111827', sub: '#6b7280', line: '#e5e7eb',
  green: '#059669', greenBg: '#d1fae5', grey: '#4b5563', greyBg: '#e5e7eb',
  blue: '#2563eb', red: '#dc2626', amberBg: '#fef3c7', amber: '#92400e',
};

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit' }) : '');
const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString('en-SG', { day: '2-digit', month: 'short' }) : '');

export default function App() {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState(null);

  useEffect(() => {
    A.getProfile().then((p) => { setProfile(p); setLoading(false); });
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <SafeAreaView style={s.safe} edges={['top', 'left', 'right']}>
        {loading ? (
          <View style={s.center}><ActivityIndicator size="large" color={C.blue} /></View>
        ) : profile ? (
          <HomeScreen profile={profile} onSignOut={() => setProfile(null)} />
        ) : (
          <SetupScreen onDone={setProfile} />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

/* ======================= SETUP ======================= */

function SetupScreen({ onDone }) {
  const [code, setCode] = useState('');
  const [staffId, setStaffId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!code.trim() || !staffId.trim() || !name.trim()) {
      Alert.alert('Missing details', 'Please fill in all three boxes.');
      return;
    }
    setBusy(true);
    try {
      await A.register({ code, staffId, name });
      Alert.alert(
        'Location access',
        'To clock you in and out automatically, the app needs your location set to "Always" ' +
          '(Android: "Allow all the time"). It only checks when you cross the boundary of a workplace.',
        [{
          text: 'Continue',
          onPress: async () => {
            try {
              await A.requestPermissions();
              await A.startAutoTracking();
              await A.checkNow();
            } catch {}
            onDone(await A.getProfile());
          },
        }]
      );
    } catch (e) {
      Alert.alert('Could not register', e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
        <Text style={s.title}>{APP_TITLE}</Text>
        <Text style={s.lead}>Set up once. After that, you're clocked in when you arrive at work and clocked out when you leave.</Text>

        <View style={s.card}>
          <Field label="Access code" value={code} onChangeText={setCode} placeholder="From your supervisor" autoCapitalize="characters" />
          <Field label="Staff ID" value={staffId} onChangeText={setStaffId} placeholder="e.g. C12345" autoCapitalize="characters" />
          <Field label="Full name" value={name} onChangeText={setName} placeholder="As on your staff pass" autoCapitalize="words" last />
          <Button title={busy ? 'Registering…' : 'Register'} onPress={submit} disabled={busy} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, last, ...props }) {
  return (
    <View style={[s.field, last && { marginBottom: 20 }]}>
      <Text style={s.label}>{label}</Text>
      <TextInput style={s.input} placeholderTextColor="#9ca3af" autoCorrect={false} {...props} />
    </View>
  );
}

/* ======================= HOME ======================= */

function HomeScreen({ profile, onSignOut }) {
  const [status, setStatus] = useState({ status: 'OUT' });
  const [perms, setPerms] = useState({ foreground: false, background: false });
  const [tracking, setTracking] = useState(false);
  const [sites, setSites] = useState([]);
  const [queue, setQueue] = useState([]);
  const [history, setHistory] = useState([]);
  const [here, setHere] = useState(null); // { site, distance, inside, accuracy }
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastError, setLastError] = useState('');

  const reloadLocal = useCallback(async () => {
    setStatus(await A.getStatus());
    setSites(await A.getSites());
    setQueue(await A.getQueue());
    setHistory(await A.getHistory());
    setPerms(await A.getPermissionState());
    setTracking(await A.isAutoTrackingOn());
  }, []);

  const syncAll = useCallback(async () => {
    setLastError('');
    try { await A.refreshFromServer(); } catch (e) { setLastError(e.message); }
    try { await A.startAutoTracking(); } catch {}
    const f = await A.flushQueue();
    if (f.error) setLastError(f.error);
    try { setHere(await A.checkNow()); } catch {}
    await reloadLocal();
  }, [reloadLocal]);

  useEffect(() => {
    reloadLocal().then(syncAll);
    const sub = AppState.addEventListener('change', (st) => { if (st === 'active') syncAll(); });
    return () => sub.remove();
  }, [reloadLocal, syncAll]);

  const onRefresh = async () => { setRefreshing(true); await syncAll(); setRefreshing(false); };

  const manualIn = async () => {
    setBusy(true);
    try {
      const pos = await A.getCurrentPosition();
      const near = A.nearestSite(sites, pos.coords);
      if (!near) throw new Error('No workplaces set up yet. Ask your supervisor.');
      const limit = (near.site.radius || 500) + Math.min(pos.coords.accuracy || 0, 100);
      if (near.distance > limit) {
        Alert.alert('Too far away', `You're about ${Math.round(near.distance)} m from ${near.site.name}. You can only clock in within ${near.site.radius || 500} m.`);
        return;
      }
      const r = await A.recordEvent('ENTER', near.site.name, 'manual', pos.coords);
      if (r.error) Alert.alert('Saved on phone', 'No connection right now. It will be sent automatically.');
    } catch (e) {
      Alert.alert('Could not clock in', e.message);
    } finally {
      setBusy(false);
      reloadLocal();
    }
  };

  const manualOut = () => {
    Alert.alert('Clock out now?', 'This records your clock-out time as now.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clock out',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            let coords = null;
            try { coords = (await A.getCurrentPosition()).coords; } catch {}
            const r = await A.recordEvent('EXIT', status.site, 'manual', coords);
            if (r.error) Alert.alert('Saved on phone', 'No connection right now. It will be sent automatically.');
          } finally {
            setBusy(false);
            reloadLocal();
          }
        },
      },
    ]);
  };

  const signOut = () => {
    Alert.alert('Sign out?', 'Automatic clock-in and clock-out will stop on this phone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          await A.stopAutoTracking();
          await AsyncStorage.clear();
          onSignOut();
        },
      },
    ]);
  };

  const fixPermissions = async () => {
    const p = await A.requestPermissions();
    if (!p.background) Linking.openSettings();
    await syncAll();
  };

  const isIn = status.status === 'IN';
  const outsideButIn = isIn && here && !here.inside && here.distance > (here.site?.radius || 500) + (here.accuracy || 0);

  return (
    <ScrollView
      contentContainerStyle={s.page}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <View style={s.headerRow}>
        <Text style={s.title}>{APP_TITLE}</Text>
        <Pressable onPress={onRefresh} hitSlop={10}><Text style={s.link}>Refresh</Text></Pressable>
      </View>

      {/* Status */}
      <View style={[s.statusCard, { backgroundColor: isIn ? C.greenBg : C.greyBg }]}>
        <Text style={[s.statusLabel, { color: isIn ? C.green : C.grey }]}>{isIn ? 'CLOCKED IN' : 'CLOCKED OUT'}</Text>
        <Text style={s.statusMain}>{isIn ? status.site || 'Workplace' : 'Not at a workplace'}</Text>
        <Text style={s.statusSub}>
          {isIn && status.clockIn ? `Since ${fmtTime(status.clockIn)}, ${fmtDay(status.clockIn)}` : 'You will be clocked in automatically on arrival'}
        </Text>
      </View>

      {/* Warnings */}
      {!perms.background && (
        <Banner
          text={'Automatic clock-in is OFF. Set location to "Always" (Android: "Allow all the time").'}
          action="Fix" onPress={fixPermissions}
        />
      )}
      {outsideButIn && (
        <Banner text={`You seem to be ${Math.round(here.distance)} m from ${here.site.name} but are still clocked in. Tap Clock out if you've left.`} />
      )}
      {!!lastError && queue.length > 0 && (
        <Banner text={`${queue.length} record(s) waiting to send. They'll go out when you're back online.`} />
      )}

      {/* Manual buttons */}
      <View style={s.buttonRow}>
        <Button title="Clock in" onPress={manualIn} disabled={busy || isIn} style={s.flex} />
        <View style={s.gap} />
        <Button title="Clock out" onPress={manualOut} disabled={busy || !isIn} style={s.flex} variant="outline" />
      </View>
      <Text style={s.hint}>Use these only if the automatic one missed you. Clock in works within the site radius.</Text>

      {/* Details */}
      <View style={s.card}>
        <Text style={s.cardTitle}>This phone</Text>
        <Row label="Staff" value={`${profile.name} (${profile.staffId})`} />
        <Row label="Auto tracking" value={tracking && perms.background ? 'On' : 'Off'} good={tracking && perms.background} />
        <Row label="Location access" value={perms.background ? 'Always' : perms.foreground ? 'While using only' : 'Not allowed'} good={perms.background} />
        <Row label="Workplaces" value={`${sites.length}`} />
        <Row label="Nearest" value={here?.site ? `${here.site.name}, ${fmtDist(here.distance)}` : '–'} />
        <Row label="Waiting to send" value={`${queue.length}`} last />
      </View>

      {/* History */}
      <View style={s.card}>
        <Text style={s.cardTitle}>Recent activity</Text>
        {history.length === 0 ? (
          <Text style={s.empty}>Nothing yet.</Text>
        ) : (
          history.slice(0, 10).map((h, i) => (
            <View key={`${h.time}-${i}`} style={[s.histRow, i === Math.min(history.length, 10) - 1 && s.noLine]}>
              <View style={[s.dot, { backgroundColor: h.type === 'ENTER' ? C.green : C.grey }]} />
              <View style={s.flex}>
                <Text style={s.histMain}>{h.result}</Text>
                <Text style={s.histSub}>{h.site} · {h.source === 'manual' ? 'Manual' : 'Auto'}</Text>
              </View>
              <Text style={s.histTime}>{fmtTime(h.time)}{'\n'}<Text style={s.histSub}>{fmtDay(h.time)}</Text></Text>
            </View>
          ))
        )}
      </View>

      <Pressable onPress={signOut} style={s.signOut}><Text style={s.signOutText}>Sign out of this phone</Text></Pressable>
    </ScrollView>
  );
}

const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

/* ======================= SMALL PARTS ======================= */

function Button({ title, onPress, disabled, style, variant }) {
  const outline = variant === 'outline';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        s.btn, outline && s.btnOutline, disabled && s.btnDisabled, pressed && !disabled && { opacity: 0.8 }, style,
      ]}
    >
      <Text style={[s.btnText, outline && { color: C.blue }, disabled && { color: '#6b7280' }]}>{title}</Text>
    </Pressable>
  );
}

function Row({ label, value, good, last }) {
  return (
    <View style={[s.row, last && s.noLine]}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={[s.rowValue, good === true && { color: C.green }, good === false && { color: C.red }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function Banner({ text, action, onPress }) {
  return (
    <View style={s.banner}>
      <Text style={[s.bannerText, s.flex]}>{text}</Text>
      {action && (
        <Pressable onPress={onPress} style={s.bannerBtn}><Text style={s.bannerBtnText}>{action}</Text></Pressable>
      )}
    </View>
  );
}

/* ======================= STYLES ======================= */

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  page: { padding: 16, paddingBottom: 40, width: '100%', maxWidth: 560, alignSelf: 'center' },
  flex: { flex: 1 },
  gap: { width: 12 },

  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  title: { fontSize: 24, fontWeight: '700', color: C.text },
  lead: { fontSize: 15, color: C.sub, marginTop: 6, marginBottom: 20, lineHeight: 21 },
  link: { fontSize: 15, color: C.blue, fontWeight: '600' },

  card: { backgroundColor: C.card, borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: C.line },
  cardTitle: { fontSize: 13, fontWeight: '700', color: C.sub, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },

  field: { marginBottom: 14 },
  label: { fontSize: 14, fontWeight: '600', color: C.text, marginBottom: 6 },
  input: {
    borderWidth: 1, borderColor: '#d1d5db', borderRadius: 10, paddingHorizontal: 12,
    height: 46, fontSize: 16, color: C.text, backgroundColor: '#fff',
  },

  btn: { height: 50, borderRadius: 12, backgroundColor: C.blue, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  btnOutline: { backgroundColor: '#fff', borderWidth: 1.5, borderColor: C.blue },
  btnDisabled: { backgroundColor: '#d1d5db', borderColor: '#d1d5db' },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  buttonRow: { flexDirection: 'row', alignItems: 'stretch' },
  hint: { fontSize: 13, color: C.sub, marginTop: 8, marginBottom: 16, lineHeight: 18 },

  statusCard: { borderRadius: 16, padding: 20, marginBottom: 16 },
  statusLabel: { fontSize: 13, fontWeight: '800', letterSpacing: 1 },
  statusMain: { fontSize: 26, fontWeight: '700', color: C.text, marginTop: 6 },
  statusSub: { fontSize: 15, color: C.sub, marginTop: 4 },

  banner: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.amberBg, borderRadius: 12,
    padding: 12, marginBottom: 12,
  },
  bannerText: { color: C.amber, fontSize: 14, lineHeight: 19 },
  bannerBtn: { marginLeft: 12, backgroundColor: C.amber, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  bannerBtnText: { color: '#fff', fontWeight: '700' },

  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: C.line,
  },
  noLine: { borderBottomWidth: 0 },
  rowLabel: { fontSize: 15, color: C.sub, marginRight: 12 },
  rowValue: { fontSize: 15, color: C.text, fontWeight: '600', flexShrink: 1, textAlign: 'right' },

  empty: { fontSize: 15, color: C.sub, paddingVertical: 10 },
  histRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  histMain: { fontSize: 15, color: C.text, fontWeight: '600' },
  histSub: { fontSize: 13, color: C.sub, marginTop: 2 },
  histTime: { fontSize: 15, color: C.text, fontWeight: '600', textAlign: 'right', marginLeft: 12 },

  signOut: { alignItems: 'center', paddingVertical: 14 },
  signOutText: { color: C.red, fontSize: 15, fontWeight: '600' },
});
