// 房间 upload_template 的占位符替换。
import { basename, extname } from 'node:path';

/**
 * 渲染模板字符串。可用占位符：
 *   {name}     主播名（room.name）
 *   {roomId}   房间号
 *   {title}    开播时的标题（recording.title 暂未存，用文件名截取代替）
 *   {date}     录制开始日期 YYYY-MM-DD
 *   {datetime} 录制开始时间 YYYY-MM-DD HH:MM
 *   {file}     源文件名（不含扩展名）
 */
export function renderTemplate(tmpl, ctx) {
  if (typeof tmpl !== 'string') return tmpl;
  return tmpl.replace(/\{(\w+)\}/g, (_, k) => {
    const v = ctx[k];
    return v === undefined || v === null ? '' : String(v);
  });
}

export function buildContext({ room, recording }) {
  const startedAt = recording?.started_at ? new Date(recording.started_at * 1000) : new Date();
  const pad = n => String(n).padStart(2, '0');
  const date = `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}`;
  const datetime = `${date} ${pad(startedAt.getHours())}:${pad(startedAt.getMinutes())}`;
  const fileBase = recording?.file_path ? basename(recording.file_path, extname(recording.file_path)) : '';
  // 文件名形如 20260505-153020-主播名-标题
  // 把"-"分隔的最后一段当作直播标题
  const titleFromFilename = (() => {
    const parts = fileBase.split('-');
    return parts.length >= 4 ? parts.slice(3).join('-') : '';
  })();
  return {
    name: room?.name || '',
    roomId: room?.id || '',
    title: titleFromFilename,
    date,
    datetime,
    file: fileBase,
  };
}

/** 把 template 对象里的所有字符串字段做一遍替换 */
export function renderTemplateObject(template, ctx) {
  const out = {};
  for (const [k, v] of Object.entries(template || {})) {
    out[k] = typeof v === 'string' ? renderTemplate(v, ctx) : v;
  }
  return out;
}
