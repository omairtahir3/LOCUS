const nodemailer = require('nodemailer');
const Notification = require('../models/Notification');
const { generateAIDoseReminder, generateAIMissedDoseAlert, generateAITakenDoseAlert, generateAIUserTakenDoseAlert, generateAIEscalatedAlert, generateAIUserMissedDoseAlert } = require('./geminiAgent');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const fs = require('fs');
const path = require('path');

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

// Send an email notification via Nodemailer
const sendEmail = async ({ to, subject, html }) => {
  try {
    if (!process.env.EMAIL_USER || process.env.EMAIL_USER.includes('your_email')) {
      console.log(`[Nodemailer Simulation] To: ${to} | Subject: "${subject}"`);
      return true;
    }
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'LOCUS <noreply@locus-assist.com>',
      to,
      subject,
      html,
    });
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

// Pre-load logo as base64 to ensure it renders in email clients
let cachedLogoDataUri = '';
try {
  const logoPath = path.join(__dirname, '../../frontend/public/logo.png');
  if (fs.existsSync(logoPath)) {
    const b64 = fs.readFileSync(logoPath, 'base64');
    cachedLogoDataUri = `data:image/png;base64,${b64}`;
  }
} catch (e) {
  console.error('Could not load logo for email:', e.message);
}

// Generate premium interactive HTML email template with LOCUS branding
const getLocusEmailHtml = ({ title, message, type, medicationLogId, notificationId }) => {
  const appUrl = process.env.APP_URL || 'http://localhost:5173';
  const logoSrc = cachedLogoDataUri || `${appUrl}/logo.png`;
  
  let badgeText = 'SYSTEM NOTIFICATION';
  let badgeColor = '#064E3B'; // Dark green
  let badgeBg = '#D1FAE5';    // Light green
  let accentColor = '#10B981'; // Green
  
  if (type === 'dose_reminder') {
    badgeText = 'MEDICATION REMINDER';
    badgeColor = '#064E3B'; badgeBg = '#D1FAE5'; accentColor = '#10B981';
  } else if (type === 'missed_dose' || type === 'emergency' || type === 'escalated') {
    badgeText = 'CRITICAL ALERT';
    badgeColor = '#064E3B'; badgeBg = '#D1FAE5'; accentColor = '#10B981';
  } else if (type === 'status_check') {
    badgeText = 'STATUS CHECK';
    badgeColor = '#064E3B'; badgeBg = '#D1FAE5'; accentColor = '#10B981';
  } else if (type === 'caregiver_message') {
    badgeText = 'CAREGIVER MESSAGE';
    badgeColor = '#064E3B'; badgeBg = '#D1FAE5'; accentColor = '#10B981';
  }

  let actionButtons = '';
  if (type === 'dose_reminder') {
    actionButtons = `
      <table border="0" cellpadding="0" cellspacing="0" style="margin-top: 28px; width: 100%;">
        <tr>
          <td align="center">
            <a href="${appUrl}/medications" style="background-color: #10B981; color: #ffffff; font-weight: 700; font-size: 14px; padding: 14px 28px; border-radius: 8px; text-decoration: none; display: inline-block; margin: 6px; box-shadow: 0 4px 12px rgba(16, 185, 129, 0.4);">
              ✓ Confirm Dose Taken
            </a>
            <a href="${appUrl}/medications" style="background-color: #F59E0B; color: #ffffff; font-weight: 700; font-size: 14px; padding: 14px 28px; border-radius: 8px; text-decoration: none; display: inline-block; margin: 6px; box-shadow: 0 4px 12px rgba(245, 158, 11, 0.4);">
              Snooze 10m
            </a>
          </td>
        </tr>
      </table>
    `;
  } else if (type === 'status_check') {
    actionButtons = `
      <table border="0" cellpadding="0" cellspacing="0" style="margin-top: 28px; width: 100%;">
        <tr>
          <td align="center">
            <a href="${appUrl}/notifications" style="background-color: ${accentColor}; color: #ffffff; font-weight: 700; font-size: 14px; padding: 14px 28px; border-radius: 8px; text-decoration: none; display: inline-block; margin: 6px; box-shadow: 0 4px 12px rgba(13, 148, 136, 0.4);">
              I'm Okay
            </a>
            <a href="${appUrl}/notifications" style="background-color: #475569; color: #ffffff; font-weight: 700; font-size: 14px; padding: 14px 28px; border-radius: 8px; text-decoration: none; display: inline-block; margin: 6px;">
              Please Call Me
            </a>
          </td>
        </tr>
      </table>
    `;
  } else {
    actionButtons = `
      <table border="0" cellpadding="0" cellspacing="0" style="margin-top: 28px; width: 100%;">
        <tr>
          <td align="center">
            <a href="${appUrl}/dashboard" style="background-color: ${accentColor}; color: #ffffff; font-weight: 700; font-size: 14px; padding: 14px 32px; border-radius: 8px; text-decoration: none; display: inline-block; box-shadow: 0 4px 12px rgba(13, 148, 136, 0.4);">
              Open Live Dashboard
            </a>
          </td>
        </tr>
      </table>
    `;
  }

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin: 0; padding: 0; background-color: #ECFDF5; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; -webkit-font-smoothing: antialiased;">
      <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #ECFDF5; padding: 40px 10px;">
        <tr>
          <td align="center">
            <!-- Main Card -->
            <table border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; background-color: #D1FAE5; border-radius: 16px; overflow: hidden; border: 1px solid #10B981; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.08), 0 4px 6px -4px rgba(0, 0, 0, 0.05);">
              
              <!-- Header Brand & Logo -->
              <tr>
                <td style="background-color: #A7F3D0; padding: 32px; border-bottom: 3px solid ${accentColor}; text-align: center;">
                  <table border="0" cellpadding="0" cellspacing="0" width="100%">
                    <tr>
                      <td align="center">
                        <img src="${logoSrc}" alt="LOCUS" height="48" style="vertical-align: middle;" />
                      </td>
                    </tr>
                    <tr>
                      <td align="center" style="font-size: 11px; font-weight: 700; letter-spacing: 4px; color: #047857; padding-top: 12px;">
                        COGNITIVE CARE ASSISTANT
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Body Section -->
              <tr>
                <td style="padding: 40px 32px; background-color: #FFFFFF; color: #064E3B;">
                  
                  <!-- Badge -->
                  <table border="0" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="background-color: ${badgeBg}; color: ${badgeColor}; font-size: 11px; font-weight: 800; letter-spacing: 1px; padding: 6px 14px; border-radius: 9999px; text-transform: uppercase;">
                        ${badgeText}
                      </td>
                    </tr>
                  </table>

                  <!-- Title -->
                  <h1 style="margin: 22px 0 14px 0; font-size: 24px; font-weight: 800; color: #064E3B; line-height: 1.3;">
                    ${title}
                  </h1>

                  <!-- Message -->
                  <div style="font-size: 16px; color: #065F46; line-height: 1.6; background-color: #ECFDF5; padding: 20px 24px; border-left: 4px solid ${accentColor}; border-radius: 8px; margin-top: 16px;">
                    ${message}
                  </div>

                  <!-- Interactive Action Buttons -->
                  ${actionButtons}

                </td>
              </tr>

              <!-- Helpful Pro-Tip Box -->
              <tr>
                <td style="padding: 0 32px 32px 32px; background-color: #FFFFFF;">
                  <table border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #D1FAE5; border-radius: 12px; padding: 18px; border: 1px dashed #34D399;">
                    <tr>
                      <td style="font-size: 13px; color: #047857; line-height: 1.5;">
                        <span style="color: ${accentColor}; font-weight: 700;">PRO TIP:</span> You can confirm medication doses, snooze alerts, or respond to caregiver check-ins directly with a single tap using the interactive buttons above.
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Footer Section -->
              <tr>
                <td style="background-color: #ECFDF5; padding: 28px 32px; border-top: 1px solid #6EE7B7; text-align: center; font-size: 12px; color: #047857; line-height: 1.6;">
                  <p style="margin: 0 0 8px 0; font-weight: 700; color: #059669; letter-spacing: 1px;">
                    LOCUS AUTONOMOUS AI CARE PLATFORM
                  </p>
                  <p style="margin: 0;">
                    This is an automated healthcare notification. If you are experiencing a medical emergency, please contact your local emergency services immediately.<br>
                    <a href="${appUrl}/settings" style="color: ${accentColor}; text-decoration: underline; margin-top: 10px; display: inline-block;">Manage Notification Settings</a>
                  </p>
                </td>
              </tr>

            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
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
}) => {
  let finalMessage = message;
  if (medicationLogId) {
    const MedicationLog = require('../models/MedicationLog');
    const log = await MedicationLog.findById(medicationLogId);
    if (log && log.scheduled_time) {
      const dtStr = new Date(log.scheduled_time).toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true
      });
      finalMessage = `${message}\n\n(Scheduled for: ${dtStr})`;
    }
  }

  const notification = await Notification.create({
    recipient_id: recipientId,
    subject_user_id: subjectUserId,
    type,
    title,
    message: finalMessage,
    medication_id: medicationId,
    medication_log_id: medicationLogId,
    requires_acknowledgement: requiresAcknowledgement,
    delivery: {
      push:  { sent: false, failed: false },
      email: { sent: false, failed: false },
      sms:   { sent: false, failed: false },
    }
  });

  const updates = {};

  // Send email if requested
  if (sendEmailTo) {
    const sent = await sendEmail({
      to: sendEmailTo,
      subject: title,
      html: getLocusEmailHtml({ title, message, type, medicationLogId, notificationId: notification._id }),
    });
    updates['delivery.email.sent'] = sent;
    updates['delivery.email.sent_at'] = sent ? new Date() : null;
    updates['delivery.email.failed'] = !sent;
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
  const appUrl = process.env.APP_URL || 'http://localhost:5173';

  const User = require('../models/User');
  const MedicationLog = require('../models/MedicationLog');
  const caregivers = await User.find({ _id: { $in: user.caregiver_ids } });
  const log = await MedicationLog.findById(logId) || {};

  for (const caregiver of caregivers) {
    if (!caregiver.notification_prefs?.missed_dose) continue;

    let title, message;
    if (log && (log.status === 'camera_off' || log.status === 'skipped')) {
      title = `Camera Offline: ${medication.name} Unverified`;
      message = `We couldn't verify if ${user.name} took their ${medication.name} because the camera was offline. Please verify manually.`;
    } else if (log && log.pre_generated_missed_title && log.pre_generated_missed_message) {
      title = log.pre_generated_missed_title;
      message = log.pre_generated_missed_message;
    } else {
      const aiContent = await generateAIMissedDoseAlert(user, medication, log, caregiver);
      title = aiContent.title;
      message = aiContent.message;
    }

    // If it's a camera_off event, provide a Mark as Taken button for caregivers
    let actionButtons = '';
    if (log.status === 'camera_off' || log.status === 'skipped') {
      actionButtons = `
        <table border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-top: 24px;">
          <tr>
            <td align="left">
              <a href="${appUrl}/api/medications/logs/${logId}/taken?caregiver=${caregiver._id}" style="display: inline-block; padding: 12px 24px; background-color: #10b981; color: #ffffff; text-decoration: none; font-weight: 700; border-radius: 8px; font-size: 14px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
                ✓ Mark as Taken
              </a>
            </td>
          </tr>
        </table>
      `;
    }

    await createNotification({
      recipientId: caregiver._id,
      subjectUserId: user._id,
      type: log.status === 'camera_off' ? 'camera_off_alert' : 'missed_dose',
      title: title,
      message: message,
      actionButtons,
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
      recipientId: caregiver._id,
      subjectUserId: user._id,
      type: 'dose_confirmed',
      title: aiContent.title,
      message: aiContent.message,
      actionButtons: '',
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

  let title, message;
  if (log && (log.status === 'camera_off' || log.status === 'skipped')) {
    title = `Camera Offline: Could not verify ${medication.name}`;
    message = `Your camera was offline during your scheduled time for ${medication.name}, so we couldn't automatically verify if you took it.`;
  } else if (log && log.pre_generated_missed_title && log.pre_generated_missed_message) {
    title = log.pre_generated_missed_title;
    message = log.pre_generated_missed_message;
  } else {
    const aiContent = await generateAIUserMissedDoseAlert(user, medication, log);
    title = aiContent.title;
    message = aiContent.message;
  }

  await createNotification({
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

// Escalate an unacknowledged alert (re-send via Email & FCM and mark escalated)
const escalateAlert = async (notification) => {
  const User = require('../models/User');
  const recipient = await User.findById(notification.recipient_id);
  if (!recipient) return false;

  console.log(`[Escalation] Escalating alert ${notification._id} (${notification.title}) for caregiver ${recipient.name}`);

  const aiContent = await generateAIEscalatedAlert(notification, recipient);
  const escTitle = aiContent.title;
  const escMsg = aiContent.message;

  if (recipient.email) {
    await sendEmail({
      to: recipient.email,
      subject: escTitle,
      html: getLocusEmailHtml({ title: escTitle, message: escMsg, type: 'escalated', notificationId: notification._id }),
    });
  }
  await sendPushNotification({ userId: recipient._id, title: escTitle, body: escMsg });

  await Notification.findByIdAndUpdate(notification._id, {
    $set: {
      escalated: true,
      escalated_at: new Date(),
      'delivery.email.sent': true,
      'delivery.email.sent_at': new Date(),
      'delivery.push.sent': true,
      'delivery.push.sent_at': new Date(),
    }
  });

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
};