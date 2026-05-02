require('dotenv').config();

async function test() {
  const { fetchAllMetrics } = require('../index.js');
  const m = await fetchAllMetrics();
  console.log('priorNetFlow30d:', m.priorNetFlow30d);
  console.log('deltaOfDeltas:', m.deltaOfDeltas);
  console.log('netFlow30d:', m.netFlow30d);
  console.log('netFlow7d:', m.netFlow7d);
}

test().catch(console.error);