require('dotenv').config();
const mongoose = require('mongoose');
const Notification = require('./models/Notification');
const User = require('./models/User');
const axios = require('axios');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/locusDB');
  const caregiver = await User.findOne({ role: 'caregiver' });

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;
  const payload = {
    system_instruction: { parts: [{ text: "You are LOCUS AI. Generate a test notification JSON." }] },
    contents: [{ parts: [{ text: "Generate test notification JSON: {\"title\": \"Test\", \"message\": \"Test\"}" }] }],
    generationConfig: { temperature: 0.6, responseMimeType: "application/json" }
  };
  
  console.log('Calling Gemini directly...');
  try {
      const response = await axios.post(url, payload, { timeout: 15000 });
      let text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      console.log("RAW TEXT FROM GEMINI:");
      console.log(text);
  } catch(e) {
      console.log("AXIOS ERROR:");
      console.log(e.response ? e.response.data : e.message);
  }
  process.exit(0);
}
run();
