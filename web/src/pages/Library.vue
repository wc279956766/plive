<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../api.js';

const recordings = ref([]);
const progressMap = ref({});   // { 'rec:12': { percent, phase, ... } }
const error = ref('');
let timer = null;
let progressTimer = null;

// 上传弹窗状态
const dialog = ref(null);   // null | { recId, meta, submitting, error }

function fmtTime(unixSec) {
  if (!unixSec) return '—';
  return new Date(unixSec * 1000).toLocaleString('zh-CN', { hour12: false });
}
function fmtDuration(sec) {
  if (!sec) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
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
    pending:   { text: '等待上传', cls: 'unknown' },
    uploading: { text: '上传中',   cls: 'live' },
    success:   { text: '已上传',   cls: 'live' },
    failed:    { text: '上传失败', cls: 'offline' },
    skipped:   { text: '不上传',   cls: 'offline' },
  }[s] || { text: s, cls: 'unknown' };
}

async function refresh() {
  try { recordings.value = await api.listRecordings(); }
  catch (e) { error.value = e.message; }
}

async function refreshProgress() {
  try { progressMap.value = await api.uploadProgress(); }
  catch {}
}

function fmtSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec < 1) return '';
  const u = ['B/s','KB/s','MB/s','GB/s']; let i = 0; let v = bytesPerSec;
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
  return ({
    merging:    '合并中',
    preupload:  '准备',
    init:       '初始化',
    uploading:  '传输中',
    completing: '提交中',
  })[phase] || phase || '';
}

async function openUploadDialog(rec) {
  try {
    const [meta, mergeRes] = await Promise.all([
      api.uploadDefaults(rec.id),
      api.mergeCandidates(rec.id, 180).catch(() => ({ candidates: [rec] })),
    ]);
    const candidates = mergeRes.candidates || [rec];
    // 默认全部勾选（含 seed 自身）
    const selectedIds = candidates.map(c => c.id);
    dialog.value = {
      recId: rec.id,
      recName: rec.file_path?.split('/').slice(-1)[0],
      meta,
      candidates,
      selectedIds,
      submitting: false,
      error: '',
    };
  } catch (e) {
    alert('获取默认值失败：' + e.message);
  }
}

function toggleMergeId(id) {
  if (!dialog.value) return;
  // seed 自身不能取消
  if (id === dialog.value.recId) return;
  const i = dialog.value.selectedIds.indexOf(id);
  if (i >= 0) dialog.value.selectedIds.splice(i, 1);
  else dialog.value.selectedIds.push(id);
}

async function submitUpload() {
  if (!dialog.value) return;
  dialog.value.submitting = true; dialog.value.error = '';
  try {
    const meta = { ...dialog.value.meta };
    if (dialog.value.selectedIds && dialog.value.selectedIds.length > 1) {
      meta.merge_recording_ids = dialog.value.selectedIds;
    }
    await api.uploadRecording(dialog.value.recId, meta);
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
  <table v-if="recordings.length">
    <thead>
      <tr>
        <th>开始</th>
        <th>结束</th>
        <th>主播</th>
        <th>房间</th>
        <th>时长</th>
        <th>大小</th>
        <th>上传</th>
        <th>BV</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="r in recordings" :key="r.id">
        <td class="muted">{{ fmtTime(r.started_at) }}</td>
        <td class="muted">{{ r.ended_at ? fmtTime(r.ended_at) : '录制中…' }}</td>
        <td>{{ r.room_name || '—' }}</td>
        <td>{{ r.room_id }}</td>
        <td>{{ fmtDuration(r.duration_sec) }}</td>
        <td>{{ fmtSize(r.size_bytes) }}</td>
        <td class="upload-cell">
          <template v-if="r.upload_status === 'uploading' && progressMap['rec:'+r.id]">
            <div class="progress">
              <div class="bar" :style="{ width: progressMap['rec:'+r.id].percent + '%' }"></div>
            </div>
            <div class="prog-meta muted">
              <span>{{ phaseLabel(progressMap['rec:'+r.id].phase) }}</span>
              <span>{{ progressMap['rec:'+r.id].percent.toFixed(1) }}%</span>
              <span v-if="progressMap['rec:'+r.id].currentChunk">
                {{ progressMap['rec:'+r.id].currentChunk }}/{{ progressMap['rec:'+r.id].totalChunks }}
              </span>
              <span v-if="progressMap['rec:'+r.id].currentChunkAttempt > 1" class="retry">
                ⟳{{ progressMap['rec:'+r.id].currentChunkAttempt }}/{{ progressMap['rec:'+r.id].maxChunkAttempts }}
              </span>
              <span v-if="fmtSpeed(progressMap['rec:'+r.id].speedBytesPerSec)">
                {{ fmtSpeed(progressMap['rec:'+r.id].speedBytesPerSec) }}
              </span>
              <span v-if="fmtEta(progressMap['rec:'+r.id])">
                {{ fmtEta(progressMap['rec:'+r.id]) }}
              </span>
            </div>
          </template>
          <span v-else class="badge" :class="statusBadge(r.upload_status).cls">
            {{ statusBadge(r.upload_status).text }}
          </span>
        </td>
        <td>
          <a v-if="r.bilibili_bvid" :href="`https://www.bilibili.com/video/${r.bilibili_bvid}`"
             target="_blank" rel="noreferrer">{{ r.bilibili_bvid }}</a>
          <span v-else class="muted">—</span>
        </td>
        <td class="action-cell">
          <span v-if="!r.file_exists" class="badge offline" title="本地文件已清理（保留 7 天后自动删除）">已清理</span>
          <template v-else>
            <button v-if="r.ended_at && (r.upload_status === 'pending' || r.upload_status === 'failed')"
                    class="primary" @click="openUploadDialog(r)">上传</button>
            <RouterLink v-if="r.ended_at" :to="{ path: '/slicer', query: { rec: r.id } }">
              <button>切片</button>
            </RouterLink>
          </template>
        </td>
      </tr>
    </tbody>
  </table>
  <p v-else class="empty muted">暂无录像。监控的房间开播录完一次后会出现在这里。</p>

  <!-- 上传弹窗 -->
  <div v-if="dialog" class="modal-mask" @click.self="dialog = null">
    <div class="modal">
      <h3>上传到 B 站</h3>
      <p class="muted small">{{ dialog.recName }}</p>

      <!-- 自动合并相邻段提示（≥2 段才显示）-->
      <div v-if="dialog.candidates && dialog.candidates.length > 1" class="merge-box">
        <div class="merge-title">检测到同会话相邻段（默认全部合并上传）</div>
        <div v-for="c in dialog.candidates" :key="c.id" class="merge-row">
          <label class="inline">
            <input type="checkbox"
                   :checked="dialog.selectedIds.includes(c.id)"
                   :disabled="c.id === dialog.recId"
                   @change="toggleMergeId(c.id)" />
            <span>#{{ c.id }} · {{ fmtTime(c.started_at) }}–{{ fmtTime(c.ended_at) }}
                  · {{ fmtSize(c.size_bytes) }}{{ c.id === dialog.recId ? ' (主)' : '' }}</span>
          </label>
        </div>
      </div>

      <label>标题</label>
      <input v-model="dialog.meta.title" placeholder="必填" />

      <label>分区 ID (tid)</label>
      <input v-model.number="dialog.meta.tid" type="number" placeholder="21=日常 17=单机 65=综合 ..." />

      <label>标签（逗号分隔）</label>
      <input v-model="dialog.meta.tag" />

      <label>简介</label>
      <textarea v-model="dialog.meta.desc" rows="4"></textarea>

      <div class="row">
        <label class="inline">
          <input type="radio" :value="1" v-model.number="dialog.meta.copyright" /> 自制
        </label>
        <label class="inline">
          <input type="radio" :value="2" v-model.number="dialog.meta.copyright" /> 转载
        </label>
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
.empty { padding: 48px; text-align: center; }
.action-cell { display: flex; gap: 6px; align-items: center; }
.action-cell a { text-decoration: none; }

.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex;
  justify-content: center; align-items: center; z-index: 100; }
.modal { background: #252525; border: 1px solid #3c3c3c; border-radius: 6px;
  padding: 20px; width: 600px; max-width: 95vw; max-height: 90vh; overflow-y: auto; }
.modal h3 { margin: 0 0 4px; }
.modal label { display: block; margin: 12px 0 4px; font-size: 12px; color: #aaa; }
.modal label.inline { display: inline-block; margin: 0 16px 0 0; }
.modal input, .modal textarea { width: 100%; }
.modal .small { font-size: 12px; margin-bottom: 12px; }
.modal .actions { margin-top: 16px; display: flex; justify-content: flex-end; gap: 8px; }
.error { color: #ff8080 !important; margin: 8px 0; }

.upload-cell { min-width: 200px; }
.progress { width: 180px; height: 8px; background: #1a1a1a;
            border: 1px solid #3c3c3c; border-radius: 3px; overflow: hidden; }
.progress .bar { height: 100%; background: #2d8c3c; transition: width .4s ease; }
.prog-meta { display: flex; gap: 8px; font-size: 11px; margin-top: 2px; flex-wrap: wrap; }
.prog-meta .retry { color: #ffb84d; }

.merge-box { background: #1f2a1f; border: 1px solid #3c5c3c; border-radius: 4px;
             padding: 8px 12px; margin: 12px 0; }
.merge-title { font-size: 12px; color: #80ff80; margin-bottom: 4px; }
.merge-row { font-size: 12px; color: #ddd; padding: 2px 0; }
.merge-row .inline { display: flex; align-items: center; gap: 6px; cursor: pointer; }
.merge-row input[disabled] { opacity: .6; }
</style>
