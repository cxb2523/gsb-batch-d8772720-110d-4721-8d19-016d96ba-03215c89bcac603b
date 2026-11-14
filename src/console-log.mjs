import { stripVTControlCharacters } from 'node:util';

const clock = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
const levels = new Map([
  ['info', '信息'], ['warn', '警告'], ['error', '错误'], ['state', '状态'],
]);

function plainText(value) {
  const withoutOsc = String(value ?? '').replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g, '');
  return stripVTControlCharacters(withoutOsc)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
}

// Only the translated business message belongs in the terminal. Raw protocol
// details and extra fields may contain account credentials and stay out.
export function formatConsoleLog(entry) {
  const date = new Date(entry?.t ?? Date.now());
  const time = Number.isNaN(date.getTime()) ? '--:--:--' : clock.format(date);
  const account = plainText(entry?.account).replace(/\n/g, '').slice(0, 8) || '系统';
  const prefix = `[${time}] [${account}] [${levels.get(entry?.level) ?? '信息'}] `;
  return plainText(entry?.message).split('\n').map(line => prefix + line).join('\n');
}
