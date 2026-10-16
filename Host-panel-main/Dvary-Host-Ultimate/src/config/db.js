const mongoose = require('mongoose');

// Removes stale UNIQUE indexes left on the users collection by older versions of the app
// (e.g. "username_1"). Only the _id, email and googleId indexes are allowed to stay unique.
async function dropStaleUserIndexes() {
  const User = require('../models/User');
  try {
    const indexes = await User.collection.indexes();
    for (const i of indexes) {
      const keys = Object.keys(i.key);
      const stale = i.unique && i.name !== '_id_' && !(keys.length === 1 && (keys[0] === 'email' || keys[0] === 'googleId'));
      if (stale) {
        await User.collection.dropIndex(i.name);
        console.log('Dropped stale unique index on users:', i.name);
      }
    }
  } catch (e) {
    if (e.codeName !== 'NamespaceNotFound') console.error('Index cleanup failed:', e.message);
  }
}

module.exports = async function connectDB() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is missing in .env');
  mongoose.set('strictQuery', true);
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('MongoDB connected');
  await dropStaleUserIndexes();
};
