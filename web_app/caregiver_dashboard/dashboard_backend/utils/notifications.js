const nodemailer = require('nodemailer');
const Notification = require('../models/Notification');

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Send an email notification
const sendEmail = async ({ to, subject, html }) => {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM,
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

// Create a notification record in DB and optionally send email
const createNotification = async ({
  recipientId,
  subjectUserId = null,
  type,
  title,
  message,
  medicationId = null,
  medicationLogId = null,
  requiresAcknowledgement = false,
  sendEmailTo = null,   // email address string if email should be sent
}) => {
  const notification = await Notification.create({
    recipient_id: recipientId,
    subject_user_id: subjectUserId,
    type,
    title,
    message,
    medication_id: medicationId,
    medication_log_id: medicationLogId,
    requires_acknowledgement: requiresAcknowledgement,
    delivery: {
      push:  { sent: false, failed: false },
      email: { sent: false, failed: false },
      sms:   { sent: false, failed: false },
    }
  });

  // Send email if requested
  if (sendEmailTo) {
    const sent = await sendEmail({
      to: sendEmailTo,
      subject: title,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2 style="color: #1F4E79;">${title}</h2>
          <p style="font-size: 16px;">${message}</p>
          <hr/>
          <p style="color: #999; font-size: 12px;">MemoryAssist — Automated Alert</p>
        </div>
      `,
    });

    await Notification.findByIdAndUpdate(notification._id, {
      'delivery.email.sent': sent,
      'delivery.email.sent_at': sent ? new Date() : null,
      'delivery.email.failed': !sent,
    });
  }

  return notification;
};

// Notify all caregivers of a user about a missed dose
const notifyCaregiversMissedDose = async (user, medication, logId) => {
  if (!user.caregiver_ids || user.caregiver_ids.length === 0) return;

  const User = require('../models/User');
  const caregivers = await User.find({ _id: { $in: user.caregiver_ids } });

  for (const caregiver of caregivers) {
    if (!caregiver.notification_prefs?.missed_dose) continue;

    await createNotification({
      recipientId: caregiver._id,
      subjectUserId: user._id,
      type: 'missed_dose',
      title: `Missed Dose Alert — ${user.name}`,
      message: `${user.name} missed their ${medication.name} (${medication.dosage}) dose. Please check in with them.`,
      medicationId: medication._id,
      medicationLogId: logId,
      requiresAcknowledgement: true,
      sendEmailTo: caregiver.notification_prefs?.email ? caregiver.email : null,
    });
  }
};

module.exports = { createNotification, notifyCaregiversMissedDose, sendEmail };