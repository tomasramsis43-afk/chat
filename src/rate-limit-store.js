'use strict';
const { MemoryStore } = require('express-rate-limit');

// Abstraction over the rate-limit counter store.
// Single instance: in-memory MemoryStore.
// Multi instance: swap createStore() with a distributed store (e.g. rate-limit-redis)
// without touching any route or middleware call site.
function createStore() {
  return new MemoryStore();
}

module.exports = { createStore };