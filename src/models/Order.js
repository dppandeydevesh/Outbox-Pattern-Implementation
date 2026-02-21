/**
 * Order Model — the main business aggregate
 * Writes to this collection are paired with outbox entries in the same session.
 */
const mongoose = require('mongoose');

const OrderItemSchema = new mongoose.Schema({
  productId: { type: String, required: true },
  name:      { type: String, required: true },
  quantity:  { type: Number, required: true, min: 1 },
  price:     { type: Number, required: true, min: 0 },
}, { _id: false });

const OrderSchema = new mongoose.Schema(
  {
    orderId:    { type: String, required: true, unique: true, index: true },
    customerId: { type: String, required: true, index: true },
    items:      { type: [OrderItemSchema], required: true },
    totalAmount:{ type: Number, required: true },
    currency:   { type: String, default: 'USD' },
    status: {
      type: String,
      enum: ['PENDING', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED'],
      default: 'PENDING',
    },
    shippingAddress: {
      street: String,
      city:   String,
      state:  String,
      zip:    String,
      country:String,
    },
    version: { type: Number, default: 1 },  // optimistic locking / event version
  },
  { timestamps: true }
);

const Order = mongoose.model('Order', OrderSchema);
module.exports = { Order };
