<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../api.js';

const slices = ref([]);
const progressMap = ref({});
const error = ref('');
let timer = null;
let progressTimer = null;

const dialog = ref(null);  // { sliceId, sliceTitle, meta, submitting, error }

function fmtTime(unixSec) {
  if (!unixSec) return '—';
  return new Date(unixSec * 1000).toLocaleString('zh-CN', { hour12: false });
}
function fmtDuration(sec) {
  if (!sec && sec !== 0) return '—';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}
function fmtSize(b) {
  if (!b) return '—';
  const u = ['B','KB','MB','GB','TB']; let i = 0; let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}
function statusBadge(s) {
  return {
    pending:   { text: '待上传',   cls: 'unknown' },
    uploading: { text: '上传中',   cls: 'live' },
    success:   { text: '已上传',   cls: 'live' },
    failed:    { text: '上传失败', cls: 'offline' },
    skipped:   { text: '不上传',   cls: 'offline' },
  }[s] || { text: s, cls: 'unknown' };
}

async function refresh() {
  try { slices.value = await api.listSlices(); }
  catch (e) { error.value = e.message; }
}
async function refreshProgress() {
  try { progressMap.value = await api.uploadProgress(); }
  catch {}
}

function fmtSpeed(bps) {
  if (!bps || bps < 1) return '';
  const u = ['B/s','KB/s','MB/s','GB/s']; let i = 0; let v = bps;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}
function fmtEta(p) {
  if (!p || !p.speedBytesPerSec || p.speedBytesPerSec < 1) return '';
  const remain = (p.totalBytes - p.uploadedBytes) / p.speedBytesPerSec;
  if (!isFinite(remain) || remain < 0) return '';
  if (remain < 60) return `${Math.round(remain)}s`;
  if (remain < 3600) return `${Math.round(remain / 60)}m`;
  return `${(remain / 3600).toFixed(1)}h`;
}
function phaseLabel(phase) {
  return ({ preupload: '准备', init: '初始化', uploading: '传输中', completing: '提交中' })[phase] || phase || '';
}

async function removeSlice(s) {
  if (!confirm(`确定删除切片 #${s.id} "${s.title || ''}"？\n（同时删除磁盘文件）`)) return;
  await api.deleteSlice(s.id, true);
  refresh();
}

async function openUpload(s) {
  try {
    const meta = await api.sliceUploadDefaults(s.id);
    dialog.value = { sliceId: s.id, sliceTitle: s.title || `#${s.id}`,
                     meta, submitting: false, error: '' };
  } catch (e) { alert('获取默认值失败: ' + e.message); }
}

async function submitUpload() {
  if (!dialog.value) return;
  dialog.value.submitting = true; dialog.value.error = '';
  try {
    await api.uploadSlice(dialog.value.sliceId, dialog.value.meta);
    dialog.value = null;
    refresh();
  } catch (e) {
    dialog.value.error = e.message;
    dialog.value.submitting = false;
  }
}

onMounted(() => {
  refresh(); refreshProgress();
  timer = setInterval(refresh, 5000);
  progressTimer = setInterval(refreshProgress, 2000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
  if (progressTimer) clearInterval(progressTimer);
});
</script>

<template>
  <div class="header-row">
    <RouterLink to="/merge"><button class="primary">三切一（合并切片）</button></RouterLink>
  </div>
  <div v-if="error" class="error muted">{{ error }}</div>
  <table v-if="slices.length">
    <thead>
      <tr>
        <th>创建</th>
        <th>标题</th>
        <th>源</th>
        <th>区间</th>
        <th>时长</th>
        <th>大小</th>
        <th>弹幕</th>
        <th>上传</th>
        <th>BV</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="s in slices" :key="s.id">
        <td class="muted small">{{ fmtTime(s.created_at) }}</td>
        <td>{{ s.title || '(无标题)' }}</td>
        <td class="muted small">{{ s.source_recording_id ? `#${s.source_recording_id}` : '已删' }}</td>
        <td class="muted small">{{ fmtDuration(s.start_sec) }} ~ {{ fmtDuration(s.end_sec) }}</td>
        <td>{{ fmtDuration(s.duration_sec) }}</td>
        <td>{{ fmtSize(s.size_bytes) }}</td>
        <td>
          <span class="badge" :class="s.burn_danmaku ? 'live' : 'unknown'">
            {{ s.burn_danmaku ? '带弹幕' : '纯净' }}
          </span>
        </td>
        <td class="upload-cell">
          <template v-if="s.upload_status === 'uploading' && progressMap['slice:'+s.id]">
            <div class="progress">
              <div class="bar" :style="{ width: progressMap['slice:'+s.id].percent + '%' }"></div>
            </div>
            <div class="prog-meta muted">
              <span>{{ phaseLabel(progressMap['slice:'+s.id].phase) }}</span>
              <span>{{ progressMap['slice:'+s.id].percent.toFixed(1) }}%</span>
              <span v-if="progressMap['slice:'+s.id].currentChunk">
                {{ progressMap['slice:'+s.id].currentChunk }}/{{ progressMap['slice:'+s.id].totalChunks }}
              </span>
              <span v-if="fmtSpeed(progressMap['slice:'+s.id].speedBytesPerSec)">
                {{ fmtSpeed(progressMap['slice:'+s.id].speedBytesPerSec) }}
              </span>
              <span v-if="fmtEta(progressMap['slice:'+s.id])">
                {{ fmtEta(progressMap['slice:'+s.id]) }}
              </span>
            </div>
          </template>
          <span v-else class="badge" :class="statusBadge(s.upload_status).cls">
            {{ statusBadge(s.upload_status).text }}
          </span>
        </td>
        <td>
          <a v-if="s.bilibili_bvid" :href="`https://www.bilibili.com/video/${s.bilibili_bvid}`"
             target="_blank" rel="noreferrer">{{ s.bilibili_bvid }}</a>
          <span v-else class="muted">—</span>
        </td>
        <td class="action-cell">
          <button v-if="s.upload_status === 'pending' || s.upload_status === 'failed'"
                  class="primary" @click="openUpload(s)">上传</button>
          <button class="danger" @click="removeSlice(s)">删除</button>
        </td>
      </tr>
    </tbody>
  </table>
  <p v-else class="empty muted">暂无切片。从录像页"切片"按钮进切片器创建。</p>

  <!-- 上传弹窗 -->
  <div v-if="dialog" class="modal-mask" @click.self="dialog = null">
    <div class="modal">
      <h3>上传切片到 B 站</h3>
      <p class="muted small">{{ dialog.sliceTitle }}</p>

      <label>标题</label>
      <input v-model="dialog.meta.title" />

      <label>分区 ID (tid)</label>
      <input v-model.number="dialog.meta.tid" type="number" />

      <label>标签</label>
      <input v-model="dialog.meta.tag" />

      <label>简介</label>
      <textarea v-model="dialog.meta.desc" rows="4"></textarea>

      <div class="row">
        <label class="inline"><input type="radio" :value="1" v-model.number="dialog.meta.copyright" /> 自制</label>
        <label class="inline"><input type="radio" :value="2" v-model.number="dialog.meta.copyright" /> 转载</label>
      </div>
      <label v-if="dialog.meta.copyright === 2">转载源 URL</label>
      <input v-if="dialog.meta.copyright === 2" v-model="dialog.meta.source" />

      <p v-if="dialog.error" class="error muted">{{ dialog.error }}</p>

      <div class="actions">
        <button @click="dialog = null">取消</button>
        <button class="primary" :disabled="dialog.submitting || !dialog.meta.title" @click="submitUpload">
          {{ dialog.submitting ? '提交中…' : '开始上传' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.header-row { margin-bottom: 12px; }
.error { color: #ff8080; padding: 8px; }
.empty { padding: 48px; text-align: center; }
.small { font-size: 12px; }
.action-cell { display: flex; gap: 6px; }

.upload-cell { min-width: 200px; }
.progress { width: 180px; height: 8px; background: #1a1a1a;
            border: 1px solid #3c3c3c; border-radius: 3px; overflow: hidden; }
.progress .bar { height: 100%; background: #2d8c3c; transition: width .4s ease; }
.prog-meta { display: flex; gap: 8px; font-size: 11px; margin-top: 2px; flex-wrap: wrap; }

.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex;
  justify-content: center; align-items: center; z-index: 100; }
.modal { background: #252525; border: 1px solid #3c3c3c; border-radius: 6px;
  padding: 20px; width: 600px; max-width: 95vw; max-height: 90vh; overflow-y: auto; }
.modal label { display: block; margin: 12px 0 4px; font-size: 12px; color: #aaa; }
.modal label.inline { display: inline-block; margin: 0 16px 0 0; }
.modal input, .modal textarea { width: 100%; }
.modal .actions { margin-top: 16px; display: flex; justify-content: flex-end; gap: 8px; }
</style>
