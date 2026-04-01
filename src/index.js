/**
 * index.js — Kristal Auto Core
 * Entry point del pacchetto condiviso.
 */

module.exports = {
  // Token registry
  ...require('./token-registry'),

  // Safe API helpers
  ...require('./safe-api'),

  // Executor base class
  ExecutorCore: require('./executor-core'),

  // Onchain stats
  ...require('./onchain-stats-core'),

  // Brain hard blocks
  ...require('./brain-hardblocks'),

  // Brain core (bluechip bots)
  BrainCore: require('./brain-core'),
};
