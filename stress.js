// A simple stress test to use as much free memory available as possible.
// Load factor should be 1.00 if buffers and buckets are allocated correctly.

var HashTable = require('./index.js');
var Node = { crypto: require('crypto'), os: require('os') };

var size = Math.round(Node.os.freemem() * 0.8);
console.log('');
console.log('System has ' + size + ' bytes of free memory available.');
var keySize = 32;
var valueSize = 65536;
var elementsMin = Math.round((size / (2.5 + keySize + valueSize)) / 2);
var elementsMax = elementsMin;
var hashTable = new HashTable(keySize, valueSize, elementsMin, elementsMax);
console.log(
  'keySize=' + keySize +
  ' valueSize=' + valueSize +
  ' elementsMin=' + elementsMin +
  ' capacity=' + hashTable.capacity +
  ' size=' + hashTable.size
);
var elements = Math.ceil(hashTable.capacity * 2);
console.log('');
console.log('Inserting ' + elements + ' elements...');
console.log('');
var cipher = Node.crypto.createCipheriv(
  'AES-256-CTR',
  Buffer.alloc(32),
  Buffer.alloc(16)
);
var buffer = Buffer.alloc(Math.max(elements * keySize, valueSize));
var key = cipher.update(buffer);
var keyOffset = 0;
var value = cipher.update(buffer);
var valueOffset = 0;
var temp = Buffer.alloc(valueSize);
cipher.final();

var stats = {
  count: 0,
  inserts: 0,
  updates: 0,
  evictions: 0
};
function pad(integer) {
  return integer.toString().padStart(6, '0');
}
for (var index = 0; index < elements; index++) {
  var result = hashTable.cache(key, keyOffset, value, valueOffset);
  if (result === 0) stats.inserts++;
  if (result === 1) stats.updates++;
  if (result === 2) stats.evictions++;
  if (hashTable.get(key, keyOffset, temp, 0) !== 1) {
    throw new Error('get() after cache() !== 1');
  }
  if (!temp.equals(value.slice(valueOffset, valueOffset + valueSize))) {
    throw new Error('get() after cache() received a different value');
  }
  keyOffset += keySize;
  valueOffset += valueSize;
  if (valueOffset + valueSize > value.length) valueOffset = 0;
  if (keyOffset === key.length) {
    console.log(pad(index + 1) + '/' + pad(elements));
    if (index !== elements - 1) throw new Error('key wrapped unexpectedly');
  } else if (index % 1000 === 0) {
    console.log(pad(index) + '/' + pad(elements));
  }
}
console.log('');
console.log(
  'Inserts=' + stats.inserts +
  ' Updates=' + stats.updates +
  ' Evictions=' + stats.evictions
);
console.log(
  'Buffers=' + hashTable.tables.length +
  ' Buffer=' + hashTable.tables[0].buffer.length +
  ' Buckets=' + hashTable.tables[0].buckets
);
console.log(
  'Length=' + hashTable.length +
  ' Capacity=' + hashTable.capacity +
  ' Load=' + hashTable.load.toFixed(2)
);
console.log('');
if (hashTable.load > 0.95) {
  console.log('PASSED');
  console.log('');
  process.exit(0);
} else {
  console.error('WARNING: Expected a load factor of at least 95%.');
  console.log('');
  process.exit(1);
}
