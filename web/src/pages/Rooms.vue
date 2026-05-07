<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { api } from '../api.js';

const rooms = ref([]);
const newRoomId = ref('');
const error = ref('');
let timer = null;

// 投稿模板编辑弹窗
const tmplDialog = ref(null);  // { roomId, roomName, template, submitting, error }

function fmtTime(unixSec) {
  if (!unixSec) return '—';
  const d = new Date(unixSec * 1000);
  const now = Date.now() / 1000;
  const diff = now - unixSec;
  if (diff < 60) return `${Math.floor(diff)}s 前`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m 前`;
  return d.toLocaleString('zh-CN', { hour12: false });
}

async function refresh() {
  try { rooms.value = await api.listRooms(); }
  catch (e) { error.value = e.message; }
}

async function addRoom() {
  error.value = '';
  const id = parseInt(newRoomId.value, 10);
  if (!Number.isInteger(id) || id <= 0) { error.value = '房间号需要是正整数'; return; }
  try {
    await api.addRoom({ id });
    newRoomId.value = '';
    refresh();
  } catch (e) { error.value = e.message; }
}

async function toggleEnabled(room) {
  await api.patchRoom(room.id, { enabled: !room.enabled });
  refresh();
}
async function toggleAutoUpload(room) {
  await api.patchRoom(room.id, { auto_upload: !room.auto_upload });
  refresh();
}

async function removeRoom(room) {
  console.log('[removeRoom] clicked', room);
  if (!window.confirm(`确定删除房间 ${room.id} (${room.name || '未知'})？`)) return;
  try { await api.deleteRoom(room.id); }
  catch (e) { alert('删除失败：' + e.message); }
  refresh();
}

function openTemplate(room) {
  const tmpl = room.upload_template_json ? JSON.parse(room.upload_template_json) : {};
  tmplDialog.value = {
    roomId: room.id,
    roomName: room.name || '未知',
    template: {
      tid:               tmpl.tid              ?? 21,
      copyright:         tmpl.copyright        ?? 2,
      title_template:    tmpl.title_template   ?? '{name} 直播录像 {date}',
      tag:               tmpl.tag              ?? `直播录像,{name}`,
      desc:              tmpl.desc             ?? `录像存档\n源直播间: live.bilibili.com/{roomId}`,
      source:            tmpl.source           ?? `https://live.bilibili.com/{roomId}`,
    },
    submitting: false, error: '',
  };
}

async function saveTemplate() {
  if (!tmplDialog.value) return;
  tmplDialog.value.submitting = true; tmplDialog.value.error = '';
  try {
    await api.patchRoom(tmplDialog.value.roomId, {
      upload_template: tmplDialog.value.template,
    });
    tmplDialog.value = null;
    refresh();
  } catch (e) {
    tmplDialog.value.error = e.message;
    tmplDialog.value.submitting = false;
  }
}

onMounted(() => { refresh(); timer = setInterval(refresh, 5000); });
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<template>
  <section class="add-block">
    <div class="row">
      <input v-model="newRoomId" type="number" placeholder="房间号" @keyup.enter="addRoom" />
      <button class="primary" @click="addRoom">添加监控</button>
      <span v-if="error" class="muted error">{{ error }}</span>
    </div>
  </section>

  <table v-if="rooms.length">
    <thead>
      <tr>
        <th>房间号</th>
        <th>主播</th>
        <th>状态</th>
        <th>最近检查</th>
        <th>启用</th>
        <th>自动上传</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="r in rooms" :key="r.id">
        <td><a :href="`https://live.bilibili.com/${r.id}`" target="_blank" rel="noreferrer">{{ r.id }}</a></td>
        <td>{{ r.name || '—' }}</td>
        <td>
          <span class="badge" :class="r.last_status || 'unknown'">
            {{ r.last_status === 'live' ? '直播中' : r.last_status === 'offline' ? '未开播' : '?' }}
          </span>
        </td>
        <td class="muted">{{ fmtTime(r.last_status_at) }}</td>
        <td><input type="checkbox" :checked="!!r.enabled" @change="toggleEnabled(r)" /></td>
        <td><input type="checkbox" :checked="!!r.auto_upload" @change="toggleAutoUpload(r)" /></td>
        <td class="action-cell">
          <button @click="openTemplate(r)">投稿模板</button>
          <button class="danger" @click="removeRoom(r)">删除</button>
        </td>
      </tr>
    </tbody>
  </table>
  <p v-else class="empty muted">尚未添加任何监控房间。</p>

  <!-- 投稿模板编辑 -->
  <div v-if="tmplDialog" class="modal-mask" @click.self="tmplDialog = null">
    <div class="modal">
      <h3>投稿模板 — {{ tmplDialog.roomName }} (#{{ tmplDialog.roomId }})</h3>
      <p class="muted small">所有占位符在每次上传时会替换为实际值，可在弹窗里再二次修改。</p>

      <label>分区 ID (tid)</label>
      <input v-model.number="tmplDialog.template.tid" type="number" />
      <p class="muted hint">B 站分区数字 ID。常见：21=日常 / 27=综合 / 17=单机游戏 / 171=电子竞技 / 65=综合 / 19=动画</p>

      <label>版权类型</label>
      <div class="row">
        <label class="inline"><input type="radio" :value="1" v-model.number="tmplDialog.template.copyright" /> 自制</label>
        <label class="inline"><input type="radio" :value="2" v-model.number="tmplDialog.template.copyright" /> 转载</label>
      </div>

      <label v-if="tmplDialog.template.copyright === 2">转载源 URL</label>
      <input v-if="tmplDialog.template.copyright === 2" v-model="tmplDialog.template.source" />

      <label>标题模板</label>
      <input v-model="tmplDialog.template.title_template" />

      <label>标签（逗号分隔）</label>
      <input v-model="tmplDialog.template.tag" />

      <label>简介</label>
      <textarea v-model="tmplDialog.template.desc" rows="4"></textarea>

      <details class="placeholders">
        <summary>占位符（点击展开）</summary>
        <table class="ph">
          <tr><td><code>{name}</code></td><td>主播名</td></tr>
          <tr><td><code>{roomId}</code></td><td>房间号</td></tr>
          <tr><td><code>{title}</code></td><td>开播时的直播标题（从录像文件名解析）</td></tr>
          <tr><td><code>{date}</code></td><td>录制开始日期 2026-05-05</td></tr>
          <tr><td><code>{datetime}</code></td><td>2026-05-05 14:30</td></tr>
          <tr><td><code>{file}</code></td><td>源录像文件名（不含扩展名）</td></tr>
        </table>
      </details>

      <p v-if="tmplDialog.error" class="error muted">{{ tmplDialog.error }}</p>

      <div class="actions">
        <button @click="tmplDialog = null">取消</button>
        <button class="primary" :disabled="tmplDialog.submitting" @click="saveTemplate">
          {{ tmplDialog.submitting ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.add-block { margin-bottom: 16px; }
.error { color: #ff8080 !important; }
.empty { padding: 32px; text-align: center; }
input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; }
.action-cell { display: flex; gap: 6px; }

/* modal */
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex;
  justify-content: center; align-items: center; z-index: 100; }
.modal { background: #252525; border: 1px solid #3c3c3c; border-radius: 6px;
  padding: 20px; width: 640px; max-width: 95vw; max-height: 90vh; overflow-y: auto; }
.modal label { display: block; margin: 12px 0 4px; font-size: 12px; color: #aaa; }
.modal label.inline { display: inline-block; margin: 0 16px 0 0; }
.modal input, .modal textarea { width: 100%; }
.modal .small { font-size: 12px; }
.modal .hint { font-size: 11px; margin: 4px 0 0; }
.modal .actions { margin-top: 16px; display: flex; justify-content: flex-end; gap: 8px; }

.placeholders { margin-top: 14px; padding: 10px; background: #1a1a1a;
  border: 1px solid #333; border-radius: 4px; }
.placeholders summary { cursor: pointer; color: #aaa; font-size: 12px; }
.ph { margin-top: 8px; font-size: 12px; }
.ph td { padding: 2px 8px 2px 0; }
.ph code { background: #2a2a2a; padding: 1px 5px; border-radius: 3px; color: #ffaa66; }
</style>
