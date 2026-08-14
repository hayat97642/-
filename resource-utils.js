function normalizeMainTickMs(mainTickMs) {
  return Number.isFinite(mainTickMs) ? Math.round(mainTickMs) : 140;
}

function getSpawnDelayMs(spawnDelay) {
  return Number.isFinite(spawnDelay) ? Math.round(spawnDelay) : 0;
}

module.exports = {
  normalizeMainTickMs,
  getSpawnDelayMs
};
