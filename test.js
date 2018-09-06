'use strict';

var HashTable = require('./index.js');

var Node = { crypto: require('crypto') };

function Assert(description, a, b) {
  var x = a;
  var y = b;
  if (x === y) return;
  throw new Error(description + ': ' + x + ' !== ' + y);
}

// Log result and value of each operation (slow):
var Debug = false;

function Hash(buffer, offset, size) {
  if (size === 0) return '(0)';
  if (size <= 16) {
    var hash = buffer.toString('hex', offset, offset + size);
  } else {
    var hash = Node.crypto.createHash('SHA256');
    hash.update(buffer.slice(offset, offset + size));
    hash = hash.digest('hex').slice(0, 32);
  }
  return hash + ' (' + size + ')';
}

function Log(string) { console.log(string); }

function Random() { return Math.random(); }

var BAR_DOUBLE = new Array(80 + 1).join('=');
var BAR_SINGLE = new Array(80 + 1).join('-');

// For keySizes 20 and above:
var KEY_RND = Node.crypto.randomBytes(8 * 1024 * 1024);

// For keySizes 4, 8, 12 and 16:
var KEY_SEQ = (function() {
  var buffer = Buffer.alloc(8 * 1024 * 1024);
  var index = 0;
  var offset = 0;
  while (offset < buffer.length) {
    buffer.writeUInt32BE(index++, offset);
    offset += 4;
  }
  return buffer;
})();

// Tracks canonical value state for each element:
var VALUE = Node.crypto.randomBytes(8 * 1024 * 1024);

// Source of entropy for setting new values:
var ENTROPY = Node.crypto.randomBytes(VALUE.length);
var ENTROPY_OFFSET = 0;

// Receives value for get():
var TARGET = Buffer.alloc(65536 * 4);

function Test(keySize, valueSize, buffers, many, cache) {
  Assert('Number.isInteger(keySize)', Number.isInteger(keySize), true);
  Assert('Number.isInteger(valueSize)', Number.isInteger(valueSize), true);
  Assert('Number.isInteger(buffers)', Number.isInteger(buffers), true);
  Assert('many', many === true || many === false, true);
  Assert('cache', cache === true || cache === false, true);
  var key = keySize <= 16 ? KEY_SEQ : KEY_RND;
  var value = VALUE;
  var bucket = HashTable.bucket(keySize, valueSize);
  var max = Math.floor(Math.min(
    buffers * HashTable.BUCKETS_MAX * 8 / 3,
    buffers * Math.floor(HashTable.BUFFER_MAX / bucket) * 8 / 3,
    key.length / keySize,
    value.length / valueSize,
    many ? 1024 * 1024 : 64
  ));
  var elements = Math.floor(Math.random() * max) || max;
  Assert('Number.isInteger(elements)', Number.isInteger(elements), true);
  Assert('elements > 0', elements > 0, true);
  if (Math.random() < 0.6) {
    var minElements = 2;
    var minSize = 0;
  } else if (Math.random() < 0.2) {
    var minElements = Math.floor(Math.random() * elements);
    var minSize = 0;
  } else {
    var minElements = 0;
    var minSize = Math.floor(Math.random() * elements * (keySize + valueSize));
  }
  var table = new HashTable(keySize, valueSize, buffers, minElements, minSize);
  var tableLength = 0;
  var state = Buffer.alloc(elements);
  var leader = true;
  if (Debug) Log('');
  if (Debug) Log(BAR_DOUBLE);
  Log(
    'HashTable:' +
    ' keySize=' + keySize.toString().padEnd(6, ' ') +
    ' valueSize=' + valueSize.toString().padEnd(6, ' ') +
    ' buffers=' + buffers.toString().padEnd(6, ' ') +
    ' elements=' + elements
  );
  if (Debug) Log(BAR_DOUBLE);

  function Mutate(id, reset) {
    var keyOffset = id * keySize;
    var valueOffset = id * valueSize;
    function Cache() {
      if (!cache) return;
      var source = ENTROPY;
      var sourceOffset = (ENTROPY_OFFSET += valueSize);
      if (sourceOffset + valueSize > ENTROPY.length) {
        sourceOffset = ENTROPY_OFFSET = 0;
      }
      var sourceHash1 = Hash(source, sourceOffset, valueSize);
      var result = table.cache(key, keyOffset, source, sourceOffset);
      var sourceHash2 = Hash(source, sourceOffset, valueSize);
      Assert('sourceHash', sourceHash2, sourceHash1);
      if (Debug) {
        var sourceHash = Hash(source, sourceOffset, valueSize);
        Log('  cache() result=' + result + ' value=' + sourceHash);
      }
      if (result === 1) {
        // Updated
        Assert('result', result, state[id]);
      } else if (result === 2) {
        // Evicted
        state[id] = 1;
      } else {
        // Inserted
        Assert('result', result, 0);
        state[id] = 1;
        tableLength++;
      }
      Assert(
        'source.copy()',
        source.copy(value, valueOffset, sourceOffset, sourceOffset + valueSize),
        valueSize
      );
      Assert('table.length', table.length, tableLength);
    }
    function Exist(cached) {
      // `cached` indicates whether element is certain to exist:
      Assert('cached', cached === 0 || cached === 1, true);
      var result = table.exist(key, keyOffset);
      if (Debug) Log('  exist() result=' + result);
      Assert('result', result, (cache && result === 0) ? cached : state[id]);
      Assert('table.length', table.length, tableLength);
    }
    function Get(cached) {
      Assert('cached', cached === 0 || cached === 1, true);
      var target = TARGET;
      var targetOffset = Math.floor(
        Math.random() * (TARGET.length - valueSize)
      );
      Assert('targetOffset', targetOffset + valueSize <= TARGET.length, true);
      if (!state[id] || cache) {
        var targetHex = target.toString(
          'hex',
          targetOffset,
          targetOffset + valueSize
        );
      }
      var result = table.get(key, keyOffset, target, targetOffset);
      if (Debug) {
        if (result === 1) {
          var targetHash = Hash(target, targetOffset, valueSize);
          Log('    get() result=' + result + ' value=' + targetHash);
        } else {
          Log('    get() result=' + result);
        }
      }
      Assert('result', result, (cache && result === 0) ? cached : state[id]);
      Assert('table.length', table.length, tableLength);
      if (result === 1) {
        var targetSlice = target.slice(targetOffset, targetOffset + valueSize);
        var valueSlice = value.slice(valueOffset, valueOffset + valueSize);
        Assert('target', targetSlice.equals(valueSlice), true);
      } else {
        Assert(
          'target',
          target.toString('hex', targetOffset, targetOffset + valueSize),
          targetHex
        );
      }
    }
    function Set() {
      if (cache) return;
      var source = ENTROPY;
      var sourceOffset = (ENTROPY_OFFSET += valueSize);
      if (sourceOffset + valueSize > ENTROPY.length) {
        sourceOffset = ENTROPY_OFFSET = 0;
      }
      var result = table.set(key, keyOffset, source, sourceOffset);
      if (Debug) {
        var sourceHash = Hash(source, sourceOffset, valueSize);
        Log('    set() result=' + result + ' value=' + sourceHash);
      }
      Assert('result', result, state[id]);
      Assert(
        'source.copy()',
        source.copy(value, valueOffset, sourceOffset, sourceOffset + valueSize),
        valueSize
      );
      if (!state[id]) {
        state[id] = 1;
        tableLength++;
      }
      Assert('table.length', table.length, tableLength);
    }
    function Unset() {
      var result = table.unset(key, keyOffset);
      if (Debug) Log('  unset() result=' + result);
      if (cache) {
        Assert('result', result, result === 1 ? state[id] : 0);
        if (result === 1) {
          state[id] = 0;
          tableLength--;
        }
      } else {
        Assert('result', result, state[id]);
        if (state[id]) {
          state[id] = 0;
          tableLength--;
        }
      }
      Assert('table.length', table.length, tableLength);
    }
    if (leader) {
      leader = false;
    } else if (Debug) {
      Log('');
      Log(BAR_SINGLE);
    }
    if (Debug) {
      Log('');
      Log('  key=' + Hash(key, keyOffset, keySize));
      Log('');
    }
    if (reset) {
      Get(0);
      Exist(0);
      Unset();
      Get(0);
      Exist(0);
    } else {
      Get(0);
      Exist(0);
      if (Random() < 0.50) {
        Unset();
        Get(0);
        Exist(0);
      }
      if (Random() < 0.50) {
        Cache();
        Set();
        Get(1);
        Exist(1);
      }
      if (Random() < 0.25) {
        Unset();
        Get(0);
        Exist(0);
      }
      if (Random() < 0.25) {
        Cache();
        Set();
        Get(1);
        Exist(1);
      }
    }
    var stats = { capacity: 0, size: 0 };
    for (var index = 0, length = table.tables.length; index < length; index++) {
      var tableSize = table.tables[index].buffer.length;
      stats.capacity += (tableSize / table.bucket) * 8;
      stats.size += tableSize;
    }
    Assert('table.capacity', table.capacity, stats.capacity);
    Assert('table.length', table.length, tableLength);
    Assert('table.load', table.load, tableLength / stats.capacity);
    Assert('table.size', table.size, stats.size);
  }
  function Iterate() {
    for (var id = 0; id < elements; id++) Mutate(id, false);
  }
  function Reset() {
    for (var id = 0; id < elements; id++) Mutate(id, true);
  }
  function Skip() {
    var length = Math.round(Random() * elements / 4);
    while (length--) Mutate(Math.floor(Random() * elements), false);
  }
  Iterate();
  Skip();
  Iterate();
  Reset();
}

// Exception message constants must be strings:
[ 'ERROR_MAXIMUM_CAPACITY_EXCEEDED', 'ERROR_MODE', 'ERROR_SET'].forEach(
  function(key) {
    Assert('HashTable.' + key, typeof HashTable[key], 'string');
  }
);

// Constants must be integers:
[
  'KEY_MIN',
  'KEY_MAX',
  'VALUE_MIN',
  'VALUE_MAX',
  'BUFFERS_MIN',
  'BUFFERS_MAX',
  'ELEMENTS_MIN',
  'ELEMENTS_MAX',
  'SIZE_MIN',
  'SIZE_MAX',
  'BUCKETS_MIN',
  'BUCKETS_MAX',
  'BUFFER_MAX'
].forEach(
  function(key) {
    Assert('HashTable.' + key, typeof HashTable[key], 'number');
    Assert('HashTable.' + key, Number.isSafeInteger(HashTable[key]), true);
    Assert('HashTable.' + key, HashTable[key] >= 0, true);
  }
);

// HashTable must throw exceptions:
[
  [
    HashTable.KEY_MIN - 1, 0, 1, 0, 0,
    'keySize must be at least ' + HashTable.KEY_MIN
  ],
  [
    HashTable.KEY_MAX + 1, 0, 1, 0, 0,
    'keySize must be at most ' + HashTable.KEY_MAX
  ],
  [
    4, HashTable.VALUE_MIN - 1, 1, 0, 0,
    'valueSize must be at least ' + HashTable.VALUE_MIN
  ],
  [
    4, HashTable.VALUE_MAX + 1, 1, 0, 0,
    'valueSize must be at most ' + HashTable.VALUE_MAX
  ],
  [
    4, 0, HashTable.BUFFERS_MIN - 1, 0, 0,
    'buffers must be at least ' + HashTable.BUFFERS_MIN
  ],
  [
    4, 0, HashTable.BUFFERS_MAX + 1, 0, 0,
    'buffers must be at most ' + HashTable.BUFFERS_MAX
  ],
  [
    4, 0, HashTable.BUFFERS_MIN + 5, 0, 0,
    'buffers must be a power of 2'
  ],
  [
    4, 0, 1, HashTable.ELEMENTS_MIN - 1, 0,
    'elements must be at least ' + HashTable.ELEMENTS_MIN
  ],
  [
    4, 0, 1, HashTable.ELEMENTS_MAX + 1, 0,
    'elements must be at most ' + HashTable.ELEMENTS_MAX
  ],
  [
    4, 0, 1, 0, HashTable.SIZE_MIN - 1,
    'size must be at least ' + HashTable.SIZE_MIN
  ],
  [
    4, 0, 1, 0, HashTable.SIZE_MAX + 1,
    'size must be at most ' + HashTable.SIZE_MAX
  ],
  [
    HashTable.KEY_MIN + 1, 0, 1, 0, 0,
    'keySize must be a multiple of 4'
  ],
  [
    4, 65536, 1, 1024 * 1024 * 1024, 0,
    HashTable.ERROR_MAXIMUM_CAPACITY_EXCEEDED
  ]
].forEach(
  function(args) {
    Assert('args.length === 6', args.length === 6, true);
    var error;
    try {
      var keySize = args[0];
      var valueSize = args[1];
      var buffers = args[2];
      var elements = args[3];
      var size = args[4];
      new HashTable(keySize, valueSize, buffers, elements, size);
    } catch (exception) {
      error = exception.message;
    }
    Assert('error', error, args[5]);
  }
);

// Values used by README must match constants:
Assert('README KEY_MAX', 64, HashTable.KEY_MAX);
Assert('README VALUE_MAX', 64 * 1024 * 1024, HashTable.VALUE_MAX);
Assert('README BUFFERS_MAX', 8192, HashTable.BUFFERS_MAX);
Assert('README ELEMENTS_MAX', 68719476736, HashTable.ELEMENTS_MAX);
Assert('README SIZE_MAX', 1024 * 1024 * 1024 * 1024, HashTable.SIZE_MAX);

var KEY_SIZES = [4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64];
Assert('KEY_SIZES[0]', KEY_SIZES[0], HashTable.KEY_MIN);
Assert('KEY_SIZES[N]', KEY_SIZES[KEY_SIZES.length - 1], HashTable.KEY_MAX);

var VALUE_SIZES = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
  12, 13, 14, 16, 18, 20, 22, 23,
  24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 61,
  64, 128, 256, 1024, 4096, 65536, 65537
];
Assert(
  'TARGET.length > VALUE_SIZES[N]',
  TARGET.length > VALUE_SIZES[VALUE_SIZES.length - 1],
  true
);

var BUFFERS = [1, 2, 4, 8, 16, 32, 64, 128, 8192];

var KEY_RND_HASH = Hash(KEY_RND, 0, KEY_RND.length);
var KEY_SEQ_HASH = Hash(KEY_SEQ, 0, KEY_SEQ.length);
var ENTROPY_HASH = Hash(ENTROPY, 0, ENTROPY.length);

KEY_SIZES.forEach(
  function(keySize) {
    var manyIndex = Math.floor(Math.random() * VALUE_SIZES.length);
    var cacheIndex = Math.floor(Math.random() * VALUE_SIZES.length);
    VALUE_SIZES.forEach(
      function(valueSize, valueSizeIndex) {
        var buffersLength = BUFFERS.length;
        if (Math.random() < 0.9) buffersLength = Math.min(4, buffersLength);
        var buffers = BUFFERS[Math.floor(Math.random() * buffersLength)];
        var many = valueSizeIndex === manyIndex && Math.random() < 0.5;
        var cache = valueSizeIndex === cacheIndex;
        Test(keySize, valueSize, buffers, many, cache);
      }
    );
  }
);

// Read-only buffers must not be modified by any HashTable methods:
Assert('KEY_RND_HASH', Hash(KEY_RND, 0, KEY_RND.length), KEY_RND_HASH);
Assert('KEY_SEQ_HASH', Hash(KEY_SEQ, 0, KEY_SEQ.length), KEY_SEQ_HASH);
Assert('ENTROPY_HASH', Hash(ENTROPY, 0, ENTROPY.length), ENTROPY_HASH);

Log(BAR_DOUBLE);
Log('PASSED ALL TESTS');
Log(BAR_DOUBLE);
