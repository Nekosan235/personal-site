// Transcript formatting for the meetings page. AssemblyAI returns Chinese as
// per-character tokens separated by spaces, so the display text needs the same
// cleanup the standalone transcript tool uses before it is written to disk.

const CJK = '\\u4e00-\\u9fff\\u3400-\\u4dbf';
const CJK_PUNCT = '，。、！？：；（）【】「」『』《》…—·';

/** Remove per-character spaces between Han characters and tidy punctuation. */
export function cleanCjkSpacing(value) {
  let text = String(value ?? '').replace(/\u3000/g, ' ').trim();
  if (!text) return '';
  text = text.replace(/\s+/g, ' ');
  // "F Y 二 八" -> "FY 二 八", "R O C D" -> "ROCD"
  let previous;
  do {
    previous = text;
    text = text.replace(/\b([A-Z])\s+(?=[A-Z]\b)/g, '$1');
  } while (text !== previous);
  text = text.replace(new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`, 'g'), '');
  text = text.replace(new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK_PUNCT}])`, 'g'), '');
  text = text.replace(new RegExp(`(?<=[${CJK_PUNCT}])\\s+(?=[${CJK}])`, 'g'), '');
  text = text.replace(/(?<=[（【「『《])\s+/g, '');
  text = text.replace(new RegExp(`(?<=[${CJK_PUNCT}])\\s+(?=[${CJK_PUNCT}])`, 'g'), '');
  text = text.replace(/\s+([,.;:!?])/g, '$1');
  return text.replace(/\s+/g, ' ').trim();
}

export function formatClock(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = Math.floor(total % 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function utterancesOf(transcript) {
  const list = Array.isArray(transcript?.utterances) ? transcript.utterances : [];
  return list
    .map((item) => ({
      speaker: String(item?.speaker ?? '?'),
      start: Number(item?.start) || 0,
      end: Number(item?.end) || 0,
      text: cleanCjkSpacing(item?.text),
    }))
    .filter((item) => item.text);
}

export function buildTranscriptText(transcript) {
  return utterancesOf(transcript)
    .map((item) => `[${formatClock(item.start)}] Speaker ${item.speaker}: ${item.text}`)
    .join('\n');
}

export function buildTranscriptMarkdown(meta, transcript) {
  const segments = utterancesOf(transcript);
  const speakers = [...new Set(segments.map((item) => item.speaker))].sort();
  const perSpeaker = new Map();
  for (const segment of segments) {
    const entry = perSpeaker.get(segment.speaker) ?? { ms: 0, chars: 0, count: 0 };
    entry.ms += Math.max(0, segment.end - segment.start);
    entry.chars += segment.text.length;
    entry.count += 1;
    perSpeaker.set(segment.speaker, entry);
  }
  const totalMs = [...perSpeaker.values()].reduce((sum, entry) => sum + entry.ms, 0) || 1;

  const lines = [];
  lines.push(`# ${meta.title || '会议转写稿'}`);
  lines.push('');
  lines.push(`- 录音文件：${meta.audio?.deleted ? '已删除（释放空间）' : (meta.audio?.filename || '—')}`);
  lines.push(`- 音频时长：${formatDuration(transcript?.durationMs ?? meta.audio?.durationMs ?? 0)}`);
  lines.push(`- 转写模型：${transcript?.model || '—'}`);
  lines.push(`- 检测语言：${transcript?.language || '自动'}`);
  lines.push(`- 说话人：${speakers.length ? `${speakers.join(' / ')}（共 ${speakers.length} 人）` : '—'}`);
  lines.push(`- 转写时间：${meta.transcript?.completedAt ? new Date(meta.transcript.completedAt).toISOString() : '—'}`);
  lines.push('');
  if (perSpeaker.size > 1) {
    lines.push('## 发言统计');
    lines.push('');
    lines.push('| 说话人 | 发言时长 | 占比 | 字数 | 段数 |');
    lines.push('|---|---|---|---|---|');
    for (const speaker of speakers) {
      const entry = perSpeaker.get(speaker);
      lines.push(`| Speaker ${speaker} | ${formatDuration(entry.ms)} | ${Math.round((entry.ms / totalMs) * 100)}% | ${entry.chars} | ${entry.count} |`);
    }
    lines.push('');
  }
  lines.push('## 逐段转写');
  lines.push('');
  for (const segment of segments) {
    lines.push(`**Speaker ${segment.speaker}**　\`${formatClock(segment.start)}\``);
    lines.push('');
    lines.push(segment.text);
    lines.push('');
  }
  return lines.join('\n');
}
