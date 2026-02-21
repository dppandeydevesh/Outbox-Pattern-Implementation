const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema(
  {
    userId:   { type: String, required: true, unique: true, index: true },
    email:    { type: String, required: true, unique: true },
    name:     { type: String, required: true },
    role:     { type: String, enum: ['customer', 'admin'], default: 'customer' },
    version:  { type: Number, default: 1 },
  },
  { timestamps: true }
);

const User = mongoose.model('User', UserSchema);
module.exports = { User };
