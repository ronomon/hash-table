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
be used as a fast user space cache**.

* Surprisingly, the implementation is **written in Javascript** to avoid the
[100-200ns bridging cost](https://github.com/nodejs/abi-stable-node/issues/327)
of calling into C from Javascript. Even a C implementation making use of SIMD
operations may struggle to regain the cost of being called from Javascript.

## Reliable

`@ronomon/hash-table` was designed for billions of elements:

* Each hash table instance is partitioned across multiple buffers and
**scales linearly up to a maximum of 68,719,476,736 elements or 1 TB of
memory**, whichever comes first.

* Exactly **2.5 bytes of overhead per element** at 100% load.

* The implementation is purely in terms of huge flat buffer instances. Apart
from jumping to a huge flat buffer instance, there is **no pointer chasing**.
Most importantly, this **sidesteps memory fragmentation issues** and is **GC
friendly**. If the GC can't look into the buffers, the GC has nothing further to
do. This places almost zero load on the GC.

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

* Each 8-byte bloom filter is partitioned into 8 subsidary filters, so that
**bloom filters can be reset with minimal latency**. This further solves the
edge case where a key in second position is never removed while other keys are
churned repeatedly. Without bloom filter partitioning, the bucket's false
positive rate would approach 100%. With bloom filter partitioning, only 1/8th of
the bucket's filter would be adversely affected.

* **A maximum of 16 cuckoo displacements per insert are allowed in order to
limit recursion** and keep the algorithm intuitive. If both buckets are full and
no element can be displaced into another bucket, the buffer is resized by a
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

**var hashTable = new HashTable(keySize, valueSize, [buffers=8],
[elements=1024], [size])**

* `keySize` An integer, must be a multiple of 4 bytes, up to a maximum of 64
bytes (`HashTable.KEY_MAX`).
* `valueSize` An integer, from 0 bytes up to a maximum of 64 MB
(`HashTable.VALUE_MAX`).
* `buffers` An integer, the number of hash table buffers, must be a power of 2,
up to a maximum of 8,192 (`HashTable.BUFFERS_MAX`). Each buffer can support at
most 65,536 buckets, or 524,288 elements (`65536 * 8`) and can be resized to at
most `HashTable.BUFFER_MAX`, whichever comes first.
* `elements` An integer, reserve or pre-allocate the hash table according to the
number of elements expected to be inserted to avoid unnecessary resizes.
* `size` An integer, reserve or pre-allocate the hash table according to the
amount of memory in bytes desired, up to a maximum of `HashTable.SIZE_MAX`
bytes. If both `elements` and `size` are provided, then the hash table will be
pre-allocated according to `size`.

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

Similar to `set()` but inserts by evicting an existing least recently used
element, rather than resizing the hash table.

* `key` A buffer, contains the key to be inserted or updated.
* `keyOffset` An integer, the offset into `key` at which the key begins.
* `value` A buffer, contains the value to be inserted or updated.
* `valueOffset` An integer, the offset into `value` at which the value begins.
* Returns an integer, `0` if the element was inserted, `1` if the element was
updated, `2` if the element was inserted by evicting another element.

*The `set()` and `cache()` methods are mutually exclusive and cannot be used on
the same hash table instance. This restriction is in place to prevent the user
from accidentally evicting elements which were inserted by `set()`, and to
enable several caching optimizations. When using `cache()` to cache elements in
a hash table, you can still use the `get()`, `exist()` and `unset()` methods to
retrieve, test and remove cached elements.*

**hashTable.capacity**

An integer, read-only, the current total capacity of the hash table, i.e. the
number of elements which the hash table can accommodate at 100% load, increased
through automatic resizing of the hash table buffers.

**hashTable.length**

An integer, read-only, the number of elements actually present in the hash
table.

**hashTable.load**

A fraction between 0 and 1, read-only, the length of the hash table divided by
the capacity of the hash table.

**hashTable.size**

An integer, read-only, the total size of the hash table buffers in bytes.

### Example

```javascript
var HashTable = require('@ronomon/hash-table');

var keySize = 16;
var valueSize = 4;
var buffers = 64; // Optional. Partition across 64 buffers.
var elements = 100000; // Optional. Reserve space for at least 100,000 elements.

var hashTable = new HashTable(keySize, valueSize, buffers, elements);

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
var hashTable = new HashTable(keySize, valueSize, buffers, elements);
var result = hashTable.cache(key, keyOffset, value, valueOffset);
if (result === 0) console.log('cache(): element was inserted');
if (result === 1) console.log('cache(): element was updated');
if (result === 2) console.log('cache(): element evicted another element');
```

### Exceptions

Apart from validation exceptions thrown for programming errors, the following
exceptions may be thrown for operating errors:

**HashTable.ERROR_MAXIMUM_CAPACITY_EXCEEDED**

A buffer cannot be further resized due to reaching `HashTable.BUFFER_MAX` or
`HashTable.BUCKETS_MAX`. Partition the hash table across more buffers to spread
the load and increase capacity.

**HashTable.ERROR_SET**

An insert failed despite multiple resize attempts. This should never happen and
may indicate an adversarial attack, or weak system entropy.

## Performance

```

            CPU=Intel(R) Xeon(R) CPU E3-1230 V2 @ 3.30GHz

===============================================================================
            KEY=8 VALUE=0              |            KEY=8 VALUE=4              
---------------------------------------|---------------------------------------
      set() Insert              230ns  |      set() Insert              271ns  
      set() Reserve             132ns  |      set() Reserve             147ns  
      set() Update              149ns  |      set() Update              167ns  
      get() Miss                 99ns  |      get() Miss                 92ns  
      get() Hit                 147ns  |      get() Hit                 166ns  
    exist() Miss                 97ns  |    exist() Miss                 90ns  
    exist() Hit                 144ns  |    exist() Hit                 144ns  
    unset() Miss                100ns  |    unset() Miss                 92ns  
    unset() Hit                 200ns  |    unset() Hit                 200ns  
    cache() Insert              124ns  |    cache() Insert              139ns  
    cache() Evict               159ns  |    cache() Evict               165ns  
    cache() Miss                127ns  |    cache() Miss                117ns  
    cache() Hit                 135ns  |    cache() Hit                 131ns  
===============================================================================
            KEY=8 VALUE=8              |            KEY=8 VALUE=16             
---------------------------------------|---------------------------------------
      set() Insert              310ns  |      set() Insert              391ns  
      set() Reserve             158ns  |      set() Reserve             176ns  
      set() Update              183ns  |      set() Update              207ns  
      get() Miss                 98ns  |      get() Miss                111ns  
      get() Hit                 181ns  |      get() Hit                 205ns  
    exist() Miss                 95ns  |    exist() Miss                109ns  
    exist() Hit                 152ns  |    exist() Hit                 160ns  
    unset() Miss                 97ns  |    unset() Miss                112ns  
    unset() Hit                 214ns  |    unset() Hit                 231ns  
    cache() Insert              150ns  |    cache() Insert              177ns  
    cache() Evict               197ns  |    cache() Evict               215ns  
    cache() Miss                144ns  |    cache() Miss                153ns  
    cache() Hit                 147ns  |    cache() Hit                 163ns  
===============================================================================
            KEY=8 VALUE=32             |            KEY=8 VALUE=64             
---------------------------------------|---------------------------------------
      set() Insert              483ns  |      set() Insert              774ns  
      set() Reserve             231ns  |      set() Reserve             539ns  
      set() Update              254ns  |      set() Update              325ns  
      get() Miss                106ns  |      get() Miss                113ns  
      get() Hit                 250ns  |      get() Hit                 324ns  
    exist() Miss                104ns  |    exist() Miss                111ns  
    exist() Hit                 173ns  |    exist() Hit                 179ns  
    unset() Miss                107ns  |    unset() Miss                115ns  
    unset() Hit                 261ns  |    unset() Hit                 299ns  
    cache() Insert              218ns  |    cache() Insert              297ns  
    cache() Evict               256ns  |    cache() Evict               307ns  
    cache() Miss                165ns  |    cache() Miss                113ns  
    cache() Hit                 178ns  |    cache() Hit                 164ns  
===============================================================================
            KEY=8 VALUE=4096           |            KEY=8 VALUE=65536          
---------------------------------------|---------------------------------------
      set() Insert             6373ns  |      set() Insert            64085ns  
      set() Reserve            2478ns  |      set() Reserve           23030ns  
      set() Update             1521ns  |      set() Update            20883ns  
      get() Miss                135ns  |      get() Miss                175ns  
      get() Hit                 834ns  |      get() Hit                7785ns  
    exist() Miss                127ns  |    exist() Miss                170ns  
    exist() Hit                 232ns  |    exist() Hit                 261ns  
    unset() Miss                104ns  |    unset() Miss                 66ns  
    unset() Hit                1095ns  |    unset() Hit               13178ns  
    cache() Insert             1552ns  |    cache() Insert            24247ns  
    cache() Evict              1419ns  |    cache() Evict             20395ns  
    cache() Miss                133ns  |    cache() Miss                172ns  
    cache() Hit                 195ns  |    cache() Hit                 225ns  
===============================================================================
            KEY=16 VALUE=0             |            KEY=16 VALUE=4             
---------------------------------------|---------------------------------------
      set() Insert              368ns  |      set() Insert              404ns  
      set() Reserve             172ns  |      set() Reserve             189ns  
      set() Update              197ns  |      set() Update              209ns  
      get() Miss                114ns  |      get() Miss                116ns  
      get() Hit                 194ns  |      get() Hit                 207ns  
    exist() Miss                112ns  |    exist() Miss                114ns  
    exist() Hit                 190ns  |    exist() Hit                 194ns  
    unset() Miss                113ns  |    unset() Miss                115ns  
    unset() Hit                 255ns  |    unset() Hit                 427ns  
    cache() Insert              172ns  |    cache() Insert              179ns  
    cache() Evict               221ns  |    cache() Evict               227ns  
    cache() Miss                169ns  |    cache() Miss                165ns  
    cache() Hit                 182ns  |    cache() Hit                 185ns  
===============================================================================
            KEY=16 VALUE=8             |            KEY=16 VALUE=16            
---------------------------------------|---------------------------------------
      set() Insert              428ns  |      set() Insert              481ns  
      set() Reserve             195ns  |      set() Reserve             226ns  
      set() Update              229ns  |      set() Update              249ns  
      get() Miss                123ns  |      get() Miss                123ns  
      get() Hit                 229ns  |      get() Hit                 249ns  
    exist() Miss                123ns  |    exist() Miss                122ns  
    exist() Hit                 200ns  |    exist() Hit                 204ns  
    unset() Miss                123ns  |    unset() Miss                121ns  
    unset() Hit                 275ns  |    unset() Hit                 286ns  
    cache() Insert              191ns  |    cache() Insert              216ns  
    cache() Evict               239ns  |    cache() Evict               260ns  
    cache() Miss                179ns  |    cache() Miss                183ns  
    cache() Hit                 201ns  |    cache() Hit                 209ns  
===============================================================================
            KEY=16 VALUE=32            |            KEY=16 VALUE=64            
---------------------------------------|---------------------------------------
      set() Insert              619ns  |      set() Insert              627ns  
      set() Reserve             272ns  |      set() Reserve             350ns  
      set() Update              291ns  |      set() Update              377ns  
      get() Miss                126ns  |      get() Miss                123ns  
      get() Hit                 290ns  |      get() Hit                 377ns  
    exist() Miss                126ns  |    exist() Miss                123ns  
    exist() Hit                 214ns  |    exist() Hit                 232ns  
    unset() Miss                125ns  |    unset() Miss                123ns  
    unset() Hit                 311ns  |    unset() Hit                 370ns  
    cache() Insert              245ns  |    cache() Insert              318ns  
    cache() Evict               294ns  |    cache() Evict               353ns  
    cache() Miss                191ns  |    cache() Miss                170ns  
    cache() Hit                 219ns  |    cache() Hit                 239ns  
===============================================================================
            KEY=16 VALUE=4096          |            KEY=16 VALUE=65536         
---------------------------------------|---------------------------------------
      set() Insert             7560ns  |      set() Insert            89862ns  
      set() Reserve            3053ns  |      set() Reserve           36458ns  
      set() Update             1818ns  |      set() Update            28266ns  
      get() Miss                217ns  |      get() Miss                208ns  
      get() Hit                 974ns  |      get() Hit                8795ns  
    exist() Miss                153ns  |    exist() Miss                194ns  
    exist() Hit                 285ns  |    exist() Hit                 337ns  
    unset() Miss                178ns  |    unset() Miss                 84ns  
    unset() Hit                1526ns  |    unset() Hit               16412ns  
    cache() Insert             2092ns  |    cache() Insert            27629ns  
    cache() Evict              1779ns  |    cache() Evict             25393ns  
    cache() Miss                159ns  |    cache() Miss                200ns  
    cache() Hit                 244ns  |    cache() Hit                 271ns  
===============================================================================
            KEY=32 VALUE=0             |            KEY=32 VALUE=4             
---------------------------------------|---------------------------------------
      set() Insert              615ns  |      set() Insert              635ns  
      set() Reserve             254ns  |      set() Reserve             279ns  
      set() Update              289ns  |      set() Update              312ns  
      get() Miss                174ns  |      get() Miss                158ns  
      get() Hit                 290ns  |      get() Hit                 306ns  
    exist() Miss                157ns  |    exist() Miss                158ns  
    exist() Hit                 284ns  |    exist() Hit                 286ns  
    unset() Miss                157ns  |    unset() Miss                158ns  
    unset() Hit                 376ns  |    unset() Hit                 379ns  
    cache() Insert              249ns  |    cache() Insert              264ns  
    cache() Evict               296ns  |    cache() Evict               314ns  
    cache() Miss                226ns  |    cache() Miss                227ns  
    cache() Hit                 282ns  |    cache() Hit                 283ns  
===============================================================================
            KEY=32 VALUE=8             |            KEY=32 VALUE=16            
---------------------------------------|---------------------------------------
      set() Insert              670ns  |      set() Insert              715ns  
      set() Reserve             294ns  |      set() Reserve             315ns  
      set() Update              324ns  |      set() Update              346ns  
      get() Miss                161ns  |      get() Miss                164ns  
      get() Hit                 318ns  |      get() Hit                 342ns  
    exist() Miss                161ns  |    exist() Miss                164ns  
    exist() Hit                 290ns  |    exist() Hit                 293ns  
    unset() Miss                161ns  |    unset() Miss                163ns  
    unset() Hit                 387ns  |    unset() Hit                 399ns  
    cache() Insert              274ns  |    cache() Insert              290ns  
    cache() Evict               328ns  |    cache() Evict               341ns  
    cache() Miss                234ns  |    cache() Miss                233ns  
    cache() Hit                 288ns  |    cache() Hit                 291ns  
===============================================================================
            KEY=32 VALUE=32            |            KEY=32 VALUE=64            
---------------------------------------|---------------------------------------
      set() Insert              821ns  |      set() Insert              852ns  
      set() Reserve             335ns  |      set() Reserve             423ns  
      set() Update              378ns  |      set() Update              455ns  
      get() Miss                163ns  |      get() Miss                160ns  
      get() Hit                 374ns  |      get() Hit                 454ns  
    exist() Miss                163ns  |    exist() Miss                159ns  
    exist() Hit                 298ns  |    exist() Hit                 306ns  
    unset() Miss                165ns  |    unset() Miss                160ns  
    unset() Hit                 418ns  |    unset() Hit                 465ns  
    cache() Insert              324ns  |    cache() Insert              403ns  
    cache() Evict               367ns  |    cache() Evict               422ns  
    cache() Miss                236ns  |    cache() Miss                198ns  
    cache() Hit                 294ns  |    cache() Hit                 277ns  
===============================================================================
            KEY=32 VALUE=4096          |            KEY=32 VALUE=65536         
---------------------------------------|---------------------------------------
      set() Insert             7329ns  |      set() Insert            67493ns  
      set() Reserve            2333ns  |      set() Reserve           28302ns  
      set() Update             1615ns  |      set() Update            21012ns  
      get() Miss                198ns  |      get() Miss                239ns  
      get() Hit                 957ns  |      get() Hit                7916ns  
    exist() Miss                187ns  |    exist() Miss                230ns  
    exist() Hit                 355ns  |    exist() Hit                 392ns  
    unset() Miss                177ns  |    unset() Miss                124ns  
    unset() Hit                1244ns  |    unset() Hit               13428ns  
    cache() Insert             1720ns  |    cache() Insert            23512ns  
    cache() Evict              1512ns  |    cache() Evict             20536ns  
    cache() Miss                193ns  |    cache() Miss                238ns  
    cache() Hit                 283ns  |    cache() Hit                 328ns  
===============================================================================
            KEY=64 VALUE=0             |            KEY=64 VALUE=4             
---------------------------------------|---------------------------------------
      set() Insert             1100ns  |      set() Insert             1140ns  
      set() Reserve             433ns  |      set() Reserve             457ns  
      set() Update              468ns  |      set() Update              479ns  
      get() Miss                244ns  |      get() Miss                248ns  
      get() Hit                 467ns  |      get() Hit                 480ns  
    exist() Miss                243ns  |    exist() Miss                246ns  
    exist() Hit                 455ns  |    exist() Hit                 457ns  
    unset() Miss                245ns  |    unset() Miss                248ns  
    unset() Hit                 578ns  |    unset() Hit                 583ns  
    cache() Insert              421ns  |    cache() Insert              443ns  
    cache() Evict               460ns  |    cache() Evict               451ns  
    cache() Miss                331ns  |    cache() Miss                257ns  
    cache() Hit                 448ns  |    cache() Hit                 380ns  
===============================================================================
            KEY=64 VALUE=8             |            KEY=64 VALUE=16            
---------------------------------------|---------------------------------------
      set() Insert             1212ns  |      set() Insert              906ns  
      set() Reserve             850ns  |      set() Reserve             483ns  
      set() Update              483ns  |      set() Update              522ns  
      get() Miss                244ns  |      get() Miss                241ns  
      get() Hit                 484ns  |      get() Hit                 523ns  
    exist() Miss                242ns  |    exist() Miss                239ns  
    exist() Hit                 454ns  |    exist() Hit                 474ns  
    unset() Miss                244ns  |    unset() Miss                243ns  
    unset() Hit                 582ns  |    unset() Hit                 613ns  
    cache() Insert              445ns  |    cache() Insert              454ns  
    cache() Evict               463ns  |    cache() Evict               482ns  
    cache() Miss                258ns  |    cache() Miss                267ns  
    cache() Hit                 387ns  |    cache() Hit                 401ns  
===============================================================================
            KEY=64 VALUE=32            |            KEY=64 VALUE=64            
---------------------------------------|---------------------------------------
      set() Insert             1049ns  |      set() Insert             1490ns  
      set() Reserve             506ns  |      set() Reserve             598ns  
      set() Update              548ns  |      set() Update              611ns  
      get() Miss                246ns  |      get() Miss                240ns  
      get() Hit                 550ns  |      get() Hit                 613ns  
    exist() Miss                245ns  |    exist() Miss                238ns  
    exist() Hit                 472ns  |    exist() Hit                 467ns  
    unset() Miss                249ns  |    unset() Miss                240ns  
    unset() Hit                 625ns  |    unset() Hit                 646ns  
    cache() Insert              477ns  |    cache() Insert              562ns  
    cache() Evict               507ns  |    cache() Evict               579ns  
    cache() Miss                283ns  |    cache() Miss                319ns  
    cache() Hit                 423ns  |    cache() Hit                 451ns  
===============================================================================
            KEY=64 VALUE=4096          |            KEY=64 VALUE=65536         
---------------------------------------|---------------------------------------
      set() Insert             7702ns  |      set() Insert            73799ns  
      set() Reserve            2531ns  |      set() Reserve           24950ns  
      set() Update             1805ns  |      set() Update            21224ns  
      get() Miss                278ns  |      get() Miss                321ns  
      get() Hit                1179ns  |      get() Hit                8131ns  
    exist() Miss                269ns  |    exist() Miss                320ns  
    exist() Hit                 527ns  |    exist() Hit                 554ns  
    unset() Miss                259ns  |    unset() Miss                209ns  
    unset() Hit                1462ns  |    unset() Hit               13601ns  
    cache() Insert             1878ns  |    cache() Insert            25262ns  
    cache() Evict              1666ns  |    cache() Evict             20664ns  
    cache() Miss                269ns  |    cache() Miss                311ns  
    cache() Hit                 421ns  |    cache() Hit                 452ns  
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
