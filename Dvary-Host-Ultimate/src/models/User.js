const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['user', 'admin'], default: 'user' },
  coins: { type: Number, default: 0, min: 0 },
  banned: { type: Boolean, default: false },
  lastLoginAt: { type: Date, default: null },
  muted: { type: Boolean, default: false },
  pteroUserId: { type: Number, default: null },
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
