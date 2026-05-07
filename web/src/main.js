import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import Rooms from './pages/Rooms.vue';
import Library from './pages/Library.vue';
import Slices from './pages/Slices.vue';
import Slicer from './pages/Slicer.vue';
import Merge from './pages/Merge.vue';
import Settings from './pages/Settings.vue';
import './style.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/rooms' },
    { path: '/rooms', component: Rooms, name: 'rooms', meta: { title: '房间' } },
    { path: '/library', component: Library, name: 'library', meta: { title: '录像' } },
    { path: '/slices', component: Slices, name: 'slices', meta: { title: '切片' } },
    { path: '/slicer', component: Slicer, name: 'slicer', meta: { title: '切片器' } },
    { path: '/merge', component: Merge, name: 'merge', meta: { title: '合并切片' } },
    { path: '/settings', component: Settings, name: 'settings', meta: { title: '设置' } },
  ],
});

createApp(App).use(router).mount('#app');
