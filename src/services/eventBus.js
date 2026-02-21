/**
 * EventBus
 *
 * Abstraction over the actual message broker.
 * In production, replace the `publish` implementation with:
 *   - Kafka:  kafkaProducer.send({ topic, messages: [{ key, value }] })
 *   - SQS:    sqs.sendMessage({ QueueUrl, MessageBody, MessageGroupId })
 *   - Redis:  redisClient.xadd(topic, '*', 'data', JSON.stringify(message))
 *
 * The interface is intentionally broker-agnostic.
 *
 * Kafka-style outbox example (uncomment to use):
 * ─────────────────────────────────────────────
 * const { Kafka } = require('kafkajs');
 * const kafka = new Kafka({ clientId: 'outbox-publisher', brokers: ['kafka:9092'] });
 * const producer = kafka.producer({ allowAutoTopicCreation: false });
 * await producer.connect();
 *
 * In publish():
 *   await producer.send({
 *     topic: message.topic,
 *     messages: [{
 *       key: message.aggregateId,
 *       value: JSON.stringify(message),
 *       headers: { eventId: message.eventId, correlationId: message.correlationId },
 *     }],
 *   });
 */
const { logger } = require('./logger');

class EventBus {
  constructor() {
    // In-memory bus for demo. Replace with real broker client here.
    this._subscribers = {};
  }

  /**
   * Publish a domain event to a topic.
   * @param {Object} message
   */
  async publish(message) {
    const { topic, eventId, eventType } = message;

    // ── Simulate occasional transient failure (5% chance) ──────────────────
    // Remove this in production!
    if (process.env.SIMULATE_FAILURES === 'true' && Math.random() < 0.05) {
      throw new Error('Simulated transient broker failure');
    }

    logger.info(`[EventBus] → topic:${topic} | eventId:${eventId} | type:${eventType}`);
    logger.debug(`[EventBus] payload: ${JSON.stringify(message)}`);

    // Notify in-process subscribers (useful for testing / internal consumers)
    const handlers = this._subscribers[topic] || [];
    for (const handler of handlers) {
      try {
        await handler(message);
      } catch (err) {
        // Subscriber errors must NOT affect the publisher status
        logger.error(`[EventBus] Subscriber error on topic ${topic}: ${err.message}`);
      }
    }
  }

  /** Register an in-process consumer for a topic */
  subscribe(topic, handler) {
    if (!this._subscribers[topic]) this._subscribers[topic] = [];
    this._subscribers[topic].push(handler);
  }
}

// Singleton event bus instance
const globalEventBus = new EventBus();

module.exports = { EventBus, globalEventBus };
