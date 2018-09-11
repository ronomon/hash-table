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

function Test(keySize, valueSize, many, cache) {
  Assert('Number.isInteger(keySize)', Number.isInteger(keySize), true);
  Assert('Number.isInteger(valueSize)', Number.isInteger(valueSize), true);
  Assert('many', many === true || many === false, true);
  Assert('cache', cache === true || cache === false, true);
  var key = keySize <= 16 ? KEY_SEQ : KEY_RND;
  var value = VALUE;
  var bucket = HashTable.bucket(keySize, valueSize);
  var max = Math.floor(Math.min(
    key.length / keySize,
    value.length / valueSize,
    many ? (Math.random() < 0.5 ? 1048576 : 65536) : 64
  ));
  var elements = Math.floor(Math.random() * max) || max;
  Assert('Number.isInteger(elements)', Number.isInteger(elements), true);
  Assert('elements > 0', elements > 0, true);
  if (Math.random() < 0.3) {
    var elementsMin = 0;
  } else if (Math.random() < 0.2) {
    var elementsMin = Math.round(elements * 1.2);
  } else {
    var elementsMin = Math.floor(Math.random() * elements);
  }
  if (Math.random() < 0.3) {
    var elementsMax = 0;
  } else if (Math.random() < 0.05) {
    var elementsMax = HashTable.ELEMENTS_MAX;
  } else {
    var elementsMax = elementsMin + Math.floor(Math.random() * elements);
  }
  var table = new HashTable(keySize, valueSize, elementsMin, elementsMax);
  Assert('table.capacity >= elementsMin', table.capacity >= elementsMin, true);
  var tableLength = 0;
  var state = Buffer.alloc(elements);
  var leader = true;
  if (Debug) Log('');
  if (Debug) Log(BAR_DOUBLE);
  Log(
    'HashTable:' +
    ' keySize=' + keySize.toString().padEnd(3, ' ') +
    ' valueSize=' + valueSize.toString().padEnd(6, ' ') +
    ' buffers=' + table.tables.length.toString().padEnd(5, ' ') +
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
    HashTable.KEY_MIN - 1, 0, 1, 0,
    'keySize must be at least ' + HashTable.KEY_MIN
  ],
  [
    HashTable.KEY_MAX + 1, 0, 1, 0,
    'keySize must be at most ' + HashTable.KEY_MAX
  ],
  [
    4, HashTable.VALUE_MIN - 1, 1, 0,
    'valueSize must be at least ' + HashTable.VALUE_MIN
  ],
  [
    4, HashTable.VALUE_MAX + 1, 1, 0,
    'valueSize must be at most ' + HashTable.VALUE_MAX
  ],
  [
    4, 0, HashTable.ELEMENTS_MIN - 1, 0,
    'elementsMin must be at least ' + HashTable.ELEMENTS_MIN
  ],
  [
    4, 0, HashTable.ELEMENTS_MAX + 1, 0,
    'elementsMin must be at most ' + HashTable.ELEMENTS_MAX
  ],
  [
    4, 0, 123, 122,
    'elementsMax must be at least 123'
  ],
  [
    4, 0, 1, HashTable.ELEMENTS_MAX + 1,
    'elementsMax must be at most ' + HashTable.ELEMENTS_MAX
  ],
  [
    HashTable.KEY_MIN + 1, 0, 1, 0,
    'keySize must be a multiple of 4'
  ],
  [
    4, 65536, 1024 * 1024 * 1024, 0,
    HashTable.ERROR_MAXIMUM_CAPACITY_EXCEEDED
  ]
].forEach(
  function(args) {
    Assert('args.length === 5', args.length === 5, true);
    var error;
    try {
      var keySize = args[0];
      var valueSize = args[1];
      var elementsMin = args[2];
      var elementsMax = args[3];
      new HashTable(keySize, valueSize, elementsMin, elementsMax);
    } catch (exception) {
      error = exception.message;
    }
    Assert('error', error, args[4]);
  }
);

// Values used by README must match constants:
Assert('README a maximum of 64 bytes', 64, HashTable.KEY_MAX);
Assert('README a maximum of 1 MB', 1024 * 1024, HashTable.VALUE_MAX);
Assert('README 4,294,967,296 elements', 4294967296, HashTable.ELEMENTS_MAX);
Assert('README 16 TB', 17592186044416, HashTable.BUFFERS_MAX * 2147483648);

// Maximum load factor must not be artificially restricted by too few buckets:
(function() {
  var elements = HashTable.BUCKETS_MAX * 8;
  var keySize = HashTable.KEY_MIN;
  while (keySize <= HashTable.KEY_MAX) {
    var valueSize = HashTable.VALUE_MIN;
    while (valueSize <= HashTable.VALUE_MAX) {
      var elements = HashTable.BUCKETS_MAX * 8;
      while (elements < HashTable.ELEMENTS_MAX) {
        var buffers = HashTable.buffers(keySize, valueSize, elements);
        var buckets = HashTable.buckets(elements, buffers);
        Assert('buckets >= 64', buckets >= 64, true);
        elements = elements * 2;
      }
      valueSize = valueSize === 0 ? 1 : valueSize * 2;
    }
    keySize += 4;
  }
})();

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

var KEY_RND_HASH = Hash(KEY_RND, 0, KEY_RND.length);
var KEY_SEQ_HASH = Hash(KEY_SEQ, 0, KEY_SEQ.length);
var ENTROPY_HASH = Hash(ENTROPY, 0, ENTROPY.length);

KEY_SIZES.forEach(
  function(keySize) {
    var manyIndex = Math.floor(Math.random() * VALUE_SIZES.length);
    var cacheIndex = Math.floor(Math.random() * VALUE_SIZES.length);
    VALUE_SIZES.forEach(
      function(valueSize, valueSizeIndex) {
        var many = valueSizeIndex === manyIndex && Math.random() < 0.5;
        var cache = valueSizeIndex === cacheIndex;
        Test(keySize, valueSize, many, cache);
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
