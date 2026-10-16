require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../src/models/User');

(async () => {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!process.env.MONGODB_URI) { console.error('MONGODB_URI is missing in .env'); process.exit(1); }
  if (!email || !email.includes('@')) { console.error('ADMIN_EMAIL is missing or invalid in .env'); process.exit(1); }
  if (password.length < 8 || password === 'CHANGE_THIS') { console.error('Set a strong ADMIN_PASSWORD (min 8 chars) in .env'); process.exit(1); }
  await mongoose.connect(process.env.MONGODB_URI);
  const existing = await User.findOne({ email });
  if (existing) {
    if (existing.role !== 'admin') { existing.role = 'admin'; await existing.save(); console.log('Existing user promoted to admin:', email); }
    else console.log('Admin already exists:', email);
  } else {
    const hash = await bcrypt.hash(password, 12);
    await User.create({ name: 'Administrator', email, password: hash, role: 'admin', coins: 0 });
    console.log('Admin created:', email);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
