// Lists the indexes on the users collection and drops stale unique ones
// (anything unique except _id and email). Run once: node scripts/fix-user-indexes.js
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');

(async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is missing in .env');
  await mongoose.connect(process.env.MONGODB_URI);
  const indexes = await User.collection.indexes();
  console.log('Current indexes:');
  indexes.forEach((i) => console.log(' -', i.name, JSON.stringify(i.key), i.unique ? '(unique)' : ''));

  for (const i of indexes) {
    const keys = Object.keys(i.key);
    const stale = i.unique && i.name !== '_id_' && !(keys.length === 1 && keys[0] === 'email');
    if (stale) { await User.collection.dropIndex(i.name); console.log('Dropped stale unique index:', i.name); }
  }
  await User.syncIndexes();
  console.log('Done.');
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
