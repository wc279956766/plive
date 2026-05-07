<script setup>
import { RouterView, useRoute } from 'vue-router';
import { computed } from 'vue';

const route = useRoute();
const title = computed(() => route.meta?.title ?? '');
</script>

<template>
  <header class="topbar">
    <div class="brand">plive</div>
    <nav>
      <RouterLink to="/rooms">房间</RouterLink>
      <RouterLink to="/library">录像</RouterLink>
      <RouterLink to="/slices">切片</RouterLink>
      <RouterLink to="/settings">设置</RouterLink>
    </nav>
    <div class="spacer" />
    <span class="page-title muted">{{ title }}</span>
  </header>
  <main>
    <RouterView />
  </main>
</template>

<style scoped>
.topbar { display: flex; align-items: center; gap: 16px; padding: 10px 16px;
  background: #252525; border-bottom: 1px solid #3c3c3c; }
.brand { font-weight: bold; font-size: 16px; color: #6da5ff; }
nav { display: flex; gap: 4px; }
nav :deep(a) { color: #ccc; text-decoration: none; padding: 6px 10px; border-radius: 4px; }
nav :deep(a:hover) { background: #2d2d2d; }
nav :deep(a.router-link-active) { background: #2d6cdf; color: #fff; }
.spacer { flex: 1; }
.page-title { font-size: 12px; }
main { flex: 1; padding: 16px; max-width: 1200px; width: 100%; margin: 0 auto; }
</style>
