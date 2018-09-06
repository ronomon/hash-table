// An indication of the pitfalls of using a vanilla object as a hash table:

var HashTable = require('./index.js');
var Node = { crypto: require('crypto') };

var keySize = 16;
var valueSize = 0;
var element = keySize + valueSize;
var elements = 4000000;
var buffer = Node.crypto.randomBytes(element * elements);
console.log('');
console.log(' '.repeat(23) + 'keySize=' + keySize + ' valueSize=' + valueSize);
console.log('');

console.log('  @ronomon/hash-table: Inserting ' + elements + ' elements...');
var now = Date.now();
var table = new HashTable(keySize, valueSize, 64, elements);
var offset = 0;
var length = elements;
while (length--) {
  table.set(buffer, offset, buffer, offset + keySize);
  offset += element;
}
console.log('  @ronomon/hash-table: ' + (Date.now() - now) + 'ms');
console.log('');

console.log('       vanilla object: Inserting ' + elements + ' elements...');
var now = Date.now();
var object = {};
var offset = 0;
var length = elements;
while (length--) {
  var key = buffer.toString('base64', offset, offset + keySize);
  // We don't even try to slice a value (this would be slower), just use "1":
  object[key] = 1;
  offset += element;
}
console.log('       vanilla object: ' + (Date.now() - now) + 'ms');
console.log('');
