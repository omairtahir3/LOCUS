const axios = require('axios');

/**
 * LOCUS Gemini AI Agent for Dynamic Notifications & Alerts
 * Uses Google Gemini 1.5 Flash (Free Tier) to generate empathetic, persona-tailored messages.
 * Includes robust dynamic fallbacks when API key is unconfigured or offline.
 */

// --- Circuit Breaker Pattern ---
let consecutiveFailures = 0;
let breakerTrippedUntil = null;

// --- Hardcoded Vault (Tier 0 Fallback) ---
const hardcodedVault = {
  dose_reminder: [
    "It's time for your scheduled medication.",
    "Please take your medication now.",
    "Time for your daily medication routine.",
    "Your health is important! It's time for your medication.",
    "Friendly reminder: your medicine is due."
  ],
  missed_caregiver: [
    "A dose was missed by the patient. Please check on them.",
    "Medication was not verified in time. Caregiver intervention required.",
    "Alert: Scheduled medication was missed.",
    "Please follow up: A medication dose was missed."
  ],
  missed_patient: [
    "You missed your medication window. Please take it as soon as possible.",
    "We noticed you haven't taken your medication. Please check your pillbox.",
    "Your scheduled medication time has passed. Please take it now.",
    "Reminder: You missed a dose. It's important to stay on track."
  ],
  taken_caregiver: [
    "The patient has successfully verified their medication.",
    "Good news: Medication dose confirmed.",
    "Dose taken and verified."
  ],
  taken_patient: [
    "Great job taking your medication on time!",
    "Dose confirmed. Keep up the good work!",
    "Medication verified successfully."
  ]
};

const getRandomString = (array) => array[Math.floor(Math.random() * array.length)];

const callGeminiJSON = async (systemInstruction, prompt) => {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey || apiKey === 'your_gemini_api_key_here' || apiKey.trim() === '') {
    return null; // Gracefully use dynamic fallback
  }

  if (breakerTrippedUntil && new Date() < breakerTrippedUntil) {
    console.warn(`[Circuit Breaker] API calls disabled until ${breakerTrippedUntil.toISOString()}`);
    return null;
  }

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    const payload = {
      system_instruction: {
        parts: [{ text: systemInstruction }]
      },
      contents: [{
        parts: [{ text: prompt }]
      }],
      generationConfig: {
        temperature: 0.6,
        maxOutputTokens: 250,
        responseMimeType: "application/json"
      }
    };

    const response = await axios.post(url, payload, { timeout: 15000 });
    let text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      text = text.replace(/```json/gi, '').replace(/```/g, '').trim();
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start !== -1 && end !== -1) {
        text = text.substring(start, end + 1);
        consecutiveFailures = 0; // Reset breaker on success
        if (breakerTrippedUntil) breakerTrippedUntil = null;
        return JSON.parse(text);
      }
      throw new Error("No valid JSON object found in Gemini response.");
    }
  } catch (err) {
    consecutiveFailures++;
    console.warn(`[GeminiAgent] API call failed. Consecutive failures: ${consecutiveFailures}. Error:`, err?.response?.data?.error?.message || err.message);
    if (consecutiveFailures >= 3) {
      breakerTrippedUntil = new Date(Date.now() + 12 * 3600000); // Trip for 12 hours
      console.error(`[Circuit Breaker] Tripped! Disabling Gemini for 12 hours.`);
    }
  }
  return null;
};

/**
 * Generate AI Dose Reminder for Patient
 */
const generateAIDoseReminder = async (user, medication, log) => {
  const isElderly = user.role === 'elderly';
  const userName = user.name || 'Friend';
  const medName = medication.name || 'Medication';
  const medDosage = medication.dosage || '';
  const timeStr = log.scheduled_time ? new Date(log.scheduled_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'scheduled window';

  const systemInstruction = `You are LOCUS, an empathetic AI healthcare and medication assistant.
Your task is to generate a JSON object with two fields:
- "title": A short notification title (max 50 characters).
- "message": A 1-2 sentence reminder body text.
Strict Rules:
1. Do NOT invent medical advice or change dosages.
2. If the user is an elderly patient, use a warm, respectful, gentle, and encouraging tone.
3. If the user is self-managing, use a clean, supportive, motivational tone.
4. Output MUST be valid JSON matching {"title": "...", "message": "..."}.`;

  const prompt = `Generate a reminder for:
Patient Name: ${userName}
Role: ${user.role || 'user'} (${isElderly ? 'Elderly Patient' : 'Self-Managing User'})
Medication: ${medName} (${medDosage})
Scheduled Time: ${timeStr}
Reminder Attempt: ${log.reminder_count || 1}`;

  const aiResult = await callGeminiJSON(systemInstruction, prompt);
  if (aiResult && aiResult.title && aiResult.message) {
    console.log(`[GeminiAgent] Generated AI Dose Reminder for ${userName}: "${aiResult.title}"`);
    return aiResult;
  }

  // Robust dynamic fallback using Hardcoded Vault
  return {
    title: isElderly ? `Hello ${userName} — Medication Reminder` : `[Reminder] ${medName} ${medDosage}`,
    message: getRandomString(hardcodedVault.dose_reminder)
  };
};

/**
 * Generate AI Missed Dose Alert for Caregivers
 */
const generateAIMissedDoseAlert = async (user, medication, log, caregiver) => {
  const patientName = user.name || 'Patient';
  const caregiverName = caregiver?.name || 'Caregiver';
  const medName = medication.name || 'Medication';
  const medDosage = medication.dosage || '';
  const remCount = log.reminder_count || 3;
  const timeStr = log.scheduled_time ? new Date(log.scheduled_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'scheduled time';

  const systemInstruction = `You are LOCUS AI. Your task is to generate an urgent, clinical caregiver alert in JSON format: {"title": "...", "message": "..."}.
Summarize clearly that the patient has missed their medication after all automated reminder attempts.
Tone: Professional, urgent, concise, actionable.`;

  const isCameraOff = log.status === 'camera_off';
  const prompt = `Generate a caregiver alert for:
Caregiver: ${caregiverName}
Patient: ${patientName}
Medication: ${medName} (${medDosage})
Scheduled Time: ${timeStr}
Reminders Exhausted: ${remCount} attempts
Condition: ${isCameraOff ? "The patient's camera was OFF for the entire 2-hour window. Emphasize that it is marked 'Camera Off' due to no detection attempt, rather than explicitly 'Missed'." : "The patient turned on their camera, but the medication was NOT detected. Emphasize that it is marked 'Missed'."}`;

  const aiResult = await callGeminiJSON(systemInstruction, prompt);
  if (aiResult && aiResult.title && aiResult.message) {
    console.log(`[GeminiAgent] Generated AI Missed Dose Alert for caregiver ${caregiverName}: "${aiResult.title}"`);
    return aiResult;
  }

  // Robust dynamic fallback
  return {
    title: isCameraOff ? `[Camera Off Alert] ${patientName} did not verify ${medName}` : `[Missed Dose Alert] ${patientName} missed ${medName}`,
    message: isCameraOff 
      ? `Caregiver Alert for ${caregiverName}: ${patientName} did not turn on their camera to verify the ${medName} (${medDosage}) dose scheduled for ${timeStr} after ${remCount} automated reminder attempts. Please check in with them or mark it manually as taken if you can verify it.`
      : `Caregiver Alert for ${caregiverName}: ${patientName} has missed their ${medName} (${medDosage}) dose scheduled for ${timeStr} after ${remCount} automated reminder attempts. Please check in with them immediately to ensure safety.`
  };
};

/**
 * Generate AI Taken Dose Alert for Caregivers
 */
const generateAITakenDoseAlert = async (user, medication, log, caregiver) => {
  const patientName = user?.name || 'Your patient';
  const caregiverName = caregiver?.name || 'Caregiver';
  const medName = medication?.name || 'their medication';
  const medDosage = medication?.dosage || '';
  
  let timeStr = 'their scheduled time';
  if (log?.scheduled_time) {
    timeStr = new Date(log.scheduled_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  const systemInstruction = `You are LOCUS AI. Generate a positive, reassuring alert in JSON format: {"title": "...", "message": "..."}.
Emphasize that the patient successfully took their medication and no action is required from the caregiver.`;

  const prompt = `Generate taken dose notice for:
Caregiver: ${caregiverName}
Patient: ${patientName}
Medication: ${medName} (${medDosage})
Scheduled Time: ${timeStr}`;

  const aiResult = await callGeminiJSON(systemInstruction, prompt);
  if (aiResult && aiResult.title && aiResult.message) {
    console.log(`[GeminiAgent] Generated AI Taken Dose Alert for caregiver ${caregiverName}: "${aiResult.title}"`);
    return aiResult;
  }

  // Robust dynamic fallback
  return {
    title: `[Dose Taken] ${patientName} took ${medName}`,
    message: `Update for ${caregiverName}: ${patientName} has successfully taken their ${medName} (${medDosage}) scheduled for ${timeStr}. No further action is required.`
  };
};

/**
 * Generate AI Taken Dose Alert for User (Elderly)
 */
const generateAIUserTakenDoseAlert = async (user, medication, log) => {
  const patientName = user?.name || 'there';
  const medName = medication?.name || 'your medication';
  const medDosage = medication?.dosage || '';

  const systemInstruction = `You are LOCUS AI, an encouraging and supportive healthcare assistant. Generate a positive, reassuring alert in JSON format: {"title": "...", "message": "..."}.
Congratulate the user for successfully taking their medication on time. Keep it short, warm, and friendly.`;

  const prompt = `Generate taken dose confirmation for:
User: ${patientName}
Medication: ${medName} (${medDosage})`;

  const aiResult = await callGeminiJSON(systemInstruction, prompt);
  if (aiResult && aiResult.title && aiResult.message) {
    console.log(`[GeminiAgent] Generated AI Taken Dose Confirmation for user ${patientName}: "${aiResult.title}"`);
    return aiResult;
  }

  // Robust dynamic fallback using Hardcoded Vault
  return {
    title: `[Confirmed] ${medName} Taken`,
    message: getRandomString(hardcodedVault.taken_patient)
  };
};

/**
 * Generate AI Escalated Alert for Caregivers
 */
const generateAIEscalatedAlert = async (notification, caregiver) => {
  const caregiverName = caregiver?.name || 'Caregiver';
  const origTitle = notification.title || 'Safety Alert';
  const origMsg = notification.message || 'An alert requires your attention.';

  const systemInstruction = `You are LOCUS AI. Generate an urgent escalation notice in JSON format: {"title": "...", "message": "..."}.
Emphasize that the previous safety alert remains unacknowledged after 15 minutes and requires immediate caregiver intervention.`;

  const prompt = `Generate escalation notice for:
Caregiver: ${caregiverName}
Original Title: ${origTitle}
Original Message: ${origMsg}
Unacknowledged Duration: >15 minutes`;

  const aiResult = await callGeminiJSON(systemInstruction, prompt);
  if (aiResult && aiResult.title && aiResult.message) {
    console.log(`[GeminiAgent] Generated AI Escalated Alert for caregiver ${caregiverName}: "${aiResult.title}"`);
    return aiResult;
  }

  // Robust dynamic fallback
  return {
    title: `[ESCALATED URGENT] ${origTitle}`,
    message: `[URGENT SAFETY ESCALATION] Notice for ${caregiverName}: The following alert has not been acknowledged for over 15 minutes: "${origMsg}". Please intervene immediately.`
  };
};

/**
 * Generate AI Missed Dose Alert for the User Themselves
 */
const generateAIUserMissedDoseAlert = async (user, medication, log) => {
  const isElderly = user.role === 'elderly';
  const userName = user.name || 'Friend';
  const medName = medication.name || 'Medication';
  const medDosage = medication.dosage || '';
  const timeStr = log.scheduled_time ? new Date(log.scheduled_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'scheduled time';
  const isCameraOff = log.status === 'camera_off';

  const systemInstruction = `You are LOCUS, an empathetic AI healthcare assistant.
Your task is to generate a JSON object with two fields:
- "title": A short notification title (max 50 characters).
- "message": A 1-2 sentence alert body text.
Context: The user has entirely missed their medication window and all reminders were exhausted.
Rules:
1. Do NOT invent medical advice.
2. If the user is an elderly patient, use a warm, respectful, gentle tone, encouraging them to take it now if safe, or check with their caregiver.
3. If the user is self-managing, use a clean, direct, motivational tone.
4. Output MUST be valid JSON matching {"title": "...", "message": "..."}.`;

  const prompt = `Generate a missed dose alert for:
Patient Name: ${userName}
Medication: ${medName} (${medDosage})
Scheduled Time: ${timeStr}
Role: ${isElderly ? 'Elderly Patient (needs gentle tone)' : 'Self-managing user (needs direct tone)'}
Condition: ${isCameraOff ? "Your camera was OFF for the entire 2-hour window. Emphasize that it is marked 'Camera Off' and your caregiver has been notified to check in." : "You turned on your camera, but we couldn't detect the medication. Emphasize that it is marked 'Missed' and your caregiver has been notified."}`;

  const aiResult = await callGeminiJSON(systemInstruction, prompt);
  if (aiResult && aiResult.title && aiResult.message) {
    console.log(`[GeminiAgent] Generated AI User Missed Dose Alert for ${userName}: "${aiResult.title}"`);
    return aiResult;
  }

  // Robust dynamic fallback
  return {
    title: isCameraOff ? `Camera Off: ${medName} Verification Incomplete` : `Missed Dose: ${medName}`,
    message: isCameraOff 
      ? `We noticed your camera was not turned on during the checkup window for ${medName} (${medDosage}) scheduled at ${timeStr}. This has been marked as 'Camera Off' and we've notified your caregiver to follow up.`
      : `We were unable to detect your ${medName} (${medDosage}) dose scheduled at ${timeStr}. This has been marked as 'Missed' and we've notified your caregiver to follow up.`
  };
};

/**
 * Generate AI Skipped Medicine Alert for Caregivers/Users
 */
const generateAISkippedMedicineAlert = async (patientName, caregiverName, scheduledTime, expectedCount, takenCount, skippedCount, isCaregiver) => {
  const systemInstruction = `You are LOCUS AI. Generate an urgent, concise safety alert in JSON format: {"title": "...", "message": "..."}.
Summarize clearly that the patient's camera detection showed they skipped some of their scheduled medicines.
Tone: Professional, urgent, concise, actionable.`;

  const prompt = `Generate an alert for:
Recipient: ${isCaregiver ? caregiverName + ' (Caregiver)' : patientName + ' (Patient)'}
Patient Name: ${patientName}
Scheduled Time: ${scheduledTime}
Expected Medicines: ${expectedCount}
Detected Taken: ${takenCount}
Skipped Medicines: ${skippedCount}`;

  const aiResult = await callGeminiJSON(systemInstruction, prompt);
  if (aiResult && aiResult.title && aiResult.message) {
    console.log(`[GeminiAgent] Generated AI Skipped Medicine Alert for ${isCaregiver ? caregiverName : patientName}: "${aiResult.title}"`);
    return aiResult;
  }

  // Robust dynamic fallback
  const title = `⚠ Skipped ${skippedCount} Medicine${skippedCount > 1 ? 's' : ''}`;
  const message = isCaregiver
    ? `Caregiver Alert: ${patientName} was scheduled to take ${expectedCount} medicine(s) at ${scheduledTime}, but only ${takenCount} were detected. ${skippedCount} medicine(s) were skipped.`
    : `Expected to take ${expectedCount} medicine(s) at ${scheduledTime}, but only ${takenCount} were detected. ${skippedCount} medicine(s) were skipped.`;

  return { title, message };
};

module.exports = {
  callGeminiJSON,
  generateAIDoseReminder,
  generateAIMissedDoseAlert,
  generateAITakenDoseAlert,
  generateAIUserTakenDoseAlert,
  generateAIEscalatedAlert,
  generateAISkippedMedicineAlert,
  generateAIUserMissedDoseAlert
};
