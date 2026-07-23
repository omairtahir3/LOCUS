require('dotenv').config();
const mongoose = require('mongoose');
const os = require('os');
const User = require('./models/User');

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

async function updateUsers() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/locusDB');
    console.log('Connected.');

    const usersToUpdate = await User.find({});

    console.log(`Found ${usersToUpdate.length} users needing an RTMP URL.`);

    const rtmpHost = process.env.RTMP_HOST || getLocalIP();
    let updatedCount = 0;

    for (const user of usersToUpdate) {
      user.camera_stream_url = `rtsp://locus_ai:LocusRead2026@127.0.0.1:8554/live/${user._id}`;
      await user.save(); // Using save() ensures pre-save hooks (like password hashing if modified, though not modified here) work correctly
      updatedCount++;
    }

    console.log(`Successfully updated ${updatedCount} users.`);
    process.exit(0);
  } catch (error) {
    console.error('Error updating users:', error);
    process.exit(1);
  }
}

updateUsers();
