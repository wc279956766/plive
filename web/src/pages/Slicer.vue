<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api.js';

const route = useRoute();
const router = useRouter();

const recordings = ref([]);
const recordingId = ref(null);
const recording = computed(() =>
  recordings.value.find(r => r.id === recordingId.value));

const video = ref(null);
const duration = ref(0);
const currentTime = ref(0);

// 代理预览状态
const proxyState = ref(null);   // { state: 'missing'|'generating'|'ready', percent }
let proxyPoller = null;

async function loadProxy(recId) {
  // 停掉之前的轮询
  if (proxyPoller) { clearInterval(proxyPoller); proxyPoller = null; }
  // 状态查询
  let st = await api.proxyStatus(recId);
  proxyState.value = st;
  if (st.state === 'ready') {
    await nextTick();
    if (video.value) video.value.src = `/api/recordings/${recId}/proxy`;
    return;
  }
  // 不存在则触发生成
  if (st.state === 'missing') {
    try { st = await api.proxyGenerate(recId); proxyState.value = st; }
    catch (e) { proxyState.value = { state: 'error', error: e.message }; return; }
  }
  // 轮询
  proxyPoller = setInterval(async () => {
    if (recordingId.value !== recId) {
      clearInterval(proxyPoller); proxyPoller = null; return;
    }
    try {
      const s = await api.proxyStatus(recId);
      proxyState.value = s;
      if (s.state === 'ready') {
        clearInterval(proxyPoller); proxyPoller = null;
        await nextTick();
        if (video.value) video.value.src = `/api/recordings/${recId}/proxy`;
      }
    } catch {}
  }, 3000);
}

const inMark = ref(null);
const outMark = ref(null);
const title = ref('');
const burnDanmaku = ref(false);

const submitting = ref(false);
const status = ref('');
const error = ref('');

function fmt(s) {
  if (!isFinite(s) || s == null) return '--:--:--.---';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(3);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(6,'0')}`;
}
function parseTime(str) {
  // 接受 hh:mm:ss(.ms) 或纯秒数
  if (!str) return null;
  const m = String(str).trim().match(/^(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m) return Number(str);
  const a = m[1] ? Number(m[1]) : 0;
  const b = m[2] ? Number(m[2]) : 0;
  const c = Number(m[3]);
  return a * 3600 + b * 60 + c;
}

async function loadRecordings() {
  const list = await api.listRecordings();
  recordings.value = list.filter(r => r.ended_at);
}

function selectRecording(id) {
  recordingId.value = id;
  router.replace({ query: { ...route.query, rec: id } });
  inMark.value = outMark.value = null;
  title.value = '';
  status.value = ''; error.value = '';
  loadProxy(id);
}

function setIn() { if (video.value) inMark.value = video.value.currentTime; }
function setOut() { if (video.value) outMark.value = video.value.currentTime; }
function jumpTo(t) { if (video.value) video.value.currentTime = t; }

const canSlice = computed(() =>
  recording.value && inMark.value != null && outMark.value != null &&
  outMark.value > inMark.value && title.value.trim());

async function slice() {
  if (!canSlice.value) return;
  submitting.value = true; error.value = '';
  status.value = burnDanmaku.value
    ? '切片+烧弹幕中…（重新编码，会比较慢）'
    : '切片中…（无损模式，关键帧对齐）';
  try {
    const r = await api.createSlice({
      source_recording_id: recording.value.id,
      start_sec: inMark.value,
      end_sec: outMark.value,
      title: title.value.trim(),
      burn_danmaku: burnDanmaku.value,
    });
    status.value = `完成：${(r.size_bytes / 1024 / 1024).toFixed(1)} MB${r.burn_danmaku ? '（带弹幕）' : ''}`;
    setTimeout(() => router.push('/slices'), 800);
  } catch (e) {
    error.value = e.message; status.value = '';
  } finally {
    submitting.value = false;
  }
}

function onLoadedMetadata() {
  duration.value = video.value?.duration || 0;
}
function onTimeUpdate() {
  currentTime.value = video.value?.currentTime || 0;
}

// 键盘快捷键：space 播停 / I 起点 / O 终点 / ←→ ±5s
function onKey(e) {
  if (['INPUT','TEXTAREA'].includes(e.target.tagName)) return;
  if (e.code === 'Space') { e.preventDefault();
    video.value && (video.value.paused ? video.value.play() : video.value.pause());
  } else if (e.key === 'ArrowLeft' && video.value) {
    video.value.currentTime = Math.max(0, video.value.currentTime - (e.shiftKey ? 10 : 5));
  } else if (e.key === 'ArrowRight' && video.value) {
    video.value.currentTime = Math.min(duration.value, video.value.currentTime + (e.shiftKey ? 10 : 5));
  } else if (e.key === 'i' || e.key === 'I') setIn();
  else if (e.key === 'o' || e.key === 'O') setOut();
}

onMounted(async () => {
  await loadRecordings();
  const fromQuery = parseInt(route.query.rec, 10);
  if (Number.isInteger(fromQuery) && recordings.value.find(r => r.id === fromQuery)) {
    recordingId.value = fromQuery;
    loadProxy(fromQuery);
  }
  window.addEventListener('keydown', onKey);
});
onUnmounted(() => {
  if (proxyPoller) clearInterval(proxyPoller);
  window.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div class="slicer">
    <header>
      <select :value="recordingId" @change="selectRecording(Number($event.target.value))">
        <option :value="null" disabled>选择源录像…</option>
        <option v-for="r in recordings" :key="r.id" :value="r.id">
          [{{ r.room_id }}] {{ r.room_name }} — {{ new Date(r.started_at*1000).toLocaleString('zh-CN', { hour12: false }) }}
        </option>
      </select>
    </header>

    <main v-if="recording" class="player-area">
      <div class="player-wrap">
        <video ref="video"
               controls
               @loadedmetadata="onLoadedMetadata"
               @timeupdate="onTimeUpdate" />
        <div v-if="proxyState && proxyState.state !== 'ready'" class="proxy-overlay">
          <template v-if="proxyState.state === 'generating'">
            <div class="big">⏳ 正在生成预览…</div>
            <div class="small muted">{{ (proxyState.percent || 0).toFixed(1) }}% （480p 代理，仅用于浏览，不影响切片质量）</div>
            <div class="proxy-bar"><div class="fill" :style="{ width: (proxyState.percent || 0) + '%' }"></div></div>
          </template>
          <template v-else-if="proxyState.state === 'missing'">
            <div class="big">⚙ 准备生成预览…</div>
            <div class="small muted">第一次访问此录像，需生成 480p 代理（数分钟，VAAPI 加速）。</div>
          </template>
          <template v-else-if="proxyState.state === 'error'">
            <div class="big" style="color:#ff8080">✗ 预览生成失败</div>
            <div class="small">{{ proxyState.error }}</div>
          </template>
        </div>
      </div>

      <div class="time-display">
        <span>{{ fmt(currentTime) }}</span>
        <span class="muted"> / </span>
        <span>{{ fmt(duration) }}</span>
      </div>

      <div class="controls">
        <div class="row marks">
          <button @click="setIn">起点 [I]</button>
          <input :value="fmt(inMark)" @change="inMark = parseTime($event.target.value)"
                 :disabled="inMark == null" placeholder="--:--:--" />
          <button class="muted-btn" :disabled="inMark == null" @click="jumpTo(inMark)">→</button>

          <span class="sep" />

          <button @click="setOut">终点 [O]</button>
          <input :value="fmt(outMark)" @change="outMark = parseTime($event.target.value)"
                 :disabled="outMark == null" placeholder="--:--:--" />
          <button class="muted-btn" :disabled="outMark == null" @click="jumpTo(outMark)">→</button>

          <span class="sep" />

          <span class="muted">时长：{{ inMark != null && outMark != null ? fmt(outMark - inMark) : '—' }}</span>
        </div>

        <div class="row title-row">
          <label>切片名</label>
          <input v-model="title" placeholder="例如：精彩瞬间" />
        </div>

        <div class="row">
          <label class="inline">
            <input type="checkbox" v-model="burnDanmaku" />
            烧入弹幕（重编码，慢；不勾则保持纯净，快）
          </label>
        </div>

        <div class="row">
          <button class="primary big" :disabled="!canSlice || submitting" @click="slice">
            {{ submitting ? '切片中…' : '保存切片' }}
          </button>
          <span v-if="status" class="muted status">{{ status }}</span>
          <span v-if="error" class="error muted">{{ error }}</span>
        </div>
      </div>

      <p class="hint muted">空格 播停 · ← → ±5s（按 Shift ±10s）· I 设起点 · O 设终点</p>
    </main>

    <p v-else class="empty muted">选一个录像开始切片。</p>
  </div>
</template>

<style scoped>
.slicer { display: flex; flex-direction: column; gap: 12px; }
header { display: flex; gap: 12px; align-items: center; }
header select { flex: 1; max-width: 800px; }

.player-area { display: flex; flex-direction: column; gap: 8px; }
.player-wrap { position: relative; }
video { width: 100%; max-height: 60vh; background: #000; border-radius: 4px; display: block; }
.proxy-overlay {
  position: absolute; inset: 0; background: rgba(0,0,0,0.85);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; border-radius: 4px;
}
.proxy-overlay .big { font-size: 18px; font-weight: bold; padding: 0; background: none; }
.proxy-overlay .small { font-size: 13px; }
.proxy-bar { width: 60%; max-width: 400px; height: 8px; background: #1a1a1a;
             border: 1px solid #3c3c3c; border-radius: 3px; overflow: hidden; }
.proxy-bar .fill { height: 100%; background: #2d8c3c; transition: width .4s ease; }
.time-display { font-family: monospace; color: #ccc; padding: 0 4px; }

.controls { background: #252525; border: 1px solid #3c3c3c; border-radius: 4px; padding: 12px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.row:last-child { margin-bottom: 0; }
.marks input { width: 130px; font-family: monospace; }
.title-row label { color: #aaa; font-size: 12px; }
.title-row input { flex: 1; max-width: 480px; }
.row .inline { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.row .inline input[type="checkbox"] { width: 16px; height: 16px; }

.muted-btn { background: #1a1a1a; color: #aaa; padding: 4px 8px; }
.sep { width: 1px; height: 22px; background: #3c3c3c; margin: 0 4px; }

.big { padding: 8px 24px; font-size: 14px; font-weight: bold; background: #2d8c3c; border-color: #2d8c3c; }
.big:hover:not(:disabled) { background: #3aaa4d; }

.status { color: #80ffaa !important; }
.error { color: #ff8080 !important; }
.hint { font-size: 11px; padding-top: 4px; }
.empty { padding: 48px; text-align: center; }
</style>
