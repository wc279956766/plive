<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api.js';

const router = useRouter();
const allSlices = ref([]);
const selectedIds = ref([]);     // 顺序敏感
const title = ref('');
const submitting = ref(false);
const error = ref('');

const selectedSlices = computed(() =>
  selectedIds.value.map(id => allSlices.value.find(s => s.id === id)).filter(Boolean));

const totalDuration = computed(() =>
  selectedSlices.value.reduce((a, s) => a + (s.duration_sec || 0), 0));

const totalSize = computed(() =>
  selectedSlices.value.reduce((a, s) => a + (s.size_bytes || 0), 0));

function fmtDuration(sec) {
  if (!sec) return '0s';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}
function fmtSize(b) {
  if (!b) return '0';
  const u = ['B','KB','MB','GB']; let i = 0; let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

async function loadSlices() {
  // 只显示纯切片，不显示已合并的（可选）
  allSlices.value = await api.listSlices();
}

function toggle(id) {
  const idx = selectedIds.value.indexOf(id);
  if (idx >= 0) selectedIds.value.splice(idx, 1);
  else selectedIds.value.push(id);
}
function move(id, delta) {
  const idx = selectedIds.value.indexOf(id);
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= selectedIds.value.length) return;
  const [v] = selectedIds.value.splice(idx, 1);
  selectedIds.value.splice(newIdx, 0, v);
}

async function merge() {
  if (selectedIds.value.length < 2) { error.value = '至少选 2 个切片'; return; }
  if (!title.value.trim()) { error.value = '需要起一个名字'; return; }
  submitting.value = true; error.value = '';
  try {
    await api.mergeSlices({ slice_ids: selectedIds.value, title: title.value.trim() });
    router.push('/slices');
  } catch (e) {
    error.value = e.message;
  } finally {
    submitting.value = false;
  }
}

onMounted(loadSlices);
</script>

<template>
  <div class="merge">
    <h2 class="title">合并切片（三切一）</h2>
    <p class="muted">从下方勾选多个切片，按选中顺序拼接为一个新视频（无损 ffmpeg concat）。</p>

    <div class="layout">
      <!-- 左侧：可选切片列表 -->
      <section class="pane">
        <h3>可选切片（{{ allSlices.length }}）</h3>
        <ul class="slice-list">
          <li v-for="s in allSlices" :key="s.id"
              :class="{ selected: selectedIds.includes(s.id) }"
              @click="toggle(s.id)">
            <input type="checkbox" :checked="selectedIds.includes(s.id)"
                   @click.stop="toggle(s.id)" />
            <span class="title-cell">{{ s.title || `#${s.id}` }}</span>
            <span class="muted small">{{ fmtDuration(s.duration_sec) }} · {{ fmtSize(s.size_bytes) }}</span>
          </li>
        </ul>
      </section>

      <!-- 右侧：选中顺序 -->
      <section class="pane">
        <h3>合并顺序（{{ selectedIds.length }}）<span class="muted small">总 {{ fmtDuration(totalDuration) }} · {{ fmtSize(totalSize) }}</span></h3>
        <ol class="slice-list ordered">
          <li v-for="(s, i) in selectedSlices" :key="s.id">
            <span class="seq">#{{ i + 1 }}</span>
            <span class="title-cell">{{ s.title || `#${s.id}` }}</span>
            <span class="muted small">{{ fmtDuration(s.duration_sec) }}</span>
            <span class="actions">
              <button class="muted-btn" :disabled="i === 0" @click="move(s.id, -1)">↑</button>
              <button class="muted-btn" :disabled="i === selectedSlices.length - 1" @click="move(s.id, 1)">↓</button>
              <button class="danger" @click="toggle(s.id)">✕</button>
            </span>
          </li>
        </ol>
        <p v-if="!selectedSlices.length" class="empty muted">从左边勾选切片</p>
      </section>
    </div>

    <div class="footer">
      <input v-model="title" placeholder="合并后的标题" />
      <button class="primary" :disabled="submitting || selectedIds.length < 2 || !title.trim()" @click="merge">
        {{ submitting ? '合并中…' : '开始合并' }}
      </button>
      <span v-if="error" class="error muted">{{ error }}</span>
    </div>
  </div>
</template>

<style scoped>
.merge { display: flex; flex-direction: column; gap: 12px; }
.title { margin: 0; font-size: 18px; }
.layout { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
.pane { background: #252525; border: 1px solid #3c3c3c; border-radius: 6px; padding: 12px; }
.pane h3 { margin: 0 0 10px; font-size: 14px; color: #ccc; display: flex; justify-content: space-between; align-items: center; }
.slice-list { list-style: none; padding: 0; margin: 0; max-height: 50vh; overflow-y: auto; }
.slice-list li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 4px; cursor: pointer; }
.slice-list li:hover { background: #2c2c2c; }
.slice-list li.selected { background: #1f3556; }
.slice-list .title-cell { flex: 1; font-size: 13px; }
.slice-list .small { font-size: 11px; }
.ordered .seq { color: #6da5ff; font-weight: bold; min-width: 28px; }
.ordered .actions { display: flex; gap: 4px; }
.muted-btn { padding: 2px 8px; font-size: 11px; }
.empty { padding: 32px; text-align: center; }
.footer { display: flex; gap: 8px; align-items: center; padding-top: 8px; border-top: 1px solid #333; }
.footer input { flex: 1; max-width: 480px; }
.error { color: #ff8080 !important; }
</style>
