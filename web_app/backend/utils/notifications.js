const nodemailer = require('nodemailer');
const Notification = require('../models/Notification');
const { generateAIDoseReminder, generateAIMissedDoseAlert, generateAITakenDoseAlert, generateAIUserTakenDoseAlert, generateAIEscalatedAlert, generateAIUserMissedDoseAlert } = require('./llmAgent');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const fs = require('fs');
const path = require('path');
const { queueEmail, flushAll, configure: configureDigest } = require('./emailDigest');

// Initialize Firebase Admin
try {
  const serviceAccountPath = path.join(__dirname, '../firebase-service-account.json');
  if (fs.existsSync(serviceAccountPath)) {
    const serviceAccount = require(serviceAccountPath);
    initializeApp({
      credential: cert(serviceAccount)
    });
    console.log('[Firebase Admin] Initialized successfully.');
  } else {
    console.log('[Firebase Admin] Warning: firebase-service-account.json not found. Push notifications will be simulated.');
  }
} catch (e) {
  console.error('[Firebase Admin] Initialization failed:', e.message);
}
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Check SMTP once at boot and say so loudly. Caregiver emails had been failing
// on every send with "535 Username and Password not accepted" for weeks, and
// the only trace was a one-line warning per email buried in the log while the
// delivery record claimed success. A configuration problem should announce
// itself at startup, not per notification.
const emailConfigured = !!process.env.EMAIL_USER && !process.env.EMAIL_USER.includes('your_email');
let smtpVerified = false;
if (emailConfigured) {
  transporter.verify()
    .then(() => { smtpVerified = true; console.log(`[Email] SMTP OK — ${process.env.EMAIL_HOST} as ${process.env.EMAIL_USER}`); })
    .catch(err => {
      const gmail = /gmail/i.test(process.env.EMAIL_HOST || '');
      console.error(`[Email] SMTP verification FAILED: ${err.message.split('\n')[0]}`);
      if (gmail && /535|invalid login|not accepted/i.test(err.message)) {
        console.error('[Email] Gmail rejected the password. Gmail SMTP requires a 16-character App Password '
          + '(Google Account → Security → 2-Step Verification → App passwords), not the account password. '
          + 'App passwords are revoked when the account password changes. '
          + 'Until EMAIL_PASS is a valid app password, NO caregiver emails will be delivered.');
      }
    });
} else {
  console.log('[Email] EMAIL_USER not configured — emails will be simulated (logged, not sent).');
}

/**
 * Who, if anyone, an unanswered alert can be escalated TO.
 *
 * caregiver_ids is an ELDERLY-only concept (see models/User.js). A normal
 * user has nobody watching over them, so for them there is no second person
 * to chase, nothing to acknowledge to, and no caregiver to mention. Saying
 * "we've let your caregiver know" to someone with no caregiver is a false
 * statement about what the app did, and escalating their own alert back to
 * them is just the same message again with ESCALATED on it (150 of those had
 * been sent by 23 Sep 2026).
 *
 * Returns the caregiver documents, or [] when there is no escalation path.
 */
async function escalationTargets(recipientId, subjectUserId) {
  const User = require('../models/User');
  const recipient = await User.findById(recipientId).lean();
  if (!recipient) return [];
  // A caregiver IS the escalation target: chasing them again is the point.
  if (recipient.role === 'caregiver') return [recipient];
  // Otherwise the alert is about the recipient themselves. Only an elderly
  // user has anyone behind them.
  const subject = String(subjectUserId || recipientId) === String(recipientId)
    ? recipient
    : await User.findById(subjectUserId).lean();
  if (!subject || !subject.caregiver_ids || !subject.caregiver_ids.length) return [];
  return User.find({ _id: { $in: subject.caregiver_ids } }).lean();
}

/**
 * Bring the dedup_key index into line with the model.
 *
 * Mongoose's autoIndex creates a missing index but will not alter one that
 * already exists under the same name with different options, so an older
 * `sparse` version would survive a deploy and keep rejecting every keyless
 * notification (sparse indexes DO index explicit nulls). This drops anything
 * that does not match and lets the model rebuild it, after clearing nulls
 * left by an earlier schema.
 */
async function ensureDedupIndex() {
  try {
    const coll = Notification.collection;
    const existing = (await coll.indexes()).find(i => i.name === 'dedup_key_1');
    const correct = existing && existing.unique === true
      && JSON.stringify(existing.partialFilterExpression) === JSON.stringify({ dedup_key: { $type: 'string' } });
    if (existing && !correct) {
      await coll.dropIndex('dedup_key_1');
      console.log('[Notifications] replaced the old dedup_key index');
    }
    await Notification.updateMany({ dedup_key: null }, { $unset: { dedup_key: '' } });
    if (!correct) await Notification.syncIndexes();
  } catch (e) {
    console.error('[Notifications] could not set up the dedup_key index:', e.message);
  }
}

// Send an email notification via Nodemailer
/**
 * FE-15: fetch a keyframe so it can be embedded in an email.
 *
 * A caregiver told an item is lost needs to SEE it: a name and a map pin do
 * not tell them whether it is the right set of keys. The id was being carried
 * in finding.evidence and shown nowhere. Returns a nodemailer attachment, or
 * null if the frame has already aged out under KEYFRAME_TTL_HOURS.
 */
async function keyframeAttachment(keyframeId, cid = 'keyframe') {
  if (!keyframeId) return null;
  try {
    const axios = require('axios');
    const base = process.env.PYTHON_SERVICE_URL || 'http://localhost:8000';
    const res = await axios.get(`${base}/api/keyframes/${keyframeId}/image`, {
      responseType: 'arraybuffer', timeout: 10000,
    });
    return { filename: 'last-seen.jpg', content: Buffer.from(res.data), cid,
             contentType: res.headers['content-type'] || 'image/jpeg' };
  } catch (e) {
    console.warn(`[Email] keyframe ${keyframeId} unavailable (${e.response?.status || e.code || e.message}); sending without it`);
    return null;
  }
}

const sendEmail = async ({ to, subject, html, text, attachments = [] }) => {
  try {
    if (!emailConfigured) {
      // Simulated: log it, but do NOT report it as sent. Reporting simulated
      // sends as delivered is how a broken mail setup stays invisible.
      console.log(`[Email Simulation] To: ${to} | Subject: "${subject}"`);
      return false;
    }

    const mailOptions = {
      from: process.env.EMAIL_FROM || 'LOCUS <noreply@locus-assist.com>',
      to,
      subject,
      html,
      // Without a text/plain part, clients that do not render HTML fall back to
      // stripping the markup, which is where stray tags and entities show up.
      ...(text ? { text } : {}),
    };

    // The app logo is black artwork on transparency, which disappears against
    // a dark header and against whatever background a client in dark mode
    // decides to paint. assets/logo-email.png is the same mark in white, and
    // it sits on an explicit dark green band, so it is legible either way.
    const logoPath = path.join(__dirname, '../assets/logo-email.png');
    const fallbackLogo = path.join(__dirname, '../../frontend/public/logo.png');
    const logo = fs.existsSync(logoPath) ? logoPath : (fs.existsSync(fallbackLogo) ? fallbackLogo : null);
    mailOptions.attachments = [
      ...(logo ? [{ filename: 'logo.png', path: logo, cid: 'locuslogo' }] : []),
      ...attachments,
    ];

    await transporter.sendMail(mailOptions);
    return true;
  } catch (err) {
    console.error('Email send error:', err.message);
    return false;
  }
};

// Send a push notification via FCM / Local Push
const sendPushNotification = async ({ userId, title, body, payload = {} }) => {
  try {
    const User = require('../models/User');
    const user = await User.findById(userId);
    
    if (user && user.fcm_token && getApps().length > 0) {
      await getMessaging().send({
        token: user.fcm_token,
        notification: { title, body },
        data: {
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
          ...payload
        }
      });
      console.log(`[FCM Push] Successfully sent to User ${userId} -> "${title}"`);
      return true;
    }
    
    // Fallback if no token or Firebase not configured
    console.log(`[FCM Push Simulated] Dispatched to User ${userId} -> "${title}: ${body}"`);
    return true;
  } catch (err) {
    console.error('[FCM Push] Send error:', err.message);
    return false;
  }
};

// ── Email ───────────────────────────────────────────────────────────────────
//
// One layout for every notification. The message body is written by
// llmAgent.js (or its template) and arrives already in plain, warm language,
// so the email's job is to present it and offer one clear thing to do -- not
// to shout. The previous version wrapped every message, including "your dose
// is confirmed", in a CRITICAL ALERT badge, an all-caps "LOCUS AUTONOMOUS AI
// CARE PLATFORM" footer and a PRO TIP box describing buttons that were not on
// the page; and it promised one-tap actions that only opened the app.
//
// Palette stays light green throughout. No exclamation marks, no all-caps, no
// letter-spaced banners.

// Text arrives from the agent and from user-entered names, and goes into HTML.
// Only the three characters that can break markup are encoded; apostrophes and
// quotes are left as they are so no reader ever sees &#39; or &quot;.
const escapeHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A bare URL in a message (the map link in a lost-item alert) should be
// tappable rather than a wall of characters to copy out by hand.
const linkify = html => html.replace(
  /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g,
  u => `<a href="${u}" style="color: #059669;">${u}</a>`);

// A message is one or two sentences, but anything that did arrive with line
// breaks becomes real paragraphs rather than collapsing into a run-on line.
const paragraphs = (text, style) => escapeHtml(text)
  .split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
  .map(p => `<p style="${style}">${linkify(p.replace(/\n/g, '<br />'))}</p>`)
  .join('');

// Per type: the quiet label above the title, and the one action offered.
// Links open the app -- none of these are one-tap endpoints, so none of them
// claim to be.
const EMAIL_TYPES = {
  dose_reminder:               { kicker: 'Medication reminder', cta: 'Confirm in LOCUS',       path: '/medications' },
  missed_dose:                 { kicker: 'Worth a check',       cta: 'Open LOCUS',             path: '/medications' },
  camera_off_alert:            { kicker: 'Not confirmed',       cta: 'Confirm it by hand',     path: '/medications' },
  skipped_medicine:            { kicker: 'Worth a check',       cta: 'Open LOCUS',             path: '/medications' },
  dose_confirmed:              { kicker: 'All done',            cta: "See today's doses",      path: '/medications' },
  emergency:                   { kicker: 'Needs you now',       cta: 'Open LOCUS',             path: '/dashboard' },
  escalated:                   { kicker: 'Still waiting',       cta: 'Open LOCUS',             path: '/notifications' },
  status_check:                { kicker: 'Check-in',            cta: 'Reply in LOCUS',         path: '/notifications' },
  caregiver_message:           { kicker: 'Message',             cta: 'Read in LOCUS',          path: '/notifications' },
  system:                      { kicker: 'Notice',              cta: 'Open LOCUS',             path: '/dashboard' },
  routine_medication_gap:      { kicker: 'Medication',          cta: 'See the dose history',   path: '/medications' },
  routine_inactivity:          { kicker: 'Needs you now',       cta: 'Open LOCUS',             path: '/dashboard' },
  routine_camera_off:          { kicker: 'Camera',              cta: 'Check the camera',       path: '/dashboard' },
  routine_deviation:           { kicker: 'A change in routine', cta: 'Open LOCUS',             path: '/dashboard' },
  routine_left_behind:         { kicker: 'Your things',         cta: 'See where it was',       path: '/items' },
  routine_habitual_item:       { kicker: 'Your things',         cta: 'See where it usually is', path: '/items' },
  routine_item_lost:           { kicker: 'Your things',         cta: 'See where it was',       path: '/items' },
  routine_item_lost_escalated: { kicker: 'Needs you now',       cta: 'Open LOCUS',             path: '/dashboard' },
};

/**
 * @param {string}  title          already written for a person, sentence case
 * @param {string}  message        one or two sentences, plain language
 * @param {string}  type           Notification.type
 * @param {string}  [detailLabel]  e.g. 'Scheduled for'   (optional row)
 * @param {string}  [detailValue]  e.g. 'Monday 22 September, 2:00 PM'
 * @param {string}  [linkLabel]    e.g. 'Where it was last seen'  (optional row)
 * @param {string}  [linkUrl]      a plain https link the reader can tap
 * @param {string}  [kicker]       overrides the type's label
 * @param {string}  [ctaLabel]     overrides the type's button, for one-off
 * @param {string}  [ctaUrl]       emails such as a password reset
 * @param {string}  [footNote]     replaces the standard footer sentence
 * @param {string}  [imageCid]     cid of an attached image to show (FE-15)
 * @param {string}  [imageCaption] one line under it
 */
const getLocusEmailHtml = ({ title, message, type, detailLabel, detailValue, linkLabel, linkUrl, kicker, ctaLabel, ctaUrl, footNote, imageCid, imageCaption }) => {
  const appUrl = process.env.APP_URL || 'http://localhost:5173';
  const base = EMAIL_TYPES[type] || EMAIL_TYPES.system;
  const t = {
    kicker: kicker || base.kicker,
    cta: ctaLabel || base.cta,
    href: ctaUrl || `${appUrl}${base.path}`,
  };

  const detailRow = (detailLabel && detailValue) ? `
              <tr>
                <td style="padding: 0 32px;">
                  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #F0FDF4; border-radius: 10px;">
                    <tr>
                      <td style="padding: 14px 18px; font-size: 14px; color: #047857; line-height: 1.5;">
                        ${escapeHtml(detailLabel)} <span style="color: #064E3B; font-weight: 600;">${escapeHtml(detailValue)}</span>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>` : '';

  // FE-15: the frame the camera last saw the item in. Bounded so a portrait
  // frame cannot push the button off the screen.
  const imageRow = imageCid ? `
              <tr>
                <td style="padding: 18px 32px 0 32px;">
                  <img src="cid:${escapeHtml(imageCid)}" alt="${escapeHtml(imageCaption || 'Last seen')}" width="496" style="display: block; width: 100%; max-width: 496px; height: auto; border: 1px solid #D1FAE5; border-radius: 10px;" />
                  ${imageCaption ? `<p style="margin: 8px 0 0 0; font-size: 13px; color: #047857;">${escapeHtml(imageCaption)}</p>` : ''}
                </td>
              </tr>` : '';

  const linkRow = (linkLabel && linkUrl) ? `
              <tr>
                <td style="padding: 12px 32px 0 32px; font-size: 14px; color: #047857; line-height: 1.5;">
                  ${escapeHtml(linkLabel)}: <a href="${escapeHtml(linkUrl)}" style="color: #059669;">${escapeHtml(linkUrl)}</a>
                </td>
              </tr>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #F0FDF4; -webkit-font-smoothing: antialiased;">
  <div style="display: none; max-height: 0; overflow: hidden; opacity: 0;">${escapeHtml(message)}</div>
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
            <td style="padding: 32px 32px 4px 32px;">
              <p style="margin: 0 0 6px 0; font-size: 13px; color: #059669;">${escapeHtml(t.kicker)}</p>
              <h1 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 600; color: #064E3B; line-height: 1.35;">${escapeHtml(title)}</h1>
              ${paragraphs(message, 'margin: 0 0 14px 0; font-size: 16px; color: #1F2937; line-height: 1.65;')}
            </td>
          </tr>
${imageRow}${detailRow}${linkRow}
          <tr>
            <td style="padding: 22px 32px 32px 32px;">
              <a href="${escapeHtml(t.href)}" style="display: inline-block; background-color: #10B981; color: #FFFFFF; font-size: 15px; font-weight: 600; padding: 13px 26px; border-radius: 9px; text-decoration: none;">${escapeHtml(t.cta)}</a>
            </td>
          </tr>

          <tr>
            <td style="background-color: #ECFDF5; padding: 20px 32px; border-top: 1px solid #D1FAE5; font-size: 12px; color: #047857; line-height: 1.7;">
              ${escapeHtml(footNote || 'LOCUS sent this automatically. It is not medical advice, and in an emergency please call your local emergency number.')}<br />
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

/** The text/plain alternative, for clients that do not render HTML. */
const getLocusEmailText = ({ title, message, type, detailLabel, detailValue, linkLabel, linkUrl, ctaLabel, ctaUrl, footNote }) => {
  const appUrl = process.env.APP_URL || 'http://localhost:5173';
  const base = EMAIL_TYPES[type] || EMAIL_TYPES.system;
  const blocks = [title, message];
  if (detailLabel && detailValue) blocks.push(`${detailLabel} ${detailValue}`);
  if (linkLabel && linkUrl) blocks.push(`${linkLabel}: ${linkUrl}`);
  blocks.push(`${ctaLabel || base.cta}: ${ctaUrl || appUrl + base.path}`);
  blocks.push((footNote || 'LOCUS sent this automatically. It is not medical advice, and in an emergency please call your local emergency number.')
    + `\nChoose which emails you get: ${appUrl}/settings`);
  return blocks.join('\n\n');
};

// Create a notification record in DB and optionally send email & push
const createNotification = async ({
  recipientId,
  subjectUserId = null,
  type,
  title,
  message,
  medicationId = null,
  medicationLogId = null,
  requiresAcknowledgement = false,
  sendEmailTo = null,
  sendPush = true,
  dedupKey = null,
  attachments = [],
  imageCid = null,
  imageCaption = null,
}) => {
  // The scheduled time used to be glued onto the message as
  // "\n\n(Scheduled for: ...)". Those newlines collapse in HTML, so both the
  // email and the notifications page showed a parenthesis jammed onto the end
  // of the sentence. It travels as its own field now and is laid out as a row.
  // Requiring acknowledgement is what puts an alert into the escalation queue.
  // With nobody to escalate to, it can only ever be re-sent to the person who
  // already has it, so it is downgraded to a plain notification.
  if (requiresAcknowledgement && !(await escalationTargets(recipientId, subjectUserId)).length) {
    requiresAcknowledgement = false;
  }

  let detailLabel = null, detailValue = null;
  if (medicationLogId) {
    const MedicationLog = require('../models/MedicationLog');
    const log = await MedicationLog.findById(medicationLogId);
    if (log && log.scheduled_time) {
      detailLabel = 'Scheduled for';
      detailValue = new Date(log.scheduled_time).toLocaleString('en-US', {
        weekday: 'long', day: 'numeric', month: 'long',
        hour: 'numeric', minute: '2-digit', hour12: true,
      });
    }
  }

  let notification;
  try {
    notification = await Notification.create({
      recipient_id: recipientId,
      subject_user_id: subjectUserId,
      type,
      title,
      message,
      medication_id: medicationId,
      medication_log_id: medicationLogId,
      requires_acknowledgement: requiresAcknowledgement,
      // absent, never null, when there is no natural key (see the model)
      ...(dedupKey ? { dedup_key: dedupKey } : {}),
      delivery: {
        push:  { sent: false, failed: false },
        email: { sent: false, failed: false },
        sms:   { sent: false, failed: false },
      }
    });
  } catch (e) {
    // Unique index on dedup_key: this exact alert has already been raised and
    // delivered. Return the original and, above all, do not send it again.
    if (e.code === 11000 && dedupKey) {
      console.warn(`[Notifications] duplicate suppressed: ${dedupKey}`);
      return await Notification.findOne({ dedup_key: dedupKey });
    }
    throw e;
  }

  const updates = {};

  // Send email if requested
  // Queued, not sent: a burst to the same person goes out as one email.
  // emailDigest records delivery.email.* itself once the send happens, so the
  // fields are set here only when it sends inline (EMAIL_COALESCE_MS=0).
  if (sendEmailTo) {
    const sent = await queueEmail({
      to: sendEmailTo,
      parts: { title, message, type, detailLabel, detailValue, imageCid, imageCaption },
      notificationId: notification._id,
      attachments,
    });
    if (sent !== null) {
      updates['delivery.email.sent'] = sent;
      updates['delivery.email.sent_at'] = sent ? new Date() : null;
      updates['delivery.email.failed'] = !sent;
    }
  }

  // Send push notification via FCM
  if (sendPush) {
    const sentPush = await sendPushNotification({
      userId: recipientId,
      title,
      body: message,
      payload: { type, medicationId: medicationId?.toString(), logId: medicationLogId?.toString() }
    });
    updates['delivery.push.sent'] = sentPush;
    updates['delivery.push.sent_at'] = sentPush ? new Date() : null;
    updates['delivery.push.failed'] = !sentPush;
  }

  if (Object.keys(updates).length > 0) {
    await Notification.findByIdAndUpdate(notification._id, { $set: updates });
  }

  return notification;
};

// Notify user about an upcoming or snoozed dose
const notifyUserDoseReminder = async (user, medication, log) => {
  if (user.notification_prefs && !user.notification_prefs.push && !user.notification_prefs.email) return null;

  const aiContent = await generateAIDoseReminder(user, medication, log);
  const title = aiContent.title;
  const message = aiContent.message;

  return await createNotification({
    // Reminder #2 for a dose is a different event from reminder #1, so the
    // count is part of the key; the same count is the same event.
    dedupKey: `${user._id}:dose_reminder:${log._id}:${log.reminder_count || 0}`,
    recipientId: user._id,
    subjectUserId: user._id,
    type: 'dose_reminder',
    title,
    message,
    medicationId: medication._id,
    medicationLogId: log._id,
    requiresAcknowledgement: false,
    sendEmailTo: user.notification_prefs?.email ? user.email : null,
    sendPush: user.notification_prefs?.push !== false,
  });
};

// Notify all caregivers of a user about a missed dose
const notifyCaregiversMissedDose = async (user, medication, logId) => {
  if (!user.caregiver_ids || user.caregiver_ids.length === 0) return;

  const User = require('../models/User');
  const MedicationLog = require('../models/MedicationLog');
  const caregivers = await User.find({ _id: { $in: user.caregiver_ids } });
  const log = await MedicationLog.findById(logId) || {};

  for (const caregiver of caregivers) {
    if (!caregiver.notification_prefs?.missed_dose) continue;

    // camera_off and skipped used to be written here by hand, as
    // "Camera Offline: Panadol Unverified / ... Please verify manually." The
    // agent already distinguishes "could not see it" from "was missed" and
    // says so in plain words, so both cases go through it. Pre-generated text
    // is only used for a genuine miss: it was written with missed wording.
    let title, message;
    const cameraOff = log && (log.status === 'camera_off' || log.status === 'skipped');
    if (!cameraOff && log && log.pre_generated_missed_title && log.pre_generated_missed_message) {
      title = log.pre_generated_missed_title;
      message = log.pre_generated_missed_message;
    } else {
      const aiContent = await generateAIMissedDoseAlert(user, medication, log, caregiver);
      title = aiContent.title;
      message = aiContent.message;
    }

    await createNotification({
      dedupKey: `${caregiver._id}:missed:${logId}`,
      recipientId: caregiver._id,
      subjectUserId: user._id,
      type: log.status === 'camera_off' ? 'camera_off_alert' : 'missed_dose',
      title: title,
      message: message,
      medicationId: medication._id,
      medicationLogId: logId,
      requiresAcknowledgement: true,
      sendEmailTo: caregiver.notification_prefs?.email ? caregiver.email : null,
      sendPush: caregiver.notification_prefs?.push !== false,
    });
  }
};

// Notify all caregivers of a user about a taken dose
const notifyCaregiversTakenDose = async (user, medication, logId) => {
  if (!user.caregiver_ids || user.caregiver_ids.length === 0) return;

  const User = require('../models/User');
  const MedicationLog = require('../models/MedicationLog');
  const caregivers = await User.find({ _id: { $in: user.caregiver_ids } });
  const log = await MedicationLog.findById(logId) || {};

  for (const caregiver of caregivers) {
    if (caregiver.notification_prefs && caregiver.notification_prefs.push === false && caregiver.notification_prefs.email === false) continue;

    const aiContent = await generateAITakenDoseAlert(user, medication, log, caregiver);

    await createNotification({
      dedupKey: `${caregiver._id}:taken:${logId}`,
      recipientId: caregiver._id,
      subjectUserId: user._id,
      type: 'dose_confirmed',
      title: aiContent.title,
      message: aiContent.message,
      medicationId: medication._id,
      medicationLogId: logId,
      requiresAcknowledgement: false,
      sendEmailTo: caregiver.notification_prefs?.email ? caregiver.email : null,
      sendPush: caregiver.notification_prefs?.push !== false,
    });
  }
};

// Notify the user themselves about a taken dose (AI generation)
const notifyUserTakenDose = async (user, medication, logId) => {
  const MedicationLog = require('../models/MedicationLog');
  const log = await MedicationLog.findById(logId) || {};

  const aiContent = await generateAIUserTakenDoseAlert(user, medication, log);

  await createNotification({
    dedupKey: `${user._id}:taken:${logId}`,
    recipientId: user._id,
    subjectUserId: user._id,
    type: 'dose_confirmed',
    title: aiContent.title,
    message: aiContent.message,
    medicationId: medication._id,
    medicationLogId: logId,
    requiresAcknowledgement: false,
    sendEmailTo: user.notification_prefs?.email ? user.email : null,
    sendPush: user.notification_prefs?.push !== false,
  });
};

// Notify the user themselves about a missed dose (AI generation)
const notifyUserMissedDose = async (user, medication, logId) => {
  const MedicationLog = require('../models/MedicationLog');
  const log = await MedicationLog.findById(logId) || {};

  // Same as the caregiver path: the agent phrases camera_off as "we couldn't
  // see it", never as a missed dose, so it is not written by hand here.
  let title, message;
  const cameraOff = log && (log.status === 'camera_off' || log.status === 'skipped');
  if (!cameraOff && log && log.pre_generated_missed_title && log.pre_generated_missed_message) {
    title = log.pre_generated_missed_title;
    message = log.pre_generated_missed_message;
  } else {
    // Only claim a caregiver was told if one exists to tell. Normal users have
    // none (caregiver_ids is elderly-only), and notifyCaregiversMissedDose
    // returns early for them, so the claim would be false.
    const caregiverNotified = !!(user.caregiver_ids && user.caregiver_ids.length);
    const aiContent = await generateAIUserMissedDoseAlert(user, medication, log, caregiverNotified);
    title = aiContent.title;
    message = aiContent.message;
  }

  await createNotification({
    dedupKey: `${user._id}:missed:${logId}`,
    recipientId: user._id,
    subjectUserId: user._id,
    type: log.status === 'camera_off' ? 'camera_off_alert' : 'missed_dose',
    title: title,
    message: message,
    medicationId: medication._id,
    medicationLogId: logId,
    requiresAcknowledgement: true,
    sendEmailTo: user.notification_prefs?.email ? user.email : null,
    sendPush: user.notification_prefs?.push !== false,
  });
};

// Escalate an unacknowledged alert. For a caregiver this re-alerts them; for
// an elderly user it goes to the people looking after them. With nobody to
// escalate to it does nothing, rather than sending the same person the same
// message with ESCALATED on it.
const escalateAlert = async (notification) => {
  const targets = await escalationTargets(notification.recipient_id, notification.subject_user_id);
  if (!targets.length) {
    console.log(`[Escalation] No caregiver to escalate ${notification._id} to, leaving it`);
    return false;
  }
  const recipient = targets[0];

  // When the alert is being passed to somebody else, it has to be restated for
  // them: the original is addressed to the person who did not answer.
  const passedOn = String(recipient._id) !== String(notification.recipient_id);
  let subjectName = null;
  if (passedOn) {
    const User = require('../models/User');
    const subject = await User.findById(notification.subject_user_id || notification.recipient_id).lean();
    subjectName = subject?.name || null;
  }

  console.log(`[Escalation] Escalating alert ${notification._id} (${notification.title}) to ${targets.map(t => t.name).join(', ')}`);

  const aiContent = await generateAIEscalatedAlert(notification, recipient, subjectName);
  const escTitle = aiContent.title;
  const escMsg = aiContent.message;

  // Record what ACTUALLY happened. This used to stamp email.sent = true
  // unconditionally, so every caregiver email that failed at SMTP was recorded
  // as delivered fifteen minutes later -- the delivery records read
  // {sent: true, failed: true} -- and the failure was invisible from the UI.
  let emailSent = null;
  if (recipient.email) {
    emailSent = await queueEmail({
      to: recipient.email,
      parts: { title: escTitle, message: escMsg, type: 'escalated' },
      notificationId: notification._id,
    });
  }
  const pushSent = await sendPushNotification({ userId: recipient._id, title: escTitle, body: escMsg });

  const set = { escalated: true, escalated_at: new Date() };
  if (recipient.email && emailSent !== null) {
    set['delivery.email.sent'] = emailSent;
    set['delivery.email.failed'] = !emailSent;
    if (emailSent) set['delivery.email.sent_at'] = new Date();
  }
  set['delivery.push.sent'] = pushSent;
  set['delivery.push.failed'] = !pushSent;
  if (pushSent) set['delivery.push.sent_at'] = new Date();
  await Notification.findByIdAndUpdate(notification._id, { $set: set });

  return true;
};

module.exports = {
  createNotification,
  notifyCaregiversMissedDose,
  notifyCaregiversTakenDose,
  notifyUserDoseReminder,
  notifyUserMissedDose,
  notifyUserTakenDose,
  escalateAlert,
  sendEmail,
  sendPushNotification,
  getLocusEmailHtml,
  getLocusEmailText,
  queueEmail,
  flushEmails: flushAll,
  ensureDedupIndex,
  keyframeAttachment,
};

// emailDigest needs to send and to record delivery, but notifications.js is
// what requires it, so the dependencies are handed over rather than required
// back (which would be a cycle).
configureDigest({ sendEmail, getLocusEmailHtml, getLocusEmailText, Notification });