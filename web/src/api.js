// 简易 fetch 包装：仅当有 body 时才加 Content-Type，避免空 body 触发 Fastify 400
async function req(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  let body = opts.body;
  if (body !== undefined && typeof body !== 'string') {
    body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(url, { ...opts, headers, body });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

export const api = {
  health:        ()              => req('/api/health'),
  listRooms:     ()              => req('/api/rooms'),
  addRoom:       (data)          => req('/api/rooms',           { method: 'POST', body: data }),
  patchRoom:     (id, data)      => req(`/api/rooms/${id}`,     { method: 'PATCH', body: data }),
  deleteRoom:    (id)            => req(`/api/rooms/${id}`,     { method: 'DELETE' }),
  listRecordings: (limit = 100)  => req(`/api/recordings?limit=${limit}`),
  listSlices:    (limit = 200)   => req(`/api/slices?limit=${limit}`),
  deleteSlice:   (id, deleteFile = true) =>
                                    req(`/api/slices/${id}?delete_file=${deleteFile ? 1 : 0}`,
                                        { method: 'DELETE' }),
  bilibiliMe:    ()              => req('/api/bilibili/me'),
  bilibiliLogin: (cookies)       => req('/api/bilibili/login', { method: 'POST', body: { cookies } }),
  bilibiliLogout:()              => req('/api/bilibili/logout', { method: 'POST' }),
  uploadDefaults:(recId)         => req(`/api/recordings/${recId}/upload-defaults`),
  uploadRecording:(recId, meta)  => req(`/api/recordings/${recId}/upload`, { method: 'POST', body: meta }),
  createSlice:   (data)          => req('/api/slices', { method: 'POST', body: data }),
  mergeSlices:   (data)          => req('/api/slices/merge', { method: 'POST', body: data }),
  sliceUploadDefaults: (id)      => req(`/api/slices/${id}/upload-defaults`),
  uploadSlice:   (id, meta)      => req(`/api/slices/${id}/upload`, { method: 'POST', body: meta }),
  uploadProgress: ()             => req('/api/uploads/progress'),
  mergeCandidates:(recId, gap=180)=> req(`/api/recordings/${recId}/merge-candidates?gap=${gap}`),
  proxyStatus:   (recId)         => req(`/api/recordings/${recId}/proxy/status`),
  proxyGenerate: (recId)         => req(`/api/recordings/${recId}/proxy`, { method: 'POST' }),
};
