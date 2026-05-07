<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../api.js';

const recordings = ref([]);
const error = ref('');
let timer = null;

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

async function openUploadDialog(rec) {
  try {
    const meta = await api.uploadDefaults(rec.id);
    dialog.value = { recId: rec.id, recName: rec.file_path?.split('/').slice(-1)[0],
                     meta, submitting: false, error: '' };
  } catch (e) {
    alert('获取默认值失败：' + e.message);
  }
}

async function submitUpload() {
  if (!dialog.value) return;
  dialog.value.submitting = true; dialog.value.error = '';
  try {
    await api.uploadRecording(dialog.value.recId, dialog.value.meta);
    dialog.value = null;
    refresh();
  } catch (e) {
    dialog.value.error = e.message;
    dialog.value.submitting = false;
  }
}

onMounted(() => { refresh(); timer = setInterval(refresh, 5000); });
onUnmounted(() => { if (timer) clearInterval(timer); });
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
        <td>
          <span class="badge" :class="statusBadge(r.upload_status).cls">
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
</style>
