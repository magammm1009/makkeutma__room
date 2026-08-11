import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js';
import {
  getAuth, setPersistence, browserLocalPersistence, onAuthStateChanged,
  signInAnonymously, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js';
import {
  getFirestore, collection, collectionGroup, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, serverTimestamp, writeBatch
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-storage.js';

// 2026-08-11: 숙제장을 작업방 프로젝트(magamm00-5baee)로 통합했습니다.
// 옛 프로젝트(mkm-homework-9aba5)의 Firestore 문서와 Storage 인증샷은 이미 이쪽으로
// 옮겨져 있고, 이 앱은 작업방(/makkeutma__room/) 안에서 같은 오리진으로 열립니다.
const firebaseConfig = {
  apiKey: 'AIzaSyAmhsxF7syCPNfgIVb2ZIQBxgGV_rZ2nDI',
  authDomain: 'magamm00-5baee.firebaseapp.com',
  projectId: 'magamm00-5baee',
  storageBucket: 'magamm00-5baee.firebasestorage.app',
  messagingSenderId: '829544685832',
  appId: '1:829544685832:web:7ae0a5a2cd48cb62a6ccbd'
};

// 운영 이메일을 바꾸려면 여기, firestore.rules, storage.rules의 이메일을 함께 바꿔 주세요.
const APP_RELEASE = 'v32-submission-recovery-guard';
const ADMIN_EMAIL = 'sukk5753@gmail.com';
const MONTHLY_TARGET = 20;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const WRITER_BROWSER_PROFILE_KEY = 'homework-book:writer-profile:v1';

// 작업방(마끝마) 안 iframe으로 열렸는가. 주소창으로 직접 연 경우는 false라
// 지금까지처럼 닉네임 입력 화면이 그대로 뜹니다(관리자가 직접 여는 경로).
const IS_EMBEDDED = (() => { try { return window.top !== window.self; } catch { return true; } })();
const EMBED_IDENTITY_TIMEOUT_MS = 1500;
// 작업방이 닉네임을 알려 줄 때까지 로그인 화면을 잠깐 붙잡아 둡니다.
// 시간 안에 응답이 없으면(구버전 작업방) 그냥 닉네임 입력 화면으로 돌아갑니다.
let embedIdentityPending = IS_EMBEDDED;
let embedIdentityHandled = false;
let embedIdentityTimer = null;
let embedLoginSuppressed = false;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = {
  user: null,
  profile: null,
  writerTasks: [],
  writerSubmissions: [],
  writerSchedules: [],
  adminProfiles: [],
  adminTasks: [],
  adminSubmissions: [],
  monthlyAward: null,
  dailyHomework: null,
  calendarMonth: null,
  adminReportMonth: null,
  unsubs: [],
  activeStampId: null,
  activeScheduleId: null,
  selectedScheduleColor: 'coral',
  assignmentTargetKey: '__all__',
  selectedProofFile: null,
  selectedProofPreviewUrl: null,
  installPrompt: null,
  authVersion: 0,
  migrationBusy: false,
  profileMigrationBusy: false,
  kingTopThreeSyncBusy: false,
  adminSubmissionsLoaded: false
};

function localDateKey(date = new Date()) {
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}
function monthKey() { return localDateKey().slice(0, 7); }
function monthDate(month) {
  const [year, monthNumber] = String(month || monthKey()).split('-').map(Number);
  return new Date(year, Math.max(0, monthNumber - 1), 1);
}
function shiftMonthKey(month, amount) {
  const date = monthDate(month);
  date.setMonth(date.getMonth() + amount);
  const year = date.getFullYear();
  const monthNumber = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${monthNumber}`;
}
function calendarMonthKey() { return state.calendarMonth || monthKey(); }
function calendarDefaultDate() {
  const shownMonth = calendarMonthKey();
  return shownMonth === monthKey() ? localDateKey() : `${shownMonth}-01`;
}
function dateInMonth(month, day) { return `${month}-${String(day).padStart(2, '0')}`; }
function daysInMonth(month = monthKey()) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(year, monthNumber, 0).getDate();
}
function monthLabel(month = calendarMonthKey()) {
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long' }).format(monthDate(month));
}
function moveCalendarMonth(amount) {
  state.calendarMonth = shiftMonthKey(calendarMonthKey(), amount);
  renderCalendar();
}
function resetCalendarMonth() {
  state.calendarMonth = null;
  renderCalendar();
}
function formatDate(value) {
  const date = toDate(value);
  if (!date) return '방금 전';
  return new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

const STAMP_META = {
  '참잘했어요': { short: '참잘', full: '참잘했어요', className: 'red' },
  '해냈어요': { short: '해냈', full: '해냈어요', className: 'orange' },
  '꾸준해요': { short: '꾸준', full: '꾸준해요', className: 'green' },
  '아주잘했어요': { short: '아주잘', full: '아주잘했어요', className: 'purple' },
  '오늘도충분해요': { short: '충분', full: '오늘도충분해요', className: 'red' },
  '🌸': { short: '참잘', full: '참잘했어요', className: 'red' },
  '🔥': { short: '해냈', full: '해냈어요', className: 'orange' },
  '✍️': { short: '꾸준', full: '꾸준해요', className: 'green' },
  '💎': { short: '아주잘', full: '아주잘했어요', className: 'purple' },
  '🫶': { short: '충분', full: '오늘도충분해요', className: 'red' }
};
function stampMeta(value) { return STAMP_META[value] || STAMP_META['참잘했어요']; }
function renderStampSeal(value, alt = false) {
  const meta = stampMeta(value);
  return `<span class="stamp-seal ${meta.className} ${alt ? 'alt' : ''}" title="${esc(meta.full)}"><small>🌸</small></span>`;
}
function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function timestampValue(value) { return toDate(value)?.getTime() || 0; }
function normalizeNickname(value = '') {
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase();
}
function displayNickname(value = '') {
  return String(value).trim().replace(/\s+/g, ' ');
}
function mergeUniqueDocs(...groups) {
  return [...new Map(groups.flat().map((item) => [item.id, item])).values()];
}
function esc(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
}
function emojiFor(name) {
  const emojis = ['🌷', '🦊', '🐇', '🌿', '🫧', '🐣', '🦔', '🌙', '🍀', '🪻'];
  const sum = [...name].reduce((acc, char) => acc + char.codePointAt(0), 0);
  return emojis[sum % emojis.length];
}

const LOGIN_EMOJI_OPTIONS = [
  '😀','🥰','🤩','😎','🥳','🫶','🐶','🦊','🐱','🐰','🐻','🐼','🦄','🦉','🦋',
  '🌸','💮','🪷','🌹','🌺','🌻','🌼','🌷','🪻','🍀','🍄','🌙','⭐','🌟','🌈',
  '🔥','💧','🍓','🍒','🍰','☕','🫖','🎀','👑','💎','✏️','🎧','📷','💌','💖',
  '💗','💓','💞','🩵','💙','💚','💛','🧡','🩷','❤️','💜','🤎','🖤','🤍'
];

function normalizeWriterEmoji(value, fallback = '') {
  const raw = String(value || '').trim();
  if (!raw || !/\p{Extended_Pictographic}/u.test(raw)) return fallback;
  try {
    const segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' });
    const match = [...segmenter.segment(raw)].find((part) => /\p{Extended_Pictographic}/u.test(part.segment));
    return match?.segment || fallback;
  } catch {
    const match = raw.match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/u);
    return match?.[0] || fallback;
  }
}

function renderLoginEmojiPicker() {
  const grid = $('#emojiPresetGrid');
  const input = $('#emojiInput');
  const preview = $('#emojiPreview');
  if (!grid || !input || !preview) return;
  const selected = normalizeWriterEmoji(input.value, '');
  preview.textContent = selected || '🌷';
  grid.innerHTML = LOGIN_EMOJI_OPTIONS.map((emoji) => `<button type="button" class="emoji-choice ${selected === emoji ? 'selected' : ''}" data-login-emoji="${emoji}" aria-label="${emoji} 이모지 선택" aria-pressed="${selected === emoji ? 'true' : 'false'}">${emoji}</button>`).join('');
}

function chooseLoginEmoji(value) {
  const emoji = normalizeWriterEmoji(value, '');
  if (!emoji) return;
  $('#emojiInput').value = emoji;
  renderLoginEmojiPicker();
}

function readWriterBrowserProfile() {
  try {
    const raw = localStorage.getItem(WRITER_BROWSER_PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const nickname = displayNickname(parsed?.nickname || '');
    const emoji = normalizeWriterEmoji(parsed?.emoji, '');
    const writerKey = normalizeNickname(parsed?.writerKey || nickname);
    return nickname ? { nickname, emoji, writerKey } : null;
  } catch (error) {
    console.warn('Writer browser profile read skipped', error);
    return null;
  }
}

function saveWriterBrowserProfile(profile = {}) {
  const nickname = displayNickname(profile.nickname || '');
  const emoji = normalizeWriterEmoji(profile.emoji, '');
  const writerKey = normalizeNickname(profile.writerKey || nickname);
  if (!nickname || !writerKey) return;
  try {
    localStorage.setItem(WRITER_BROWSER_PROFILE_KEY, JSON.stringify({
      nickname,
      emoji,
      writerKey,
      savedAt: Date.now()
    }));
  } catch (error) {
    console.warn('Writer browser profile save skipped', error);
  }
}

function restoreWriterBrowserProfile({ force = false } = {}) {
  const saved = readWriterBrowserProfile();
  if (!saved) return;
  const nicknameInput = $('#nicknameInput');
  const emojiInput = $('#emojiInput');
  if (!nicknameInput || !emojiInput) return;

  if (force || !displayNickname(nicknameInput.value)) nicknameInput.value = saved.nickname;
  if (force || !normalizeWriterEmoji(emojiInput.value, '')) emojiInput.value = saved.emoji || emojiFor(saved.nickname);
}

function distinctWriterProfiles() {
  const byWriterKey = new Map();
  state.adminProfiles.forEach((profile) => {
    const writerKey = profile.writerKey || normalizeNickname(profile.nickname);
    if (!writerKey || !profile.nickname) return;
    const current = byWriterKey.get(writerKey);
    if (!current || timestampValue(profile.updatedAt || profile.createdAt) >= timestampValue(current.updatedAt || current.createdAt)) {
      byWriterKey.set(writerKey, { ...profile, writerKey });
    }
  });
  return [...byWriterKey.values()].sort((a, b) => String(a.nickname).localeCompare(String(b.nickname), 'ko'));
}

function profileDocumentsForWriterKey(writerKey) {
  return state.adminProfiles.filter((profile) => (profile.writerKey || normalizeNickname(profile.nickname)) === writerKey);
}

function renderAssignmentTargetButtons() {
  const container = $('#assignmentTargetButtons');
  if (!container) return;

  const writers = distinctWriterProfiles();
  if (!writers.length) {
    state.assignmentTargetKey = '';
    container.innerHTML = '<div class="writer-roster-empty">등록된 작가님이 없어요.</div>';
    return;
  }

  const validWriterKeys = new Set(writers.map((writer) => writer.writerKey));
  if (state.assignmentTargetKey !== '__all__' && !validWriterKeys.has(state.assignmentTargetKey)) {
    state.assignmentTargetKey = '__all__';
  }

  const allSelected = state.assignmentTargetKey === '__all__';
  const allButton = `<button type="button" class="assignment-target-button all ${allSelected ? 'selected' : ''}" data-assignment-target="__all__" aria-pressed="${allSelected ? 'true' : 'false'}"><span>전체 작가님</span><small>${writers.length}명</small></button>`;
  const writerButtons = writers.map((writer) => {
    const selected = state.assignmentTargetKey === writer.writerKey;
    return `<div class="writer-target-chip ${selected ? 'selected' : ''}">
      <button type="button" class="assignment-target-button" data-assignment-target="${esc(writer.writerKey)}" aria-pressed="${selected ? 'true' : 'false'}">
        <span>${esc(writer.emoji || '🌷')} ${esc(writer.nickname)}</span>
      </button>
      <button type="button" class="writer-target-delete" data-delete-writer="${esc(writer.writerKey)}" aria-label="${esc(writer.nickname)} 닉네임 명단에서 삭제" title="${esc(writer.nickname)} 닉네임 명단에서 삭제">×</button>
    </div>`;
  }).join('');

  container.innerHTML = `${allButton}${writerButtons}`;
}

async function deleteWriterNickname(writerKey, triggerButton = null) {
  const writer = distinctWriterProfiles().find((item) => item.writerKey === writerKey);
  const profiles = profileDocumentsForWriterKey(writerKey);
  if (!writer || !profiles.length) {
    toast('삭제할 닉네임을 찾지 못했어요.');
    return;
  }

  const confirmed = window.confirm(`“${writer.nickname}” 닉네임을 작가님 명단에서 삭제할까요?\n\n기존 숙제·인증·일정 기록은 지우지 않고, 배정 명단에서만 제거돼요.`);
  if (!confirmed) return;

  const button = triggerButton;
  setButtonBusy(button, true, '…');
  try {
    const operations = profiles.map((profile) => (batch) => batch.delete(profilePath(profile.id)));
    if (state.monthlyAward?.winnerWriterKey === writerKey) {
      operations.push((batch) => batch.delete(monthlyAwardPath()));
    }
    await commitOperations(operations);
    if (state.assignmentTargetKey === writerKey) state.assignmentTargetKey = '__all__';
    toast(`“${writer.nickname}” 닉네임을 명단에서 삭제했어요.`);
  } catch (error) {
    console.error(error);
    toast(friendlyError(error));
  } finally {
    setButtonBusy(button, false);
  }
}
function createAssignmentGroupId() {
  return (crypto.randomUUID?.() || `all-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`);
}

const SCHEDULE_COLORS = {
  coral: { label: '코랄', accent: '#e88170', soft: '#fff0eb' },
  peach: { label: '피치', accent: '#d98755', soft: '#fff2e7' },
  mint: { label: '민트', accent: '#5f9a73', soft: '#eaf7ef' },
  sky: { label: '하늘', accent: '#6c9fc6', soft: '#edf6ff' },
  lavender: { label: '라벤더', accent: '#8d73bd', soft: '#f3efff' },
  lemon: { label: '레몬', accent: '#c3a33a', soft: '#fff8d9' }
};
function scheduleColorMeta(key) { return SCHEDULE_COLORS[key] || SCHEDULE_COLORS.coral; }
function localDateFromKey(dateKey) {
  const [year, month, day] = String(dateKey || '').split('-').map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day);
}
function ddayLabel(dateKey) {
  const target = localDateFromKey(dateKey);
  const today = localDateFromKey(localDateKey());
  if (!target || !today) return '';
  const diff = Math.round((target - today) / 86400000);
  if (diff === 0) return 'D-DAY';
  return diff > 0 ? `D-${diff}` : `D+${Math.abs(diff)}`;
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function shiftDateKey(dateKey, amount) {
  const date = localDateFromKey(dateKey) || localDateFromKey(localDateKey());
  date.setDate(date.getDate() + amount);
  return localDateKey(date);
}

function dateKeyFromValue(value, fallback = localDateKey()) {
  const date = toDate(value);
  return date ? localDateKey(date) : fallback;
}

function homeworkDateKey(task) {
  if (isDateKey(task?.assignedDateKey)) return task.assignedDateKey;
  if (isDateKey(task?.createdDateKey)) return task.createdDateKey;
  return dateKeyFromValue(task?.createdAt);
}

function homeworkDateLabel(dateKey) {
  const date = localDateFromKey(dateKey);
  if (!date) return '날짜 미상';
  return new Intl.DateTimeFormat('ko-KR', {
    month: 'short',
    day: 'numeric',
    weekday: 'short'
  }).format(date);
}

function dailyDateKeyFromTaskId(taskId) {
  const match = String(taskId || '').match(/^daily:(\d{4}-\d{2}-\d{2})(?::\d+)?$/);
  return match?.[1] || null;
}

function submissionCompletionDateKey(submission) {
  if (isDateKey(submission?.createdDateKey)) return submission.createdDateKey;

  const dailyDateKey = dailyDateKeyFromTaskId(submission?.taskId);
  if (dailyDateKey) return dailyDateKey;

  const createdAt = toDate(submission?.createdAt);
  if (createdAt) return localDateKey(createdAt);

  // Older records with no completion timestamp retain their existing stamped day.
  if (isDateKey(submission?.stampDateKey)) return submission.stampDateKey;
  return localDateKey();
}

function normalizeDailyTemplates(setting = {}) {
  const source = Array.isArray(setting?.tasks)
    ? setting.tasks
    : (String(setting?.title || '').trim() ? [{ slot: 1, title: setting.title }] : []);

  const seen = new Set();
  return source
    .map((item, index) => {
      const slotCandidate = Number(item?.slot ?? index + 1);
      const slot = [1, 2, 3].includes(slotCandidate) ? slotCandidate : index + 1;
      return { slot, title: String(item?.title || '').trim() };
    })
    .filter((item) => item.title && [1, 2, 3].includes(item.slot) && !seen.has(item.slot) && (seen.add(item.slot) || true))
    .sort((a, b) => a.slot - b.slot)
    .slice(0, 3);
}

function dailySettingStartDate(setting = {}) {
  if (isDateKey(setting?.effectiveFromDateKey)) return setting.effectiveFromDateKey;
  return dateKeyFromValue(setting?.updatedAt);
}

function dailyConfigForDate(dateKey) {
  const setting = state.dailyHomework;
  if (!setting) return null;

  const current = {
    isActive: Boolean(setting.isActive),
    tasks: normalizeDailyTemplates(setting)
  };
  const currentStart = dailySettingStartDate(setting);

  if (dateKey >= currentStart) return current;

  const history = Array.isArray(setting.history) ? setting.history : [];
  const matching = history
    .filter((entry) => isDateKey(entry?.fromDateKey)
      && entry.fromDateKey <= dateKey
      && (!entry.toDateKey || entry.toDateKey >= dateKey))
    .sort((a, b) => String(b.fromDateKey).localeCompare(String(a.fromDateKey)))[0];

  if (!matching) return null;
  return {
    isActive: Boolean(matching.isActive),
    tasks: normalizeDailyTemplates(matching)
  };
}

function legacyDailyTaskId(task) {
  if (task?.source === 'daily' && Number(task.dailySlot) === 1 && isDateKey(task.dailyDateKey)) {
    return `daily:${task.dailyDateKey}`;
  }
  return null;
}

function submissionMatchesTask(submission, task) {
  if (!submission || !task?.id) return false;
  if (submission.taskId === task.id) return true;
  const legacyId = legacyDailyTaskId(task);
  return Boolean(legacyId && submission.taskId === legacyId);
}

function taskIsCompleted(task) {
  return Boolean(task?.done)
    || state.writerSubmissions.some((submission) => submissionMatchesTask(submission, task));
}

function submissionDocumentIdForTask(taskId) {
  // 과제 ID는 자동 생성 ID 또는 daily:YYYY-MM-DD:slot 형태라, 이 정규화로 안정적인 문서 ID가 됩니다.
  return `task-${String(taskId || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function dailyHomeworkTasksForDate(dateKey = localDateKey()) {
  const config = dailyConfigForDate(dateKey);
  if (!config?.isActive || !config.tasks.length) return [];

  return config.tasks.map((template) => {
    const task = {
      id: `daily:${dateKey}:${template.slot}`,
      title: template.title,
      source: 'daily',
      assignmentScope: 'daily',
      virtual: true,
      done: false,
      dailyDateKey: dateKey,
      assignedDateKey: dateKey,
      dailySlot: template.slot,
      createdAt: null
    };
    return { ...task, done: taskIsCompleted(task) };
  });
}

function dailyHomeworkTasksForToday() {
  return dailyHomeworkTasksForDate(localDateKey());
}

function recentPastDailyHomeworkTasks(days = 35) {
  const today = localDateKey();
  const tasks = [];
  for (let offset = 1; offset <= days; offset += 1) {
    tasks.push(...dailyHomeworkTasksForDate(shiftDateKey(today, -offset)));
  }
  return tasks;
}

function taskForSubmission(taskId) {
  const selectedId = String(taskId || '');
  const dailyDateKey = dailyDateKeyFromTaskId(selectedId);

  // 자정을 넘긴 채 제출창을 열어 둔 경우에도, 선택했던 날짜의 매일 숙제를 정확히 찾습니다.
  if (dailyDateKey) {
    const dailyTask = dailyHomeworkTasksForDate(dailyDateKey)
      .find((task) => task.id === selectedId || legacyDailyTaskId(task) === selectedId);
    if (dailyTask) return dailyTask;
  }

  return state.writerTasks.find((item) => item.id === selectedId) || null;
}


function canonicalProfileData(source = {}, writerKey, { includeCreatedAt = false } = {}) {
  const nickname = displayNickname(source.nickname || writerKey);
  const profile = {
    nickname,
    nicknameLower: writerKey,
    writerKey,
    emoji: normalizeWriterEmoji(source.emoji, emojiFor(nickname)),
    role: 'writer',
    profileVersion: 2,
    updatedAt: serverTimestamp()
  };
  if (includeCreatedAt) profile.createdAt = source.createdAt || serverTimestamp();
  return profile;
}

async function linkAnonymousUserToWriter(user, writerKey, profileData, { deleteLegacy = false } = {}) {
  const batch = writeBatch(db);
  const canonicalRef = profilePath(writerKey);
  const sessionRef = writerSessionPath(user.uid);
  const canonicalSnap = await getDoc(canonicalRef);

  const existingCanonical = canonicalSnap.exists() ? canonicalSnap.data() : null;
  const existingUpdatedAt = timestampValue(existingCanonical?.updatedAt || existingCanonical?.createdAt);
  const incomingUpdatedAt = timestampValue(profileData?.updatedAt || profileData?.createdAt);
  const useIncoming = !existingCanonical || incomingUpdatedAt > existingUpdatedAt;
  const selected = useIncoming ? profileData : existingCanonical;

  batch.set(
    canonicalRef,
    canonicalProfileData(selected || profileData, writerKey, { includeCreatedAt: !existingCanonical }),
    { merge: true }
  );
  batch.set(sessionRef, {
    writerKey,
    storageVersion: 1,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  }, { merge: true });

  if (deleteLegacy && user.uid !== writerKey) {
    batch.delete(profilePath(user.uid));
  }
  await batch.commit();

  return {
    ...(existingCanonical || {}),
    ...(selected || profileData || {}),
    ...canonicalProfileData(selected || profileData, writerKey),
    writerKey,
    nicknameLower: writerKey
  };
}

async function migrateCurrentLegacyProfile(user) {
  const legacyRef = profilePath(user.uid);
  const legacySnap = await getDoc(legacyRef);
  if (!legacySnap.exists()) return null;

  const legacy = legacySnap.data();
  const writerKey = legacy.writerKey || normalizeNickname(legacy.nickname);
  if (!writerKey || !legacy.nickname) return null;

  const canonical = await linkAnonymousUserToWriter(user, writerKey, legacy, { deleteLegacy: user.uid !== writerKey });
  return canonical;
}

function isAdmin(user = state.user) {
  return Boolean(user?.email && user.email.toLowerCase() === ADMIN_EMAIL.toLowerCase());
}
function profilePath(writerKey) { return doc(db, 'profiles', writerKey); }
function writerSessionPath(uid) { return doc(db, 'writerSessions', uid); }
function writerTasksPath(writerKey) { return collection(db, 'writers', writerKey, 'tasks'); }
function writerSubmissionsPath(writerKey) { return collection(db, 'writers', writerKey, 'submissions'); }
function writerTaskPath(writerKey, taskId) { return doc(db, 'writers', writerKey, 'tasks', taskId); }
function writerSubmissionPath(writerKey, submissionId) { return doc(db, 'writers', writerKey, 'submissions', submissionId); }
function writerSchedulesPath(writerKey) { return collection(db, 'writers', writerKey, 'schedules'); }
function writerSchedulePath(writerKey, scheduleId) { return doc(db, 'writers', writerKey, 'schedules', scheduleId); }
function dailyHomeworkPath() { return doc(db, 'appSettings', 'dailyHomework'); }
function legacyDailyHomeworkPath() { return doc(db, 'dailyHomework', 'current'); }
function awardMonthKey() { return shiftMonthKey(monthKey(), -1); }
function monthlyAwardPath(month = awardMonthKey()) { return doc(db, 'monthlyAwards', month); }
function clearListeners() {
  state.unsubs.forEach((unsubscribe) => { try { unsubscribe(); } catch (_) {} });
  state.unsubs = [];
}
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(window.__seedToastTimer);
  window.__seedToastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}
function friendlyError(error) {
  const code = error?.code || '';
  if (code.includes('auth/invalid-credential') || code.includes('auth/wrong-password')) return '이메일 또는 비밀번호를 다시 확인해 주세요.';
  if (code.includes('auth/email-already-in-use')) return '이미 만들어진 관리자 계정이에요. 로그인 버튼을 사용해 주세요.';
  if (code.includes('auth/weak-password')) return '비밀번호는 6자 이상으로 정해 주세요.';
  if (code.includes('auth/operation-not-allowed')) return 'Firebase Authentication에서 익명 로그인 또는 이메일/비밀번호 로그인을 먼저 켜 주세요.';
  if (code.includes('permission-denied')) return '데이터 연결 권한을 확인하지 못했어요. 새 규칙을 배포한 뒤 앱을 완전히 닫고 다시 열어 주세요.';
  if (code.includes('unavailable') || code.includes('network-request-failed')) return '데이터 연결이 차단되었어요. 광고·개인정보 차단 확장 프로그램에서 이 사이트 또는 firestore.googleapis.com 차단을 풀어 주세요.';
  if (code.includes('deadline-exceeded') || code.includes('write-timeout')) return '저장 확인 시간이 길어졌어요. 네트워크를 확인한 뒤 다시 시도해 주세요.';
  if (code.includes('storage/unauthorized')) return '사진 저장 권한이 없어요. Storage 규칙과 로그인 상태를 확인해 주세요.';
  if (code.includes('storage/quota-exceeded')) return 'Storage 용량 한도에 도달했어요.';
  if (code.includes('storage/unknown')) return '사진 저장 중 문제가 생겼어요. Storage 버킷 생성과 요금제를 확인해 주세요.';
  return error?.message || '잠시 후 다시 시도해 주세요.';
}
function setButtonBusy(button, busy, text) {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.disabled = true;
    button.textContent = text || '처리 중…';
  } else {
    button.disabled = false;
    button.textContent = button.dataset.originalText || button.textContent;
  }
}

function waitForWrite(promise, timeoutMs = 10000) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => {
      const error = new Error('write-timeout');
      error.code = 'deadline-exceeded';
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
}
function showScreen(name) {
  // 작업방에서 열렸는데 아직 닉네임을 못 받았다면 로그인 화면이 깜빡이지 않게
  // 로딩 화면을 유지합니다. 나중에 게이트가 풀리면 다시 제대로 보여 줍니다.
  let target = name;
  if (name === 'login' && embedIdentityPending) {
    embedLoginSuppressed = true;
    target = 'loading';
  }
  $$('.screen').forEach((screen) => screen.classList.toggle('active', screen.id === `${target}Screen`));
  renderTopActions();
}
function openModal(id) { $(`#${id}`).classList.add('show'); }
function closeModal(id) { $(`#${id}`).classList.remove('show'); }

function renderTopActions() {
  const actions = [];
  if (state.user && isAdmin()) {
    actions.push(`<span class="pill">관리자 · ${esc(ADMIN_EMAIL)}</span>`);
    actions.push('<button id="goAdmin" class="ghost-btn" type="button">관리자 관리함</button>');
    actions.push('<button id="logoutButton" class="danger-btn" type="button">로그아웃</button>');
  } else if (state.user && state.profile) {
    actions.push(`<span class="pill">${esc(normalizeWriterEmoji(state.profile.emoji, '🌷'))} ${esc(state.profile.nickname)} 작가님</span>`);
    actions.push('<button id="writerLogout" class="ghost-btn" type="button">로그아웃</button>');
    actions.push('<button id="openAdminFromTop" class="ghost-btn" type="button">관리자 인증</button>');
  } else {
    actions.push('<button id="openAdminFromTop" class="ghost-btn" type="button">관리자 인증</button>');
  }
  if (state.installPrompt) actions.push('<button id="installApp" class="install-btn" type="button">앱 설치</button>');
  $('#topActions').innerHTML = actions.join('');
  $('#goAdmin')?.addEventListener('click', () => showScreen('admin'));
  $('#openAdminFromTop')?.addEventListener('click', () => openModal('adminAuthModal'));
  $('#writerLogout')?.addEventListener('click', async () => {
    await signOut(auth);
    toast('작가 로그아웃을 완료했어요.');
  });
  $('#logoutButton')?.addEventListener('click', async () => {
    await signOut(auth);
    toast('관리자 로그아웃을 완료했어요.');
  });
  $('#installApp')?.addEventListener('click', installApp);
}

async function handleAuthChanged(user) {
  const version = ++state.authVersion;
  clearListeners();
  state.user = user;
  state.profile = null;
  state.writerTasks = [];
  state.writerSubmissions = [];
  state.writerSchedules = [];
  state.activeScheduleId = null;
  state.adminProfiles = [];
  state.adminTasks = [];
  state.adminSubmissions = [];
  state.adminSubmissionsLoaded = false;
  state.monthlyAward = null;
  state.dailyHomework = null;
  state.calendarMonth = null;
  state.adminReportMonth = null;
  state.assignmentTargetKey = '__all__';

  if (!user) {
    restoreWriterBrowserProfile({ force: true });
    renderLoginEmojiPicker();
    showScreen('login');
    return;
  }

  if (isAdmin(user)) {
    setupAdminListeners();
    showScreen('admin');
    (async () => {
      await migrateLegacyData();
      await migrateProfilesToNicknameKeys();
      await migrateDailyHomeworkSetting();
    })().catch((error) => console.warn('Profile migration skipped', error));
    return;
  }

  if (!user.isAnonymous) {
    await signOut(auth);
    if (version === state.authVersion) {
      showScreen('login');
      toast('등록된 관리자 이메일로만 관리함을 열 수 있어요.');
    }
    return;
  }

  try {
    const sessionSnap = await getDoc(writerSessionPath(user.uid));
    if (version !== state.authVersion) return;

    if (sessionSnap.exists()) {
      const writerKey = sessionSnap.data().writerKey;
      if (writerKey) {
        const canonicalSnap = await getDoc(profilePath(writerKey));
        if (version !== state.authVersion) return;
        if (canonicalSnap.exists()) {
          activateWriter(user.uid, { ...canonicalSnap.data(), writerKey, nicknameLower: writerKey });
          return;
        }
      }
    }

    const migratedLegacyProfile = await migrateCurrentLegacyProfile(user);
    if (version !== state.authVersion) return;
    if (migratedLegacyProfile) {
      activateWriter(user.uid, migratedLegacyProfile);
      return;
    }

    restoreWriterBrowserProfile({ force: true });
    renderLoginEmojiPicker();
    showScreen('login');
  } catch (error) {
    if (version !== state.authVersion) return;
    console.error(error);
    restoreWriterBrowserProfile({ force: true });
    renderLoginEmojiPicker();
    showScreen('login');
    toast(friendlyError(error));
  }
}

function activateWriter(uid, profileData) {
  const nickname = displayNickname(profileData.nickname);
  const writerKey = profileData.writerKey || normalizeNickname(nickname);
  const emoji = normalizeWriterEmoji(profileData.emoji, emojiFor(nickname));
  state.profile = {
    uid,
    ...profileData,
    nickname,
    nicknameLower: writerKey,
    writerKey,
    emoji,
    profileVersion: 2
  };
  saveWriterBrowserProfile(state.profile);
  setupWriterListeners(writerKey);
  showScreen('writer');
}

function setupWriterListeners(writerKey) {
  // 작가별 고정 경로를 읽습니다. 쿼리 규칙 추론에 의존하지 않아
  // 닉네임으로 다시 들어와도 같은 숙제장이 안정적으로 열립니다.
  state.unsubs.push(onSnapshot(writerTasksPath(writerKey), (snapshot) => {
    state.writerTasks = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
      .sort((a, b) => timestampValue(b.createdAt) - timestampValue(a.createdAt));
    renderWriter();
  }, (error) => {
    console.warn('Writer task listener failed', error);
    toast(friendlyError(error));
  }));
  state.unsubs.push(onSnapshot(writerSubmissionsPath(writerKey), (snapshot) => {
    state.writerSubmissions = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
      .sort((a, b) => timestampValue(b.stampAt || b.createdAt) - timestampValue(a.stampAt || a.createdAt));
    renderWriter();
  }, (error) => {
    console.warn('Writer submission listener failed', error);
    toast(friendlyError(error));
  }));
  state.unsubs.push(onSnapshot(writerSchedulesPath(writerKey), (snapshot) => {
    state.writerSchedules = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
      .sort((a, b) => String(a.dateKey || '').localeCompare(String(b.dateKey || '')) || String(a.title || '').localeCompare(String(b.title || ''), 'ko'));
    renderWriter();
  }, (error) => {
    console.warn('Writer schedule listener failed', error);
    toast(friendlyError(error));
  }));
  setupDailyHomeworkListener();
  setupMonthlyAwardListener();
}

function setupDailyHomeworkListener() {
  state.unsubs.push(onSnapshot(dailyHomeworkPath(), (snapshot) => {
    state.dailyHomework = snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
    if (isAdmin()) renderAdmin();
    else renderWriter();
  }, (error) => {
    console.warn('Daily homework listener failed', error);
    toast(friendlyError(error));
  }));
}

function setupMonthlyAwardListener() {
  state.unsubs.push(onSnapshot(monthlyAwardPath(), (snapshot) => {
    state.monthlyAward = snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
    if (isAdmin()) {
      renderAdmin();
      scheduleKingTopThreeSync();
    } else {
      renderWriter();
    }
  }, (error) => {
    console.warn('Monthly award listener failed', error);
    toast(friendlyError(error));
  }));
}

function setupAdminListeners() {
  setupDailyHomeworkListener();
  setupMonthlyAwardListener();
  state.unsubs.push(onSnapshot(collection(db, 'profiles'), (snapshot) => {
    state.adminProfiles = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
      .sort((a, b) => String(a.nickname || '').localeCompare(String(b.nickname || ''), 'ko'));
    renderAdmin();
  }, (error) => {
    console.warn('Admin profile listener failed', error);
    toast(friendlyError(error));
  }));

  // 관리자 화면은 모든 작가의 하위 tasks / submissions를 읽습니다.
  // 여기서 storageVersion 조건을 Firestore 쿼리에 넣으면 컬렉션 그룹 전용 인덱스를
  // 별도로 만들어야 합니다. 현재 운영 데이터는 v3 경로에만 저장되므로,
  // 전체를 읽은 뒤 브라우저에서 v3 데이터만 표시해 인덱스 생성 대기 없이 안정적으로 엽니다.
  state.unsubs.push(onSnapshot(collectionGroup(db, 'tasks'), (snapshot) => {
    state.adminTasks = snapshot.docs.map((item) => {
      const data = item.data();
      return { id: item.id, writerKey: data.writerKey || item.ref.parent.parent?.id || '', ...data };
    }).filter((item) => item.storageVersion === 3)
      .sort((a, b) => timestampValue(b.createdAt) - timestampValue(a.createdAt));
    renderAdmin();
  }, (error) => {
    console.warn('Admin task listener failed', error);
    toast(friendlyError(error));
  }));

  state.unsubs.push(onSnapshot(collectionGroup(db, 'submissions'), (snapshot) => {
    state.adminSubmissions = snapshot.docs.map((item) => {
      const data = item.data();
      return { id: item.id, writerKey: data.writerKey || item.ref.parent.parent?.id || '', ...data };
    }).filter((item) => item.storageVersion === 3)
      .sort((a, b) => {
        if (Boolean(a.stamped) !== Boolean(b.stamped)) return Number(Boolean(a.stamped)) - Number(Boolean(b.stamped));
        return timestampValue(b.createdAt) - timestampValue(a.createdAt);
      });
    state.adminSubmissionsLoaded = true;
    renderAdmin();
    scheduleKingTopThreeSync();
  }, (error) => {
    console.warn('Admin submission listener failed', error);
    toast(friendlyError(error));
  }));
}

async function commitOperations(operations) {
  for (let index = 0; index < operations.length; index += 400) {
    const batch = writeBatch(db);
    operations.slice(index, index + 400).forEach((operation) => operation(batch));
    await batch.commit();
  }
}

async function migrateDailyHomeworkSetting() {
  if (!isAdmin()) return;
  const currentRef = dailyHomeworkPath();
  const currentSnap = await getDoc(currentRef);
  if (currentSnap.exists()) return;

  const legacySnap = await getDoc(legacyDailyHomeworkPath());
  if (!legacySnap.exists()) return;

  const legacy = legacySnap.data();
  await setDoc(currentRef, {
    title: String(legacy.title || ''),
    isActive: Boolean(legacy.isActive),
    storageVersion: 2,
    migratedFrom: 'dailyHomework/current',
    updatedByEmail: ADMIN_EMAIL,
    updatedAt: serverTimestamp()
  }, { merge: true });
}

async function migrateProfilesToNicknameKeys() {
  if (!isAdmin() || state.profileMigrationBusy) return;
  state.profileMigrationBusy = true;

  try {
    const profilesSnap = await getDocs(collection(db, 'profiles'));
    const grouped = new Map();

    profilesSnap.docs.forEach((snapshot) => {
      const data = snapshot.data();
      const writerKey = data.writerKey || normalizeNickname(data.nickname);
      if (!writerKey || !data.nickname) return;
      const group = grouped.get(writerKey) || [];
      group.push({ id: snapshot.id, ref: snapshot.ref, data });
      grouped.set(writerKey, group);
    });

    const operations = [];
    grouped.forEach((docs, writerKey) => {
      const canonicalDoc = docs.find((item) => item.id === writerKey);
      const selected = [...docs].sort((a, b) => {
        const aTime = timestampValue(a.data.updatedAt || a.data.createdAt);
        const bTime = timestampValue(b.data.updatedAt || b.data.createdAt);
        if (bTime !== aTime) return bTime - aTime;
        return Number(b.id === writerKey) - Number(a.id === writerKey);
      })[0];

      const canonicalNeedsUpdate = !canonicalDoc
        || canonicalDoc.data.profileVersion !== 2
        || canonicalDoc.data.writerKey !== writerKey
        || canonicalDoc.data.nicknameLower !== writerKey;

      if (canonicalNeedsUpdate || selected.id !== writerKey) {
        operations.push((batch) => batch.set(
          profilePath(writerKey),
          canonicalProfileData(selected.data, writerKey, { includeCreatedAt: !canonicalDoc }),
          { merge: true }
        ));
      }

      docs.filter((item) => item.id !== writerKey).forEach((legacyDoc) => {
        operations.push((batch) => batch.set(writerSessionPath(legacyDoc.id), {
          writerKey,
          storageVersion: 1,
          createdAt: legacyDoc.data.createdAt || serverTimestamp(),
          updatedAt: serverTimestamp()
        }, { merge: true }));
        operations.push((batch) => batch.delete(legacyDoc.ref));
      });
    });

    if (operations.length) {
      await commitOperations(operations);
      console.info(`Nickname profile migration applied: ${operations.length} operations`);
    }
  } finally {
    state.profileMigrationBusy = false;
  }
}

async function migrateLegacyData() {
  if (!isAdmin() || state.migrationBusy) return;
  state.migrationBusy = true;
  const migrationRef = doc(db, 'system', 'legacy-v2-to-writer-paths');
  try {
    const status = await getDoc(migrationRef);
    if (status.exists()) return;

    const [profilesSnap, tasksSnap, submissionsSnap] = await Promise.all([
      getDocs(collection(db, 'profiles')),
      getDocs(collection(db, 'tasks')),
      getDocs(collection(db, 'submissions'))
    ]);

    const profilesByUid = new Map(profilesSnap.docs.map((item) => [item.id, item.data()]));
    const operations = [];
    let moved = 0;

    profilesSnap.docs.forEach((item) => {
      const profile = item.data();
      const writerKey = profile.writerKey || normalizeNickname(profile.nickname);
      if (profile.nickname && writerKey && (!profile.writerKey || profile.nicknameLower !== writerKey)) {
        operations.push((batch) => batch.update(item.ref, { writerKey, nicknameLower: writerKey, updatedAt: serverTimestamp() }));
      }
    });

    tasksSnap.docs.forEach((item) => {
      const data = item.data();
      const profile = profilesByUid.get(data.writerUid);
      const writerKey = data.writerKey || normalizeNickname(data.writerNickname || profile?.nickname);
      if (!writerKey) return;
      const writerNickname = data.writerNickname || profile?.nickname || writerKey;
      operations.push((batch) => batch.set(writerTaskPath(writerKey, item.id), {
        ...data,
        writerKey,
        writerNickname,
        migratedFrom: 'legacy-v2',
        storageVersion: 3
      }, { merge: true }));
      moved += 1;
    });

    submissionsSnap.docs.forEach((item) => {
      const data = item.data();
      const profile = profilesByUid.get(data.writerUid);
      const writerKey = data.writerKey || normalizeNickname(data.writerNickname || profile?.nickname);
      if (!writerKey) return;
      const writerNickname = data.writerNickname || profile?.nickname || writerKey;
      operations.push((batch) => batch.set(writerSubmissionPath(writerKey, item.id), {
        ...data,
        writerKey,
        writerNickname,
        migratedFrom: 'legacy-v2',
        storageVersion: 3
      }, { merge: true }));
      moved += 1;
    });

    await commitOperations(operations);
    await setDoc(migrationRef, { completedAt: serverTimestamp(), movedDocuments: moved, version: 3 });
    if (moved) toast(`기존 숙제·인증 ${moved}건을 새 연결 방식으로 옮겼어요.`);
  } finally {
    state.migrationBusy = false;
  }
}

function monthlyLeaderboard(reportMonth = awardMonthKey()) {
  const byWriter = new Map();

  state.adminSubmissions
    .filter((item) => item.stamped && submissionCompletionDateKey(item).startsWith(reportMonth))
    .forEach((item) => {
      const writerKey = item.writerKey || normalizeNickname(item.writerNickname);
      if (!writerKey) return;
      const entry = byWriter.get(writerKey) || {
        writerKey,
        nickname: item.writerNickname || '작가',
        emoji: item.writerEmoji || '🌱',
        count: 0
      };
      entry.count += 1;
      byWriter.set(writerKey, entry);
    });

  return [...byWriter.values()]
    .sort((a, b) => b.count - a.count || String(a.nickname).localeCompare(String(b.nickname), 'ko'));
}

function awardMonthLabel() {
  return `${shortMonthLabel(awardMonthKey())} 정산`;
}

function kingTopThree() {
  return monthlyLeaderboard(awardMonthKey()).slice(0, 3);
}

function normalizeAwardTopThree(award) {
  const rows = Array.isArray(award?.topThree) ? award.topThree : [];
  const used = new Set();
  return rows
    .map((row, index) => ({
      writerKey: String(row?.writerKey || ''),
      nickname: String(row?.nickname || '작가'),
      emoji: String(row?.emoji || '🌷'),
      count: Number(row?.count || 0),
      rank: Number(row?.rank || index + 1)
    }))
    .filter((row) => row.writerKey && !used.has(row.writerKey) && (used.add(row.writerKey) || true))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 3);
}

function serializeTopThree(rows) {
  return rows.slice(0, 3).map((row, index) => ({
    rank: index + 1,
    writerKey: row.writerKey,
    nickname: row.nickname,
    emoji: row.emoji || '🌷',
    count: Number(row.count || 0)
  }));
}

function sameTopThree(first, second) {
  return JSON.stringify(serializeTopThree(first || [])) === JSON.stringify(serializeTopThree(second || []));
}

function writerVisibleTopThree() {
  const stored = normalizeAwardTopThree(state.monthlyAward);
  if (stored.length) return stored;

  // v29에서 저장된 최종 수상 결과는 TOP 3 배열이 없을 수 있습니다.
  // 그 경우에도 작가님 화면에서 수상자 한 분은 즉시 보이도록 처리합니다.
  if (state.monthlyAward?.winnerWriterKey) {
    return [{
      rank: Number(state.monthlyAward.selectedRank || 1),
      writerKey: state.monthlyAward.winnerWriterKey,
      nickname: state.monthlyAward.winnerNickname || '작가',
      emoji: state.monthlyAward.winnerEmoji || '👑',
      count: Number(state.monthlyAward.approvedCount || 0)
    }];
  }
  return [];
}

function scheduleKingTopThreeSync() {
  if (!isAdmin()) return;
  window.clearTimeout(window.__kingTopThreeSyncTimer);
  window.__kingTopThreeSyncTimer = window.setTimeout(() => {
    syncKingTopThree().catch((error) => console.warn('King TOP 3 sync skipped', error));
  }, 160);
}

async function syncKingTopThree() {
  if (!isAdmin() || state.kingTopThreeSyncBusy || !state.adminSubmissionsLoaded) return;

  const computed = serializeTopThree(kingTopThree());
  const stored = normalizeAwardTopThree(state.monthlyAward);
  if (sameTopThree(computed, stored)) return;

  state.kingTopThreeSyncBusy = true;
  try {
    await setDoc(monthlyAwardPath(awardMonthKey()), {
      monthKey: awardMonthKey(),
      topThree: computed,
      topThreeUpdatedAt: serverTimestamp(),
      storageVersion: 2,
      updatedAt: serverTimestamp()
    }, { merge: true });
  } finally {
    state.kingTopThreeSyncBusy = false;
  }
}

function renderKingTopThreeRows(rows, award, viewerWriterKey = null) {
  if (!rows.length) {
    return '<span class="king-empty">지난달 인증 기록이 아직 없어요.</span>';
  }

  return `<div class="king-rank-list">${rows.map((row, index) => {
    const rank = index + 1;
    const official = award?.winnerWriterKey === row.writerKey;
    const isMe = viewerWriterKey === row.writerKey;
    const crownLabel = rank === 1 ? '금관' : (rank === 2 ? '은관' : '동관');
    return `<div class="king-rank-row rank-${rank}${official ? ' official' : ''}${isMe ? ' is-me' : ''}">
      <span class="king-rank-number">${rank}</span>
      <span class="king-rank-crown crown-${rank}${official ? ' official' : ''}" aria-label="${crownLabel}">${rank === 1 ? '👑' : (rank === 2 ? '👑' : '👑')}</span>
      <span class="king-rank-emoji">${esc(row.emoji || '🌷')}</span>
      <strong>${esc(row.nickname)} 작가님${official ? ' <span class="sr-only">지난달 숙제왕</span>' : ''}</strong>
      <span class="king-rank-score">${row.count}개</span>
      ${official ? '<span class="king-rank-badge">숙제왕</span>' : ''}
    </div>`;
  }).join('')}</div>`;
}


function adminReportMonthKey() {
  return state.adminReportMonth || monthKey();
}

function moveAdminReportMonth(amount) {
  state.adminReportMonth = shiftMonthKey(adminReportMonthKey(), amount);
  renderAdmin();
}

function shortMonthLabel(month) {
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: 'short'
  }).format(monthDate(month));
}

function buildMonthlyWriterReport(reportMonth = adminReportMonthKey()) {
  const writerMap = new Map();

  distinctWriterProfiles().forEach((profile) => {
    const writerKey = profile.writerKey || normalizeNickname(profile.nickname);
    if (!writerKey) return;
    writerMap.set(writerKey, {
      writerKey,
      nickname: profile.nickname || '작가',
      emoji: profile.emoji || '🌷',
      submitted: 0,
      stamped: 0,
      pending: 0
    });
  });

  adminSubmissionDisplayRows()
    .filter((submission) => !submission.duplicateStampedBy && submissionCompletionDateKey(submission).startsWith(reportMonth))
    .forEach((submission) => {
      const writerKey = submission.writerKey || normalizeNickname(submission.writerNickname);
      if (!writerKey) return;

      const entry = writerMap.get(writerKey) || {
        writerKey,
        nickname: submission.writerNickname || '작가',
        emoji: submission.writerEmoji || '🌷',
        submitted: 0,
        stamped: 0,
        pending: 0
      };

      entry.submitted += 1;
      if (submission.stamped) entry.stamped += 1;
      else entry.pending += 1;
      writerMap.set(writerKey, entry);
    });

  return [...writerMap.values()]
    .sort((a, b) => b.stamped - a.stamped
      || b.submitted - a.submitted
      || String(a.nickname).localeCompare(String(b.nickname), 'ko'));
}

function renderAdminMonthlyReport() {
  const label = $('#adminReportMonth');
  const summary = $('#monthlyReportSummary');
  const list = $('#monthlyReportList');
  if (!label || !summary || !list) return;

  const reportMonth = adminReportMonthKey();
  const rows = buildMonthlyWriterReport(reportMonth);
  const totals = rows.reduce((acc, row) => {
    acc.writers += 1;
    acc.submitted += row.submitted;
    acc.stamped += row.stamped;
    acc.pending += row.pending;
    if (row.submitted > 0) acc.activeWriters += 1;
    return acc;
  }, { writers: 0, activeWriters: 0, submitted: 0, stamped: 0, pending: 0 });

  label.textContent = shortMonthLabel(reportMonth);
  summary.innerHTML = `
    <div class="report-summary-item"><span>참여 작가님</span><strong>${totals.activeWriters} / ${totals.writers}명</strong></div>
    <div class="report-summary-item"><span>인증</span><strong>${totals.submitted}건</strong></div>
    <div class="report-summary-item"><span>도장</span><strong>${totals.stamped}개</strong></div>
    <div class="report-summary-item ${totals.pending ? 'has-pending' : ''}"><span>미확인</span><strong>${totals.pending}건</strong></div>
  `;

  list.innerHTML = rows.length
    ? rows.map((row, index) => {
      const progress = Math.min(100, Math.round((row.stamped / MONTHLY_TARGET) * 100));
      const activity = row.submitted
        ? `인증 ${row.submitted} · 미확인 ${row.pending}`
        : '이달 인증 없음';
      return `<article class="monthly-report-row ${row.submitted ? 'active' : 'idle'}">
        <div class="monthly-report-profile">
          <span class="monthly-report-rank">${index + 1}</span>
          <span class="monthly-report-avatar">${esc(row.emoji || '🌷')}</span>
          <div class="monthly-report-copy">
            <strong>${esc(row.nickname)} 작가님</strong>
            <span>${esc(activity)}</span>
          </div>
          <b>${row.stamped} <small>/ ${MONTHLY_TARGET}</small></b>
        </div>
        <div class="monthly-progress" aria-label="${esc(row.nickname)} 작가님 도장 ${row.stamped}개, 목표 ${MONTHLY_TARGET}개">
          <span style="--monthly-progress:${progress}%"></span>
        </div>
      </article>`;
    }).join('')
    : '<div class="empty">등록된 작가님이 아직 없어요.</div>';
}

function renderWriterMonthlyKing() {
  const target = $('#writerKingCard');
  const periodTarget = $('#writerKingMonth');
  if (!target || !state.profile) return;

  if (periodTarget) periodTarget.textContent = awardMonthLabel();

  const rows = writerVisibleTopThree();
  target.innerHTML = renderKingTopThreeRows(rows, state.monthlyAward, state.profile.writerKey);
  target.classList.toggle('is-me', rows.some((row) => row.writerKey === state.profile.writerKey));
}

function renderAdminMonthlyKing() {
  const select = $('#monthlyKingSelect');
  const status = $('#adminKingStatus');
  const topThreeTarget = $('#adminKingTop3');
  const periodTarget = $('#adminKingMonth');
  if (!select || !status || !topThreeTarget) return;

  const ranking = monthlyLeaderboard(awardMonthKey());
  const topThree = ranking.slice(0, 3);
  const award = state.monthlyAward;
  if (periodTarget) periodTarget.textContent = awardMonthLabel();

  scheduleKingTopThreeSync();

  // 지난달 실제 도장 기록이 있는 작가님만 최종 숙제왕 후보로 표시합니다.
  select.disabled = !ranking.length;
  select.innerHTML = ranking.length
    ? `<option value="">작가님 선택</option>${ranking.map((writer, index) => {
        const selected = award?.winnerWriterKey === writer.writerKey ? ' selected' : '';
        return `<option value="${esc(writer.writerKey)}"${selected}>${index + 1}위 · ${esc(writer.nickname)} 작가님 · 도장 ${writer.count}개</option>`;
      }).join('')}`
    : '<option value="">지난달 인증 기록 없음</option>';

  if (award?.winnerWriterKey) {
    status.innerHTML = `<span class="king-status-crown">👑</span><strong>${esc(award.winnerNickname || '작가')} 작가님</strong><span>${Number(award.approvedCount || 0)}개 · 최종 선정</span>`;
  } else {
    const leader = topThree[0];
    status.innerHTML = leader
      ? `<span class="king-status-crown">👑</span><strong>지난달 1위 후보 · ${esc(leader.nickname)} 작가님</strong><span>${leader.count}개</span>`
      : '<span class="king-empty">지난달 정산 전</span>';
  }

  topThreeTarget.innerHTML = renderKingTopThreeRows(topThree, award);
}

async function saveMonthlyKing() {
  const writerKey = $('#monthlyKingSelect')?.value;
  const ranking = monthlyLeaderboard(awardMonthKey());
  const winner = ranking.find((item) => item.writerKey === writerKey);
  if (!winner) {
    toast('지난달 인증 기록이 있는 작가님을 골라 주세요.');
    return;
  }

  const selectedRank = ranking.findIndex((item) => item.writerKey === winner.writerKey) + 1;
  const button = $('#saveMonthlyKing');
  setButtonBusy(button, true, '선정 중…');
  try {
    await setDoc(monthlyAwardPath(awardMonthKey()), {
      monthKey: awardMonthKey(),
      winnerWriterKey: winner.writerKey,
      winnerNickname: winner.nickname,
      winnerEmoji: winner.emoji || '👑',
      approvedCount: winner.count,
      selectedRank,
      topThree: serializeTopThree(ranking),
      topThreeUpdatedAt: serverTimestamp(),
      storageVersion: 2,
      selectedByEmail: ADMIN_EMAIL,
      selectedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
    toast(`${awardMonthLabel()} 숙제왕으로 ${winner.nickname} 작가님을 선정했어요 👑`);
  } catch (error) {
    console.error(error);
    toast(friendlyError(error));
  } finally {
    setButtonBusy(button, false);
  }
}

async function clearMonthlyKing() {
  if (!state.monthlyAward?.winnerWriterKey) {
    toast('아직 지난달 숙제왕이 선정되지 않았어요.');
    return;
  }
  const button = $('#clearMonthlyKing');
  setButtonBusy(button, true, '취소 중…');
  try {
    await setDoc(monthlyAwardPath(awardMonthKey()), {
      monthKey: awardMonthKey(),
      winnerWriterKey: null,
      winnerNickname: null,
      winnerEmoji: null,
      approvedCount: null,
      selectedRank: null,
      selectedByEmail: null,
      selectedAt: null,
      topThree: serializeTopThree(kingTopThree()),
      topThreeUpdatedAt: serverTimestamp(),
      storageVersion: 2,
      updatedAt: serverTimestamp()
    }, { merge: true });
    toast('지난달 숙제왕 선정을 취소했어요. TOP 3 정산은 그대로 유지돼요.');
  } catch (error) {
    console.error(error);
    toast(friendlyError(error));
  } finally {
    setButtonBusy(button, false);
  }
}

function renderDailyHomeworkStatus() {
  const target = $('#dailyHomeworkStatus');
  if (!target) return;

  const setting = state.dailyHomework;
  const tasks = normalizeDailyTemplates(setting);
  if (setting?.isActive && tasks.length) {
    target.innerHTML = `<span class="daily-homework-badge">ON</span><div class="daily-homework-status-copy">${tasks.map((task) => `<strong>${task.slot}. ${esc(task.title)}</strong>`).join('')}</div>`;
    target.classList.add('active');
    $('#openDailyHomeworkFromCard').textContent = '수정하기';
  } else {
    target.textContent = '설정 안 함';
    target.classList.remove('active');
    $('#openDailyHomeworkFromCard').textContent = '설정하기';
  }
}

function openDailyHomeworkModal() {
  const setting = state.dailyHomework || {};
  const taskBySlot = new Map(normalizeDailyTemplates(setting).map((task) => [task.slot, task.title]));
  [1, 2, 3].forEach((slot) => {
    $(`#dailyHomeworkTask${slot}`).value = taskBySlot.get(slot) || '';
  });
  $('#dailyHomeworkActive').checked = Boolean(setting.isActive);
  $('#clearDailyHomework').style.display = taskBySlot.size || setting?.isActive ? 'inline-flex' : 'none';
  openModal('dailyHomeworkModal');
  setTimeout(() => $('#dailyHomeworkTask1').focus(), 0);
}

async function saveDailyHomework() {
  if (!isAdmin()) {
    toast('관리자 인증 상태를 확인하지 못했어요. 다시 로그인해 주세요.');
    return;
  }

  const tasks = [1, 2, 3]
    .map((slot) => ({ slot, title: $(`#dailyHomeworkTask${slot}`).value.trim() }))
    .filter((task) => task.title);
  const isActive = Boolean($('#dailyHomeworkActive').checked);

  if (isActive && !tasks.length) {
    toast('매일 자동으로 보여 줄 숙제를 하나 이상 적어 주세요.');
    $('#dailyHomeworkTask1').focus();
    return;
  }

  const button = $('#saveDailyHomework');
  const before = state.dailyHomework ? { ...state.dailyHomework } : null;
  const previousTasks = normalizeDailyTemplates(before);
  const previousIsActive = Boolean(before?.isActive);
  const previousStart = dailySettingStartDate(before || {});
  const today = localDateKey();
  const sameTasks = JSON.stringify(previousTasks) === JSON.stringify(tasks);
  const configChanged = !before || previousIsActive !== isActive || !sameTasks;

  let history = Array.isArray(before?.history) ? [...before.history] : [];
  if (before && configChanged && previousStart < today) {
    history = history
      .filter((entry) => entry?.fromDateKey !== previousStart)
      .concat([{
        fromDateKey: previousStart,
        toDateKey: shiftDateKey(today, -1),
        isActive: previousIsActive,
        tasks: previousTasks
      }])
      .slice(-36);
  }

  const optimistic = {
    title: tasks[0]?.title || '',
    tasks,
    isActive,
    effectiveFromDateKey: configChanged ? today : previousStart,
    history,
    storageVersion: 3,
    updatedByEmail: ADMIN_EMAIL
  };

  setButtonBusy(button, true, '저장 중…');
  state.dailyHomework = optimistic;
  renderAdmin();
  closeModal('dailyHomeworkModal');

  try {
    await waitForWrite(setDoc(dailyHomeworkPath(), {
      ...optimistic,
      updatedAt: serverTimestamp()
    }, { merge: true }));
    toast(isActive ? `매일 자동 숙제 ${tasks.length}개를 설정했어요 🔁` : '매일 자동 숙제를 잠시 껐어요.');
  } catch (error) {
    console.error(error);
    state.dailyHomework = before;
    renderAdmin();
    openDailyHomeworkModal();
    toast(friendlyError(error));
  } finally {
    setButtonBusy(button, false);
  }
}

async function clearDailyHomework() {
  if (!isAdmin()) {
    toast('관리자 인증 상태를 확인하지 못했어요. 다시 로그인해 주세요.');
    return;
  }

  const button = $('#clearDailyHomework');
  const before = state.dailyHomework ? { ...state.dailyHomework } : null;
  setButtonBusy(button, true, '해제 중…');
  state.dailyHomework = null;
  renderAdmin();
  closeModal('dailyHomeworkModal');

  try {
    await waitForWrite(deleteDoc(dailyHomeworkPath()));
    toast('매일 자동 숙제 설정을 해제했어요.');
  } catch (error) {
    console.error(error);
    state.dailyHomework = before;
    renderAdmin();
    openDailyHomeworkModal();
    toast(friendlyError(error));
  } finally {
    setButtonBusy(button, false);
  }
}

async function toggleScheduleCompleted(scheduleId) {
  if (!state.profile) return;
  const schedule = state.writerSchedules.find((item) => item.id === scheduleId);
  if (!schedule) return;
  try {
    await updateDoc(writerSchedulePath(state.profile.writerKey, schedule.id), {
      completed: !Boolean(schedule.completed),
      updatedAt: serverTimestamp()
    });
    toast(schedule.completed ? '일정을 다시 진행 중으로 바꿨어요.' : '일정을 완료했어요 ✓');
  } catch (error) {
    console.error(error);
    toast(friendlyError(error));
  }
}

function renderWriterStampTotal() {
  const totalTarget = $('#writerStampTotal');
  const monthTarget = $('#writerStampMonth');
  const progressTarget = $('#writerStampProgress');
  if (!totalTarget || !monthTarget || !progressTarget) return;

  const allStamps = state.writerSubmissions.filter((item) => item.stamped);
  const currentMonth = monthKey();
  const currentMonthStamps = allStamps.filter((item) => submissionCompletionDateKey(item).startsWith(currentMonth));
  const progress = Math.min(100, Math.round((currentMonthStamps.length / MONTHLY_TARGET) * 100));

  totalTarget.textContent = `내가 모은 도장 총 ${allStamps.length}개`;
  monthTarget.textContent = `${currentMonthStamps.length} / ${MONTHLY_TARGET}개`;
  progressTarget.style.width = `${progress}%`;
  progressTarget.parentElement?.setAttribute(
    'aria-label',
    `이번 달 칭찬 도장 ${currentMonthStamps.length}개, 목표 ${MONTHLY_TARGET}개`
  );
}

function renderWriter() {
  if (!state.profile || !state.user) return;
  const profileEmoji = normalizeWriterEmoji(state.profile.emoji, '🌷');
  const today = localDateKey();
  $('#writerName').textContent = state.profile.nickname || '작가';
  $('#writerEmoji').textContent = profileEmoji;
  $('#streakText').textContent = `${profileEmoji} ${state.profile.nickname || '나'}의 숙제장`;

  const dailyTasks = dailyHomeworkTasksForToday();
  const todayPersistent = state.writerTasks
    .filter((task) => homeworkDateKey(task) === today)
    .map((task) => ({ ...task, done: taskIsCompleted(task) }));
  const assigned = [
    ...dailyTasks,
    ...todayPersistent.filter((task) => (task.source || 'admin') === 'admin')
  ];
  const selfTasks = todayPersistent.filter((task) => task.source === 'self');

  const pastPersistent = state.writerTasks
    .filter((task) => homeworkDateKey(task) < today)
    .map((task) => ({ ...task, done: taskIsCompleted(task), pastDateKey: homeworkDateKey(task) }));
  const pastDaily = recentPastDailyHomeworkTasks().map((task) => ({ ...task, pastDateKey: task.dailyDateKey }));
  const pastTasks = [...pastPersistent, ...pastDaily]
    .sort((a, b) => String(b.pastDateKey).localeCompare(String(a.pastDateKey))
      || Number(a.done) - Number(b.done)
      || String(a.title).localeCompare(String(b.title), 'ko'));

  const taskTemplate = (task) => {
    const source = task.source || 'admin';
    const sourceLabel = source === 'self' ? '내가 직접 정함' : (source === 'daily' ? '매일 자동 숙제' : '오늘의 숙제');
    return `<div class="task ${task.done ? 'done' : ''} ${task.virtual ? 'daily-task' : ''}">
      <div class="task-check">${task.done ? '✓' : ''}</div>
      <div class="task-copy">
        <div class="task-title">${esc(task.title)}</div>
        <div class="task-meta"><span class="task-source ${source}">${sourceLabel}</span></div>
      </div>
      <div class="task-side">${source === 'self' && !task.done ? `<button type="button" class="self-task-remove" data-remove-own-task="${task.id}" aria-label="내가 정한 숙제 삭제">×</button>` : ''}</div>
    </div>`;
  };

  const pastTaskTemplate = (task) => {
    const source = task.source || 'admin';
    const sourceLabel = source === 'self' ? '내가 정한 숙제' : (source === 'daily' ? '매일 자동 숙제' : '관리자 숙제');
    const completed = Boolean(task.done);
    return `<div class="past-homework-item ${completed ? 'completed' : 'missed'}">
      <div class="past-homework-copy">
        <span class="past-homework-date">${esc(homeworkDateLabel(task.pastDateKey))}</span>
        <strong>${esc(task.title)}</strong>
        <span class="past-homework-source">${esc(sourceLabel)}</span>
      </div>
      <span class="past-homework-status ${completed ? 'completed' : 'missed'}">${completed ? '완료' : '미완료'}</span>
    </div>`;
  };

  const assignedHtml = assigned.length ? assigned.map(taskTemplate).join('') : '<div class="empty">오늘의 숙제가 없어요.</div>';
  const selfHtml = selfTasks.length ? selfTasks.map(taskTemplate).join('') : '<div class="empty">오늘 정한 숙제가 없어요.</div>';
  const missedCount = pastTasks.filter((task) => !task.done).length;
  const visiblePast = pastTasks.slice(0, 60);
  const pastHtml = visiblePast.length
    ? visiblePast.map(pastTaskTemplate).join('')
    : '<div class="empty">지난 숙제 기록이 아직 없어요.</div>';
  const pastSummary = pastTasks.length
    ? `<span class="past-homework-summary">${pastTasks.length}개 · 미완료 ${missedCount}개</span>`
    : '';

  $('#taskList').innerHTML = `<section class="task-group">
      <div class="task-group-head"><div class="task-group-title"><strong>오늘의 숙제</strong></div></div>
      <div class="task-stack">${assignedHtml}</div>
    </section>
    <section class="task-group">
      <div class="task-group-head"><div class="task-group-title"><strong>내가 정한 숙제</strong></div><button class="self-task-add" type="button" data-open-self-task>＋ 내 숙제 정하기</button></div>
      <div class="task-stack">${selfHtml}</div>
    </section>
    <section class="task-group past-homework-group">
      <div class="task-group-head">
        <div class="task-group-title"><strong>과거 숙제함</strong>${pastSummary}</div>
      </div>
      <div class="past-homework-stack">${pastHtml}${pastTasks.length > visiblePast.length ? `<div class="past-homework-more">최근 60개 기록을 보여 주고 있어요.</div>` : ''}</div>
    </section>`;

  renderSubmitTasks();
  renderWriterMonthlyKing();
  renderWriterStampTotal();
  renderCalendar();
  renderHistory();
}

function renderSubmitTasks() {
  const today = localDateKey();
  const pending = [
    ...dailyHomeworkTasksForToday().filter((task) => !task.done),
    ...state.writerTasks.filter((task) => homeworkDateKey(task) === today && !taskIsCompleted(task))
  ];
  $('#submitTask').innerHTML = pending.length
    ? pending.map((task) => `<option value="${task.id}">${esc(task.title)}${task.source === 'daily' ? ' · 매일 숙제' : ''}</option>`).join('')
    : '<option value="free">자유 숙제 인증</option>';
}

function renderCalendar() {
  const currentMonth = calendarMonthKey();
  const [year, monthNumber] = currentMonth.split('-').map(Number);
  const firstWeekday = new Date(year, monthNumber - 1, 1).getDay();
  const totalDays = daysInMonth(currentMonth);

  const stamped = state.writerSubmissions.filter((item) => item.stamped && submissionCompletionDateKey(item).startsWith(currentMonth));
  const stampsByDate = new Map();
  stamped.forEach((item) => {
    const completedDateKey = submissionCompletionDateKey(item);
    const stamps = stampsByDate.get(completedDateKey) || [];
    stamps.push(item.stampType || '참잘했어요');
    stampsByDate.set(completedDateKey, stamps);
  });

  const monthSchedules = state.writerSchedules.filter((item) => String(item.dateKey || '').startsWith(currentMonth));
  const schedulesByDate = new Map();
  monthSchedules.forEach((item) => {
    const schedules = schedulesByDate.get(item.dateKey) || [];
    schedules.push(item);
    schedulesByDate.set(item.dateKey, schedules);
  });

  $('#monthBadge').textContent = monthLabel(currentMonth);
  $('#stampSummary').textContent = `${stamped.length} / ${MONTHLY_TARGET}개`;
  $('#scheduleListTitle').textContent = `${monthLabel(currentMonth)} 일정`;
  $('#prevCalendarMonth').disabled = false;
  $('#nextCalendarMonth').disabled = false;

  const nextSchedule = state.writerSchedules
    .filter((item) => !item.completed && String(item.dateKey || '') >= localDateKey())
    .sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)))[0];
  const dday = $('#scheduleDday');
  if (nextSchedule) {
    const color = scheduleColorMeta(nextSchedule.colorKey);
    dday.innerHTML = `<span class="dday-badge" style="--schedule-accent:${color.accent}">${esc(ddayLabel(nextSchedule.dateKey))}</span><button type="button" class="dday-title" data-open-schedule="${esc(nextSchedule.id)}">${esc(nextSchedule.title)}</button>`;
    dday.style.display = 'flex';
  } else {
    dday.innerHTML = '';
    dday.style.display = 'none';
  }

  const cells = [];
  for (let index = 0; index < firstWeekday; index += 1) cells.push('<div class="calendar-empty" aria-hidden="true"></div>');
  for (let day = 1; day <= totalDays; day += 1) {
    const date = dateInMonth(currentMonth, day);
    const dayStamps = stampsByDate.get(date) || [];
    const daySchedules = schedulesByDate.get(date) || [];
    const activeSchedules = daySchedules.filter((schedule) => !schedule.completed);
    const classes = ['calendar-day'];
    if (dayStamps.length) classes.push('has-stamp');
    if (daySchedules.length) classes.push('has-schedule');
    if (daySchedules.length && !activeSchedules.length) classes.push('schedules-completed');
    if (date === localDateKey()) classes.push('today');
    if ((firstWeekday + day - 1) % 7 === 0) classes.push('sunday');
    if ((firstWeekday + day - 1) % 7 === 6) classes.push('saturday');

    const flowers = dayStamps.length
      ? `${renderStampSeal(dayStamps[0])}<span class="stamp-count" aria-label="칭찬 도장 ${dayStamps.length}개">${dayStamps.length}</span>`
      : '';
    const cellColor = (activeSchedules[0] || daySchedules[0]) ? scheduleColorMeta((activeSchedules[0] || daySchedules[0]).colorKey) : null;
    const cellStyle = cellColor ? ` style="--calendar-schedule-color:${cellColor.accent};--calendar-schedule-soft:${cellColor.soft}"` : '';
    const scheduleDots = daySchedules.slice(0, 2).map((schedule) => {
      const color = scheduleColorMeta(schedule.colorKey);
      return `<button type="button" class="calendar-schedule-dot ${schedule.completed ? 'completed' : ''}" data-open-schedule="${esc(schedule.id)}" title="${esc(schedule.completed ? `완료 · ${schedule.title}` : schedule.title)}" aria-label="${esc(schedule.title)} 일정 수정" style="--schedule-color:${color.accent}">${schedule.completed ? '✓' : ''}</button>`;
    }).join('');
    const scheduleExtra = daySchedules.length > 2 ? `<span class="schedule-more">+${daySchedules.length - 2}</span>` : '';
    const preview = daySchedules.map((schedule) => schedule.title).join(' · ');
    cells.push(`<div class="${classes.join(' ')}"${cellStyle} data-create-schedule-date="${date}" title="${esc(preview || `${day}일 일정 등록`)}" role="button" tabindex="0" aria-label="${day}일 ${preview || '일정 등록'}"><span class="day-number">${day}</span><div class="day-stamps">${flowers}</div><div class="calendar-schedules">${scheduleDots}${scheduleExtra}</div></div>`);
  }
  $('#stampBoard').innerHTML = cells.join('');
  renderScheduleList(monthSchedules);
}

function renderScheduleList(schedules) {
  const list = $('#scheduleList');
  const count = $('#scheduleCount');
  if (!list || !count) return;
  const completedCount = schedules.filter((schedule) => schedule.completed).length;
  count.textContent = completedCount ? `${schedules.length}개 · 완료 ${completedCount}개` : `${schedules.length}개`;
  list.innerHTML = schedules.length
    ? schedules.map((schedule) => {
      const color = scheduleColorMeta(schedule.colorKey);
      const completionText = schedule.completed ? '완료' : ddayLabel(schedule.dateKey);
      return `<div class="schedule-list-item ${schedule.completed ? 'completed' : ''}" data-open-schedule="${esc(schedule.id)}" role="button" tabindex="0" style="--schedule-color:${color.accent};--schedule-soft:${color.soft}">
        <button type="button" class="schedule-complete-toggle ${schedule.completed ? 'completed' : ''}" data-toggle-schedule-complete="${esc(schedule.id)}" aria-label="${esc(schedule.title)} 일정 ${schedule.completed ? '미완료로 변경' : '완료 처리'}">${schedule.completed ? '✓' : ''}</button>
        <span class="schedule-list-date">${esc(schedule.dateKey.slice(8))}일</span>
        <span class="schedule-list-title">${esc(schedule.title)}</span>
        <span class="schedule-list-dday">${esc(completionText)}</span>
      </div>`;
    }).join('')
    : '<div class="schedule-empty">등록한 일정이 없어요.</div>';
}

function renderHistory() {
  const history = state.writerSubmissions.filter((item) => item.stamped).slice(0, 30);
  $('#historyCount').textContent = `최근 ${history.length}개`;
  $('#historyList').innerHTML = history.length ? history.map((item, index) => {
    const feedback = String(item.feedback || '').trim();
    return `<div class="history-item ${feedback ? 'has-feedback' : ''}">
      <div class="history-icon">${renderStampSeal(item.stampType || '참잘했어요', index % 2 === 1)}</div>
      <div class="history-copy">
        <div class="history-title-row"><strong>${esc(item.taskTitle || '자유 숙제')}</strong><span class="history-date">${esc(formatDate(item.createdAt || item.stampAt))}</span></div>
        <span class="history-text">${esc(item.text || '')}</span>
        ${feedback ? `<div class="writer-feedback"><span class="writer-feedback-label">💌 리로의 답장</span><p>${esc(feedback)}</p></div>` : ''}
      </div>
    </div>`;
  }).join('') : '<div class="empty">아직 완료 기록이 없어요. 첫 번째 오늘의 숙제를 남겨 볼까요? 🌱</div>';
}

function submissionDedupeKey(submission) {
  const writerKey = String(submission?.writerKey || '');
  const taskId = String(submission?.taskId || '');
  return writerKey && taskId ? `${writerKey}::${taskId}` : '';
}

function stampedTwinMap(submissions = state.adminSubmissions) {
  const map = new Map();
  submissions
    .filter((submission) => submission.stamped && submissionDedupeKey(submission))
    .forEach((submission) => {
      const key = submissionDedupeKey(submission);
      const existing = map.get(key);
      if (!existing || timestampValue(submission.stampAt || submission.createdAt) > timestampValue(existing.stampAt || existing.createdAt)) {
        map.set(key, submission);
      }
    });
  return map;
}

function adminSubmissionDisplayRows() {
  const stampedByTask = stampedTwinMap();
  return state.adminSubmissions.map((submission) => {
    const key = submissionDedupeKey(submission);
    const twin = !submission.stamped && key ? stampedByTask.get(key) : null;
    return { ...submission, duplicateStampedBy: twin || null };
  });
}

function renderAdmin() {
  if (!isAdmin()) return;
  $('#adminState').textContent = `인증됨 · ${ADMIN_EMAIL}`;

  const displaySubmissions = adminSubmissionDisplayRows();
  const actionableSubmissions = displaySubmissions.filter((item) => !item.duplicateStampedBy);
  const pending = actionableSubmissions.filter((item) => !item.stamped);
  $('#pendingBadge').textContent = `미확인 ${pending.length}건`;

  const currentMonth = monthKey();
  const monthly = actionableSubmissions.filter((item) => item.stamped && submissionCompletionDateKey(item).startsWith(currentMonth));
  $('#completedWriters').textContent = `${new Set(monthly.map((item) => item.writerKey || item.writerUid)).size}명`;
  $('#monthlyStamps').textContent = `${monthly.length}개`;

  const taskCounts = {};
  actionableSubmissions
    .filter((item) => String(item.createdDateKey || '').startsWith(currentMonth))
    .forEach((item) => { taskCounts[item.taskTitle] = (taskCounts[item.taskTitle] || 0) + 1; });
  $('#popularTask').textContent = Object.entries(taskCounts).sort((a, b) => b[1] - a[1])[0]?.[0]?.slice(0, 16) || '오늘의 숙제';

  renderAdminMonthlyKing();
  renderDailyHomeworkStatus();
  renderAdminMonthlyReport();

  $('#submissionList').innerHTML = displaySubmissions.length ? displaySubmissions.map((item) => {
    const source = item.taskSource || 'self';
    const sourceLabel = source === 'daily' ? '매일 자동' : (source === 'self' ? '직접 정함' : '관리자 배정');
    const duplicate = item.duplicateStampedBy;
    const actions = duplicate
      ? `<span class="badge duplicate-badge">동일 숙제 도장 완료</span><span class="duplicate-note">${esc(formatDate(duplicate.stampAt || duplicate.createdAt))} 인증이 이미 도장 처리됐어요.</span>`
      : (item.stamped
        ? `<span class="badge">${esc(item.stampType || '🌸')} 도장 완료</span>${item.feedback ? `<button type="button" class="mini-btn" data-view-feedback="${item.id}">답장 보기</button>` : ''}`
        : `<button type="button" class="stamp-btn" data-stamp="${item.id}">칭찬 도장 찍기</button><button type="button" class="mini-btn" data-quick-stamp="${item.id}">“좋았어요!”</button>`);

    return `<div class="submission ${item.stamped ? 'is-done' : ''} ${duplicate ? 'is-duplicate' : ''}">
      <div class="submission-meta">
        <div class="writer"><span class="avatar">${esc(item.writerEmoji || '🌱')}</span>${esc(item.writerNickname || '작가')} 작가님</div>
        <span class="time">${esc(formatDate(item.createdAt))}</span>
      </div>
      <div class="submission-task"><span class="source-badge ${source}">${sourceLabel}</span>✎ ${esc(item.taskTitle || '자유 숙제')}</div>
      <p class="submission-text">${esc(item.text || '')}</p>
      ${item.blocker ? `<div class="submission-proof">💭 막힌 곳: ${esc(item.blocker)}</div>` : ''}
      ${item.imagePath ? `<div class="submission-actions"><button type="button" class="proof-btn" data-open-proof="${esc(item.imagePath)}" data-proof-caption="${esc(item.writerNickname || '작가')} 작가님의 인증 사진">사진 보기</button></div>` : ''}
      <div class="submission-actions">${actions}</div>
    </div>`;
  }).join('') : '<div class="empty">아직 확인할 인증이 없어요. 오늘도 다정한 감독님 휴식 시간! ☕</div>';

  const groupedAssignments = [];
  const groupMap = new Map();
  state.adminTasks.filter((task) => (task.source || 'admin') === 'admin').forEach((task) => {
    const groupId = task.assignmentScope === 'all' && task.assignmentGroupId ? task.assignmentGroupId : null;
    const groupKey = groupId ? `all:${groupId}` : `single:${task.writerKey}:${task.id}`;
    if (!groupMap.has(groupKey)) {
      const item = { representative: task, count: 0, groupId };
      groupMap.set(groupKey, item);
      groupedAssignments.push(item);
    }
    groupMap.get(groupKey).count += 1;
  });
  $('#assignmentList').innerHTML = groupedAssignments.length ? groupedAssignments.slice(0, 40).map(({ representative: task, count, groupId }) => {
    const isAll = Boolean(groupId);
    const target = isAll ? `전체 작가님 · ${count}명` : `${task.writerNickname || '작가'} 작가님`;
    const scope = isAll ? '전체 숙제' : ((task.source || 'admin') === 'self' ? '직접 정함' : '개별 숙제');
    return `<div class="assignment-line"><span><b>${esc(target)}</b> <em class="source-badge ${isAll ? 'admin' : ((task.source || 'admin') === 'self' ? 'self' : 'admin')}">${esc(scope)}</em> · ${esc(task.title)}</span><button type="button" data-remove-admin-task="${task.id}" aria-label="숙제 삭제">×</button></div>`;
  }).join('') : '<div class="empty">배정된 숙제가 없어요.</div>';
  renderAssignmentTargetButtons();
}

// 닉네임 하나로 숙제장에 들어가는 실제 절차입니다.
// 폼 제출(signInWriter)과 작업방 자동 입장이 이 함수를 함께 씁니다.
// 성공하면 true, 실패하면 false를 돌려줍니다.
async function signInWriterWithName(rawName, rawEmoji, { button = null, errorPrefix = '' } = {}) {
  const name = displayNickname(rawName || '');
  const writerKey = normalizeNickname(name);
  const requestedEmoji = normalizeWriterEmoji(rawEmoji, '');

  if (!name || !writerKey) {
    toast('작가 닉네임을 넣어 주세요 🌷');
    return false;
  }

  setButtonBusy(button, true, '숙제장 여는 중…');

  try {
    if (auth.currentUser && !auth.currentUser.isAnonymous) await signOut(auth);
    const user = auth.currentUser?.isAnonymous ? auth.currentUser : (await signInAnonymously(auth)).user;

    const canonicalRef = profilePath(writerKey);
    const canonicalSnap = await getDoc(canonicalRef);
    const existingCanonical = canonicalSnap.exists() ? canonicalSnap.data() : null;
    const emoji = requestedEmoji || normalizeWriterEmoji(existingCanonical?.emoji, emojiFor(name));

    const profileForWriter = {
      ...(existingCanonical || {}),
      nickname: name,
      nicknameLower: writerKey,
      writerKey,
      emoji,
      role: 'writer',
      profileVersion: 2,
      createdAt: existingCanonical?.createdAt || serverTimestamp(),
      updatedAt: serverTimestamp()
    };

    const batch = writeBatch(db);
    batch.set(canonicalRef, profileForWriter, { merge: true });
    batch.set(writerSessionPath(user.uid), {
      writerKey,
      storageVersion: 1,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });

    // v18 이하가 남긴 UID 기반 프로필은 현재 사용자 것이면 함께 정리합니다.
    if (user.uid !== writerKey) {
      const legacyRef = profilePath(user.uid);
      const legacySnap = await getDoc(legacyRef);
      if (legacySnap.exists() && (legacySnap.data().writerKey || normalizeNickname(legacySnap.data().nickname)) === writerKey) {
        batch.delete(legacyRef);
      }
    }

    await batch.commit();
    activateWriter(user.uid, {
      ...(existingCanonical || {}),
      nickname: name,
      nicknameLower: writerKey,
      writerKey,
      emoji,
      role: 'writer',
      profileVersion: 2
    });
    return true;
  } catch (error) {
    console.error(error);
    toast(`${errorPrefix}${friendlyError(error)}`);
    return false;
  } finally {
    setButtonBusy(button, false);
  }
}

async function signInWriter(event) {
  event.preventDefault();
  await signInWriterWithName($('#nicknameInput').value, $('#emojiInput').value, {
    button: $('#nicknameForm button[type="submit"]')
  });
}

async function adminAuth(mode) {
  const email = $('#adminEmail').value.trim().toLowerCase();
  const password = $('#adminPassword').value;
  if (!email || !password) { toast('관리자 이메일과 비밀번호를 입력해 주세요.'); return; }
  if (email !== ADMIN_EMAIL.toLowerCase()) { toast('등록된 관리자 이메일이 아니에요.'); return; }
  const button = mode === 'create' ? $('#createAdmin') : $('#signInAdmin');
  setButtonBusy(button, true, mode === 'create' ? '계정 만드는 중…' : '로그인 중…');
  try {
    if (auth.currentUser) await signOut(auth);
    if (mode === 'create') await createUserWithEmailAndPassword(auth, email, password);
    else await signInWithEmailAndPassword(auth, email, password);
    $('#adminPassword').value = '';
    closeModal('adminAuthModal');
  } catch (error) {
    console.error(error);
    toast(friendlyError(error));
  } finally {
    setButtonBusy(button, false);
  }
}

function setSelectedScheduleColor(colorKey) {
  state.selectedScheduleColor = SCHEDULE_COLORS[colorKey] ? colorKey : 'coral';
  $$('#scheduleColors [data-schedule-color]').forEach((button) => {
    const selected = button.dataset.scheduleColor === state.selectedScheduleColor;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
}

function openScheduleModal(scheduleId = null, dateKey = calendarDefaultDate()) {
  const schedule = scheduleId ? state.writerSchedules.find((item) => item.id === scheduleId) : null;
  state.activeScheduleId = schedule?.id || null;
  $('#scheduleModalTitle').textContent = schedule ? '일정 수정' : '일정 등록';
  $('#scheduleDate').value = schedule?.dateKey || dateKey || localDateKey();
  $('#scheduleTitle').value = schedule?.title || '';
  $('#scheduleCompleted').checked = Boolean(schedule?.completed);
  setSelectedScheduleColor(schedule?.colorKey || 'coral');
  $('#deleteSchedule').style.display = schedule ? 'inline-flex' : 'none';
  openModal('scheduleModal');
  setTimeout(() => $('#scheduleTitle').focus(), 0);
}

async function saveSchedule() {
  if (!state.user || !state.profile) return;
  const dateKey = $('#scheduleDate').value;
  const title = $('#scheduleTitle').value.trim();
  if (!dateKey) { toast('일정을 등록할 날짜를 골라 주세요.'); return; }
  if (!title) { toast('일정을 한 줄로 적어 주세요.'); $('#scheduleTitle').focus(); return; }

  const button = $('#saveSchedule');
  setButtonBusy(button, true, '저장 중…');
  try {
    if (state.activeScheduleId) {
      await updateDoc(writerSchedulePath(state.profile.writerKey, state.activeScheduleId), {
        dateKey,
        title,
        colorKey: state.selectedScheduleColor,
        completed: Boolean($('#scheduleCompleted').checked),
        updatedAt: serverTimestamp()
      });
      toast('일정을 수정했어요.');
    } else {
      await addDoc(writerSchedulesPath(state.profile.writerKey), {
        writerUid: state.user.uid,
        writerKey: state.profile.writerKey,
        writerNickname: state.profile.nickname,
        dateKey,
        title,
        colorKey: state.selectedScheduleColor,
        completed: Boolean($('#scheduleCompleted').checked),
        storageVersion: 1,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      toast('달력에 일정을 등록했어요.');
    }
    closeModal('scheduleModal');
  } catch (error) {
    console.error(error);
    toast(friendlyError(error));
  } finally {
    setButtonBusy(button, false);
  }
}

async function deleteSchedule() {
  if (!state.activeScheduleId || !state.profile) return;
  const button = $('#deleteSchedule');
  setButtonBusy(button, true, '삭제 중…');
  try {
    await deleteDoc(writerSchedulePath(state.profile.writerKey, state.activeScheduleId));
    closeModal('scheduleModal');
    toast('일정을 지웠어요.');
  } catch (error) {
    console.error(error);
    toast(friendlyError(error));
  } finally {
    setButtonBusy(button, false);
  }
}

async function saveSelfTask() {
  if (!state.user || !state.profile) return;
  const title = $('#selfTaskInput').value.trim();
  if (!title) { toast('오늘 내가 해볼 숙제를 한 줄로 적어 주세요 ✍️'); $('#selfTaskInput').focus(); return; }
  const button = $('#saveSelfTask');
  setButtonBusy(button, true, '저장 중…');
  try {
    await addDoc(writerTasksPath(state.profile.writerKey), {
      writerUid: state.user.uid,
      writerKey: state.profile.writerKey,
      writerNickname: state.profile.nickname,
      title,
      source: 'self',
      assignmentScope: 'self',
      assignedDateKey: localDateKey(),
      done: false,
      storageVersion: 3,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      submittedAt: null
    });
    $('#selfTaskInput').value = '';
    closeModal('selfTaskModal');
    toast('오늘의 나만의 숙제를 정했어요. 아주 좋아요 🌱');
  } catch (error) { toast(friendlyError(error)); } finally { setButtonBusy(button, false); }
}

function resetProofSelection() {
  state.selectedProofFile = null;
  if (state.selectedProofPreviewUrl) URL.revokeObjectURL(state.selectedProofPreviewUrl);
  state.selectedProofPreviewUrl = null;
  $('#proofFile').value = '';
  $('#proofPreview').src = '';
  $('#proofPreview').style.display = 'none';
}

async function compressImage(file) {
  if (!file.type.startsWith('image/')) throw new Error('이미지 파일만 첨부할 수 있어요.');
  if (file.size > MAX_UPLOAD_BYTES) throw new Error('사진은 5MB 이하만 올릴 수 있어요.');
  const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
  const image = await new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = dataUrl; });
  const maxSize = 1600;
  const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('사진을 처리하지 못했어요.')), 'image/jpeg', 0.82));
}

async function submitHomework() {
  if (!state.user || !state.profile) return;

  const taskId = $('#submitTask').value;
  const task = taskForSubmission(taskId);
  const text = $('#submitText').value.trim();
  const blocker = $('#blockerText').value.trim();
  if (!text) {
    toast('완료 기록을 한 줄만 남겨 주세요 🌱');
    $('#submitText').focus();
    return;
  }

  if (task && taskIsCompleted(task)) {
    closeModal('submitModal');
    toast('이 숙제는 이미 인증되어 완료 처리되어 있어요 ✓');
    return;
  }

  const button = $('#submitHomework');
  setButtonBusy(button, true, state.selectedProofFile ? '사진과 기록 저장 중…' : '인증 저장 중…');

  try {
    // 숙제별로 같은 인증 문서 ID를 사용해 같은 과제가 두 번 생성되지 않게 합니다.
    const submissionRef = task
      ? doc(writerSubmissionsPath(state.profile.writerKey), submissionDocumentIdForTask(task.id))
      : doc(writerSubmissionsPath(state.profile.writerKey));

    if (task) {
      const existing = await getDoc(submissionRef);
      if (existing.exists()) {
        closeModal('submitModal');
        toast('이미 같은 숙제 인증이 남아 있어요. 완료 상태를 확인해 주세요 ✓');
        return;
      }
    }

    let imagePath = null;
    if (state.selectedProofFile) {
      const compressed = await compressImage(state.selectedProofFile);
      // 인증샷은 익명 UID가 아니라 writerKey(닉네임) 아래에 넣습니다.
      // UID는 프로젝트를 옮기거나 브라우저를 바꾸면 새로 발급돼 옛 사진이 미아가 됩니다.
      // Storage 규칙은 writerSessions/{내 uid}.writerKey === 이 writerKey 일 때만 허용합니다.
      imagePath = `proofs/${state.profile.writerKey}/${submissionRef.id}.jpg`;
      await uploadBytes(ref(storage, imagePath), compressed, { contentType: 'image/jpeg' });
    }

    const completionDateKey = task?.source === 'daily' && isDateKey(task.dailyDateKey)
      ? task.dailyDateKey
      : localDateKey();

    const batch = writeBatch(db);
    batch.set(submissionRef, {
      writerUid: state.user.uid,
      writerKey: state.profile.writerKey,
      writerNickname: state.profile.nickname,
      writerEmoji: state.profile.emoji || '🌱',
      taskId: task?.id || null,
      taskTitle: task?.title || '자유 숙제 인증',
      taskSource: task?.source || 'self',
      text,
      blocker: blocker || null,
      imagePath,
      stamped: false,
      stampType: null,
      feedback: null,
      stampAt: null,
      stampDateKey: null,
      // 자정을 넘긴 채 제출했더라도 선택했던 매일 숙제 날짜를 유지합니다.
      createdDateKey: completionDateKey,
      storageVersion: 3,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    if (task && !task.virtual) {
      batch.update(writerTaskPath(state.profile.writerKey, task.id), {
        done: true,
        submittedAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }

    await batch.commit();
    $('#submitText').value = '';
    $('#blockerText').value = '';
    resetProofSelection();
    closeModal('submitModal');
    toast('인증을 남겼어요! 관리자의 도장을 기다려 봅시다 ✦');
  } catch (error) {
    console.error(error);
    const duplicateWrite = task && (error?.code === 'permission-denied' || error?.code === 'already-exists');
    toast(duplicateWrite
      ? '이미 같은 숙제 인증이 저장되어 있어요. 완료 상태를 다시 확인해 주세요 ✓'
      : friendlyError(error));
  } finally {
    setButtonBusy(button, false);
  }
}

async function saveAssignment() {
  const writerKey = state.assignmentTargetKey;
  const title = $('#assignmentTask').value.trim();
  const writers = distinctWriterProfiles();
  const button = $('#saveAssignment');
  if (!title) { toast('숙제 내용을 적어 주세요 📝'); $('#assignmentTask').focus(); return; }
  if (!writerKey) { toast('숙제를 받을 작가님을 골라 주세요.'); return; }

  const isAllAssignment = writerKey === '__all__';
  const targets = isAllAssignment
    ? writers
    : writers.filter((writer) => writer.writerKey === writerKey);

  if (!targets.length) {
    toast(isAllAssignment ? '전체 숙제를 받을 등록 작가님이 아직 없어요.' : '숙제를 받을 작가님을 찾지 못했어요.');
    return;
  }

  setButtonBusy(button, true, isAllAssignment ? '전체 배정 중…' : '배정 중…');
  try {
    const assignmentGroupId = isAllAssignment ? createAssignmentGroupId() : null;
    const operations = targets.map((writer) => (batch) => {
      const taskRef = doc(writerTasksPath(writer.writerKey));
      batch.set(taskRef, {
        writerUid: writer.id,
        writerKey: writer.writerKey,
        writerNickname: writer.nickname,
        title,
        source: 'admin',
        assignmentScope: isAllAssignment ? 'all' : 'individual',
        assignmentGroupId,
        assignedDateKey: localDateKey(),
        done: false,
        storageVersion: 3,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        submittedAt: null
      });
    });
    await commitOperations(operations);
    $('#assignmentTask').value = '';
    closeModal('assignmentModal');
    toast(isAllAssignment
      ? `전체 작가님 ${targets.length}명에게 숙제를 배정했어요.`
      : `${targets[0].nickname} 작가님에게 숙제를 배정했어요.`);
  } catch (error) {
    console.error(error);
    toast(friendlyError(error));
  } finally {
    setButtonBusy(button, false);
  }
}

function openStamp(submissionId, quick = false) {
  const submission = state.adminSubmissions.find((item) => item.id === submissionId);
  if (!submission) return;
  state.activeStampId = submissionId;
  $('#stampTitle').textContent = `${submission.writerNickname || '작가'} 작가님에게 칭찬 도장`;
  $('#stampTaskText').textContent = `✎ ${submission.taskTitle || '자유 숙제 인증'}`;
  $('#stampType').value = stampMeta(submission.stampType || '참잘했어요').full;
  $('#feedbackText').value = quick ? '좋았어요! 오늘의 숙제를 해낸 힘이 다음 원고를 만들어요.' : (submission.feedback || '');
  openModal('stampModal');
}

async function saveStamp() {
  const submission = state.adminSubmissions.find((item) => item.id === state.activeStampId);
  if (!submission) return;
  if (submission.stamped) {
    closeModal('stampModal');
    toast('이미 도장 처리된 인증이에요 ✓');
    return;
  }

  const button = $('#saveStamp');
  const completionDateKey = submissionCompletionDateKey(submission);
  setButtonBusy(button, true, '도장 찍는 중…');
  try {
    await waitForWrite(updateDoc(writerSubmissionPath(submission.writerKey, submission.id), {
      stamped: true,
      stampType: $('#stampType').value,
      feedback: $('#feedbackText').value.trim() || null,
      stampAt: serverTimestamp(),
      // 도장을 늦게 찍어도 달력과 월간 집계는 인증을 남긴 날짜를 기준으로 합니다.
      stampDateKey: completionDateKey,
      updatedAt: serverTimestamp()
    }));
    closeModal('stampModal');
    state.activeStampId = null;
    toast(`${submission.writerNickname || '작가'} 작가님에게 칭찬 도장을 찍었어요!`);
  } catch (error) {
    console.error(error);
    toast(friendlyError(error));
  } finally {
    setButtonBusy(button, false);
  }
}

async function removeTask(taskId, ownOnly = false) {
  const task = ownOnly ? state.writerTasks.find((item) => item.id === taskId) : state.adminTasks.find((item) => item.id === taskId);
  if (!task) return;
  if (ownOnly && (task.source !== 'self' || task.done)) return;

  try {
    if (!ownOnly && task.assignmentScope === 'all' && task.assignmentGroupId) {
      const relatedTasks = state.adminTasks.filter((item) => item.assignmentScope === 'all' && item.assignmentGroupId === task.assignmentGroupId);
      await commitOperations(relatedTasks.map((item) => (batch) => batch.delete(writerTaskPath(item.writerKey, item.id))));
      toast(`전체 숙제 ${relatedTasks.length}건을 함께 지웠어요.`);
      return;
    }

    const writerKey = task.writerKey || state.profile?.writerKey;
    if (!writerKey) throw new Error('숙제 대상 작가 정보를 찾지 못했어요.');
    await deleteDoc(writerTaskPath(writerKey, taskId));
    toast(ownOnly ? '내가 정한 숙제를 지웠어요.' : '숙제를 지웠어요.');
  } catch (error) {
    console.error(error);
    toast(friendlyError(error));
  }
}

async function openProof(path, caption) {
  try {
    $('#proofCaption').textContent = caption || '';
    $('#proofImage').removeAttribute('src');
    openModal('proofModal');
    const url = await getDownloadURL(ref(storage, path));
    $('#proofImage').src = url;
  } catch (error) {
    closeModal('proofModal');
    toast(friendlyError(error));
  }
}

async function installApp() {
  if (!state.installPrompt) return;
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  renderTopActions();
}

$('#emojiInput').addEventListener('input', renderLoginEmojiPicker);
restoreWriterBrowserProfile();
renderLoginEmojiPicker();
$('#nicknameForm').addEventListener('submit', signInWriter);
$('#brandHome').addEventListener('click', () => { if (isAdmin()) showScreen('admin'); else if (state.profile) showScreen('writer'); else showScreen('login'); });
$('#openAdminLogin').addEventListener('click', () => openModal('adminAuthModal'));
$('#signInAdmin').addEventListener('click', () => adminAuth('signin'));
$('#createAdmin').addEventListener('click', () => adminAuth('create'));
$('#openSubmit').addEventListener('click', () => openModal('submitModal'));
$('#openSchedule').addEventListener('click', () => openScheduleModal());
$('#prevCalendarMonth').addEventListener('click', () => moveCalendarMonth(-1));
$('#nextCalendarMonth').addEventListener('click', () => moveCalendarMonth(1));
$('#prevAdminReportMonth').addEventListener('click', () => moveAdminReportMonth(-1));
$('#nextAdminReportMonth').addEventListener('click', () => moveAdminReportMonth(1));
$('#saveSchedule').addEventListener('click', saveSchedule);
$('#deleteSchedule').addEventListener('click', deleteSchedule);
$('#submitHomework').addEventListener('click', submitHomework);
$('#saveSelfTask').addEventListener('click', saveSelfTask);
$('#openAssignment').addEventListener('click', () => { state.assignmentTargetKey = '__all__'; renderAssignmentTargetButtons(); openModal('assignmentModal'); });
$('#openDailyHomework').addEventListener('click', openDailyHomeworkModal);
$('#openDailyHomeworkFromCard').addEventListener('click', openDailyHomeworkModal);
$('#saveDailyHomework').addEventListener('click', saveDailyHomework);
$('#clearDailyHomework').addEventListener('click', clearDailyHomework);
$('#saveAssignment').addEventListener('click', saveAssignment);
$('#saveMonthlyKing').addEventListener('click', saveMonthlyKing);
$('#clearMonthlyKing').addEventListener('click', clearMonthlyKing);
$('#saveStamp').addEventListener('click', saveStamp);
$('#proofFile').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (!file) { resetProofSelection(); return; }
  if (!file.type.startsWith('image/')) { toast('이미지 파일만 첨부할 수 있어요.'); resetProofSelection(); return; }
  state.selectedProofFile = file;
  if (state.selectedProofPreviewUrl) URL.revokeObjectURL(state.selectedProofPreviewUrl);
  state.selectedProofPreviewUrl = URL.createObjectURL(file);
  $('#proofPreview').src = state.selectedProofPreviewUrl;
  $('#proofPreview').style.display = 'block';
});
$$('[data-close]').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.close)));
$$('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeModal(backdrop.id); }));
document.addEventListener('click', (event) => {
  const loginEmoji = event.target.closest('[data-login-emoji]');
  const assignmentTarget = event.target.closest('[data-assignment-target]');
  const deleteWriter = event.target.closest('[data-delete-writer]');
  const scheduleColor = event.target.closest('[data-schedule-color]');
  const toggleSchedule = event.target.closest('[data-toggle-schedule-complete]');
  const openSchedule = event.target.closest('[data-open-schedule]');
  const createSchedule = event.target.closest('[data-create-schedule-date]');
  if (loginEmoji) {
    chooseLoginEmoji(loginEmoji.dataset.loginEmoji);
    return;
  }
  if (assignmentTarget) {
    state.assignmentTargetKey = assignmentTarget.dataset.assignmentTarget;
    renderAssignmentTargetButtons();
    return;
  }
  if (deleteWriter) {
    deleteWriterNickname(deleteWriter.dataset.deleteWriter, deleteWriter);
    return;
  }
  if (scheduleColor) {
    setSelectedScheduleColor(scheduleColor.dataset.scheduleColor);
    return;
  }
  if (toggleSchedule) {
    toggleScheduleCompleted(toggleSchedule.dataset.toggleScheduleComplete);
    return;
  }
  if (openSchedule) {
    openScheduleModal(openSchedule.dataset.openSchedule);
    return;
  }
  if (createSchedule) {
    openScheduleModal(null, createSchedule.dataset.createScheduleDate);
    return;
  }
  const selfTask = event.target.closest('[data-open-self-task]');
  const ownDelete = event.target.closest('[data-remove-own-task]');
  const adminDelete = event.target.closest('[data-remove-admin-task]');
  const stamp = event.target.closest('[data-stamp]');
  const quickStamp = event.target.closest('[data-quick-stamp]');
  const feedback = event.target.closest('[data-view-feedback]');
  const proof = event.target.closest('[data-open-proof]');
  if (selfTask) openModal('selfTaskModal');
  if (ownDelete) removeTask(ownDelete.dataset.removeOwnTask, true);
  if (adminDelete) removeTask(adminDelete.dataset.removeAdminTask, false);
  if (stamp) openStamp(stamp.dataset.stamp);
  if (quickStamp) openStamp(quickStamp.dataset.quickStamp, true);
  if (feedback) {
    const submission = state.adminSubmissions.find((item) => item.id === feedback.dataset.viewFeedback);
    if (submission?.feedback) toast(`💌 ${submission.feedback}`);
  }
  if (proof) openProof(proof.dataset.openProof, proof.dataset.proofCaption);
});

document.addEventListener('keydown', (event) => {
  const dateCell = event.target.closest?.('[data-create-schedule-date]');
  const scheduleItem = event.target.closest?.('[data-open-schedule]');
  if (dateCell && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    openScheduleModal(null, dateCell.dataset.createScheduleDate);
    return;
  }
  if (scheduleItem && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    openScheduleModal(scheduleItem.dataset.openSchedule);
  }
});

window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); state.installPrompt = event; renderTopActions(); });
window.addEventListener('appinstalled', () => { state.installPrompt = null; renderTopActions(); toast('숙제장을 앱으로 설치했어요 🌱'); });
// 2026-08-11: 서비스워커 등록을 없앴습니다.
// 이 앱은 이제 작업방(/makkeutma__room/)과 같은 오리진에 얹히는데, 그 자리에는
// 작업방 PWA의 서비스워커가 이미 등록돼 있습니다. 숙제장이 자기 워커를 또 등록하면
// scope가 겹쳐 작업방 캐시를 망가뜨릴 수 있어 sw.js와 manifest 링크를 함께 걷어냈습니다.

// ---------------------------------------------------------------------------
// 작업방(마끝마) 임베드 다리
// 작업방 안 iframe으로 열리면 닉네임 입력을 건너뛰고 작업방이 알려 준 닉네임으로
// 바로 들어갑니다. 이미 그 닉네임으로 작업방에 들어와 있기 때문입니다.
//   ① 숙제장 → 부모 : { type: 'MKM_HW_READY', v: 1 }
//   ② 부모 → 숙제장 : { type: 'MKM_HW_IDENTITY', v: 1, nickname, emoji? }
//   ③ 숙제장은 그 닉네임으로 signInWriterWithName 을 돌리고 게이트를 건너뜁니다.
// 같은 오리진 전제라 다른 오리진에서 온 메시지는 무조건 버립니다.
// ---------------------------------------------------------------------------
function postRoomReady() {
  try {
    window.parent.postMessage({ type: 'MKM_HW_READY', v: 1 }, location.origin);
  } catch (error) {
    console.warn('Room handshake send failed', error);
  }
}

// 화면은 그대로 두고 대기만 끝냅니다(자동 입장에 성공했을 때).
function closeEmbedGate() {
  embedIdentityPending = false;
  embedLoginSuppressed = false;
  if (embedIdentityTimer) {
    clearTimeout(embedIdentityTimer);
    embedIdentityTimer = null;
  }
}

// 대기를 끝내고, 아직 아무 데도 못 들어갔으면 닉네임 입력 화면으로 돌려보냅니다.
function releaseEmbedGate({ showLogin = false } = {}) {
  const suppressed = embedLoginSuppressed;
  closeEmbedGate();
  if (state.profile || isAdmin()) return;
  if (!showLogin && !suppressed) return;
  restoreWriterBrowserProfile({ force: true });
  renderLoginEmojiPicker();
  showScreen('login');
}

async function handleRoomIdentity(data) {
  if (embedIdentityHandled) return;
  embedIdentityHandled = true;

  const nickname = displayNickname(data?.nickname || '');
  const writerKey = normalizeNickname(nickname);

  // 관리자 이메일로 로그인해 둔 상태면 관리함을 그대로 둡니다.
  // 닉네임이 비어 있거나 이미 같은 작가로 들어와 있으면 다시 로그인할 이유가 없습니다.
  if (!nickname || !writerKey || isAdmin() || state.profile?.writerKey === writerKey) {
    releaseEmbedGate();
    return;
  }

  const signedIn = await signInWriterWithName(nickname, data?.emoji, {
    errorPrefix: '작업방 닉네임으로 자동 입장하지 못했어요. '
  });
  // 성공했으면 화면은 이미 숙제장으로 넘어가 있습니다. 이때 onAuthStateChanged 가
  // 아직 돌고 있어 state.profile 이 잠깐 비어 보일 수 있으므로, 로그인 화면을
  // 다시 띄우는 판단을 아예 건너뛰고 대기만 닫습니다.
  if (signedIn) {
    closeEmbedGate();
    return;
  }
  releaseEmbedGate({ showLogin: true });
}

function initRoomEmbedBridge() {
  if (!IS_EMBEDDED) return;

  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.type !== 'MKM_HW_IDENTITY' || data.v !== 1) return;
    handleRoomIdentity(data);
  });

  embedIdentityTimer = setTimeout(() => {
    // 작업방이 구버전이라 응답이 없을 수 있습니다. 그때는 원래 닉네임 화면으로.
    if (!embedIdentityHandled) releaseEmbedGate();
  }, EMBED_IDENTITY_TIMEOUT_MS);

  postRoomReady();
  // 모듈 스크립트는 load 이벤트보다 먼저 돌아서, 부모가 아직 듣기 전일 수 있습니다.
  window.addEventListener('load', () => { if (embedIdentityPending) postRoomReady(); }, { once: true });
}

initRoomEmbedBridge();

async function bootAuth() {
  try {
    await setPersistence(auth, browserLocalPersistence);
  } catch (error) {
    console.warn('Persistence setup failed', error);
  }
  restoreWriterBrowserProfile();
  renderLoginEmojiPicker();
  onAuthStateChanged(auth, handleAuthChanged);
}
bootAuth();
