# hash-table

Fast, reliable [cuckoo hash table](https://en.wikipedia.org/wiki/Cuckoo_hashing)
for Node.js.

## Installation

```
npm install @ronomon/hash-table
```

## Motivation

Why not use a vanilla Javascript object (or Set or Map) as a hash table?

* A vanilla object has no interface to pre-allocate table capacity in advance,
and a Set or Map constructor only accepts an iterable. If the Javascript
engine's underlying implementation of a vanilla object is a hash table, then a
vanilla object must resize multiple times (copying every key and value multiple
times) while you insert millions of elements.

* A vanilla object has no concept of binary keys. Encoding binary keys as
hexadecimal or Base64 strings is slow, and Javascript strings have additional
storage overhead.

* Extreme GC pause times. Millions of pointers in a vanilla object can block the
Node.js event loop every few seconds for tens to hundreds of milliseconds at a
time, whenever the GC needs to mark every pointer in the object.

A simple comparison, which you can run yourself:

```
node vanilla.js
```

Ignoring any GC implications or per-key memory overhead considerations, which
are more serious:

```

                       keySize=16 valueSize=0

  @ronomon/hash-table: Inserting 4000000 elements...
  @ronomon/hash-table: 783ms

            new Set(): Inserting 4000000 elements...
            new Set(): 3695ms

       vanilla object: Inserting 4000000 elements...
       vanilla object: 5557ms

```

## Fast

`@ronomon/hash-table` features several design decisions and optimizations:

* Each element, a key and corresponding value, can reside in at most 1 of 2
possible buckets, guaranteeing **constant lookup time** in the worst-case.

* Each bucket contains up to 8 elements to support **a hash table load factor of
80% or higher**, unlike linear or chained hash tables which support a load
factor (`elements / capacity`) of at most 50% and which waste the other 50% of
memory. A more efficient load factor means that **table resizes are less
frequent**.

* Each element in a bucket has a tag, which is an 8-bit hash of the key. When
searching for an element in a bucket, these **8-bit tags are compared first,
eliminating comparisons against most keys in the bucket**.

* **Cache misses across buckets are reduced by an order of magnitude**. In the
case of a naive cuckoo hash table, if an element is not in its first bucket then
its second bucket must be fetched from memory, causing a cache miss, which is
slow and why cuckoo hashing is sometimes overlooked in favor of
[linear probing](https://en.wikipedia.org/wiki/Linear_probing) or
[double hashing](https://en.wikipedia.org/wiki/Double_hashing). However, in our
design, the first bucket has an 8-byte coarse-grained bloom filter (k=1). If the
element is not in this bloom filter, the element is guaranteed not to be in
either of its first or second buckets, and a cache miss can be avoided nearly
90% of the time.

* The 8-bit tag further contributes to **reduced cache misses within buckets**
when keys or values are large.

* Each element is included in its first bucket's bloom filter, regardless of
whether the element is in its first or second bucket, so that **a negative
lookup can be performed in a single branch** by testing against a single bit in
the bloom filter instead of testing against all 8 tags.

* Each bucket has a 1-byte bitmap indicating which of the 8 slots in the bucket
contain elements, so that **the first empty slot in a bucket can be found with a
single branch on a 256-byte precomputed lookup table** instead of iterating
across all 8 slots.

* Each element's key is hashed with 2 independent hash functions to locate its
first and second buckets. These hashes are computed by interleaving both hash
function lookup tables into **a single interleaved hash function lookup table
for optimal locality of reference**.

* The hash function requires keys to be a multiple of 4 bytes and uses an
unrolled loop, so that **keys are hashed 4 bytes at a time**.

* The number of buckets in a table is a power of 2 for a **fast bitwise mod**.
While Daniel Lemire's excellent [fast alternative to the modulo reduction](https://lemire.me/blog/2016/06/27/a-fast-alternative-to-the-modulo-reduction/)
yields better entropy mixing of all available bits, it is not used since
Javascript's 64-bit integer operations are not fast.

* Each bucket is padded to a multiple of 64 bytes for **optimal cache line
alignment**.

* **An unrolled copy method is selected at instantiation to copy the key and
value without branching** if the key or value is 4, 8, 16, 32, 64, 128, 256
bytes etc. **A native copy method is used for larger values**.

* Methods accept **a buffer and a buffer offset to avoid a buffer slice**. While
a buffer slice may not copy the underlying memory, it adds overhead through
allocating an object which must eventually be reclaimed by the GC. This overhead
is considerable when inserting millions of elements.

* The [CLOCK LRU eviction algorithm](https://en.wikipedia.org/wiki/Page_replacement_algorithm#Clock)
is supported at an overhead of 2 bits per element, so that **the hash table can
be used as a fast user-space cache**.

* Surprisingly, the implementation is **written in Javascript** to avoid the
[100-200ns bridging cost](https://github.com/nodejs/abi-stable-node/issues/327)
of calling into C from Javascript. Even a C implementation making use of SIMD
instructions may struggle to regain the cost of being called from Javascript.

## Reliable

`@ronomon/hash-table` was designed for billions of elements:

* Each hash table instance is partitioned across multiple buffers and
**scales linearly up to a maximum of 4,294,967,296 elements or 16 TB of
memory**, whichever comes first.

* Exactly **2.5 bytes of overhead per element** at 100% load.

* The implementation is purely in terms of huge flat buffer instances. Apart
from jumping to a huge flat buffer instance, there is **no pointer chasing**.
Most importantly, this **sidesteps memory fragmentation issues** and is **GC
friendly**. If the GC cannot look into the buffers, the GC has nothing further
to do. This places almost zero load on the GC.

* [Tabulation hashing](https://en.wikipedia.org/wiki/Tabulation_hashing) is used
as a **fast high-quality hash function** instead of more popular hash functions
such as MurmurHash etc. Tabulation hashing has excellent proven [theoretical
properties](http://www2.imm.dtu.dk/projects/thrash-workshop/slides/thorup.pdf),
guarantees
[3-independence](https://en.wikipedia.org/wiki/K-independent_hashing), consists
solely of table lookups and XOR, is one of the fastest hash functions when
evaluating hash functions implemented in Javascript, and is **resistant to hash
flooding attacks**. When compared with hash functions which use magic numbers
and attempt avalanche through empirical methods, tabulation hashing is easier to
understand and implement, and harder to get wrong.

* Each 8-byte bloom filter has a separate 1-byte count of the number of elements
in second position, so that **bloom filters can be reset without a runaway
increase in false positives**.

* Each 8-byte bloom filter is partitioned into 8 subsidiary filters, so that
**bloom filters can be reset with minimal latency**. Further, this solves the
edge case where a key in second position is never removed while other keys are
churned repeatedly. Without bloom filter partitioning, the bucket's false
positive rate would approach 100%. With bloom filter partitioning, only 1/8th of
the bucket's filter would be adversely affected.

* **A maximum of 16 cuckoo displacements per insert are allowed in order to
limit recursion** and to keep the algorithm intuitive. If both buckets are full
and no element can be displaced into another bucket, the buffer is resized by a
factor of 2 to make space for the insert.

* Each buffer is resized independently of other buffers so that the **resize
latency for a massive hash table is bounded per insert**. This guarantee does
NOT extend to a batch of inserts. For example, subsequent inserts may cause
other buffers to resize in close succession. But then again, you can **reserve
or pre-allocate a massive hash table upfront to eliminate resize latency**.

* The number of resize attempts per insert is bounded as a precaution against
resource exhaustion in the unlikely event that several resizes do not produce an
empty slot.

## Usage

**var hashTable = new HashTable(keySize, valueSize, [elementsMin],
[elementsMax])**

* `keySize` An integer, must be a multiple of 4 bytes, up to a maximum of 64
bytes (`HashTable.KEY_MAX`).
* `valueSize` An integer, from 0 bytes up to a maximum of 1 MB
(`HashTable.VALUE_MAX`).
* `elementsMin` An integer, a *hint* as to the minimum number of elements
expected to be inserted, to avoid unnecessary resizing over the short term.
* `elementsMax` An integer, a *hint* as to the maximum number of elements
expected to be inserted, to ensure sufficient capacity over the long term.

**hashTable.set(key, keyOffset, value, valueOffset)**

Inserts or updates an element in the hash table.

* `key` A buffer, contains the key to be inserted or updated.
* `keyOffset` An integer, the offset into `key` at which the key begins.
* `value` A buffer, contains the value to be inserted or updated.
* `valueOffset` An integer, the offset into `value` at which the value begins.
* Returns an integer, `0` if the element was inserted, `1` if the element was
updated.

**hashTable.get(key, keyOffset, value, valueOffset)**

Retrieves an element's value from the hash table.

* `key` A buffer, contains the key to be retrieved.
* `keyOffset` An integer, the offset into `key` at which the key begins.
* `value` A buffer, the element's value will be copied into this buffer if the
element exists.
* `valueOffset` An integer, the offset into `value` at which to begin copying.
* Returns an integer, `0` if the element was not found, `1` if the element was
found.

**hashTable.exist(key, keyOffset)**

Tests whether an element exists in the hash table.

* `key` A buffer, contains the key to be tested.
* `keyOffset` An integer, the offset into `key` at which the key begins.
* Returns an integer, `0` if the element was not found, `1` if the element was
found.

**hashTable.unset(key, keyOffset)**

Removes an element from the hash table.

* `key` A buffer, contains the key to be removed.
* `keyOffset` An integer, the offset into `key` at which the key begins.
* Returns an integer, `0` if the element was not found, `1` if the element was
removed.

**hashTable.cache(key, keyOffset, value, valueOffset)**

Similar to `set()` but inserts by evicting a least recently used element, rather
than resizing the hash table.

* `key` A buffer, contains the key to be inserted or updated.
* `keyOffset` An integer, the offset into `key` at which the key begins.
* `value` A buffer, contains the value to be inserted or updated.
* `valueOffset` An integer, the offset into `value` at which the value begins.
* Returns an integer, `0` if the element was inserted, `1` if the element was
updated, `2` if the element was inserted by evicting another element.

*`cache()` will never resize the hash table. Use the same `elementsMin` and
`elementsMax` arguments to size the hash table appropriately.*

*`cache()` and `set()` are mutually exclusive and cannot be used on the same
hash table instance. This restriction is in place to prevent the user from
accidentally evicting elements which were inserted by `set()`, and to enable
several caching optimizations. When using `cache()`, you can still use `get()`,
`exist()` and `unset()` to retrieve, test and remove cached elements.*

**hashTable.capacity**

An integer, read-only, the current total capacity of the hash table, i.e. the
number of elements which the hash table can accommodate at 100% load, which will
increase through automatic resizing of the hash table buffers.

**hashTable.length**

An integer, read-only, the number of elements actually present in the hash
table.

**hashTable.load**

A fraction between 0 and 1, read-only, the length of the hash table divided by
the capacity of the hash table.

**hashTable.size**

An integer, read-only, the total size of all hash table buffers in bytes.

### Example

```javascript
var HashTable = require('@ronomon/hash-table');

var keySize = 16;
var valueSize = 4;
var elementsMin = 1024; // Optional. Reserve space for at least 1,024 elements.
var elementsMax = 65536; // Optional. Expect at most 65,536 elements.

var hashTable = new HashTable(keySize, valueSize, elementsMin, elementsMax);

// set():
var key = Buffer.alloc(keySize);
var keyOffset = 0;
var value = Buffer.alloc(valueSize);
var valueOffset = 0;
var result = hashTable.set(key, keyOffset, value, valueOffset);
if (result === 0) console.log('set(): element was inserted');
if (result === 1) console.log('set(): element was updated');

// get():
var result = hashTable.get(key, keyOffset, value, valueOffset);
if (result === 0) console.log('get(): element does not exist, nothing copied');
if (result === 1) console.log('get(): element exists, copied value to buffer');

// exist():
var result = hashTable.exist(key, keyOffset);
if (result === 0) console.log('exist(): element does not exist');
if (result === 1) console.log('exist(): element exists');

// unset():
var result = hashTable.unset(key, keyOffset);
if (result === 0) console.log('unset(): element does not exist, not removed');
if (result === 1) console.log('unset(): element was removed');

// cache():
// cache() cannot be used on the same instance as set(), reinstantiate:
var hashTable = new HashTable(keySize, valueSize, elementsMin, elementsMax);
var result = hashTable.cache(key, keyOffset, value, valueOffset);
if (result === 0) console.log('cache(): element was inserted');
if (result === 1) console.log('cache(): element was updated');
if (result === 2) console.log('cache(): element evicted another element');
```

### Exceptions

Apart from validation exceptions thrown for programming errors, the following
exceptions may be thrown for operating errors:

**HashTable.ERROR_MAXIMUM_CAPACITY_EXCEEDED**

A hash table buffer could not be further resized due to reaching
`HashTable.BUFFER_MAX` or `HashTable.BUCKETS_MAX`. Increase `elementsMax` when
instantiating the hash table to ensure sufficient capacity.

**HashTable.ERROR_SET**

An insert failed despite several resize attempts. This should never happen and
may indicate weak system entropy.

## Performance

```

            CPU=Intel(R) Xeon(R) CPU E3-1230 V2 @ 3.30GHz

===============================================================================
            KEY=8 VALUE=0              |            KEY=8 VALUE=4              
---------------------------------------|---------------------------------------
      set() Insert              228ns  |      set() Insert              269ns  
      set() Reserve             134ns  |      set() Reserve             139ns  
      set() Update              149ns  |      set() Update              164ns  
      get() Miss                 99ns  |      get() Miss                100ns  
      get() Hit                 147ns  |      get() Hit                 164ns  
    exist() Miss                 98ns  |    exist() Miss                 99ns  
    exist() Hit                 143ns  |    exist() Hit                 148ns  
    unset() Miss                 98ns  |    unset() Miss                 98ns  
    unset() Hit                 196ns  |    unset() Hit                 200ns  
    cache() Insert              122ns  |    cache() Insert              139ns  
    cache() Evict               153ns  |    cache() Evict               174ns  
    cache() Miss                120ns  |    cache() Miss                133ns  
    cache() Hit                 133ns  |    cache() Hit                 136ns  
===============================================================================
            KEY=8 VALUE=8              |            KEY=8 VALUE=16             
---------------------------------------|---------------------------------------
      set() Insert              299ns  |      set() Insert              346ns  
      set() Reserve             158ns  |      set() Reserve             172ns  
      set() Update              175ns  |      set() Update              195ns  
      get() Miss                 96ns  |      get() Miss                103ns  
      get() Hit                 174ns  |      get() Hit                 191ns  
    exist() Miss                 94ns  |    exist() Miss                102ns  
    exist() Hit                 148ns  |    exist() Hit                 160ns  
    unset() Miss                 93ns  |    unset() Miss                101ns  
    unset() Hit                 204ns  |    unset() Hit                 224ns  
    cache() Insert              151ns  |    cache() Insert              165ns  
    cache() Evict               189ns  |    cache() Evict               207ns  
    cache() Miss                150ns  |    cache() Miss                158ns  
    cache() Hit                 146ns  |    cache() Hit                 166ns  
===============================================================================
            KEY=8 VALUE=32             |            KEY=8 VALUE=64             
---------------------------------------|---------------------------------------
      set() Insert              418ns  |      set() Insert              631ns  
      set() Reserve             190ns  |      set() Reserve             275ns  
      set() Update              225ns  |      set() Update              280ns  
      get() Miss                104ns  |      get() Miss                111ns  
      get() Hit                 223ns  |      get() Hit                 277ns  
    exist() Miss                103ns  |    exist() Miss                109ns  
    exist() Hit                 172ns  |    exist() Hit                 183ns  
    unset() Miss                103ns  |    unset() Miss                110ns  
    unset() Hit                 251ns  |    unset() Hit                 295ns  
    cache() Insert              192ns  |    cache() Insert              244ns  
    cache() Evict               229ns  |    cache() Evict               286ns  
    cache() Miss                167ns  |    cache() Miss                179ns  
    cache() Hit                 181ns  |    cache() Hit                 191ns  
===============================================================================
            KEY=8 VALUE=4096           |            KEY=8 VALUE=65536          
---------------------------------------|---------------------------------------
      set() Insert             6436ns  |      set() Insert            79601ns  
      set() Reserve            2178ns  |      set() Reserve           24260ns  
      set() Update             1518ns  |      set() Update            20550ns  
      get() Miss                135ns  |      get() Miss                181ns  
      get() Hit                 828ns  |      get() Hit                7904ns  
    exist() Miss                127ns  |    exist() Miss                171ns  
    exist() Hit                 232ns  |    exist() Hit                 269ns  
    unset() Miss                104ns  |    unset() Miss                 63ns  
    unset() Hit                1088ns  |    unset() Hit               13284ns  
    cache() Insert             1746ns  |    cache() Insert            20381ns  
    cache() Evict              1471ns  |    cache() Evict             20526ns  
    cache() Miss                180ns  |    cache() Miss                224ns  
    cache() Hit                 231ns  |    cache() Hit                 283ns  
===============================================================================
            KEY=16 VALUE=0             |            KEY=16 VALUE=4             
---------------------------------------|---------------------------------------
      set() Insert              339ns  |      set() Insert              389ns  
      set() Reserve             161ns  |      set() Reserve             182ns  
      set() Update              197ns  |      set() Update              211ns  
      get() Miss                114ns  |      get() Miss                115ns  
      get() Hit                 194ns  |      get() Hit                 208ns  
    exist() Miss                113ns  |    exist() Miss                112ns  
    exist() Hit                 197ns  |    exist() Hit                 189ns  
    unset() Miss                112ns  |    unset() Miss                111ns  
    unset() Hit                 250ns  |    unset() Hit                 423ns  
    cache() Insert              164ns  |    cache() Insert              184ns  
    cache() Evict               206ns  |    cache() Evict               225ns  
    cache() Miss                163ns  |    cache() Miss                166ns  
    cache() Hit                 183ns  |    cache() Hit                 189ns  
===============================================================================
            KEY=16 VALUE=8             |            KEY=16 VALUE=16            
---------------------------------------|---------------------------------------
      set() Insert              416ns  |      set() Insert              444ns  
      set() Reserve             189ns  |      set() Reserve             192ns  
      set() Update              225ns  |      set() Update              240ns  
      get() Miss                124ns  |      get() Miss                120ns  
      get() Hit                 221ns  |      get() Hit                 238ns  
    exist() Miss                122ns  |    exist() Miss                119ns  
    exist() Hit                 199ns  |    exist() Hit                 205ns  
    unset() Miss                122ns  |    unset() Miss                119ns  
    unset() Hit                 458ns  |    unset() Hit                 509ns  
    cache() Insert              185ns  |    cache() Insert              197ns  
    cache() Evict               232ns  |    cache() Evict               243ns  
    cache() Miss                176ns  |    cache() Miss                179ns  
    cache() Hit                 195ns  |    cache() Hit                 202ns  
===============================================================================
            KEY=16 VALUE=32            |            KEY=16 VALUE=64            
---------------------------------------|---------------------------------------
      set() Insert              527ns  |      set() Insert              521ns  
      set() Reserve             242ns  |      set() Reserve             324ns  
      set() Update              268ns  |      set() Update              331ns  
      get() Miss                125ns  |      get() Miss                122ns  
      get() Hit                 265ns  |      get() Hit                 328ns  
    exist() Miss                125ns  |    exist() Miss                120ns  
    exist() Hit                 217ns  |    exist() Hit                 234ns  
    unset() Miss                128ns  |    unset() Miss                121ns  
    unset() Hit                 619ns  |    unset() Hit                 484ns  
    cache() Insert              226ns  |    cache() Insert              279ns  
    cache() Evict               263ns  |    cache() Evict               316ns  
    cache() Miss                185ns  |    cache() Miss                206ns  
    cache() Hit                 212ns  |    cache() Hit                 224ns  
===============================================================================
            KEY=16 VALUE=4096          |            KEY=16 VALUE=65536         
---------------------------------------|---------------------------------------
      set() Insert             6264ns  |      set() Insert            80181ns  
      set() Reserve            2172ns  |      set() Reserve           23874ns  
      set() Update             1535ns  |      set() Update            20602ns  
      get() Miss                155ns  |      get() Miss                204ns  
      get() Hit                 863ns  |      get() Hit                7758ns  
    exist() Miss                148ns  |    exist() Miss                186ns  
    exist() Hit                 272ns  |    exist() Hit                 343ns  
    unset() Miss                130ns  |    unset() Miss                150ns  
    unset() Hit                1228ns  |    unset() Hit               13332ns  
    cache() Insert             1767ns  |    cache() Insert            20791ns  
    cache() Evict              1486ns  |    cache() Evict             20552ns  
    cache() Miss                201ns  |    cache() Miss                243ns  
    cache() Hit                 266ns  |    cache() Hit                 318ns  
===============================================================================
            KEY=32 VALUE=0             |            KEY=32 VALUE=4             
---------------------------------------|---------------------------------------
      set() Insert              526ns  |      set() Insert              549ns  
      set() Reserve             239ns  |      set() Reserve             251ns  
      set() Update              295ns  |      set() Update              302ns  
      get() Miss                160ns  |      get() Miss                161ns  
      get() Hit                 293ns  |      get() Hit                 302ns  
    exist() Miss                158ns  |    exist() Miss                158ns  
    exist() Hit                 281ns  |    exist() Hit                 282ns  
    unset() Miss                159ns  |    unset() Miss                158ns  
    unset() Hit                 590ns  |    unset() Hit                 616ns  
    cache() Insert              239ns  |    cache() Insert              249ns  
    cache() Evict               272ns  |    cache() Evict               282ns  
    cache() Miss                217ns  |    cache() Miss                224ns  
    cache() Hit                 271ns  |    cache() Hit                 277ns  
===============================================================================
            KEY=32 VALUE=8             |            KEY=32 VALUE=16            
---------------------------------------|---------------------------------------
      set() Insert              562ns  |      set() Insert              625ns  
      set() Reserve             244ns  |      set() Reserve             277ns  
      set() Update              316ns  |      set() Update              325ns  
      get() Miss                164ns  |      get() Miss                162ns  
      get() Hit                 314ns  |      get() Hit                 325ns  
    exist() Miss                161ns  |    exist() Miss                159ns  
    exist() Hit                 290ns  |    exist() Hit                 291ns  
    unset() Miss                162ns  |    unset() Miss                159ns  
    unset() Hit                 646ns  |    unset() Hit                 693ns  
    cache() Insert              243ns  |    cache() Insert              261ns  
    cache() Evict               290ns  |    cache() Evict               301ns  
    cache() Miss                227ns  |    cache() Miss                226ns  
    cache() Hit                 277ns  |    cache() Hit                 283ns  
===============================================================================
            KEY=32 VALUE=32            |            KEY=32 VALUE=64            
---------------------------------------|---------------------------------------
      set() Insert              685ns  |      set() Insert              739ns  
      set() Reserve             308ns  |      set() Reserve             356ns  
      set() Update              348ns  |      set() Update              399ns  
      get() Miss                161ns  |      get() Miss                154ns  
      get() Hit                 347ns  |      get() Hit                 398ns  
    exist() Miss                163ns  |    exist() Miss                154ns  
    exist() Hit                 296ns  |    exist() Hit                 304ns  
    unset() Miss                162ns  |    unset() Miss                155ns  
    unset() Hit                 799ns  |    unset() Hit                 662ns  
    cache() Insert              276ns  |    cache() Insert              360ns  
    cache() Evict               322ns  |    cache() Evict               376ns  
    cache() Miss                231ns  |    cache() Miss                272ns  
    cache() Hit                 289ns  |    cache() Hit                 299ns  
===============================================================================
            KEY=32 VALUE=4096          |            KEY=32 VALUE=65536         
---------------------------------------|---------------------------------------
      set() Insert             6761ns  |      set() Insert            78095ns  
      set() Reserve            2309ns  |      set() Reserve           23743ns  
      set() Update             1611ns  |      set() Update            20693ns  
      get() Miss                202ns  |      get() Miss                250ns  
      get() Hit                 952ns  |      get() Hit                7802ns  
    exist() Miss                190ns  |    exist() Miss                227ns  
    exist() Hit                 354ns  |    exist() Hit                 444ns  
    unset() Miss                174ns  |    unset() Miss                199ns  
    unset() Hit                1383ns  |    unset() Hit               13594ns  
    cache() Insert             1868ns  |    cache() Insert            20883ns  
    cache() Evict              1530ns  |    cache() Evict             20565ns  
    cache() Miss                246ns  |    cache() Miss                295ns  
    cache() Hit                 339ns  |    cache() Hit                 401ns  
===============================================================================
            KEY=64 VALUE=0             |            KEY=64 VALUE=4             
---------------------------------------|---------------------------------------
      set() Insert              947ns  |      set() Insert              961ns  
      set() Reserve             378ns  |      set() Reserve             370ns  
      set() Update              463ns  |      set() Update              471ns  
      get() Miss                240ns  |      get() Miss                236ns  
      get() Hit                 465ns  |      get() Hit                 471ns  
    exist() Miss                239ns  |    exist() Miss                236ns  
    exist() Hit                 452ns  |    exist() Hit                 452ns  
    unset() Miss                240ns  |    unset() Miss                237ns  
    unset() Hit                 628ns  |    unset() Hit                 650ns  
    cache() Insert              386ns  |    cache() Insert              383ns  
    cache() Evict               407ns  |    cache() Evict               412ns  
    cache() Miss                315ns  |    cache() Miss                323ns  
    cache() Hit                 432ns  |    cache() Hit                 437ns  
===============================================================================
            KEY=64 VALUE=8             |            KEY=64 VALUE=16            
---------------------------------------|---------------------------------------
      set() Insert             1008ns  |      set() Insert              837ns  
      set() Reserve             378ns  |      set() Reserve             439ns  
      set() Update              478ns  |      set() Update              501ns  
      get() Miss                235ns  |      get() Miss                231ns  
      get() Hit                 475ns  |      get() Hit                 498ns  
    exist() Miss                235ns  |    exist() Miss                230ns  
    exist() Hit                 451ns  |    exist() Hit                 466ns  
    unset() Miss                236ns  |    unset() Miss                230ns  
    unset() Hit                 674ns  |    unset() Hit                 720ns  
    cache() Insert              376ns  |    cache() Insert              390ns  
    cache() Evict               421ns  |    cache() Evict               434ns  
    cache() Miss                338ns  |    cache() Miss                353ns  
    cache() Hit                 444ns  |    cache() Hit                 448ns  
===============================================================================
            KEY=64 VALUE=32            |            KEY=64 VALUE=64            
---------------------------------------|---------------------------------------
      set() Insert              929ns  |      set() Insert             1293ns  
      set() Reserve             438ns  |      set() Reserve             516ns  
      set() Update              511ns  |      set() Update              555ns  
      get() Miss                227ns  |      get() Miss                231ns  
      get() Hit                 507ns  |      get() Hit                 553ns  
    exist() Miss                227ns  |    exist() Miss                227ns  
    exist() Hit                 459ns  |    exist() Hit                 457ns  
    unset() Miss                227ns  |    unset() Miss                229ns  
    unset() Hit                 821ns  |    unset() Hit                 688ns  
    cache() Insert              440ns  |    cache() Insert              479ns  
    cache() Evict               460ns  |    cache() Evict               485ns  
    cache() Miss                386ns  |    cache() Miss                302ns  
    cache() Hit                 454ns  |    cache() Hit                 435ns  
===============================================================================
            KEY=64 VALUE=4096          |            KEY=64 VALUE=65536         
---------------------------------------|---------------------------------------
      set() Insert             7004ns  |      set() Insert            81742ns  
      set() Reserve            2502ns  |      set() Reserve           24197ns  
      set() Update             1776ns  |      set() Update            20955ns  
      get() Miss                268ns  |      get() Miss                326ns  
      get() Hit                1166ns  |      get() Hit                8035ns  
    exist() Miss                259ns  |    exist() Miss                297ns  
    exist() Hit                 515ns  |    exist() Hit                 592ns  
    unset() Miss                249ns  |    unset() Miss                266ns  
    unset() Hit                1490ns  |    unset() Hit               13617ns  
    cache() Insert             2004ns  |    cache() Insert            21043ns  
    cache() Evict              1671ns  |    cache() Evict             20711ns  
    cache() Miss                336ns  |    cache() Miss                383ns  
    cache() Hit                 492ns  |    cache() Hit                 551ns  
```

## Tests

`@ronomon/hash-table` ships with extensive tests, including a fuzz test:

```
node test.js
```

## Benchmark

```
node benchmark.js
```
