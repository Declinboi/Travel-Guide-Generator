// Save as: scripts/debug-memory.js
// Run with: node --expose-gc scripts/debug-memory.js

const v8 = require('v8');
const { performance } = require('perf_hooks');

class MemoryMonitor {
  constructor() {
    this.snapshots = [];
    this.startTime = performance.now();
  }

  takeSnapshot(label) {
    if (global.gc) {
      global.gc();
    }

    const heapStats = v8.getHeapStatistics();
    const memUsage = process.memoryUsage();
    const elapsed = Math.round(performance.now() - this.startTime);

    const snapshot = {
      label,
      elapsed: `${elapsed}ms`,
      heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)} MB`,
      heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)} MB`,
      rss: `${Math.round(memUsage.rss / 1024 / 1024)} MB`,
      external: `${Math.round(memUsage.external / 1024 / 1024)} MB`,
      heapLimit: `${Math.round(heapStats.heap_size_limit / 1024 / 1024)} MB`,
    };

    this.snapshots.push(snapshot);
    console.log(`\n[${label}]`, snapshot);

    return snapshot;
  }

  printReport() {
    console.log('\n========== MEMORY REPORT ==========');
    console.table(this.snapshots);
  }

  checkLeak() {
    if (this.snapshots.length < 2) return;

    const first = this.snapshots[0];
    const last = this.snapshots[this.snapshots.length - 1];

    const firstHeap = parseInt(first.heapUsed);
    const lastHeap = parseInt(last.heapUsed);
    const leak = lastHeap - firstHeap;

    console.log('\n========== LEAK DETECTION ==========');
    console.log(`Starting heap: ${first.heapUsed}`);
    console.log(`Ending heap: ${last.heapUsed}`);
    console.log(`Leak: ${leak > 0 ? '+' : ''}${leak} MB`);

    if (leak > 100) {
      console.warn('⚠️  POTENTIAL MEMORY LEAK DETECTED!');
    } else {
      console.log('✅ Memory usage looks normal');
    }
  }
}

// Export for use in your app
module.exports = MemoryMonitor;

// Test if run directly
if (require.main === module) {
  const monitor = new MemoryMonitor();

  monitor.takeSnapshot('Start');

  // Simulate heavy load
  const data = [];
  for (let i = 0; i < 10; i++) {
    console.log(`\nIteration ${i + 1}/10`);
    
    // Allocate ~100MB
    const chunk = Buffer.alloc(100 * 1024 * 1024);
    data.push(chunk);
    
    monitor.takeSnapshot(`After allocation ${i + 1}`);
    
    // Clear and GC
    data.length = 0;
    if (global.gc) global.gc();
    
    monitor.takeSnapshot(`After cleanup ${i + 1}`);
  }

  monitor.printReport();
  monitor.checkLeak();
}