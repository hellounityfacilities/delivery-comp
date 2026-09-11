// In-process event bus. Swap for Redis pub/sub when running multiple instances.
const { EventEmitter } = require('events');
module.exports = new EventEmitter();
