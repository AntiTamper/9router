// Migration 004: API key overhaul — structured config + overage accounting.
// Additive + backward compatible. Existing keys keep working via legacy columns;
// the new `config` JSON holds fusion limits, hard-cap anchor, timers,
// availability, per-key token saver, model exposure, and overage pool.

function columnExists(db, table, column) {
  return db.all(`PRAGMA table_info(${table})`).some((row) => row.name === column);
}

function addColumn(db, table, column, definition) {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const migration = {
  version: 4,
  name: "api-key-overhaul-overage",
  up(db) {
    // Structured per-key config (JSON). NULL/empty => derive from legacy columns.
    addColumn(db, "apiKeys", "config", "TEXT");
    addColumn(db, "apiKeys", "monthlyTokenLimit", "INTEGER");
    // Tag tokens consumed from the overage pool so accounting survives window
    // rollovers and can be reset independently. 0 = normal, 1 = overage.
    addColumn(db, "usageHistory", "overage", "INTEGER DEFAULT 0");
    db.exec("CREATE INDEX IF NOT EXISTS idx_uh_overage ON usageHistory(apiKey, overage)");
    db.run("UPDATE usageHistory SET overage = 0 WHERE overage IS NULL");
  },
};

export default migration;