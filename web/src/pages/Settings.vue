<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api.js';

const me = ref(null);          // { logged_in, user?, expired? }
const cookies = ref('');
const error = ref('');
const success = ref('');
const loading = ref(false);

async function refresh() {
  try {
    me.value = await api.bilibiliMe();
  } catch (e) {
    error.value = e.message;
  }
}

async function login() {
  error.value = ''; success.value = ''; loading.value = true;
  try {
    const r = await api.bilibiliLogin(cookies.value);
    success.value = `登录成功：${r.user.uname} (UID ${r.user.mid})`;
    cookies.value = '';
    await refresh();
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function logout() {
  if (!confirm('确定退出登录？后续无法自动上传，需要重新粘贴 cookie。')) return;
  await api.bilibiliLogout();
  await refresh();
}

onMounted(refresh);
</script>

<template>
  <h2 class="title">B 站登录</h2>

  <section v-if="me?.logged_in" class="card user">
    <img v-if="me.user.avatar" :src="me.user.avatar" referrerpolicy="no-referrer" />
    <div class="info">
      <div class="uname">{{ me.user.uname }}</div>
      <div class="muted">UID {{ me.user.mid }} · Lv.{{ me.user.level || '?' }} · 硬币 {{ me.user.coin }}</div>
    </div>
    <button class="danger" @click="logout">退出</button>
  </section>

  <section v-else class="card login">
    <p v-if="me?.expired" class="muted warn">⚠ 之前的 cookie 已失效，请重新粘贴。</p>
    <p class="muted">把 B 站网页（已登录）的 cookie 粘进来。最少要包含 <code>SESSDATA</code>、<code>bili_jct</code>、<code>DedeUserID</code> 三个字段。</p>
    <p class="muted">
      获取方法（Chrome / Firefox 都通用）：
    </p>
    <ol class="muted">
      <li>用浏览器登录 <a href="https://www.bilibili.com" target="_blank" rel="noreferrer">bilibili.com</a></li>
      <li>F12 打开开发者工具 → <b>Application/存储</b> → <b>Cookies</b> → <code>https://www.bilibili.com</code></li>
      <li>把表里所有行的 <code>name=value</code> 复制下来（或者只复 SESSDATA / bili_jct / DedeUserID 三个）</li>
      <li>粘到下面的输入框，每个字段一行或用 <code>;</code> 分隔都行</li>
    </ol>
    <textarea v-model="cookies" rows="6"
              placeholder="SESSDATA=xxxxx; bili_jct=yyyyy; DedeUserID=12345"></textarea>
    <div class="row">
      <button class="primary" :disabled="loading || !cookies.trim()" @click="login">
        {{ loading ? '验证中…' : '登录' }}
      </button>
      <span v-if="error" class="error muted">{{ error }}</span>
      <span v-if="success" class="success muted">{{ success }}</span>
    </div>
  </section>
</template>

<style scoped>
.title { font-size: 18px; margin: 0 0 16px 0; }
.card { background: #252525; border: 1px solid #3c3c3c; border-radius: 6px;
  padding: 16px; max-width: 720px; }
.user { display: flex; align-items: center; gap: 16px; }
.user img { width: 56px; height: 56px; border-radius: 50%; }
.user .info { flex: 1; }
.user .uname { font-size: 16px; font-weight: 500; }

.login textarea { width: 100%; min-height: 100px; font-family: monospace; font-size: 12px; }
.login ol { padding-left: 20px; line-height: 1.7; font-size: 13px; }
.login code { background: #1a1a1a; padding: 1px 4px; border-radius: 3px;
  border: 1px solid #333; font-size: 11px; }
.warn { color: #ffaa66; }
.error { color: #ff8080 !important; }
.success { color: #80ffaa !important; }
.row { margin-top: 12px; gap: 12px; }
</style>
