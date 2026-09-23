/**
 * Collapses a burst of emails to the same person into one message.
 *
 * The scheduler marks every dose that passed its 2-hour window in a single
 * pass, so a caregiver whose camera was off overnight got one email per dose:
 * six in under a minute on 23 Sep 2026, all saying the same thing about the
 * same medication. Six emails is not six times the information.
 *
 * Every email is held for COALESCE_MS. If nothing else arrives for that
 * person, it is sent on its own, exactly as before. If more arrive, they go
 * out as one email that lists each item. Delivery is recorded per
 * notification once the send actually happens, so delivery.email.sent stays
 * truthful rather than optimistic.
 *
 * The hold is short by design: it is a coalescing window, not a digest
 * schedule. Set EMAIL_COALESCE_MS=0 to send immediately (tests do).
 */

const COALESCE_MS = process.env.EMAIL_COALESCE_MS !== undefined
  ? Number(process.env.EMAIL_COALESCE_MS)
  : 60000;

// to -> { items: [{ parts, notificationId }], timer }
const pending = new Map();

// Injected by notifications.js to avoid a require cycle.
let deps = null;
const configure = d => { deps = d; };

const escapeHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Subject for a coalesced send: honest about how many, vague about nothing. */
const digestSubject = items => `${items.length} updates from LOCUS`;

const digestHtml = items => {
  const appUrl = process.env.APP_URL || 'http://localhost:5173';
  const rows = items.map(({ parts }) => `
            <tr>
              <td style="padding: 0 0 18px 0; border-bottom: 1px solid #ECFDF5;">
                <p style="margin: 0 0 4px 0; font-size: 16px; font-weight: 600; color: #064E3B; line-height: 1.4;">${escapeHtml(parts.title)}</p>
                <p style="margin: 0; font-size: 15px; color: #1F2937; line-height: 1.6;">${escapeHtml(parts.message)}</p>
                ${(parts.detailLabel && parts.detailValue)
                  ? `<p style="margin: 6px 0 0 0; font-size: 13px; color: #047857;">${escapeHtml(parts.detailLabel)} ${escapeHtml(parts.detailValue)}</p>` : ''}
              </td>
            </tr>
            <tr><td style="height: 18px;"></td></tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(digestSubject(items))}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #F0FDF4; -webkit-font-smoothing: antialiased;">
  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F0FDF4; padding: 32px 12px;">
    <tr>
      <td align="center">
        <table border="0" cellpadding="0" cellspacing="0" width="100%" role="presentation" style="max-width: 560px; background-color: #FFFFFF; border: 1px solid #D1FAE5; border-radius: 14px; overflow: hidden; font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
          <tr>
            <td style="background-color: #064E3B; padding: 20px 32px;">
              <img src="cid:locuslogo" alt="LOCUS" width="105" height="30" style="display: block; border: 0; width: 105px; height: 30px; color: #FFFFFF; font-size: 20px; font-weight: 700; letter-spacing: 2px;" />
            </td>
          </tr>
          <tr>
            <td style="padding: 32px 32px 8px 32px;">
              <p style="margin: 0 0 6px 0; font-size: 13px; color: #059669;">A few things at once</p>
              <h1 style="margin: 0 0 22px 0; font-size: 22px; font-weight: 600; color: #064E3B; line-height: 1.35;">${items.length} updates from LOCUS</h1>
              <table border="0" cellpadding="0" cellspacing="0" width="100%">${rows}</table>
            </td>
          </tr>
          <tr>
            <td style="padding: 6px 32px 32px 32px;">
              <a href="${appUrl}/notifications" style="display: inline-block; background-color: #10B981; color: #FFFFFF; font-size: 15px; font-weight: 600; padding: 13px 26px; border-radius: 9px; text-decoration: none;">Open LOCUS</a>
            </td>
          </tr>
          <tr>
            <td style="background-color: #ECFDF5; padding: 20px 32px; border-top: 1px solid #D1FAE5; font-size: 12px; color: #047857; line-height: 1.7;">
              LOCUS grouped these because they arrived together. It is not medical advice, and in an emergency please call your local emergency number.<br />
              <a href="${appUrl}/settings" style="color: #059669;">Choose which emails you get</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

const digestText = items => {
  const appUrl = process.env.APP_URL || 'http://localhost:5173';
  const body = items.map(({ parts }) => {
    const detail = (parts.detailLabel && parts.detailValue) ? `\n${parts.detailLabel} ${parts.detailValue}` : '';
    return `${parts.title}\n${parts.message}${detail}`;
  }).join('\n\n');
  return `${items.length} updates from LOCUS\n\n${body}\n\nOpen LOCUS: ${appUrl}/notifications\n\n`
    + `LOCUS grouped these because they arrived together. It is not medical advice, and in an emergency please call your local emergency number.\n`
    + `Choose which emails you get: ${appUrl}/settings`;
};

/** Record the real outcome against every notification in the send. */
async function recordOutcome(items, sent) {
  const ids = items.map(i => i.notificationId).filter(Boolean);
  if (!ids.length) return;
  await deps.Notification.updateMany({ _id: { $in: ids } }, {
    $set: {
      'delivery.email.sent': sent,
      'delivery.email.failed': !sent,
      'delivery.email.sent_at': sent ? new Date() : null,
    },
  });
}

async function flush(to) {
  const entry = pending.get(to);
  if (!entry) return false;
  pending.delete(to);
  if (entry.timer) clearTimeout(entry.timer);
  const { items } = entry;

  let sent;
  if (items.length === 1) {
    const { parts, attachments } = items[0];
    sent = await deps.sendEmail({
      to, subject: parts.title,
      html: deps.getLocusEmailHtml(parts),
      text: deps.getLocusEmailText(parts),
      attachments: attachments || [],
    });
  } else {
    // In a digest the images are dropped: several inline frames would make the
    // message heavy, and each item keeps its own alert to open. The one that
    // matters most (a lost item) is urgent and rarely arrives in a burst.
    console.log(`[Email] coalesced ${items.length} emails to ${to} into one`);
    sent = await deps.sendEmail({ to, subject: digestSubject(items), html: digestHtml(items), text: digestText(items) });
  }
  await recordOutcome(items, sent);
  return sent;
}

/**
 * Queue one email. Returns immediately; the send happens on flush.
 * With EMAIL_COALESCE_MS=0 it sends inline and returns whether it went.
 */
async function queueEmail({ to, parts, notificationId, attachments = [] }) {
  if (!to) return false;
  const entry = pending.get(to) || { items: [], timer: null };
  entry.items.push({ parts, notificationId, attachments });
  pending.set(to, entry);

  if (COALESCE_MS <= 0) return await flush(to);

  // Keep the FIRST arrival's deadline: a steady trickle must not postpone the
  // email indefinitely.
  if (!entry.timer) {
    entry.timer = setTimeout(() => { flush(to).catch(e => console.error('[Email] flush failed:', e.message)); }, COALESCE_MS);
    if (entry.timer.unref) entry.timer.unref();   // never hold the process open
  }
  return null;   // outcome not known yet; recorded on flush
}

/** Send everything held right now (shutdown, and tests). */
async function flushAll() {
  const results = [];
  for (const to of [...pending.keys()]) results.push(await flush(to));
  return results;
}

module.exports = { queueEmail, flushAll, configure, COALESCE_MS, _digestHtml: digestHtml, _digestText: digestText };
