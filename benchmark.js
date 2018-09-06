var HashTable = require('./index.js');

var Node = {
  crypto: require('crypto'),
  os: require('os'),
  process: process
};

var KEY_SIZES = [8, 16, 32, 64];
var VALUE_SIZES = [0, 4, 8, 16, 32, 64, 4096, 65536];
var BUFFERS = [4];

// Be careful not to measure swapping to disk (by using too much memory).
// At the same time, try to exceed the CPU cache to measure cache misses.
// With 64 MB per positive/negative buffer and with 4 buffers:
// 1. We expect a minimum table.size of 32 MB.
// 2. We expect a minimum tableCache.size of 16 MB.
var POSITIVE = Node.crypto.randomBytes(64 * 1024 * 1024);
var NEGATIVE = Node.crypto.randomBytes(64 * 1024 * 1024);

function average(time, elements) {
  var elapsed = Node.process.hrtime(time);
  var ns = (elapsed[0] * 1000 * 1000000) + elapsed[1];
  return Math.round(ns / elements);
}

function benchmark(keySize, valueSize, buffers) {  
  var results = {};
  var value = Buffer.alloc(valueSize);
  var bucket = HashTable.bucket(keySize, valueSize);
  var element = keySize + valueSize;
  var elements = Math.min(
    buffers * HashTable.BUCKETS_MAX * 8 / 2,
    buffers * Math.floor(HashTable.BUFFER_MAX / bucket) * 8 / 2,
    Math.floor(POSITIVE.length / element)
  );
  if (!Number.isInteger(elements)) {
    throw new Error('elements must be an integer');
  }

  // Grow the HashTable through multiple resizes while inserting:
  var time = Node.process.hrtime();
  var table = new HashTable(keySize, valueSize, buffers, 2);
  var offset = 0;
  for (var index = 0; index < elements; index++) {
    table.set(POSITIVE, offset, POSITIVE, offset + keySize);
    offset += element;
  }
  results['  set() Insert'] = average(time, elements);

  // Preallocate the HashTable by advising the HashTable of elements in advance:
  // This will avoid resizing the HashTable while inserting.
  var time = Node.process.hrtime();
  var tableReserve = new HashTable(keySize, valueSize, buffers, elements);
  var offset = 0;
  for (var index = 0; index < elements; index++) {
    tableReserve.set(POSITIVE, offset, POSITIVE, offset + keySize);
    offset += element;
  }
  results['  set() Reserve'] = average(time, elements);
  
  // Set elements which have already been inserted:
  var time = Node.process.hrtime();
  var offset = 0;
  for (var index = 0; index < elements; index++) {
    table.set(POSITIVE, offset, POSITIVE, offset + keySize);
    offset += element;
  }
  results['  set() Update'] = average(time, elements);

  // Get elements which do not exist:
  var time = Node.process.hrtime();
  var offset = 0;
  for (var index = 0; index < elements; index++) {
    table.get(NEGATIVE, offset, value, 0);
    offset += element;
  }
  results['  get() Miss'] = average(time, elements);

  // Get elements which exist:
  var time = Node.process.hrtime();
  var offset = 0;
  for (var index = 0; index < elements; index++) {
    table.get(POSITIVE, offset, value, 0);
    offset += element;
  }
  results['  get() Hit'] = average(time, elements);

  // Test elements which do not exist:
  var time = Node.process.hrtime();
  var offset = 0;
  for (var index = 0; index < elements; index++) {
    table.exist(NEGATIVE, offset);
    offset += element;
  }
  results['exist() Miss'] = average(time, elements);

  // Test elements which exist:
  var time = Node.process.hrtime();
  var offset = 0;
  for (var index = 0; index < elements; index++) {
    table.exist(POSITIVE, offset);
    offset += element;
  }
  results['exist() Hit'] = average(time, elements);

  // Unset elements which do not exist:
  var time = Node.process.hrtime();
  var offset = 0;
  for (var index = 0; index < elements; index++) {
    table.unset(NEGATIVE, offset);
    offset += element;
  }
  results['unset() Miss'] = average(time, elements);

  // Unset elements which exist:
  var time = Node.process.hrtime();
  var offset = 0;
  for (var index = 0; index < elements; index++) {
    table.unset(POSITIVE, offset);
    offset += element;
  }
  results['unset() Hit'] = average(time, elements);

  // Cache elements, triggering very few evictions:
  var time = Node.process.hrtime();
  var tableCache = new HashTable(
    keySize,
    valueSize,
    buffers,
    0,
    Math.floor(elements / 8) * bucket
  );
  var offset = 0;
  for (var index = 0; index < elements; index++) {
    tableCache.cache(POSITIVE, offset, POSITIVE, offset + keySize);
    offset += element;
  }
  results['cache() Insert'] = average(time, elements);

  // Measure long-running performance of caching to ensure it does not degrade:
  var time = Node.process.hrtime();
  var steadystate = 10;
  while (steadystate--) {
    // Cache NEGATIVE and POSITIVE elements to overflow the cache and evict:
    // Otherwise we will merely measure the update performance of cache().
    var offset = 0;
    for (var index = 0; index < elements; index++) {
      tableCache.cache(NEGATIVE, offset, NEGATIVE, offset + keySize);
      offset += element;
    }
    var offset = 0;
    for (var index = 0; index < elements; index++) {
      tableCache.cache(POSITIVE, offset, POSITIVE, offset + keySize);
      offset += element;
    }
  }
  results['cache() Evict'] = average(time, elements * 2 * 10);

  // Test a cached element which will probably not exist:
  // Use exist() rather than get() to exclude cost of value copy.
  // We want to measure cache misses rather than value copies.
  var time = Node.process.hrtime();
  var offset = 0;
  for (var index = 0; index < elements; index++) {
    tableCache.exist(NEGATIVE, offset);
    offset += element;
  }
  results['cache() Miss'] = average(time, elements);

  // Test a cached element which will probably exist:
  var time = Node.process.hrtime();
  var offset = 0;
  for (var index = 0; index < elements; index++) {
    tableCache.exist(POSITIVE, offset);
    offset += element;
  }
  results['cache() Hit'] = average(time, elements);

  return results;
}

console.log('');
console.log(new Array(12 + 1).join(' ') + 'CPU=' + Node.os.cpus()[0].model);
console.log('');

function display(keySize, valueSize, buffers, results) {
  var lines = [];
  lines.push(new Array(39 + 1).join('='));
  var header = 'KEY=' + keySize + ' VALUE=' + valueSize;
  lines.push(new Array(12 + 1).join(' ') + header);
  lines.push(new Array(39 + 1).join('-'));
  for (var key in results) {
    var label = key.padEnd(17, ' ');
    var value = (results[key] + 'ns').padStart(16, ' ');
    lines.push('    '  + label + value + '  ');
  }
  printColumn(lines);
}

var printColumns = [];
var printColumnsMax = 2;

function printColumn(lines) {
  if (lines) {
    printColumns.push(lines);
    if (printColumns.length < printColumnsMax) return;
  }
  var maxColumn = 0;
  var maxRows = 0;
  printColumns.forEach(
    function(lines) {
      lines.forEach(
        function(line) {
          if (line.length > maxColumn) maxColumn = line.length;
        }
      );
      if (lines.length > maxRows) maxRows = lines.length;
    }
  );
  for (var row = 0; row < maxRows; row++) {
    for (var column = 0; column < printColumns.length; column++) {
      var cell = printColumns[column][row] || '';
      cell = cell.padEnd(maxColumn, ' ');
      if (column > 0) cell = (cell[0] === '=' ? '=' : '|') + cell;
      Node.process.stdout.write(cell);
    }
    Node.process.stdout.write(Node.os.EOL);
  }
  printColumns = [];
}

KEY_SIZES.forEach(
  function(keySize) {
    VALUE_SIZES.forEach(
      function(valueSize) {
        BUFFERS.forEach(
          function(buffers) {
            // Discard first result to let optimizations kick in:
            // We do this for every keySize/valueSize as these have fastpaths.
            // Warm up using buffers=1 to save time.
            benchmark(keySize, valueSize, 1);
            var results = benchmark(keySize, valueSize, buffers);
            display(keySize, valueSize, buffers, results);
          }
        );
      }
    );
  }
);

if (printColumns.length < printColumnsMax) printColumn();
Node.process.stdout.write(Node.os.EOL);
