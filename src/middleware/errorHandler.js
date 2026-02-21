const { logger } = require('../services/logger');

function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || 500;
  logger.error(`${req.method} ${req.path} → ${statusCode}: ${err.message}`);
  res.status(statusCode).json({
    error: err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV !== 'production' ? { stack: err.stack } : {}),
  });
}

module.exports = { errorHandler };
