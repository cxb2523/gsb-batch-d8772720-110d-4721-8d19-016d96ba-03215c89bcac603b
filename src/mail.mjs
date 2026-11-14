import { exactAutomationId } from './automation-policy.mjs';

const ES_READ = 1, ES_NEW = 2;
const needsAction = mail => mail.status === ES_NEW || (!!mail.attachment && !mail.got);
const paused = () => ({ taskKey: 'mail', label: '邮件附件', skipped: true, reason: '邮件领取已暂停' });

// 邮箱按页返回；第一页没有附件不代表整个邮箱已领完。
export async function readMailbox(client, enabled = () => true) {
  const mails = new Map();
  let expected = 0;
  for (let pageNo = 0; pageNo < 100; pageNo++) {
    if (!enabled()) return null;
    const reply = await client.request('EmailBoxRequest', { pageNo }, 'EmailBoxResponse');
    if (!Array.isArray(reply?.email)) throw Error('邮箱列表未完整返回');
    const total = reply.total ?? (reply.email.length === 0 ? 0 : NaN);
    if (!Number.isSafeInteger(total) || total < 0) throw Error('邮箱总数未确认');
    expected = Math.max(expected, total);
    const before = mails.size;
    for (const mail of reply.email) {
      const id = exactAutomationId(mail.emailId);
      if (!id || mails.has(id)) throw Error('邮箱分页存在缺失或重复标识，稍后重新同步');
      mails.set(id, mail);
    }
    if (mails.size > expected) throw Error('邮箱总数与列表不一致，稍后重新同步');
    if (mails.size === expected) return mails;
    if (mails.size === before) throw Error('邮箱后续页未完整返回');
  }
  throw Error('邮箱分页超过检查上限，未执行领取');
}

export async function claimMail(client, { enabled = () => true } = {}) {
  const before = await readMailbox(client, enabled);
  if (!before || !enabled()) return paused();
  const targets = [...before].filter(([, mail]) => needsAction(mail));
  if (!targets.length) return { taskKey: 'mail', label: '邮件附件', skipped: true, status: 'empty', reason: '当前没有未读邮件或未领邮件附件', scanned: before.size };
  let sendError;
  try { await client.sendWatch('QuickGotReadEmailRequest', { all: true }, { window: 400 }); }
  catch (error) {
    if (error.notSent || error.prompt && error.request === 'QuickGotReadEmailRequest') throw error;
    sendError = error;
  }
  // 已发送后，即使用户暂停也核对结果；不重发，不以未收到报错代替领取成功。
  try {
    const after = await readMailbox(client);
    const confirmed = targets.filter(([id, mail]) => {
      const current = after.get(id);
      return current && (!mail.attachment || mail.got || current.got === true)
        && (mail.status !== ES_NEW || current.status === ES_READ);
    });
    if (confirmed.length !== targets.length) throw Error('重新读取邮箱后仅确认 ' + confirmed.length + '/' + targets.length + ' 封，未重复提交');
    const attachments = targets.filter(([, mail]) => mail.attachment && !mail.got).length;
    return { taskKey: 'mail', label: '邮件已确认处理 ' + targets.length + ' 封（附件 ' + attachments + ' 封）', ok: true, status: 'confirmed', sent: true, processed: targets.length, attachments, scanned: before.size };
  } catch (error) {
    return { taskKey: 'mail', label: '邮件领取结果待确认', ok: false, status: 'unknown', sent: true, error: error.message + (sendError ? '；发送结果：' + sendError.message : '') };
  }
}
